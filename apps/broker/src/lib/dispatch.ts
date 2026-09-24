import { createHash, createPublicKey, randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { AgentToken, DispatchTask, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getAuthContext } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isSerializationFailure, withSerializableRetry } from "@/lib/serializable";

type Operation = "agents" | "enroll" | "tasks" | "submit" | "claim" | "heartbeat" | "result" | "cancel" | "reject";
type Body = Record<string, unknown>;
const MAX_SEALED = 128 * 1024;
const MAX_BODY = MAX_SEALED * 6 + 4096; // JSON escaping can expand a string sixfold.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(["completed", "failed", "waiting_user", "interrupted"]);
class DispatchError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function fail(status: number, message: string): never { throw new DispatchError(status, message); }
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const response = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
function enrolled(a: AgentToken | null): a is AgentToken {
  return !!a && !a.revokedAt && !!a.dispatchEncryptionKey && !!a.dispatchSigningKey;
}
function agentView(a: AgentToken) {
  return { id: a.id, name: a.dispatchName, encryptionKey: a.dispatchEncryptionKey, signingKey: a.dispatchSigningKey };
}
function taskView(t: DispatchTask) {
  return { id: t.id, senderAgentId: t.senderAgentId, targetAgentId: t.targetAgentId, status: t.status,
    expiresAt: t.expiresAt, sealed: t.sealed, resultSealed: t.resultSealed, updatedAt: t.updatedAt };
}
function sealed(value: unknown): string {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value) > MAX_SEALED) fail(400, "Invalid sealed envelope");
  return value;
}
function publicKey(value: unknown, type: "x25519" | "ed25519"): string {
  if (typeof value !== "string" || value.length > 1024 || !value.startsWith("-----BEGIN PUBLIC KEY-----")) fail(400, "Invalid public key");
  try {
    const key = createPublicKey(value);
    if (key.asymmetricKeyType !== type) fail(400, "Wrong public key type");
    return key.export({ type: "spki", format: "pem" }).toString();
  } catch { return fail(400, "Invalid public key"); }
}
async function readBody(req: NextRequest): Promise<Body> {
  if (Number(req.headers.get("content-length")) > MAX_BODY) fail(413, "Request too large");
  const reader = req.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); fail(413, "Request too large"); }
      chunks.push(value);
    }
    if (!size) return {};
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) fail(400, "Invalid JSON body");
    return body as Body;
  } catch (e) { if (e instanceof DispatchError) throw e; return fail(400, "Invalid JSON body"); }
}

// Every operation reads live enrollment and revocation in the same serializable
// transaction as its state change. Races abort, never silently replay execution.
// An aborted attempt rolled back entirely, so the whole transaction is re-run under
// a small bounded budget (see serializable.ts). A concurrent writer to the caller's
// row is routine, not exotic: getAuthContext's throttled lastUsedAt touch runs
// outside this transaction, so an agent's first request (or first after a minute
// idle) races its own UPDATE, and before this retry that surfaced as a 503 (CI
// postgres-roundtrip flake, 2026-09-24: 40001 on the enroll UPDATE of AgentToken).
// Unique races (P2002: two identical submits inserting one id) retry too; the re-run
// finds the committed row and takes the exact-idempotency path.
const conflict = (e: unknown) => isSerializationFailure(e) || (!!e && typeof e === "object" && "code" in e && e.code === "P2002");
export async function dispatch(req: NextRequest, operation: Operation, id?: string) {
  try {
    const auth = await getAuthContext(req.headers.get("authorization"));
    if (!auth?.agentTokenId) fail(401, "Per-agent bearer token required");
    const agentId = auth.agentTokenId;
    const limit = rateLimit("dispatch", agentId, 120, 60_000);
    if (!limit.ok) {
      const res = response({ error: "Rate limited" }, 429);
      res.headers.set("Retry-After", String(limit.retryAfterSec)); return res;
    }
    if (id !== undefined && !UUID.test(id)) fail(400, "Invalid task id");
    const body = req.method === "POST" ? await readBody(req) : {};
    const result = await withSerializableRetry(() => prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const caller = await tx.agentToken.findFirst({ where: { id: agentId, accountId: auth.account.id, revokedAt: null } });
      if (!caller) fail(401, "Agent revoked");
      if (operation === "enroll") {
        if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 80) fail(400, "Invalid name");
        const data = { dispatchName: body.name.trim(), dispatchEncryptionKey: publicKey(body.encryptionKey, "x25519"), dispatchSigningKey: publicKey(body.signingKey, "ed25519") };
        if (caller.dispatchEncryptionKey || caller.dispatchSigningKey) {
          if (caller.dispatchEncryptionKey !== data.dispatchEncryptionKey || caller.dispatchSigningKey !== data.dispatchSigningKey || caller.dispatchName !== data.dispatchName) fail(409, "Enrollment is immutable");
          return { agent: agentView(caller) };
        }
        return { agent: agentView(await tx.agentToken.update({ where: { id: agentId }, data })) };
      }
      if (!enrolled(caller)) fail(403, "Agent not enrolled");
      const active = { accountId: caller.accountId, revokedAt: null, dispatchEncryptionKey: { not: null }, dispatchSigningKey: { not: null } };
      if (operation === "agents") return { agents: (await tx.agentToken.findMany({ where: active, take: 100, orderBy: { createdAt: "asc" } })).map(agentView) };
      const visible = { sender: active, target: active, OR: [{ senderAgentId: agentId }, { targetAgentId: agentId }] };
      const now = new Date();
      async function reconcile(task: DispatchTask) {
        const status = task.status === "running" && (!task.leaseExpiresAt || task.leaseExpiresAt <= now || task.expiresAt <= now) ? "interrupted"
          : task.status === "queued" && task.expiresAt <= now ? "expired" : null;
        if (status) {
          await tx.dispatchTask.updateMany({ where: { id: task.id, status: task.status, updatedAt: task.updatedAt }, data: { status, leaseExpiresAt: null } });
          return (await tx.dispatchTask.findUnique({ where: { id: task.id } }))!;
        }
        return task;
      }
      if (operation === "tasks") {
        const cursor = req.nextUrl.searchParams.get("cursor");
        if (cursor && !UUID.test(cursor)) fail(400, "Invalid cursor");
        const after = cursor ? await tx.dispatchTask.findFirst({ where: { ...visible, id: cursor } }) : null;
        if (cursor && !after) fail(400, "Invalid cursor");
        const tasks = await tx.dispatchTask.findMany({ where: { ...visible, ...(after ? { AND: [{ OR: [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }] }] } : {}) }, take: 51, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
        const views = [];
        for (const task of tasks.slice(0, 50)) views.push(taskView(await reconcile(task)));
        return { tasks: views, nextCursor: tasks.length > 50 ? tasks[49].id : null };
      }
      if (operation === "submit") {
        if (typeof body.id !== "string" || !UUID.test(body.id) || typeof body.targetAgentId !== "string" || body.targetAgentId === agentId) fail(400, "Invalid routing");
        const envelope = sealed(body.sealed);
        if (typeof body.expiresAt !== "string") fail(400, "Invalid expiry");
        const expiresAt = new Date(body.expiresAt);
        if (!Number.isFinite(expiresAt.getTime())) fail(400, "Invalid expiry");
        const target = await tx.agentToken.findFirst({ where: { ...active, id: body.targetAgentId } });
        if (!target) fail(404, "Target unavailable");
        const existing = await tx.dispatchTask.findUnique({ where: { id: body.id } });
        if (existing) {
          if (existing.senderAgentId !== agentId || existing.targetAgentId !== body.targetAgentId || existing.expiresAt.getTime() !== expiresAt.getTime() || existing.sealed !== envelope) fail(409, "Task id conflict");
          return { task: taskView(await reconcile(existing)) };
        }
        if (expiresAt <= now || expiresAt.getTime() > now.getTime() + 86400_000) fail(400, "Expiry must be within 24 hours");
        const activeCount = await tx.dispatchTask.count({ where: {
          sender: { accountId: caller.accountId }, expiresAt: { gt: now },
          OR: [{ status: "queued" }, { status: "running", leaseExpiresAt: { gt: now } }],
        } });
        if (activeCount >= 100) fail(429, "Account active task limit reached");
        return { task: taskView(await tx.dispatchTask.create({ data: { id: body.id, senderAgentId: agentId, targetAgentId: target.id, expiresAt, sealed: envelope } })) };
      }
      const found = await tx.dispatchTask.findFirst({ where: { ...visible, id } });
      if (!found) fail(404, "Task unavailable");
      if ((operation === "cancel" ? found.senderAgentId : found.targetAgentId) !== agentId) fail(403, "Wrong task participant");
      const task = await reconcile(found);
      // Return errors as values here so expired-state reconciliation commits.
      if (operation === "reject") {
        if (task.status === "rejected") return { task: taskView(task) };
        if (task.status !== "queued") return { error: "Task is not queued" };
        const rejected = await tx.dispatchTask.updateMany({ where: { id, status: "queued", expiresAt: { gt: now } }, data: { status: "rejected" } });
        if (rejected.count !== 1) return { error: "Rejection conflict" };
        return { task: taskView((await tx.dispatchTask.findUnique({ where: { id } }))!) };
      }
      if (operation === "cancel") {
        if (task.status === "queued" || task.status === "running") {
          await tx.dispatchTask.updateMany({ where: { id, status: task.status }, data: { status: "cancelled", leaseExpiresAt: null } });
          return { task: taskView((await tx.dispatchTask.findUnique({ where: { id } }))!) };
        }
        return { task: taskView(task) };
      }
      if (operation === "claim") {
        if (task.status !== "queued") return { error: "Task is not queued" };
        const leaseToken = randomBytes(32).toString("base64url");
        const claimed = await tx.dispatchTask.updateMany({ where: { id, status: "queued", expiresAt: { gt: now } }, data: { status: "running", leaseHash: hash(leaseToken), leaseExpiresAt: new Date(now.getTime() + 90_000) } });
        if (claimed.count !== 1) return { error: "Claim conflict" };
        return { task: taskView((await tx.dispatchTask.findUnique({ where: { id } }))!), leaseToken };
      }
      if (typeof body.leaseToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.leaseToken)) fail(400, "Invalid lease token");
      const leaseHash = hash(body.leaseToken);
      if (operation === "result") {
        if (typeof body.status !== "string" || !TERMINAL.has(body.status)) fail(400, "Invalid result status");
        const envelope = sealed(body.sealed);
        if (task.leaseHash === leaseHash && task.status === body.status && task.resultSealed === envelope) return { task: taskView(task) };
      }
      if (task.status !== "running" || task.leaseHash !== leaseHash || !task.leaseExpiresAt || task.leaseExpiresAt <= now || task.expiresAt <= now) return { error: "Lease is not active" };
      const data = operation === "heartbeat" ? { leaseExpiresAt: new Date(now.getTime() + 90_000) }
        : { status: body.status as string, resultSealed: body.sealed as string, leaseExpiresAt: null };
      const updated = await tx.dispatchTask.updateMany({ where: { id, status: "running", leaseHash, leaseExpiresAt: { gt: now }, expiresAt: { gt: now } }, data });
      if (updated.count !== 1) return { error: "Lease conflict" };
      return { task: taskView((await tx.dispatchTask.findUnique({ where: { id } }))!) };
    }, { isolationLevel: "Serializable" }), { retryable: conflict });
    return response(result, "error" in result ? 409 : 200);
  } catch (e) {
    if (e instanceof DispatchError) return response({ error: e.message }, e.status);
    // Still conflicting after the retry budget: safe for the client to retry with the
    // same task/result ID, so say so, whichever shape Prisma used for the abort.
    if (conflict(e)) {
      const res = response({ error: "Concurrent operation; retry request", retryable: true }, 503);
      res.headers.set("Retry-After", "1"); return res;
    }
    // Never log bodies, envelope content, or bearer/lease tokens.
    return response({ error: "Dispatch unavailable" }, 503);
  }
}
