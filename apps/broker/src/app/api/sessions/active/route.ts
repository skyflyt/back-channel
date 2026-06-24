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

  // The agent's bc-inbox-check reads its own marching orders here each cycle:
  // if disabled, it self-removes; if minutes changed, it reschedules. This is
  // what makes the dashboard "turn it off / change cadence" controls real.
  const inboxCheck = { enabled: account.inboxCheckEnabled, minutes: account.inboxCheckMinutes };

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

  const now = Date.now();
  const sessions = await Promise.all(
    rows.map(async (s) => {
      const role = s.invite.visitorAccountId === account.id ? "visitor" : "host";
      const peer = role === "visitor" ? s.invite.host : s.invite.visitor;
      const u = await sessionUnread(s.id, role, s, { includeFrames });
      // Live (real-time, opt-in) until liveExpiresAt; otherwise async inbox cadence.
      const live = !!s.liveExpiresAt && s.liveExpiresAt.getTime() > now;
      // S5 back-wrap fix: participants who enrolled browser access but whose session
      // key K hasn't been wrapped to their CURRENT mirror yet. A polling agent that
      // holds K seals K to each mirror_pub and POSTs /user-wrap{for_account_id}, so a
      // user who enrolled after the thread started can read within a poll cycle —
      // not only after the next send. Derived live from current mirror + wrap state.
      const uw = (s.userWrap && typeof s.userWrap === "object" && !Array.isArray(s.userWrap))
        ? (s.userWrap as Record<string, { v?: number }>) : {};
      const mirrorWrapsNeeded = [s.invite.host, s.invite.visitor]
        .filter((p) => p && p.mirrorPub && uw[p.id]?.v !== (p.mirrorPubVersion ?? 0))
        .map((p) => ({ account_id: p.id, mirror_pub: p.mirrorPub, version: p.mirrorPubVersion ?? 0 }));
      return {
        id: s.id,
        role,
        peer_handle: peer.handle,
        expires_at: s.invite.expiresAt.toISOString(),
        last_frame_at: u.last_frame_at,
        unread_count: u.unread_count,
        next_cursor: u.next_cursor,
        peer_present: u.peer_present,
        live,
        live_until: live ? s.liveExpiresAt!.toISOString() : null,
        // Gap A: the visitor's unsealed invite note. Surfaced to the HOST while no
        // sealed frame has landed yet (visitor created the invite then exited
        // without a handshake) so bc-inbox-check can still tell the user "X invited
        // you: <note>" instead of silently seeing an empty session.
        pending_invite_message: role === "host" && !u.last_frame_at && s.invite.message ? s.invite.message : null,
        mirror_wraps_needed: mirrorWrapsNeeded,
        ...(includeFrames ? { frames: u.frames, truncated: u.truncated } : {}),
      };
    }),
  );

  // Cheap self-inbox signal so the Tier-1 curl knows whether to spend a turn on
  // queued agent.payload items (inbox-model pivot §5) — non-consuming count only.
  const agentPayloadsPending = await prisma.agentPayload.count({ where: { accountId: account.id, deliveredAt: null } });

  return NextResponse.json({ sessions, agent_payloads_pending: agentPayloadsPending, inbox_check: inboxCheck });
}
