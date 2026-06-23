import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid, hashToken } from "@/lib/auth";
import { sendFriendAcceptedEmail } from "@/lib/email";

export const runtime = "nodejs";

/**
 * POST /api/friends/accept { token } — the INVITEE (signed in via cookie+CSRF)
 * accepts a friend invite. Creates MUTUAL trust (both TrustedPeer rows) between
 * inviter and invitee — the invite IS the trust grant — then notifies the inviter.
 */
export async function POST(req: NextRequest) {
  const me = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return NextResponse.json({ error: "csrf" }, { status: 403 });

  let token: string | undefined;
  try { token = (await req.json())?.token; } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  if (!token) return NextResponse.json({ error: "token_required" }, { status: 400 });

  const inv = await prisma.friendInvite.findUnique({ where: { tokenHash: hashToken(token) }, include: { inviter: true } });
  // Opaque 410 for every "you can't use this token" reason — unknown, expired,
  // already consumed, OR addressed to a different email. A leaked invite link
  // (forwarded/screenshotted) must NOT let just any logged-in account claim the
  // trust grant: the caller's verified account email must match the invitee the
  // inviter addressed. Same body for all so a caller can't probe which check failed.
  const gone = () => NextResponse.json({ error: "invalid_or_expired" }, { status: 410 });
  if (!inv || inv.expiresAt < new Date()) return gone();
  if (inv.status !== "pending") return gone();                       // single-use: already accepted/consumed
  const emailMatch = !!me.email && me.email.trim().toLowerCase() === inv.inviteeEmail.trim().toLowerCase();
  if (!emailMatch) return gone();                                    // token addressed to someone else — leaked link
  if (inv.inviterAccountId === me.id) return NextResponse.json({ error: "cannot_befriend_self" }, { status: 400 });

  // Mutual trust: upsert both directed TrustedPeer rows (idempotent).
  await prisma.$transaction([
    prisma.trustedPeer.upsert({ where: { accountId_trustedAccountId: { accountId: inv.inviterAccountId, trustedAccountId: me.id } }, update: {}, create: { accountId: inv.inviterAccountId, trustedAccountId: me.id } }),
    prisma.trustedPeer.upsert({ where: { accountId_trustedAccountId: { accountId: me.id, trustedAccountId: inv.inviterAccountId } }, update: {}, create: { accountId: me.id, trustedAccountId: inv.inviterAccountId } }),
    prisma.friendInvite.update({ where: { id: inv.id }, data: { status: "accepted", acceptedAt: new Date() } }),
  ]);
  await prisma.accountAudit.createMany({ data: [
    { accountId: me.id, eventType: "friend.accepted", detail: { peer: inv.inviter.handle } },
    { accountId: inv.inviterAccountId, eventType: "friend.added", detail: { peer: me.handle } },
  ] }).catch(() => {});

  // Notify the inviter they're now friends (best-effort).
  if (inv.inviter.email && inv.inviter.emailVerifiedAt) {
    void sendFriendAcceptedEmail({ to: inv.inviter.email, inviterHandle: inv.inviter.handle, friendHandle: me.handle, dashboardUrl: `${process.env.PUBLIC_APP_URL ?? "https://back-channel.app"}/account` });
  }
  return NextResponse.json({ ok: true, friend_handle: inv.inviter.handle });
}
