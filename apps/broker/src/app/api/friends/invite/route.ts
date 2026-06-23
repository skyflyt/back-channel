import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid, hashToken } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { sendFriendInviteEmail } from "@/lib/email";
import { randomBytes } from "node:crypto";

export const runtime = "nodejs";
const APP_URL = process.env.PUBLIC_APP_URL ?? "https://back-channel.app";
const TTL = 14 * 24 * 60 * 60 * 1000;

/**
 * POST /api/friends/invite { email, note? } — cookie+CSRF. Invite someone by
 * email to become friends. Emails them a /befriend link; when they sign up and
 * accept, the broker auto-creates mutual trust (see /api/friends/accept).
 */
export async function POST(req: NextRequest) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return NextResponse.json({ error: "csrf" }, { status: 403 });

  let body: { email?: string; note?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  const email = (body.email ?? "").trim().toLowerCase();
  if (!email.includes("@")) return NextResponse.json({ error: "invalid_email" }, { status: 400 });

  const rl = rateLimit("friendinvite:account", account.id, 20, 24 * 60 * 60 * 1000);
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });

  const raw = "fi_" + randomBytes(32).toString("base64url");
  const note = (body.note ?? "").trim().slice(0, 280) || null;
  await prisma.friendInvite.create({ data: { inviterAccountId: account.id, inviteeEmail: email, tokenHash: hashToken(raw), note, expiresAt: new Date(Date.now() + TTL) } });
  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "friend.invited", detail: {} } }).catch(() => {});

  const url = `${APP_URL}/befriend?token=${encodeURIComponent(raw)}`;
  const delivered = await sendFriendInviteEmail({ to: email, inviterHandle: account.handle, note, url });
  console.log(`[friend-invite] from=${account.handle} delivered=${delivered}`);
  return NextResponse.json({ ok: true, sent: true });
}

/**
 * GET /api/friends/invite?token= — probe for the /befriend page. Returns the
 * inviter's handle (the holder of the token already received it from them) so
 * the page can say "X wants to be friends." Opaque on bad/expired token.
 */
export async function GET(req: NextRequest) {
  const token = new URL(req.url).searchParams.get("token");
  if (!token) return NextResponse.json({ error: "token_required" }, { status: 400 });
  const inv = await prisma.friendInvite.findUnique({ where: { tokenHash: hashToken(token) }, include: { inviter: true } });
  if (!inv || inv.expiresAt < new Date()) return NextResponse.json({ error: "invalid_or_expired" }, { status: 404 });
  return NextResponse.json({ inviter_handle: inv.inviter.handle, note: inv.note, status: inv.status });
}
