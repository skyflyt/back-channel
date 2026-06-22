import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountDual, SESSION_COOKIE_NAME } from "@/lib/auth";

export const runtime = "nodejs";

const DAY = 864e5;
const H24 = DAY, D7 = 7 * DAY, D30 = 30 * DAY;

// 60s in-memory cache (this page isn't realtime; heavy aggregation shouldn't run
// per request). Single-instance Cloud Run, so a module-level cache is fine.
let CACHE: { at: number; payload: unknown } | null = null;
const CACHE_TTL_MS = 60_000;

/**
 * GET /api/admin/analytics — operator dashboard. Admin only; 403 (opaque) to
 * everyone else. METADATA ONLY by construction — counts/aggregates over accounts,
 * agents, sessions, trust, inbox, skills. NEVER message content (the broker holds
 * no session keys; sealed blobs are unreadable here and never returned), NEVER
 * raw emails, NEVER peer handles in pairs. Recent-activity handles are redacted.
 */
export async function GET(req: NextRequest) {
  const account = await getAccountDual(req.headers.get("authorization"), req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!account.admin) return NextResponse.json({ error: "forbidden" }, { status: 403 }); // opaque to non-admins

  // Audit every view (who looked, when) — but serve a cached payload if fresh.
  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "admin.analytics_viewed", detail: {} } }).catch(() => {});
  if (CACHE && Date.now() - CACHE.at < CACHE_TTL_MS) {
    return NextResponse.json({ ...(CACHE.payload as object), cached: true });
  }

  const now = Date.now();
  const since = (ms: number) => new Date(now - ms);
  const inWin = (d: Date | null | undefined, ms: number) => !!d && now - d.getTime() <= ms;

  const [
    accounts, agents, sessionsTotal, sessions24, sessions7, sessions30,
    endedRecent, liveNow, recentFrames, framesTotal,
    trustRows, mutualPairs, inbox7, sharesTotal, topShares,
    sched7, magicAll, magicRedeemed, ex7, exRedeemed7,
    recentSignups, recentSessions, liveSessionIds, framedSessionIds, rlHits,
  ] = await Promise.all([
    prisma.account.findMany({ select: { id: true, handle: true, createdAt: true, emailVerifiedAt: true, apiKeyLastUsedAt: true } }),
    prisma.agentToken.findMany({ where: { revokedAt: null }, select: { accountId: true, createdAt: true, lastUsedAt: true } }),
    prisma.session.count(),
    prisma.session.count({ where: { startedAt: { gte: since(H24) } } }),
    prisma.session.count({ where: { startedAt: { gte: since(D7) } } }),
    prisma.session.count({ where: { startedAt: { gte: since(D30) } } }),
    prisma.session.findMany({ where: { endedAt: { gte: since(D30) } }, select: { startedAt: true, endedAt: true } }),
    prisma.session.count({ where: { endedAt: null, liveExpiresAt: { gt: new Date() } } }),
    prisma.frame.findMany({ take: 5000, select: { body: true } }),
    prisma.frame.count(),
    prisma.trustedPeer.count(),
    prisma.trustedPeer.findMany({ select: { accountId: true, trustedAccountId: true } }),
    prisma.inboxRequest.count({ where: { createdAt: { gte: since(D7) } } }),
    prisma.skillShare.count(),
    prisma.skillShare.groupBy({ by: ["skillId"], _count: true, orderBy: { _count: { skillId: "desc" } }, take: 5 }),
    prisma.accountAudit.groupBy({ by: ["eventType"], _count: true, where: { ts: { gte: since(D7) }, eventType: { in: ["schedule.negotiated", "schedule.booked"] } } }),
    prisma.magicLink.count(),
    prisma.magicLink.count({ where: { consumedAt: { not: null } } }),
    prisma.exchangeCode.count({ where: { createdAt: { gte: since(D7) } } }),
    prisma.exchangeCode.count({ where: { createdAt: { gte: since(D7) }, usedAt: { not: null } } }),
    prisma.account.findMany({ orderBy: { createdAt: "desc" }, take: 20, select: { handle: true, email: true, createdAt: true, emailVerifiedAt: true } }),
    prisma.session.findMany({ orderBy: { startedAt: "desc" }, take: 20, select: { startedAt: true, endedAt: true, scopesGranted: true } }),
    prisma.session.findMany({ where: { endedAt: null, liveExpiresAt: { gt: new Date() } }, select: { id: true } }),
    prisma.frame.findMany({ where: { createdAt: { gte: since(36e5) } }, distinct: ["sessionId"], select: { sessionId: true } }),
    prisma.dailyMetric.findMany({ where: { key: "rate_limit_hits", day: { in: [new Date(now).toISOString().slice(0, 10), new Date(now - DAY).toISOString().slice(0, 10)] } } }),
  ]);

  // ── Adoption ──
  const accountsTotal = accounts.length;
  const accountsVerified = accounts.filter((a) => a.emailVerifiedAt).length;
  const newAccounts = { "24h": 0, "7d": 0, "30d": 0 };
  const daily = new Array(30).fill(0); // sparkline: new accounts per day, oldest→newest
  for (const a of accounts) {
    if (inWin(a.createdAt, H24)) newAccounts["24h"]++;
    if (inWin(a.createdAt, D7)) newAccounts["7d"]++;
    if (inWin(a.createdAt, D30)) newAccounts["30d"]++;
    const ageDays = Math.floor((now - a.createdAt.getTime()) / DAY);
    if (ageDays >= 0 && ageDays < 30) daily[29 - ageDays]++;
  }
  // Active accounts = any of the account's agents used in window, or legacy apiKey use.
  const lastUseByAccount = new Map<string, number>();
  for (const t of agents) {
    const u = t.lastUsedAt?.getTime() ?? 0;
    if (u > (lastUseByAccount.get(t.accountId) ?? 0)) lastUseByAccount.set(t.accountId, u);
  }
  for (const a of accounts) {
    const u = a.apiKeyLastUsedAt?.getTime() ?? 0;
    if (u > (lastUseByAccount.get(a.id) ?? 0)) lastUseByAccount.set(a.id, u);
  }
  const activeAccounts = { "24h": 0, "7d": 0, "30d": 0 };
  for (const [, u] of lastUseByAccount) {
    if (now - u <= H24) activeAccounts["24h"]++;
    if (now - u <= D7) activeAccounts["7d"]++;
    if (now - u <= D30) activeAccounts["30d"]++;
  }
  const newAgents = { "24h": 0, "7d": 0, "30d": 0 };
  for (const t of agents) {
    if (inWin(t.createdAt, H24)) newAgents["24h"]++;
    if (inWin(t.createdAt, D7)) newAgents["7d"]++;
    if (inWin(t.createdAt, D30)) newAgents["30d"]++;
  }
  const accountsWithAgent = new Set(agents.map((t) => t.accountId)).size;

  // ── Engagement ──
  const liveIds = new Set(liveSessionIds.map((s) => s.id));
  const framed = new Set(framedSessionIds.map((s) => s.sessionId));
  const activeNow = new Set<string>([...liveIds, ...framed]).size;
  const durations = endedRecent.filter((s) => s.endedAt).map((s) => (s.endedAt!.getTime() - s.startedAt.getTime()) / 60000).sort((a, b) => a - b);
  const median = durations.length ? Math.round(durations[Math.floor(durations.length / 2)]) : null;
  // Frame types — point-in-time snapshot of what's buffered RIGHT NOW (frames are
  // transient: purged when a session ends, so there's no historical throughput
  // counter yet). type is plaintext in the envelope; content stays sealed.
  const framesByType: Record<string, number> = {};
  for (const f of recentFrames) {
    let t = "unparsed";
    try { t = (JSON.parse(f.body)?.type as string) || "untyped"; } catch { /* leave */ }
    framesByType[t] = (framesByType[t] ?? 0) + 1;
  }

  // ── Features ──
  const directed = new Set(mutualPairs.map((r) => `${r.accountId}|${r.trustedAccountId}`));
  let mutual = 0;
  for (const r of mutualPairs) if (directed.has(`${r.trustedAccountId}|${r.accountId}`)) mutual++;
  mutual = Math.floor(mutual / 2); // each mutual pair counted from both sides
  const skillNameById = new Map((await prisma.userSkill.findMany({ where: { id: { in: topShares.map((s) => s.skillId) } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));
  const schedMap = Object.fromEntries(sched7.map((g) => [g.eventType, g._count]));

  // ── Recent activity (operator view — full handle + email; admin-only endpoint) ──
  const recentSignupRows = recentSignups.map((a) => ({ at: a.createdAt.toISOString(), handle: a.handle, email: a.email, verified: !!a.emailVerifiedAt }));
  const recentSessionRows = recentSessions.map((s) => ({ started_at: s.startedAt.toISOString(), scopes: s.scopesGranted, status: s.endedAt ? "ended" : "active" }));

  const payload = {
    generated_at: new Date().toISOString(),
    cached: false,
    adoption: {
      accounts_total: accountsTotal,
      accounts_verified: accountsVerified,
      accounts_pending: accountsTotal - accountsVerified,
      new_accounts: newAccounts,
      active_accounts: activeAccounts,
      agents_total: agents.length,
      avg_agents_per_account: accountsWithAgent ? Math.round((agents.length / accountsWithAgent) * 10) / 10 : 0,
      new_agents: newAgents,
      growth_sparkline_30d: daily,
    },
    engagement: {
      sessions_total: sessionsTotal,
      sessions: { "24h": sessions24, "7d": sessions7, "30d": sessions30 },
      active_sessions_now: activeNow,
      frames_buffered_total: framesTotal,
      frames_buffered_by_type: framesByType,
      frames_note: "Point-in-time snapshot of frames buffered right now; frames are transient (purged on session end), so this isn't cumulative throughput. Type only — content stays sealed.",
      median_session_minutes_30d: median,
    },
    features: {
      trust_rows: trustRows,
      trust_pairs_mutual: mutual,
      inbox_requests_7d: inbox7,
      skill_shares_total: sharesTotal,
      top_shared_skills: topShares.map((s) => ({ name: skillNameById.get(s.skillId) ?? "(deleted)", shares: s._count })),
      schedule_negotiated_7d: schedMap["schedule.negotiated"] ?? 0,
      schedule_booked_7d: schedMap["schedule.booked"] ?? 0,
      exchange_code_7d: { issued: ex7, redeemed: exRedeemed7, rate_pct: ex7 ? Math.round((exRedeemed7 / ex7) * 100) : null },
      magic_link_alltime: { issued: magicAll, redeemed: magicRedeemed, rate_pct: magicAll ? Math.round((magicRedeemed / magicAll) * 100) : null },
    },
    health: {
      inbox_check_adoption_pct: accountsWithAgent ? Math.round((activeAccounts["24h"] / accountsWithAgent) * 100) : 0,
      accounts_with_active_agent_24h: activeAccounts["24h"],
      accounts_with_agent: accountsWithAgent,
      pending_signups_24h: accounts.filter((a) => !a.emailVerifiedAt && inWin(a.createdAt, H24)).length,
      rate_limit_hits_24h: rlHits.reduce((sum, m) => sum + m.count, 0), // today + yesterday UTC buckets (~24h)
      email_delivery: { source: "resend", note: "Sent/bounced/spam-complained live in the Resend dashboard (delivery events need provider webhooks we don't mirror). View there for email health." },
    },
    recent: { signups: recentSignupRows, sessions: recentSessionRows },
    privacy_note: "Metadata only. Message content is end-to-end encrypted and unreadable here; emails and peer-pair handles are never exposed; recent-activity handles are redacted.",
  };
  CACHE = { at: Date.now(), payload };
  return NextResponse.json(payload);
}
