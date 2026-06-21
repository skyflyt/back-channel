import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromAuth, getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid } from "@/lib/auth";

export const runtime = "nodejs";

/** DELETE /api/favors/mute/:handle — un-mute favors from a peer. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ handle: string }> }) {
  const bearer = await getAccountFromAuth(req.headers.get("authorization"));
  const me = bearer ?? (await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value));
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!bearer && !csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return NextResponse.json({ error: "csrf" }, { status: 403 });

  const { handle } = await params;
  const peer = await prisma.account.findUnique({ where: { handle } });
  if (peer) await prisma.favorMute.deleteMany({ where: { accountId: me.id, mutedAccountId: peer.id } });
  return NextResponse.json({ ok: true });
}
