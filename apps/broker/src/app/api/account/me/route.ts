import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, maskApiKey, SESSION_COOKIE_NAME } from "@/lib/auth";

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
    handle: account.handle,
    email: account.email,
    display_name: account.displayName,
    created_at: account.createdAt.toISOString(),
    email_verified: !!account.emailVerifiedAt,
    api_key_masked: maskApiKey(account.apiKey),
    api_key_last_used_at: account.apiKeyLastUsedAt?.toISOString() ?? null,
    notify_idle_frames: account.notifyIdleFrames,
    summary: { active_sessions: liveSessions },
  });
}
