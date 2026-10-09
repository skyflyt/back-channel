import { createPublicKey } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { AgentToken, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getAuthContext } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { withSerializableRetry, isSerializationFailure } from "@/lib/serializable";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
class MailError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function fail(status: number, message: string): never { throw new MailError(status, message); }
function key(v: unknown, kind: string): string {
  if (typeof v !== "string" || v.length > 1024) fail(400, "Invalid public key");
  try { const k = createPublicKey(v); if (k.asymmetricKeyType !== kind) fail(400, "Wrong key type"); return k.export({ type: "spki", format: "pem" }).toString(); }
  catch { return fail(400, "Invalid public key"); }
}
const view = (a: AgentToken) => ({ id: a.id, name: a.name, runtime: a.runtimeType,
  ready: !!a.mailboxEncryptionKey && !!a.mailboxSigningKey,
  encryptionKey: a.mailboxEncryptionKey, signingKey: a.mailboxSigningKey });
const conflict = (e: unknown) => isSerializationFailure(e) || (!!e && typeof e === "object" && "code" in e && e.code === "P2002");

// Same-account mail is available to connector keys too. It grants no machine
// execution or account management capability. Every decision uses live rows.
export async function agentMailbox(req: NextRequest, operation: string, body: Record<string, unknown>) {
  const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
  try {
    const auth = await getAuthContext(req.headers.get("authorization"));
    if (!auth?.agentTokenId) fail(401, "Per-agent identity required");
    if (!rateLimit("agent-mailbox", auth.agentTokenId, 120, 60_000).ok) fail(429, "Rate limited");
    const result = await withSerializableRetry(() => prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const active = { accountId: auth.account.id, revokedAt: null };
      const caller = await tx.agentToken.findFirst({ where: { ...active, id: auth.agentTokenId! } });
      if (!caller) fail(401, "Agent revoked");
      if (operation === "enroll") {
        const encryptionKey = key(body.encryption_key, "x25519"), signingKey = key(body.signing_key, "ed25519");
        if (caller.mailboxEncryptionKey || caller.mailboxSigningKey) {
          if (caller.mailboxEncryptionKey !== encryptionKey || caller.mailboxSigningKey !== signingKey) fail(409, "Mailbox keys changed. Reconnect as a new agent to avoid losing existing mail.");
          return { agent: view(caller) };
        }
        return { agent: view(await tx.agentToken.update({ where: { id: caller.id }, data: { mailboxEncryptionKey: encryptionKey, mailboxSigningKey: signingKey } })) };
      }
      if (operation === "agents") {
        const pending = await tx.agentMessage.groupBy({ by: ["senderAgentId"], where: { targetAgentId: caller.id, sender: active, readAt: null, expiresAt: { gt: new Date() } }, _count: { _all: true } });
        const counts = new Map(pending.map(m => [m.senderAgentId, m._count._all]));
        return { self_agent_id: caller.id, agents: (await tx.agentToken.findMany({ where: active, orderBy: { createdAt: "asc" }, take: 100 })).map(a => ({ ...view(a), unread_count: counts.get(a.id) ?? 0 })) };
      }
      const now = new Date();
      const visible = { sender: active, target: active, expiresAt: { gt: now }, OR: [{ senderAgentId: caller.id }, { targetAgentId: caller.id }] };
      if (operation === "read") {
        if (body.agent_id !== undefined && (typeof body.agent_id !== "string" || !UUID.test(body.agent_id))) fail(400, "Invalid agent id");
        if (body.mark_read !== undefined && typeof body.mark_read !== "boolean") fail(400, "Invalid read flag");
        if (body.unread_only !== undefined && typeof body.unread_only !== "boolean") fail(400, "Invalid unread flag");
        if (body.before_id !== undefined && (typeof body.before_id !== "string" || !UUID.test(body.before_id))) fail(400, "Invalid cursor");
        const before = body.before_id ? await tx.agentMessage.findFirst({ where: { ...visible, id: String(body.before_id) } }) : null;
        if (body.before_id && !before) fail(400, "Invalid cursor");
        const filters: Prisma.AgentMessageWhereInput[] = [];
        if (body.unread_only === true) filters.push({ targetAgentId: caller.id, readAt: null });
        if (body.agent_id) filters.push({ OR: [{ senderAgentId: String(body.agent_id) }, { targetAgentId: String(body.agent_id) }] });
        if (before) filters.push({ OR: [{ createdAt: { lt: before.createdAt } }, { createdAt: before.createdAt, id: { lt: before.id } }] });
        const messages = await tx.agentMessage.findMany({ where: { ...visible, AND: filters }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 51 });
        const shown = messages.slice(0, 50);
        // Explicit receiver acknowledgement only. Looking in a panel defaults
        // to a peek; another agent cannot consume this agent's mail.
        if (body.mark_read === true) await tx.agentMessage.updateMany({ where: { id: { in: shown.map(m => m.id) }, targetAgentId: caller.id, readAt: null }, data: { readAt: now } });
        return { self_agent_id: caller.id, has_more: messages.length > 50, next_cursor: messages.length > 50 ? shown.at(-1)?.id : null, messages: shown.reverse().map(m => ({ id: m.id, sender_agent_id: m.senderAgentId, target_agent_id: m.targetAgentId, created_at: m.createdAt, expires_at: m.expiresAt,
          read_at: m.readAt ?? (body.mark_read === true && m.targetAgentId === caller.id ? now : null), sealed: m.senderAgentId === caller.id ? m.senderSealed : m.sealed })) };
      }
      if (operation === "send") {
        if (typeof body.id !== "string" || !UUID.test(body.id) || typeof body.agent_id !== "string" || !UUID.test(body.agent_id) || body.agent_id === caller.id) fail(400, "Choose another agent");
        const target = await tx.agentToken.findFirst({ where: { ...active, id: body.agent_id } });
        if (!target?.mailboxEncryptionKey || !target.mailboxSigningKey || !caller.mailboxSigningKey) fail(404, "Agent unavailable or mailbox not connected yet");
        for (const name of ["sealed", "sender_sealed"]) if (typeof body[name] !== "string" || !(body[name] as string).length || Buffer.byteLength(body[name] as string) > 131072) fail(400, "Invalid sealed message");
        const expiresAt = new Date(String(body.expires_at));
        if (!Number.isFinite(expiresAt.getTime())) fail(400, "Invalid expiry");
        const previous = await tx.agentMessage.findUnique({ where: { id: body.id } });
        if (previous) {
          if (previous.senderAgentId !== caller.id || previous.targetAgentId !== target.id || previous.sealed !== body.sealed || previous.senderSealed !== body.sender_sealed || previous.expiresAt.getTime() !== expiresAt.getTime()) fail(409, "Message id conflict");
          return { message_id: previous.id, status: previous.readAt ? "read" : "queued" };
        }
        if (expiresAt <= now || expiresAt.getTime() > now.getTime() + 30 * 86400_000) fail(400, "Expiry must be within 30 days");
        if (await tx.agentMessage.count({ where: { senderAgentId: caller.id, createdAt: { gt: new Date(now.getTime() - 86400_000) } } }) >= 1000) fail(429, "Daily message limit reached");
        if (await tx.agentMessage.count({ where: { targetAgentId: target.id, readAt: null, expiresAt: { gt: now } } }) >= 500) fail(429, "Recipient inbox full");
        await tx.agentMessage.deleteMany({ where: { senderAgentId: caller.id, expiresAt: { lte: now } } });
        await tx.agentMessage.create({ data: { id: body.id, senderAgentId: caller.id, targetAgentId: target.id, sealed: body.sealed as string, senderSealed: body.sender_sealed as string, expiresAt } });
        return { message_id: body.id, status: "queued" };
      }
      return fail(400, "Unknown mailbox operation");
    }, { isolationLevel: "Serializable" }), { retryable: conflict });
    return json(result);
  } catch (e) {
    if (e instanceof MailError) return json({ error: e.message }, e.status);
    console.error("[agent-mailbox] operation failed");
    return json({ error: "Mailbox unavailable. Try again shortly." }, 503);
  }
}
