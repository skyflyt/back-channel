import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * POST /api/artifacts/:id/public-share/revoke — instant kill of a public link
 * (spec §3.8). Sets the revocation latch; /a/<token> then returns the uniform 404.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return NextResponse.json({ error: "csrf" }, { status: 403 });

  const { id } = await params;
  const art = await prisma.userSkill.findUnique({ where: { id } });
  if (!art || art.accountId !== account.id) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await prisma.userSkill.update({ where: { id }, data: { publicRevokedAt: new Date() } });
  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "artifact.public_revoked", detail: { artifact: id } } }).catch(() => {});
  return NextResponse.json({ ok: true });
}
