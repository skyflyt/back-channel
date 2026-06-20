import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  hashToken,
  generateSessionCookieToken,
  sessionCookieExpiry,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_MAX_AGE_SEC,
  CSRF_COOKIE_NAME,
  generateCsrfToken,
} from "@/lib/auth";

export const runtime = "nodejs";

/**
 * POST { token } — the REAL consumer for a dashboard view-token (the scanner-
 * safe half of the pair, mirroring /api/auth/verify). A human browser on
 * /account POSTs the `vt` from the URL here; email-security scanners that
 * pre-fetch the link only GET /account (or the non-consuming view-verify
 * redirect), so they never burn the single-use token.
 *
 * On success: marks the ViewToken used (atomic single-use claim), mints a
 * SessionCookie (stored hashed), and sets the httpOnly bc_session cookie.
 */
export async function POST(req: NextRequest) {
  let token: string | undefined;
  try { token = (await req.json())?.token; } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  if (!token) return NextResponse.json({ error: "token_required" }, { status: 400 });

  const h = hashToken(token);
  const vt = await prisma.viewToken.findUnique({ where: { token: h } });
  if (!vt) return NextResponse.json({ error: "invalid_token" }, { status: 404 });
  if (vt.expiresAt.getTime() < Date.now()) return NextResponse.json({ error: "token_expired" }, { status: 410 });

  // Atomic single-use claim — first POST to flip usedAt wins.
  const claim = await prisma.viewToken.updateMany({ where: { token: h, usedAt: null }, data: { usedAt: new Date() } });
  if (claim.count === 0) return NextResponse.json({ error: "token_already_used" }, { status: 410 });

  const account = await prisma.account.findUnique({ where: { id: vt.accountId } });
  if (!account) return NextResponse.json({ error: "account_not_found" }, { status: 404 });

  const rawCookie = generateSessionCookieToken();
  await prisma.sessionCookie.create({ data: { token: hashToken(rawCookie), accountId: vt.accountId, expiresAt: sessionCookieExpiry() } });
  await prisma.accountAudit.create({ data: { accountId: vt.accountId, eventType: "view-token.consumed", detail: {} } });

  const session = vt.purpose?.startsWith("session:") ? vt.purpose.slice("session:".length) : null;
  const res = NextResponse.json({ ok: true, handle: account.handle, session });
  res.cookies.set(SESSION_COOKIE_NAME, rawCookie, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_COOKIE_MAX_AGE_SEC });
  res.cookies.set(CSRF_COOKIE_NAME, generateCsrfToken(), { httpOnly: false, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_COOKIE_MAX_AGE_SEC });
  return res;
}
