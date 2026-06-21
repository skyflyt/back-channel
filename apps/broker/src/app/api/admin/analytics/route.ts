import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountDual, SESSION_COOKIE_NAME } from "@/lib/auth";

export const runtime = "nodejs";

const WINDOWS: Record<string, number> = { "24h": 864e5, "7d": 7 * 864e5, "30d": 30 * 864e5 };

/**
 * GET /api/admin/analytics?period=24h|7d|30d|all — operator metrics. Admin only.
 * METADATA ONLY by construction: counts/aggregates over accounts, sessions,
 * trust, inbox, skills, favors. Never message content, never per-conversation
 * detail. (Broker holds no session keys; content is unreadable here anyway.)
 */
export async function GET(req: NextRequest) {
  const account = await getAccountDual(req.headers.get("authorization"), req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!account.admin) return NextResponse.json({ error: "forbidden" }, { status: 403 }); // opaque to non-admins

  const period = new URL(req.url).searchParams.get("period") ?? "7d";
  const since = WINDOWS[period] ? new Date(Date.now() - WINDOWS[period]) : null; // null = all-time
  const inPeriod = since ? { gte: since } : undefined;

  const [
    accountsTotal, accountsVerified, signups,
    sessionsStarted, sessionsActive, endReasonGroups, endedInPeriod,
    trustRows, trustEstablished, inboxGroups,
    skillsTotal, sharesTotal, importsTotal,
    favorAgg, favorCount,
    withInvite, hadSession,
  ] = await Promise.all([
    prisma.account.count(),
    prisma.account.count({ where: { emailVerifiedAt: { not: null } } }),
    prisma.account.count({ where: since ? { createdAt: inPeriod } : {} }),
    prisma.session.count({ where: since ? { startedAt: inPeriod } : {} }),
    prisma.session.count({ where: { endedAt: null } }),
    prisma.session.groupBy({ by: ["endReason"], _count: true, where: { endedAt: since ? inPeriod : { not: null } } }),
    prisma.session.findMany({ where: { endedAt: since ? inPeriod : { not: null } }, select: { startedAt: true, endedAt: true } }),
    prisma.trustedPeer.count(),
    prisma.trustedPeer.count({ where: since ? { establishedAt: inPeriod } : {} }),
    prisma.inboxRequest.groupBy({ by: ["status"], _count: true, where: since ? { createdAt: inPeriod } : {} }),
    prisma.userSkill.count(),
    prisma.skillShare.count(),
    prisma.skillImport.count(),
    prisma.favorLog.aggregate({ _sum: { tokensUsed: true }, where: since ? { at: inPeriod } : {} }),
    prisma.favorLog.count({ where: since ? { at: inPeriod } : {} }),
    prisma.invite.findMany({ distinct: ["visitorAccountId"], select: { visitorAccountId: true } }),
    prisma.session.findMany({ distinct: ["inviteId"], select: { inviteId: true } }),
  ]);

  const durations = endedInPeriod.filter((s) => s.endedAt).map((s) => (s.endedAt!.getTime() - s.startedAt.getTime()) / 60000);
  const avgDurationMin = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;

  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "admin.analytics_viewed", detail: { period } } }).catch(() => {});

  return NextResponse.json({
    period,
    generated_at: new Date().toISOString(),
    growth: { accounts_total: accountsTotal, accounts_verified: accountsVerified, accounts_pending: accountsTotal - accountsVerified, signups_in_period: signups, trust_pairs_established_in_period: trustEstablished },
    activity: {
      sessions_started_in_period: sessionsStarted,
      sessions_active_now: sessionsActive,
      ended_by_reason: Object.fromEntries(endReasonGroups.map((g) => [g.endReason ?? "unknown", g._count])),
      avg_session_minutes: avgDurationMin,
      favors_in_period: favorCount, favor_tokens_in_period: favorAgg._sum.tokensUsed ?? 0,
    },
    trust_inbox: { trust_rows_total: trustRows, inbox_by_status: Object.fromEntries(inboxGroups.map((g) => [g.status, g._count])) },
    skills: { published_total: skillsTotal, shares_total: sharesTotal, imports_total: importsTotal },
    funnel: { signups: accountsTotal, verified: accountsVerified, created_an_invite: withInvite.length, had_a_session: hadSession.length },
    note: "Metadata only — message contents are end-to-end encrypted and not visible to admins.",
  });
}
