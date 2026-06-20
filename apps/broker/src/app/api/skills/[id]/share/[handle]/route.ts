import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromAuth, getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * DELETE /api/skills/:id/share/:handle — stop sharing a skill with a peer.
 * For RPC this blocks future invokes immediately; for templates it does NOT
 * retract already-imported copies (skill-sharing-epic §8.6). bearer or cookie+CSRF.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string; handle: string }> }) {
  const bearer = await getAccountFromAuth(req.headers.get("authorization"));
  const account = bearer ?? (await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value));
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!bearer && !csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return NextResponse.json({ error: "csrf" }, { status: 403 });

  const { id, handle } = await params;
  const skill = await prisma.userSkill.findUnique({ where: { id } });
  if (!skill || skill.accountId !== account.id) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const peer = await prisma.account.findUnique({ where: { handle } });
  if (peer) {
    await prisma.skillShare.deleteMany({ where: { skillId: id, sharedWithAccountId: peer.id } });
    await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "skill.unshared", detail: { skill: id, with: handle } } }).catch(() => {});
  }
  return NextResponse.json({ ok: true });
}
