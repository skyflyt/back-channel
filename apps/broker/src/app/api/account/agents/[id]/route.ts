import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * DELETE /api/account/agents/:id — revoke one agent's key (cookie + CSRF).
 * Sets revokedAt; the key 401s immediately (auth requires revokedAt IS NULL).
 * Other agents on the account are unaffected. Idempotent.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return NextResponse.json({ error: "csrf" }, { status: 403 });

  const { id } = await params;
  const agent = await prisma.agentToken.findUnique({ where: { id } });
  if (!agent || agent.accountId !== account.id) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const revokedAt = agent.revokedAt ?? new Date();
  if (!agent.revokedAt) {
    await prisma.agentToken.update({ where: { id }, data: { revokedAt } });
    await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "agent_token.revoked", detail: { agent_token_id: id, name: agent.name } } }).catch(() => {});
  }
  return NextResponse.json({ ok: true, revoked_at: revokedAt.toISOString() });
}
