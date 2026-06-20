import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountDual, SESSION_COOKIE_NAME } from "@/lib/auth";
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
  // Dual-auth: agent bearer OR the human dashboard bc_session cookie, so
  // "Watch" / "Open the session" from the dashboard works without a key paste.
  const account = await getAccountDual(req.headers.get("authorization"), req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const session = await prisma.session.findUnique({ where: { id }, include: { invite: { include: { host: true, visitor: true } } } });
  if (!session) return NextResponse.json({ error: "session_not_found" }, { status: 404 });

  const isHost = session.invite.hostAccountId === account.id;
  const isVisitor = session.invite.visitorAccountId === account.id;
  if (!isHost && !isVisitor) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const yourRole = isHost ? "host" : "visitor";
  const peerHandle = isHost ? session.invite.visitor.handle : session.invite.host.handle;

  return NextResponse.json({
    session_id: id,
    ended: !!session.endedAt,
    end_reason: session.endReason,
    host_handle: session.invite.host.handle,
    visitor_handle: session.invite.visitor.handle,
    your_role: yourRole,    // so the page can build a session-specific wake-up prompt
    peer_handle: peerHandle,
    peers: getPeers(id),
    frames: getTranscript(id),
  });
}
