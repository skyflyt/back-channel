/**
 * PUT /api/agents/self/readiness: the Dispatch worker on a PC reports whether one of the person's agents could use an
 * app there (vault design pc-agent-readiness.md; docs/remote-app-sessions.md, "Setting up a PC"). It sends this at
 * start and every 10 minutes (`bc-worker run`), or when asked (`bc-worker readiness --report`).
 *
 * - A FULL-SCOPE per-agent key only, about itself. A connector key (claude.ai, ChatGPT over OAuth) is 403: it lives on
 *   a hosted app's servers, not on a PC. The dashboard cookie is not enough: only the worker reports.
 * - The body is the contract's object, strictly (remote-app/readiness.mjs parseReadiness): every field, no other, at
 *   most 8 KiB of JSON. Back Channel keeps no free text from the PC beyond its name and the worker's.
 * - Stored on the agent's own row (AgentToken.readiness, readinessAt = the server's clock). Shown only to the account
 *   owner (the Remote page) and, as ready/missing, to the account's agents (bc_remote_machines).
 */
import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
// Namespace imports (see remote-app.ts): route tests replace these modules with only some exports.
import * as auth from "@/lib/auth";
import * as limits from "@/lib/rate-limit";
import { hasFullScope } from "@/lib/agent-scope";
import { RemoteRuleError } from "@/lib/remote-app/rules.mjs";
import { MAX_REPORT_BYTES, parseReadiness } from "@/lib/remote-app/readiness.mjs";

const respond = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
const refuse = (status: number, error: string, message: string) => respond({ error, message }, status);

/** The body as text, refused past MAX_REPORT_BYTES without reading the rest. */
async function readBounded(req: NextRequest): Promise<string | null> {
  if (Number(req.headers.get("content-length")) > MAX_REPORT_BYTES) return null;
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REPORT_BYTES) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function putReadiness(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await auth.getAuthContext(req.headers.get("authorization"));
    if (!ctx) return refuse(401, "unauthorized", "Readiness is reported by the Back Channel worker, with its own agent key.");
    if (!ctx.agentTokenId) return refuse(401, "agent_key_required", "Readiness is reported with a per-agent key.");
    if (!hasFullScope(ctx)) {
      return refuse(403, "not_available_to_connectors", "Readiness is reported by the worker on a PC, with a full agent key. A hosted connector (claude.ai, ChatGPT) has no PC to report on.");
    }
    const agentId = ctx.agentTokenId;
    const limit = limits.rateLimit("agent-readiness", agentId, 120, 60_000);
    if (!limit.ok) {
      const res = refuse(429, "rate_limited", "Too many readiness reports. Wait a moment and retry.");
      res.headers.set("Retry-After", String(limit.retryAfterSec));
      return res;
    }
    const text = await readBounded(req);
    if (text === null) return refuse(413, "too_large", `A readiness report is at most ${MAX_REPORT_BYTES} bytes.`);
    let body: unknown;
    try { body = JSON.parse(text); } catch { return refuse(400, "invalid_json", "Send the readiness report as a JSON object."); }
    const readiness = parseReadiness(body, { agentId });
    const now = new Date();
    // Only its own live row: a key revoked since it authenticated writes nothing.
    const written = await prisma.agentToken.updateMany({
      where: { id: agentId, accountId: ctx.account.id, revokedAt: null, scope: "full" },
      data: { readiness: readiness as unknown as Prisma.InputJsonValue, readinessAt: now },
    });
    if (written.count !== 1) return refuse(401, "agent_revoked", "This agent's key has been revoked.");
    return respond({ recorded: true, readinessAt: now.toISOString() });
  } catch (e) {
    if (e instanceof RemoteRuleError) return refuse(e.status, e.code, e.message);
    // Never log the body or the key.
    console.error("[agent-readiness] failed:", e instanceof Error ? e.name : typeof e);
    return refuse(503, "unavailable", "Back Channel couldn't record readiness right now. The worker tries again in 10 minutes.");
  }
}
