import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromAuth } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

const DAY = 24 * 60 * 60 * 1000;

// Opaque error — never reveal whether the handle exists or whether trust is
// mutual. A non-trusted target looks identical to an unknown one.
const opaqueForbidden = () => NextResponse.json({ error: "not_available" }, { status: 403 });

/**
 * POST /api/inbox/request { peer_handle, scopes, message? } — bearer (the
 * requester's agent). Drops a session request in a MUTUALLY-trusted peer's
 * inbox; the recipient approves/declines from their dashboard. Trust waives the
 * invite code, not the scope approval. Scopes are capped at what the recipient
 * allows this requester (their TrustedPeer.scopeDefaults, when set).
 */
export async function POST(req: NextRequest) {
  const account = await getAccountFromAuth(req.headers.get("authorization"));
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { peer_handle?: string; scopes?: string[]; message?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  if (!body.peer_handle || !Array.isArray(body.scopes) || body.scopes.length === 0) {
    return NextResponse.json({ error: "peer_handle_and_scopes_required" }, { status: 400 });
  }

  const recipient = await prisma.account.findUnique({ where: { handle: body.peer_handle } });
  if (!recipient || recipient.id === account.id) return opaqueForbidden();

  // Mutual trust required: both directed rows must exist.
  const [iTrustThem, theyTrustMe] = await Promise.all([
    prisma.trustedPeer.findUnique({ where: { accountId_trustedAccountId: { accountId: account.id, trustedAccountId: recipient.id } } }),
    prisma.trustedPeer.findUnique({ where: { accountId_trustedAccountId: { accountId: recipient.id, trustedAccountId: account.id } } }),
  ]);
  if (!iTrustThem || !theyTrustMe) return opaqueForbidden();

  // Scope ceiling: the recipient's row toward this requester sets what they may
  // request (when scopeDefaults is non-empty). Hard-blocked scopes never allowed.
  const HARD_BLOCKED = new Set(["memory.read", "email.read", "contacts.read", "messages.read", "calendar.read", "files.read"]);
  if (body.scopes.some((s) => HARD_BLOCKED.has(s))) return NextResponse.json({ error: "scope_hard_blocked" }, { status: 400 });
  const ceiling = theyTrustMe.scopeDefaults ?? [];
  if (ceiling.length > 0 && body.scopes.some((s) => !ceiling.includes(s))) {
    return NextResponse.json({ error: "scope_exceeds_ceiling", detail: "Requested scopes exceed what this peer allows. A fresh coded invite is needed to widen." }, { status: 400 });
  }

  // Rate limit per requester→recipient pair (anti-spam on a soured pair).
  const rl = rateLimit("inbox:req", `${account.id}:${recipient.id}`, 5, DAY);
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });

  const reqRow = await prisma.inboxRequest.create({
    data: {
      recipientAccountId: recipient.id,
      requesterAccountId: account.id,
      requestedScopes: body.scopes,
      message: body.message ?? null,
      expiresAt: new Date(Date.now() + DAY),
    },
  });
  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "inbox.requested", detail: { to: recipient.handle, scopes: body.scopes } } });
  return NextResponse.json({ ok: true, request_id: reqRow.id, status: "pending", expires_at: reqRow.expiresAt.toISOString() });
}
