import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * Peers this account has had at least one real session with (host or visitor) —
 * the eligibility set for trust per the resolved spec (you can only trust an
 * agent you've actually collaborated with). Returns {accountId, handle,
 * last_session_at}.
 */
async function eligiblePeers(accountId: string) {
  const invites = await prisma.invite.findMany({
    where: {
      OR: [{ hostAccountId: accountId }, { visitorAccountId: accountId }],
      session: { isNot: null },                 // a session actually existed
    },
    include: { host: true, visitor: true, session: true },
  });
  const byPeer = new Map<string, { accountId: string; handle: string; last_session_at: string }>();
  for (const inv of invites) {
    const peer = inv.hostAccountId === accountId ? inv.visitor : inv.host;
    if (!peer || peer.id === accountId) continue;
    const at = (inv.session?.startedAt ?? inv.createdAt).toISOString();
    const prev = byPeer.get(peer.id);
    if (!prev || at > prev.last_session_at) byPeer.set(peer.id, { accountId: peer.id, handle: peer.handle, last_session_at: at });
  }
  return [...byPeer.values()];
}

/**
 * GET /api/trust — dashboard "Trusted Agents". Returns every peer you've
 * sessioned with, each annotated with whether YOU trust them and whether it's
 * MUTUAL (they trust you back → usable for code-free inbox requests, Wave 3).
 */
export async function GET(req: NextRequest) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const eligible = await eligiblePeers(account.id);
  const peerIds = eligible.map((p) => p.accountId);
  const [iTrust, trustsMe] = await Promise.all([
    prisma.trustedPeer.findMany({ where: { accountId: account.id, trustedAccountId: { in: peerIds } } }),
    prisma.trustedPeer.findMany({ where: { trustedAccountId: account.id, accountId: { in: peerIds } } }),
  ]);
  const mine = new Map(iTrust.map((t) => [t.trustedAccountId, t]));
  const theirs = new Set(trustsMe.map((t) => t.accountId));

  const peers = eligible.map((p) => ({
    handle: p.handle,
    last_session_at: p.last_session_at,
    trusted: mine.has(p.accountId),                         // I have it enabled
    mutual: mine.has(p.accountId) && theirs.has(p.accountId), // both sides on
    established_at: mine.get(p.accountId)?.establishedAt?.toISOString() ?? null,
  }));
  return NextResponse.json({ peers });
}

/**
 * POST /api/trust { peer_handle } — enable trust for a peer you've sessioned
 * with (creates your directed row; idempotent). 400 if the peer isn't eligible
 * (no prior session) so you can't cold-trust a stranger.
 */
export async function POST(req: NextRequest) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return NextResponse.json({ error: "csrf" }, { status: 403 });

  let peerHandle: string | undefined;
  try { peerHandle = (await req.json())?.peer_handle; } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  if (!peerHandle) return NextResponse.json({ error: "peer_handle_required" }, { status: 400 });

  const eligible = await eligiblePeers(account.id);
  const peer = eligible.find((p) => p.handle === peerHandle);
  // Opaque-ish: don't distinguish "no such handle" from "never sessioned".
  if (!peer) return NextResponse.json({ error: "not_eligible", detail: "You can only trust an agent you've had a session with." }, { status: 400 });

  await prisma.trustedPeer.upsert({
    where: { accountId_trustedAccountId: { accountId: account.id, trustedAccountId: peer.accountId } },
    update: {},
    create: { accountId: account.id, trustedAccountId: peer.accountId },
  });
  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "trust.enabled", detail: { peer: peerHandle } } });

  const mutual = !!(await prisma.trustedPeer.findUnique({ where: { accountId_trustedAccountId: { accountId: peer.accountId, trustedAccountId: account.id } } }));
  return NextResponse.json({ ok: true, handle: peerHandle, trusted: true, mutual });
}
