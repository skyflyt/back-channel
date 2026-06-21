import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, SESSION_COOKIE_NAME } from "@/lib/auth";
import { sessionUnread } from "@/lib/relay";

export const runtime = "nodejs";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * GET /api/account/sessions — dashboard Sessions section (cookie auth).
 * Returns { active: [...], recent: [...] } — active = my live sessions,
 * recent = sessions I was in that ended in the last 30 days. Metadata only:
 * peer handle, my role, the host-chosen goal (invite.message — plaintext, never
 * encrypted content), timestamps, end reason. No frame contents.
 */
export async function GET(req: NextRequest) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const mine = { invite: { OR: [{ hostAccountId: account.id }, { visitorAccountId: account.id }] } };
  const sessions = await prisma.session.findMany({
    where: {
      OR: [
        { endedAt: null, ...mine },
        { endedAt: { gte: new Date(Date.now() - THIRTY_DAYS_MS) }, ...mine },
      ],
    },
    include: { invite: { include: { host: true, visitor: true } } },
    orderBy: { startedAt: "desc" },
    take: 200,
  });

  const shape = (s: typeof sessions[number]) => {
    const iAmHost = s.invite.hostAccountId === account.id;
    const role = iAmHost ? "host" : "visitor";
    const peer = iAmHost ? s.invite.visitor : s.invite.host;
    const durationMin = s.endedAt ? Math.round((s.endedAt.getTime() - s.startedAt.getTime()) / 60000) : null;
    return {
      session_id: s.id,
      role,
      peer_handle: peer.handle,
      goal: s.invite.message ?? null,        // host-chosen plaintext label, not message content
      started_at: s.startedAt.toISOString(),
      ended_at: s.endedAt?.toISOString() ?? null,
      end_reason: s.endReason ?? null,
      duration_min: durationMin,
      expires_at: s.invite.expiresAt.toISOString(),
    };
  };

  // Active threads get an unread count + live-mode flag (the dashboard "Inbox"
  // shows an unread badge per peer). Recent threads don't need it.
  const now = Date.now();
  const active = await Promise.all(
    sessions.filter((s) => !s.endedAt).map(async (s) => {
      const role = s.invite.hostAccountId === account.id ? "host" : "visitor";
      let unread = 0;
      try { unread = (await sessionUnread(s.id, role, s, { includeFrames: false })).unread_count ?? 0; } catch { /* best effort */ }
      const live = !!s.liveExpiresAt && s.liveExpiresAt.getTime() > now;
      return { ...shape(s), unread_count: unread, live, live_until: live ? s.liveExpiresAt!.toISOString() : null };
    }),
  );
  const recent = sessions.filter((s) => s.endedAt).map(shape);
  return NextResponse.json({ active, recent });
}
