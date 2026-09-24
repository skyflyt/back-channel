import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { adminJson, requireOwnerAdmin } from "@/lib/admin";
import { activeSessionsNow, activitySignals, analyticsCache, activityStatus, connectionsPerDay, MAX_SCAN, medianSessionMinutes, mutualTrustPairs, REMOTE_FEATURE } from "@/lib/admin-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DAY = 864e5;
const H24 = DAY, D7 = 7 * DAY, D30 = 30 * DAY;

// 60s in-memory cache (this page isn't realtime; heavy aggregation shouldn't run
// per request). Single-instance Cloud Run, so a module-level cache is fine. It lives
// in src/lib/admin-analytics.ts so tests can clear it between cases.
const CACHE_TTL_MS = 60_000;

// Email delivery (last 7d) from Resend's API. Resend has no aggregate-stats
// endpoint, so we page GET /emails and tally `last_event`. Cached 5 min on its
// own so we don't hammer Resend even if the analytics cache is bypassed.
const PLACEHOLDER_KEY = "PLACEHOLDER_REPLACE_WITH_RESEND_API_KEY";
let RESEND_CACHE: { at: number; val: unknown } | null = null;
async function resendDelivery7d(): Promise<unknown> {
  if (RESEND_CACHE && Date.now() - RESEND_CACHE.at < 5 * 60_000) return RESEND_CACHE.val;
  // Prefer a dedicated READ/full-access key so we don't have to widen the
  // sending key (which lives in the hot email path). The send key is often
  // "sending access" only and 401s on GET /emails.
  const key = process.env.RESEND_READ_API_KEY || process.env.RESEND_API_KEY;
  if (!key || key === PLACEHOLDER_KEY) return { available: false, reason: "no_api_key" };
  const cutoff = Date.now() - 7 * DAY;
  const t = { total_7d: 0, delivered: 0, bounced: 0, complained: 0, other: 0 };
  try {
    let after: string | undefined;
    for (let page = 0; page < 6; page++) {
      const url = new URL("https://api.resend.com/emails");
      url.searchParams.set("limit", "100");
      if (after) url.searchParams.set("after", after);
      const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
      if (r.status === 401 || r.status === 403) return { available: false, reason: "key_lacks_read_access — set RESEND_READ_API_KEY to a full/read-access Resend key (the send key is sending-scoped)" };
      if (!r.ok) return { available: false, reason: `http_${r.status}` };
      const j = await r.json();
      const data: { id: string; created_at: string; last_event: string }[] = j.data ?? [];
      if (data.length === 0) break;
      for (const e of data) {
        if (new Date(e.created_at).getTime() < cutoff) continue;
        t.total_7d++;
        if (e.last_event === "delivered") t.delivered++;
        else if (e.last_event === "bounced" || e.last_event === "bounce") t.bounced++;
        else if (e.last_event === "complained") t.complained++;
        else t.other++;
      }
      after = data[data.length - 1]?.id;
      if (!j.has_more || !after) break;
    }
    const val = { available: true, window: "7d", source: "resend", ...t };
    RESEND_CACHE = { at: Date.now(), val };
    return val;
  } catch {
    return { available: false, reason: "fetch_error" };
  }
}

/**
 * GET /api/admin/analytics — the owner's dashboard. Owner only (src/lib/admin.ts:
 * dashboard session, ADMIN_EMAILS, verified email; bearer keys refused); 401/403
 * with nothing but {error} otherwise. METADATA ONLY by construction: counts,
 * aggregates and timestamps. NEVER message content (the broker holds no session
 * keys; sealed blobs are unreadable here and never returned), never key hashes,
 * credentials, cookies or connector keys, never peer handles in pairs.
 * "Active" comes only from timestamps the broker already keeps (see
 * src/lib/admin-analytics.ts); nothing here adds tracking.
 */
export async function GET(req: NextRequest) {
  const gate = await requireOwnerAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;
  const account = gate.account;

  // Audit every view (who looked, when) — but serve a cached payload if fresh.
  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "admin.analytics_viewed", detail: {} } }).catch(() => {});
  if (analyticsCache.payload && Date.now() - analyticsCache.at < CACHE_TTL_MS) {
    return adminJson({ ...(analyticsCache.payload as object), cached: true });
  }

  const now = Date.now();
  const since = (ms: number) => new Date(now - ms);

  const population = { reserved: false };
  // Every read here is a count, a groupBy, a one-row SQL aggregate, or a findMany
  // with an explicit take. Nothing reads Frame.body (sealed content).
  const [
    accountsTotal, accountsVerified, accountsReserved, newAcc24, newAcc7, newAcc30, pendingSignups24, signupDays,
    agentGroups, newAg24, newAg7, newAg30, signals,
    liveDevices, revokedDevices, entitledCount, connections7d, perDay, sessionsTotal, sessions24, sessions7, sessions30,
    median, activeNow, framesByRole, framesTotal,
    trustRows, mutual, inbox7, sharesTotal, topShares,
    sched7, magicAll, magicRedeemed, ex7, exRedeemed7,
    recentSignups, recentSessions, rlHits,
  ] = await Promise.all([
    prisma.account.count({ where: population }),
    prisma.account.count({ where: { ...population, emailVerifiedAt: { not: null } } }),
    prisma.account.count({ where: { reserved: true } }),
    prisma.account.count({ where: { ...population, createdAt: { gte: since(H24) } } }),
    prisma.account.count({ where: { ...population, createdAt: { gte: since(D7) } } }),
    prisma.account.count({ where: { ...population, createdAt: { gte: since(D30) } } }),
    prisma.account.count({ where: { ...population, emailVerifiedAt: null, createdAt: { gte: since(H24) } } }),
    // Sparkline only: one timestamp column, newest first, capped.
    prisma.account.findMany({ where: { ...population, createdAt: { gte: since(D30) } }, select: { createdAt: true }, orderBy: { createdAt: "desc" }, take: MAX_SCAN }),
    prisma.agentToken.groupBy({ by: ["accountId"], where: { revokedAt: null, account: population }, _count: { _all: true } }),
    prisma.agentToken.count({ where: { revokedAt: null, createdAt: { gte: since(H24) } } }),
    prisma.agentToken.count({ where: { revokedAt: null, createdAt: { gte: since(D7) } } }),
    prisma.agentToken.count({ where: { revokedAt: null, createdAt: { gte: since(D30) } } }),
    activitySignals(),
    prisma.appBridgeDevice.groupBy({ by: ["accountId", "role"], where: { revokedAt: null }, _count: { _all: true } }),
    prisma.appBridgeDevice.count({ where: { revokedAt: { not: null } } }),
    prisma.appBridgeEntitlement.count({ where: { feature: REMOTE_FEATURE, active: true } }),
    prisma.appBridgeConnectionEvent.count({ where: { at: { gte: since(D7) } } }),
    connectionsPerDay(now),
    prisma.session.count(),
    prisma.session.count({ where: { startedAt: { gte: since(H24) } } }),
    prisma.session.count({ where: { startedAt: { gte: since(D7) } } }),
    prisma.session.count({ where: { startedAt: { gte: since(D30) } } }),
    medianSessionMinutes(since(D30)),
    activeSessionsNow(new Date(now), since(36e5)),
    prisma.frame.groupBy({ by: ["roleDest"], _count: { _all: true } }),
    prisma.frame.count(),
    prisma.trustedPeer.count(),
    mutualTrustPairs(),
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
    prisma.dailyMetric.findMany({ where: { key: "rate_limit_hits", day: { in: [new Date(now).toISOString().slice(0, 10), new Date(now - DAY).toISOString().slice(0, 10)] } }, select: { count: true }, take: 10 }),
  ]);

  // ── Adoption ──
  const accountsPending = accountsTotal - accountsVerified;
  const newAccounts = { "24h": newAcc24, "7d": newAcc7, "30d": newAcc30 };
  const daily = new Array(30).fill(0); // sparkline: new accounts per day, oldest→newest
  for (const a of signupDays) {
    const ageDays = Math.floor((now - a.createdAt.getTime()) / DAY);
    if (ageDays >= 0 && ageDays < 30) daily[29 - ageDays]++;
  }
  const newAgents = { "24h": newAg24, "7d": newAg7, "30d": newAg30 };
  const agentsTotal = agentGroups.reduce((n, g) => n + g._count._all, 0);
  const accountsWithAgent = agentGroups.length;
  const agentsPerAccount = { none: Math.max(0, accountsTotal - accountsWithAgent), one: 0, two: 0, three_plus: 0 };
  for (const g of agentGroups) {
    if (g._count._all === 1) agentsPerAccount.one++;
    else if (g._count._all === 2) agentsPerAccount.two++;
    else agentsPerAccount.three_plus++;
  }

  // ── Activity: DAU / WAU / MAU and status, from existing timestamps only ──
  // Reserved-handle placeholders are not people; their signals are excluded.
  const reservedIds = accountsReserved
    ? new Set((await prisma.account.findMany({ where: { reserved: true }, select: { id: true }, take: 1000 })).map((a) => a.id))
    : new Set<string>();
  const activeAccounts = { "24h": 0, "7d": 0, "30d": 0 };
  const status = { active_7d: 0, active_30d: 0, dormant: 0, never: 0 };
  let withSignal = 0;
  let agentActive24h = 0; // an agent key used in 24h: the inbox-check health signal
  for (const [id, sig] of signals) {
    if (reservedIds.has(id) || !sig.lastActive) continue;
    withSignal++;
    if (sig.agent && now - sig.agent.getTime() <= H24) agentActive24h++;
    const age = now - sig.lastActive.getTime();
    if (age <= H24) activeAccounts["24h"]++;
    if (age <= D7) activeAccounts["7d"]++;
    if (age <= D30) activeAccounts["30d"]++;
    const st = activityStatus(sig.lastActive, now);
    if (st !== "never") status[st]++;
  }
  status.never = Math.max(0, accountsTotal - withSignal);

  // ── Back Channel Remote ──
  const remoteAccounts = new Set(liveDevices.map((g) => g.accountId));
  const remoteDevices = { pcs: 0, phones: 0, revoked: revokedDevices };
  for (const g of liveDevices) {
    if (g.role === "host") remoteDevices.pcs += g._count._all;
    else if (g.role === "remote") remoteDevices.phones += g._count._all;
  }

  // ── Engagement ──
  // Frames buffered right now, by addressee role. Frames are transient (purged
  // when a session ends) and their bodies are sealed; the body is never read.
  const framesByRoleMap: Record<string, number> = {};
  for (const g of framesByRole) framesByRoleMap[g.roleDest] = g._count._all;

  // ── Features ──
  const skillNameById = new Map((await prisma.userSkill.findMany({ where: { id: { in: topShares.map((s) => s.skillId) } }, select: { id: true, name: true }, take: 5 })).map((s) => [s.id, s.name]));
  const schedMap = Object.fromEntries(sched7.map((g) => [g.eventType, g._count]));

  // ── Recent activity (owner view — full handle + email; owner-only endpoint) ──
  const recentSignupRows = recentSignups.map((a) => ({ at: a.createdAt.toISOString(), handle: a.handle, email: a.email, verified: !!a.emailVerifiedAt }));
  const recentSessionRows = recentSessions.map((s) => ({ started_at: s.startedAt.toISOString(), scopes: s.scopesGranted, status: s.endedAt ? "ended" : "active" }));

  const emailDelivery = await resendDelivery7d();

  const payload = {
    generated_at: new Date().toISOString(),
    cached: false,
    adoption: {
      accounts_total: accountsTotal,
      accounts_verified: accountsVerified,
      accounts_pending: accountsPending,
      accounts_reserved: accountsReserved,
      new_accounts: newAccounts,
      active_accounts: activeAccounts,
      agents_total: agentsTotal,
      avg_agents_per_account: accountsWithAgent ? Math.round((agentsTotal / accountsWithAgent) * 10) / 10 : 0,
      agents_per_account: agentsPerAccount,
      new_agents: newAgents,
      growth_sparkline_30d: daily,
    },
    activity: {
      dau: activeAccounts["24h"], wau: activeAccounts["7d"], mau: activeAccounts["30d"],
      status,
      derived_from: "The latest of: agent key last used, dashboard sign-in or request, legacy key last used, relayed Remote connection. No activity log exists, so this is a lower bound.",
    },
    remote: {
      accounts_with_devices: remoteAccounts.size,
      accounts_entitled: entitledCount,
      devices: remoteDevices,
      connections_7d: connections7d,
      connections_per_day_7d: perDay,
    },
    engagement: {
      sessions_total: sessionsTotal,
      sessions: { "24h": sessions24, "7d": sessions7, "30d": sessions30 },
      active_sessions_now: activeNow,
      frames_buffered_total: framesTotal,
      frames_buffered_by_role: framesByRoleMap,
      frames_note: "Point-in-time count of frames buffered right now, by addressee role. Frames are transient (purged on session end), so this isn't cumulative throughput. Frame bodies are sealed and never read here.",
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
      inbox_check_adoption_pct: accountsWithAgent ? Math.round((agentActive24h / accountsWithAgent) * 100) : 0,
      accounts_with_active_agent_24h: agentActive24h,
      accounts_with_agent: accountsWithAgent,
      pending_signups_24h: pendingSignups24,
      rate_limit_hits_24h: rlHits.reduce((sum, m) => sum + m.count, 0), // today + yesterday UTC buckets (~24h)
      email_delivery: emailDelivery, // pulled from Resend's /emails list, tallied over 7d
    },
    recent: { signups: recentSignupRows, sessions: recentSessionRows },
    privacy_note: "Owner-only. Metadata only: counts, timestamps, handles and emails. Message content is end-to-end encrypted and unreadable here. No key hashes, credentials, cookies, connector keys, payloads or artifacts are returned, and peer pairs are never listed.",
  };
  analyticsCache.at = Date.now(); analyticsCache.payload = payload;
  return adminJson(payload);
}
