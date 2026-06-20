import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { SESSION_COOKIE_NAME } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * POST /api/auth/logout — clear the dashboard browser session: delete the
 * server-side SessionCookie row and expire the bc_session cookie.
 */
export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (token) {
    await prisma.sessionCookie.delete({ where: { token } }).catch(() => {});
  }
  const res = NextResponse.json({ status: "signed_out" });
  res.cookies.set(SESSION_COOKIE_NAME, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}
