import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid } from "@/lib/auth";
import { snapCheckMinutes } from "@/lib/inbox-schedule";

export const runtime = "nodejs";

/**
 * PATCH /api/account/settings — dashboard settings writes (cookie auth).
 * Currently: notify_idle_frames (the idle-recipient email toggle). Returns the
 * updated values.
 */
export async function PATCH(req: NextRequest) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return NextResponse.json({ error: "csrf" }, { status: 403 });

  let body: { notify_idle_frames?: boolean; favor_per_peer_daily?: number; favor_global_tokens_daily?: number; live_mode_default_minutes?: number; inbox_check_enabled?: boolean; inbox_check_minutes?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }

  const data: { notifyIdleFrames?: boolean; favorPerPeerDaily?: number; favorGlobalTokensDaily?: number; liveModeDefaultMinutes?: number; inboxCheckEnabled?: boolean; inboxCheckMinutes?: number } = {};
  // A finite number, floored and clamped to what the rest of the system honors; anything else is ignored.
  // (Settings → Agents & Inbox offers exactly these ranges; route-tests/account-settings pins them.)
  const clamp = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(Math.floor(v), lo), hi) : undefined);
  if (typeof body.notify_idle_frames === "boolean") data.notifyIdleFrames = body.notify_idle_frames;
  const perPeer = clamp(body.favor_per_peer_daily, 0, 1000); if (perPeer !== undefined) data.favorPerPeerDaily = perPeer;
  const tokens = clamp(body.favor_global_tokens_daily, 0, 100_000_000); if (tokens !== undefined) data.favorGlobalTokensDaily = tokens;
  const live = clamp(body.live_mode_default_minutes, 1, 120); if (live !== undefined) data.liveModeDefaultMinutes = live;
  if (typeof body.inbox_check_enabled === "boolean") data.inboxCheckEnabled = body.inbox_check_enabled;
  // Snapped to an interval that divides the day evenly, which is what agents can schedule (lib/inbox-schedule).
  const every = clamp(body.inbox_check_minutes, 5, 1440); if (every !== undefined) data.inboxCheckMinutes = snapCheckMinutes(every);
  if (Object.keys(data).length === 0) return NextResponse.json({ error: "no_valid_fields" }, { status: 400 });

  const updated = await prisma.account.update({ where: { id: account.id }, data });
  return NextResponse.json({
    notify_idle_frames: updated.notifyIdleFrames,
    favor_per_peer_daily: updated.favorPerPeerDaily,
    favor_global_tokens_daily: updated.favorGlobalTokensDaily,
    live_mode_default_minutes: updated.liveModeDefaultMinutes,
    inbox_check_enabled: updated.inboxCheckEnabled,
    inbox_check_minutes: updated.inboxCheckMinutes,
  });
}
