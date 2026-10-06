import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, SESSION_COOKIE_NAME } from "@/lib/auth";
import { isOwnerAccount } from "@/lib/admin";

export const runtime = "nodejs";

/**
 * GET /api/account/me — dashboard identity + lightweight summary. Authenticated
 * by the bc_session cookie (human tier), NOT the bearer key. 401 if no live
 * session cookie. The full API key is never returned — only a masked form.
 */
export async function GET(req: NextRequest) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Lightweight summary: count my live sessions (host or visitor, not ended).
  const liveSessions = await prisma.session.count({
    where: {
      endedAt: null,
      invite: { OR: [{ hostAccountId: account.id }, { visitorAccountId: account.id }] },
    },
  });

  return NextResponse.json({
    id: account.id,                         // needed client-side for the key-mirror AAD (must match the agent's)
    handle: account.handle,
    email: account.email,
    display_name: account.displayName,
    key_mirror_enrolled: !!account.mirrorPub,
    mirror_pub_version: account.mirrorPubVersion ?? 0,
    created_at: account.createdAt.toISOString(),
    email_verified: !!account.emailVerifiedAt,
    // SEC H1: Account.apiKey is never read (null in prod; dropping the column is a follow-up). Keys
    // exist only as AgentToken hashes, so there is nothing to mask; the member stays for the UI.
    api_key_masked: null,
    api_key_last_used_at: account.apiKeyLastUsedAt?.toISOString() ?? null,
    notify_idle_frames: account.notifyIdleFrames,
    favor_per_peer_daily: account.favorPerPeerDaily,
    favor_global_tokens_daily: account.favorGlobalTokensDaily,
    live_mode_default_minutes: account.liveModeDefaultMinutes,
    inbox_check_enabled: account.inboxCheckEnabled,
    inbox_check_minutes: account.inboxCheckMinutes,
    summary: { active_sessions: liveSessions },
    // Present only for the owner (src/lib/admin.ts), so the dashboard can show its Admin tab.
    // Omitted, not false, for everyone else: /admin answers them 404 so as not to confirm that an
    // admin area exists, and a false here would say the same thing in another place. It grants
    // nothing: /admin and every admin API check the owner again on the server.
    ...(isOwnerAccount(account) ? { admin: true } : {}),
  });
}
