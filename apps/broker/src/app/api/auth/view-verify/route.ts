import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * GET /api/auth/view-verify?token=vt_...
 *
 * NON-consuming, scanner-safe redirect. Email-security scanners pre-fetch every
 * link, so this GET must NOT consume the single-use token (that was the old
 * bug — a scanner would burn it before the human clicked). It simply forwards
 * to /account?vt=<token>, where the browser POSTs /api/auth/view-token-consume
 * to actually consume it and set the cookie. Kept for backward-compatible email
 * links; new emails point straight at /account?vt=.
 */
export async function GET(req: NextRequest) {
  const origin = process.env.PUBLIC_APP_URL ?? req.nextUrl.origin;
  const token = req.nextUrl.searchParams.get("token");
  if (!token) return NextResponse.redirect(`${origin}/login?error=expired`, { status: 303 });
  return NextResponse.redirect(`${origin}/account?vt=${encodeURIComponent(token)}`, { status: 303 });
}
