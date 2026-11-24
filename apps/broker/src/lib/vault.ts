/**
 * The vault bridge's HTTP side (docs/vault-bridge.md): the worker's two routes and the ask/collect pair the
 * bc_vault_* tools use. The rendezvous itself is vault-bridge.mjs, in memory only.
 *
 * - Switched on by VAULT_BRIDGE=on. Off, the worker routes answer 403 rollout_off and the worker waits quietly.
 * - FULL-SCOPE per-agent keys only, both sides: the worker's own key on a PC, and the person's own agents asking.
 *   A connector key (claude.ai, ChatGPT over OAuth) is 403 until a per-connector vault grant exists (step 4).
 * - Note text passes through here as one answer to one request and is never stored. Each answer leaves one
 *   AccountAudit row of metadata (op, path, bytes, commit, which agents), never text or a search query.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
// Namespace imports (see remote-app.ts): route tests replace these modules with only some exports.
import * as auth from "@/lib/auth";
import * as limits from "@/lib/rate-limit";
import { hasFullScope } from "@/lib/agent-scope";
import { OPS, MAX_WORKER_WAIT_MS, VaultBridgeError, ask, collect, deliver, nextRequest } from "@/lib/vault-bridge";

export const MAX_ANSWER_BYTES = 2 * 1024 * 1024;
const ERROR_CODES = new Set(["bad_request", "bad_path", "excluded", "not_found", "not_a_file", "not_a_folder", "binary", "too_large", "not_fetched", "failed"]);
const ID = /^vr_[A-Za-z0-9_-]{16}$/;

export const vaultRolloutOn = () => process.env.VAULT_BRIDGE === "on";

const respond = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
const refuse = (status: number, error: string, message: string) => respond({ error, message }, status);

type Caller = { accountId: string; agentId: string };
type Gate = { caller: Caller } | { refused: NextResponse };

/** Who is calling, for either side: a live full-scope per-agent key on a switched-on bridge, within its rate. */
async function gate(req: NextRequest, bucket: string, perMinute: number): Promise<Gate> {
  const ctx = await auth.getAuthContext(req.headers.get("authorization"));
  if (!ctx) return { refused: refuse(401, "unauthorized", "Send Authorization: Bearer <your agent key>.") };
  if (!ctx.agentTokenId) return { refused: refuse(401, "agent_key_required", "The vault bridge takes a per-agent key.") };
  if (!hasFullScope(ctx)) {
    return { refused: refuse(403, "not_available_to_connectors", "The vault is open to your own agents' full keys only. A hosted connector (claude.ai, ChatGPT) needs a vault grant from one of your PCs first.") };
  }
  if (!vaultRolloutOn()) return { refused: refuse(403, "rollout_off", "The vault bridge is switched off for now.") };
  const limit = limits.rateLimit(bucket, ctx.agentTokenId, perMinute, 60_000);
  if (!limit.ok) {
    const res = refuse(429, "rate_limited", "Too many vault calls. Wait a moment and retry.");
    res.headers.set("Retry-After", String(limit.retryAfterSec));
    return { refused: res };
  }
  return { caller: { accountId: ctx.account.id, agentId: ctx.agentTokenId } };
}

/** GET /api/vault/worker/next?wait=N: the worker's long-poll for the next request (N 0 to 25 seconds). */
export async function workerNext(req: NextRequest): Promise<NextResponse> {
  const g = await gate(req, "vault-worker", 240);
  if ("refused" in g) return g.refused;
  const wait = Number(req.nextUrl.searchParams.get("wait") ?? 0);
  const waitMs = Number.isFinite(wait) ? Math.max(0, Math.min(MAX_WORKER_WAIT_MS, Math.floor(wait * 1000))) : 0;
  const request = await nextRequest(g.caller.accountId, g.caller.agentId, waitMs, req.signal);
  return respond({ request });
}

async function readBounded(req: NextRequest, max: number): Promise<string | null> {
  if (Number(req.headers.get("content-length")) > max) return null;
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

type Answer = { ok: true; result: Record<string, unknown> } | { ok: false; error: string; message: string; bytes?: number };

/** The worker's answer, strictly: an object result, or a known error code with a short sentence. */
function parseAnswer(body: unknown): { id: string; answer: Answer } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.id !== "string" || !ID.test(b.id)) return null;
  if (b.ok === true) {
    if (!b.result || typeof b.result !== "object" || Array.isArray(b.result)) return null;
    return { id: b.id, answer: { ok: true, result: b.result as Record<string, unknown> } };
  }
  if (b.ok === false && typeof b.error === "string" && ERROR_CODES.has(b.error) && typeof b.message === "string" && b.message.length <= 300) {
    return { id: b.id, answer: { ok: false, error: b.error, message: b.message, ...(Number.isInteger(b.bytes) ? { bytes: b.bytes as number } : {}) } };
  }
  return null;
}

const short = (v: unknown, max = 512) => (typeof v === "string" ? v.slice(0, max) : undefined);

/** POST /api/vault/worker/result: the worker's answer to one request it was handed. */
export async function workerResult(req: NextRequest): Promise<NextResponse> {
  const g = await gate(req, "vault-worker", 240);
  if ("refused" in g) return g.refused;
  const text = await readBounded(req, MAX_ANSWER_BYTES);
  if (text === null) return refuse(413, "too_large", `An answer is at most ${MAX_ANSWER_BYTES} bytes.`);
  let parsed: ReturnType<typeof parseAnswer> = null;
  try { parsed = parseAnswer(JSON.parse(text)); } catch { parsed = null; }
  if (!parsed) return refuse(400, "invalid_answer", "Send { id, ok: true, result } or { id, ok: false, error, message }.");
  const request = deliver(g.caller.accountId, g.caller.agentId, parsed.id, parsed.answer);
  if (!request) return refuse(404, "unknown_request", "Nobody is waiting for that answer any more.");
  const a = parsed.answer;
  const result = a.ok ? a.result : null;
  // Metadata only: never the text, a listing or a search query.
  const detail = {
    op: request.op,
    path: short(request.args.path) ?? "",
    agent: request.askerAgentId,
    worker: g.caller.agentId,
    ...(a.ok ? { bytes: typeof result?.bytes === "number" ? result.bytes : undefined, commit: short(result?.commit, 64) } : { error: a.error }),
  };
  await prisma.accountAudit.create({ data: { accountId: g.caller.accountId, eventType: a.ok ? "vault.read" : "vault.denied", detail } }).catch(() => {});
  return respond({ ok: true });
}

export type VaultOutcome = { status: number; body: Record<string, unknown> };

const outcome = (answer: Answer): VaultOutcome =>
  answer.ok ? { status: 200, body: answer.result } : { status: answer.error === "failed" || answer.error === "not_fetched" ? 502 : 422, body: { error: answer.error, message: answer.message, ...(answer.bytes !== undefined ? { bytes: answer.bytes } : {}) } };

const pending = (requestId: string): VaultOutcome => ({
  status: 202,
  body: { status: "pending", request_id: requestId, next: "The PC hasn't answered yet. Call bc_vault_result with this request_id in a little while." },
});

/** One read for a person's own agent: queue it, wait up to waitMs for the answer. The caller passed gate()'s checks. */
export async function vaultAsk(caller: Caller, op: string, args: Record<string, unknown>, waitMs: number): Promise<VaultOutcome> {
  if (!(OPS as readonly string[]).includes(op)) return { status: 400, body: { error: "bad_request", message: "Not a vault read." } };
  let id: string;
  try {
    id = ask(caller.accountId, caller.agentId, op, args);
  } catch (e) {
    if (e instanceof VaultBridgeError) return { status: e.code === "too_many_open" ? 429 : e.code === "vault_offline" ? 503 : 400, body: { error: e.code, message: e.message } };
    throw e;
  }
  const got = await collect(caller.accountId, caller.agentId, id, waitMs);
  if (!got) return { status: 504, body: { error: "expired", message: "That read expired before the PC answered." } };
  return "answer" in got && got.answer ? outcome(got.answer as Answer) : pending(id);
}

/** Collect a read that answered pending earlier. Only the agent that asked can collect it, once. */
export async function vaultCollect(caller: Caller, requestId: string, waitMs: number): Promise<VaultOutcome> {
  if (!ID.test(requestId)) return { status: 400, body: { error: "bad_request", message: "That isn't a vault request id." } };
  const got = await collect(caller.accountId, caller.agentId, requestId, waitMs);
  if (!got) return { status: 404, body: { error: "unknown_request", message: "No such read is waiting for you: it was collected already, expired, or asked by another agent." } };
  return "answer" in got && got.answer ? outcome(got.answer as Answer) : pending(requestId);
}

/** The gate for the asking side (the bc_vault_* tools): same rules as the worker's, own rate bucket. */
export async function vaultCaller(req: NextRequest): Promise<Gate> {
  return gate(req, "vault-ask", 60);
}
