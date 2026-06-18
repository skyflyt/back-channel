import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromAuth } from "@/lib/auth";
import { getPeers } from "@/lib/relay";

export const runtime = "nodejs";

/**
 * GET /api/sessions/:id/peers — cheap presence check so either side can see if
 * the other is online before sending. Participants only.
 * Returns { visitor: { connected, last_seen_at }, host: { connected, last_seen_at } }.
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

  const isParticipant =
    session.invite.hostAccountId === account.id || session.invite.visitorAccountId === account.id;
  if (!isParticipant) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  return NextResponse.json({
    session_id: id,
    ended: !!session.endedAt,
    ...getPeers(id),
  });
}
