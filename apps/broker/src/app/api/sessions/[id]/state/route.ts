import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromAuth } from "@/lib/auth";
import { sessionState } from "@/lib/relay";

export const runtime = "nodejs";

/**
 * GET /api/sessions/:id/state — the caller's server-tracked cursor state, so a
 * client never has to guess which cursor to poll from. Participants only.
 * Returns { role, cursor, latest_seq, unread_count, peers, ended }.
 *   - cursor:     the seq you've acked; pass this as `cursor` to /api/poll
 *   - latest_seq: highest frame addressed to you
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const account = await getAccountFromAuth(req.headers.get("authorization"));
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const session = await prisma.session.findUnique({ where: { id }, include: { invite: true } });
  if (!session) return NextResponse.json({ error: "session_not_found" }, { status: 404 });

  const role =
    session.invite.visitorAccountId === account.id ? "visitor" :
    session.invite.hostAccountId === account.id ? "host" : null;
  if (!role) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const state = await sessionState(id, role, session);
  return NextResponse.json({ session_id: id, ended: !!session.endedAt, ...state });
}
