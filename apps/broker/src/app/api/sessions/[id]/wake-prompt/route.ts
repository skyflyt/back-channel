import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, SESSION_COOKIE_NAME } from "@/lib/auth";
import { wakePrompt } from "@/lib/notify.mjs";

export const runtime = "nodejs";

/**
 * GET /api/sessions/:id/wake-prompt — cookie-authed (dashboard). Returns the
 * canonical, session-specific "wake my agent" prompt the user can paste into
 * their assistant to resume THIS session. Uses the SAME wakePrompt() the
 * idle-recipient email uses, so the two never drift. Participants only; only
 * meaningful while the session is live.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const session = await prisma.session.findUnique({ where: { id }, include: { invite: { include: { host: true, visitor: true } } } });
  if (!session) return NextResponse.json({ error: "session_not_found" }, { status: 404 });

  const isHost = session.invite.hostAccountId === account.id;
  const isVisitor = session.invite.visitorAccountId === account.id;
  if (!isHost && !isVisitor) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (session.endedAt) return NextResponse.json({ error: "session_ended", detail: "This session is over — nothing to resume." }, { status: 410 });

  const peerHandle = isHost ? session.invite.visitor.handle : session.invite.host.handle;
  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "dashboard.wake_prompt_revealed", detail: { sessionId: id } } }).catch(() => {});

  return NextResponse.json({ session_id: id, peer_handle: peerHandle, prompt: wakePrompt(id, peerHandle) });
}
