/**
 * Owner analytics helpers: who the users are and whether they are active.
 *
 * Back Channel keeps no activity log, and this file adds none. "Last active" is
 * the latest of timestamps the broker already writes for its own purposes:
 *   - AgentToken.lastUsedAt          a bc_ agent key authenticated (throttled ~1/min; revoked tokens included)
 *   - SessionCookie.createdAt / lastUsedAt   a dashboard sign-in / dashboard request (rows are deleted when the 24 h cookie expires, so this signal is short-lived)
 *   - Account.apiKeyLastUsedAt       legacy single-key use (historical; no longer written since SEC H1)
 *   - AppBridgeConnectionEvent.at    a relayed Back Channel Remote connection (kept 7 days)
 * TrustedPeer.lastUsedAt and MirrorKeyWrap.lastUsedAt exist in the schema but
 * nothing writes them, so they are not read. The result is a lower bound: an
 * account can have been active more recently than this shows, never less.
 *
 * Every query is an aggregate (count / groupBy / _max) or bounded by an id list
 * of at most one page. Nothing selects a key hash, credential, cookie, connector
 * key, message, payload or artifact.
 */
import { prisma } from "@/lib/db";

export const DAY_MS = 86_400_000;
export const REMOTE_FEATURE = "appbridge.remote_access"; // same value as FEATURE in src/lib/appbridge.ts

export type ActivityStatus = "active_7d" | "active_30d" | "dormant" | "never";

export function activityStatus(lastActive: Date | null, now = Date.now()): ActivityStatus {
  if (!lastActive) return "never";
  const age = now - lastActive.getTime();
  if (age <= 7 * DAY_MS) return "active_7d";
  if (age <= 30 * DAY_MS) return "active_30d";
  return "dormant";
}

export type ActivitySignals = {
  agent: Date | null;       // AgentToken.lastUsedAt
  dashboard: Date | null;   // SessionCookie.createdAt / lastUsedAt
  legacyKey: Date | null;   // Account.apiKeyLastUsedAt
  remote: Date | null;      // AppBridgeConnectionEvent.at
  lastActive: Date | null;  // max of the above
};

const later = (...ds: (Date | null | undefined)[]): Date | null =>
  ds.reduce<Date | null>((m, d) => (d && (!m || d.getTime() > m.getTime()) ? d : m), null);

/**
 * Per-account activity signals. With `ids`, only those accounts (one page);
 * without, every account that has any signal (for population counts).
 */
export async function activitySignals(ids?: string[]): Promise<Map<string, ActivitySignals>> {
  const scope = ids ? { accountId: { in: ids } } : {};
  const [tokens, cookies, conns, legacy] = await Promise.all([
    prisma.agentToken.groupBy({ by: ["accountId"], where: { ...scope, lastUsedAt: { not: null } }, _max: { lastUsedAt: true } }),
    prisma.sessionCookie.groupBy({ by: ["accountId"], where: scope, _max: { lastUsedAt: true, createdAt: true } }),
    prisma.appBridgeConnectionEvent.groupBy({ by: ["accountId"], where: scope, _max: { at: true } }),
    prisma.account.findMany({ where: { ...(ids ? { id: { in: ids } } : {}), apiKeyLastUsedAt: { not: null } }, select: { id: true, apiKeyLastUsedAt: true } }),
  ]);
  const out = new Map<string, ActivitySignals>();
  const get = (id: string) => {
    let s = out.get(id);
    if (!s) { s = { agent: null, dashboard: null, legacyKey: null, remote: null, lastActive: null }; out.set(id, s); }
    return s;
  };
  for (const t of tokens) get(t.accountId).agent = t._max.lastUsedAt ?? null;
  for (const c of cookies) get(c.accountId).dashboard = later(c._max.lastUsedAt, c._max.createdAt);
  for (const e of conns) get(e.accountId).remote = e._max.at ?? null;
  for (const a of legacy) get(a.id).legacyKey = a.apiKeyLastUsedAt ?? null;
  for (const s of out.values()) s.lastActive = later(s.agent, s.dashboard, s.legacyKey, s.remote);
  return out;
}

export type RemoteSummary = {
  pcs: number; phones: number; pcs_revoked: number; phones_revoked: number;
  entitled: boolean; connections_7d: number; last_connection_at: string | null;
};

/** Back Channel Remote state for one page of accounts: counts and times only. */
export async function remoteByAccount(ids: string[], now = Date.now()): Promise<Map<string, RemoteSummary>> {
  const scope = { accountId: { in: ids } };
  const [live, revoked, ents, conns7, connsAll] = await Promise.all([
    prisma.appBridgeDevice.groupBy({ by: ["accountId", "role"], where: { ...scope, revokedAt: null }, _count: { _all: true } }),
    prisma.appBridgeDevice.groupBy({ by: ["accountId", "role"], where: { ...scope, revokedAt: { not: null } }, _count: { _all: true } }),
    prisma.appBridgeEntitlement.findMany({ where: { ...scope, feature: REMOTE_FEATURE }, select: { accountId: true, active: true } }),
    prisma.appBridgeConnectionEvent.groupBy({ by: ["accountId"], where: { ...scope, at: { gte: new Date(now - 7 * DAY_MS) } }, _count: { _all: true } }),
    prisma.appBridgeConnectionEvent.groupBy({ by: ["accountId"], where: scope, _max: { at: true } }),
  ]);
  const out = new Map<string, RemoteSummary>();
  for (const id of ids) out.set(id, { pcs: 0, phones: 0, pcs_revoked: 0, phones_revoked: 0, entitled: false, connections_7d: 0, last_connection_at: null });
  for (const g of live) {
    const s = out.get(g.accountId); if (!s) continue;
    if (g.role === "host") s.pcs += g._count._all; else if (g.role === "remote") s.phones += g._count._all;
  }
  for (const g of revoked) {
    const s = out.get(g.accountId); if (!s) continue;
    if (g.role === "host") s.pcs_revoked += g._count._all; else if (g.role === "remote") s.phones_revoked += g._count._all;
  }
  for (const e of ents) { const s = out.get(e.accountId); if (s) s.entitled = !!e.active; }
  for (const g of conns7) { const s = out.get(g.accountId); if (s) s.connections_7d = g._count._all; }
  for (const g of connsAll) { const s = out.get(g.accountId); if (s) s.last_connection_at = g._max.at ? g._max.at.toISOString() : null; }
  return out;
}

/** Relayed connections per UTC day for the last 7 days, oldest first, zero-filled. */
export async function connectionsPerDay(now = Date.now()): Promise<{ day: string; count: number }[]> {
  const days: string[] = [];
  for (let i = 6; i >= 0; i--) days.push(new Date(now - i * DAY_MS).toISOString().slice(0, 10));
  const since = new Date(`${days[0]}T00:00:00.000Z`);
  const rows = await prisma.$queryRaw<{ day: Date | string; n: number | bigint }[]>`
    SELECT date_trunc('day', "at") AS day, COUNT(*)::int AS n
    FROM "AppBridgeConnectionEvent" WHERE "at" >= ${since} GROUP BY 1`;
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(new Date(r.day).toISOString().slice(0, 10), Number(r.n));
  return days.map(day => ({ day, count: byDay.get(day) ?? 0 }));
}
