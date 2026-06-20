import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  generateSessionCookieToken,
  sessionCookieExpiry,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_MAX_AGE_SEC,
} from "@/lib/auth";

export const runtime = "nodejs";

/**
 * GET /api/auth/view-verify?token=vt_...
 * Consumes a single-use view-token, mints a browser SessionCookie, sets the
 * httpOnly `bc_session` cookie, and redirects to /account. Invalid/expired/used
 * tokens redirect to /login?error=expired. A deep-link purpose ("session:<id>")
 * carries through to /account?session=<id>.
 */
export async function GET(req: NextRequest) {
  // Behind Cloud Run, req.nextUrl.origin is the internal bind address
  // (https://0.0.0.0:8080) — unusable for a browser redirect. Prefer the public
  // app URL; fall back to the request origin only for local dev.
  const origin = process.env.PUBLIC_APP_URL ?? req.nextUrl.origin;
  const token = req.nextUrl.searchParams.get("token");
  const fail = () => NextResponse.redirect(`${origin}/login?error=expired`, { status: 303 });

  if (!token) return fail();

  const vt = await prisma.viewToken.findUnique({ where: { token } });
  if (!vt || vt.usedAt || vt.expiresAt.getTime() < Date.now()) return fail();

  // Single-use: mark consumed first (best-effort; the unique token makes a
  // double-spend race benign — both would resolve to the same account).
  await prisma.viewToken.update({ where: { token }, data: { usedAt: new Date() } });

  const cookieToken = generateSessionCookieToken();
  await prisma.sessionCookie.create({
    data: { token: cookieToken, accountId: vt.accountId, expiresAt: sessionCookieExpiry() },
  });
  await prisma.accountAudit.create({ data: { accountId: vt.accountId, eventType: "view-token.consumed", detail: {} } });

  const dest = vt.purpose?.startsWith("session:")
    ? `${origin}/account?session=${encodeURIComponent(vt.purpose.slice("session:".length))}`
    : `${origin}/account`;

  const res = NextResponse.redirect(dest, { status: 303 });
  res.cookies.set(SESSION_COOKIE_NAME, cookieToken, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE_SEC,
  });
  return res;
}
