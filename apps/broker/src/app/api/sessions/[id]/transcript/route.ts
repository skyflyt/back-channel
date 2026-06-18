import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromAuth } from "@/lib/auth";
import { getTranscript, getPeers } from "@/lib/relay";

export const runtime = "nodejs";

/**
 * GET /api/sessions/:id/transcript — chronological frame log for the human
 * transcript view. Participants only. Payloads are end-to-end encrypted, so
 * each entry carries role/time/size and a `preview` that is null for opaque
 * frames (the broker can't read encrypted content). In-memory only.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const account = await getAccountFromAuth(req.headers.get("authorization"));
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const session = await prisma.session.findUnique({ where: { id }, include: { invite: { include: { host: true, visitor: true } } } });
  if (!session) return NextResponse.json({ error: "session_not_found" }, { status: 404 });

  const isParticipant =
    session.invite.hostAccountId === account.id || session.invite.visitorAccountId === account.id;
  if (!isParticipant) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  return NextResponse.json({
    session_id: id,
    ended: !!session.endedAt,
    end_reason: session.endReason,
    host_handle: session.invite.host.handle,
    visitor_handle: session.invite.visitor.handle,
    peers: getPeers(id),
    frames: getTranscript(id),
  });
}
