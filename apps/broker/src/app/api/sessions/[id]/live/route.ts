import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountDual, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid, getAccountFromAuth } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * POST /api/sessions/:id/live — opt this thread into real-time "live mode"
 * (inbox-model pivot §2). Default cadence is async inbox (cheap, ~0 LLM tokens);
 * live mode makes both agents poll fast for a bounded window, at real token cost.
 *
 * Body: { minutes?: number } — window length; defaults to the caller's account
 * setting (liveModeDefaultMinutes, default 15). Capped at 120. Pass { off: true }
 * to end live mode now. Participant-only. Bearer (agent) or cookie+CSRF (human).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const bearer = await getAccountFromAuth(req.headers.get("authorization"));
  const account = bearer ?? (await getAccountDual(null, req.cookies.get(SESSION_COOKIE_NAME)?.value));
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!bearer && !csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return NextResponse.json({ error: "csrf" }, { status: 403 });

  const { id } = await params;
  const session = await prisma.session.findUnique({ where: { id }, include: { invite: true } });
  if (!session) return NextResponse.json({ error: "session_not_found" }, { status: 404 });
  if (session.endedAt) return NextResponse.json({ error: "session_ended" }, { status: 410 });
  if (session.invite.hostAccountId !== account.id && session.invite.visitorAccountId !== account.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { minutes?: number; off?: boolean } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  if (body.off) {
    await prisma.session.update({ where: { id }, data: { liveExpiresAt: null } });
    return NextResponse.json({ live: false, live_until: null });
  }

  const fallback = account.liveModeDefaultMinutes ?? 15;
  const minutes = Math.min(Math.max(Math.floor(body.minutes ?? fallback), 1), 120);
  const liveExpiresAt = new Date(Date.now() + minutes * 60 * 1000);
  await prisma.session.update({ where: { id }, data: { liveExpiresAt } });

  return NextResponse.json({ live: true, live_until: liveExpiresAt.toISOString(), minutes });
}
