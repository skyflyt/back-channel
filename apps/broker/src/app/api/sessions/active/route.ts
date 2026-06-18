import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromAuth } from "@/lib/auth";
import { sessionUnread } from "@/lib/relay";

export const runtime = "nodejs";

/**
 * GET /api/sessions/active — every non-ended, non-expired session this account
 * participates in, with unread state. Built for a recurring "keep my sessions
 * warm" job: it tells the agent which sessions need attention and (by default)
 * returns the unread frames inline so no second round trip is needed.
 *
 * Query: ?frames=0 to omit inline frame bodies (metadata only).
 *
 * Per session: { id, role, peer_handle, expires_at, last_frame_at,
 *                unread_count, next_cursor, peer_present, frames?, truncated? }
 *
 * This is READ-ONLY: it does not register presence or advance any cursor. To
 * mark frames seen (and reset the inactivity grace timer), the job calls
 * POST /api/poll with the returned next_cursor.
 */
export async function GET(req: NextRequest) {
  const account = await getAccountFromAuth(req.headers.get("authorization"));
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const includeFrames = new URL(req.url).searchParams.get("frames") !== "0";

  const rows = await prisma.session.findMany({
    where: {
      endedAt: null,
      invite: {
        expiresAt: { gt: new Date() },
        OR: [{ hostAccountId: account.id }, { visitorAccountId: account.id }],
      },
    },
    include: { invite: { include: { host: true, visitor: true } } },
    orderBy: { startedAt: "desc" },
  });

  const sessions = await Promise.all(
    rows.map(async (s) => {
      const role = s.invite.visitorAccountId === account.id ? "visitor" : "host";
      const peer = role === "visitor" ? s.invite.host : s.invite.visitor;
      const u = await sessionUnread(s.id, role, s, { includeFrames });
      return {
        id: s.id,
        role,
        peer_handle: peer.handle,
        expires_at: s.invite.expiresAt.toISOString(),
        last_frame_at: u.last_frame_at,
        unread_count: u.unread_count,
        next_cursor: u.next_cursor,
        peer_present: u.peer_present,
        ...(includeFrames ? { frames: u.frames, truncated: u.truncated } : {}),
      };
    }),
  );

  return NextResponse.json({ sessions });
}
