import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountDual, SESSION_COOKIE_NAME } from "@/lib/auth";

export const runtime = "nodejs";

const DAY = 864e5;

/**
 * GET /api/admin/users?limit=&offset=&sort=&filter= — operator users table.
 * Admin only (403 opaque). Full handle + email + per-account metadata for
 * spotting test vs real accounts and abuse patterns.
 *
 * METADATA ONLY: counts + timestamps. NEVER message content, inbox-request
 * message bodies, skill bodies, or trust-pair enumeration — none of those are
 * fetched or returned here. 60s in-memory cache.
 */
let CACHE: { at: number; rows: UserRow[] } | null = null;
const CACHE_TTL_MS = 60_000;

type UserRow = {
  handle: string; email: string; created_at: string; last_active_at: string | null;
  agent_count: number; session_count: number; session_count_7d: number;
  trusted_peer_count: number; invites_sent_lifetime: number; inbox_requests_sent_lifetime: number;
  inbox_check_installed: boolean; status_label: string;
};

export async function GET(req: NextRequest) {
  const account = await getAccountDual(req.headers.get("authorization"), req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!account.admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const u = new URL(req.url);
  const limit = Math.min(Math.max(Number(u.searchParams.get("limit")) || 50, 1), 200);
  const offset = Math.max(Number(u.searchParams.get("offset")) || 0, 0);
  const sort = u.searchParams.get("sort") ?? "last_active";
  const filter = u.searchParams.get("filter") ?? "";

  let rows: UserRow[];
  if (CACHE && Date.now() - CACHE.at < CACHE_TTL_MS) {
    rows = CACHE.rows;
  } else {
    const now = Date.now();
    const [accounts, agents, invites, sessions, inboxGroups, trustGroups] = await Promise.all([
      prisma.account.findMany({ select: { id: true, handle: true, email: true, createdAt: true, apiKeyLastUsedAt: true } }),
      prisma.agentToken.findMany({ where: { revokedAt: null }, select: { accountId: true, lastUsedAt: true } }),
      prisma.invite.findMany({ select: { id: true, hostAccountId: true, visitorAccountId: true } }),
      prisma.session.findMany({ select: { inviteId: true, startedAt: true } }),
      prisma.inboxRequest.groupBy({ by: ["requesterAccountId"], _count: true }),
      prisma.trustedPeer.groupBy({ by: ["accountId"], _count: true }),
    ]);

    const inviteById = new Map(invites.map((i) => [i.id, i]));
    const agentCount = new Map<string, number>();
    const lastAgentUse = new Map<string, number>();
    const recentlyPolled = new Set<string>();
    for (const a of agents) {
      agentCount.set(a.accountId, (agentCount.get(a.accountId) ?? 0) + 1);
      const t = a.lastUsedAt?.getTime() ?? 0;
      if (t > (lastAgentUse.get(a.accountId) ?? 0)) lastAgentUse.set(a.accountId, t);
      if (a.lastUsedAt && now - a.lastUsedAt.getTime() <= DAY) recentlyPolled.add(a.accountId);
    }
    const sessLifetime = new Map<string, number>();
    const sess7d = new Map<string, number>();
    for (const s of sessions) {
      const inv = inviteById.get(s.inviteId);
      if (!inv) continue;
      for (const acc of new Set([inv.hostAccountId, inv.visitorAccountId])) {
        sessLifetime.set(acc, (sessLifetime.get(acc) ?? 0) + 1);
        if (now - s.startedAt.getTime() <= 7 * DAY) sess7d.set(acc, (sess7d.get(acc) ?? 0) + 1);
      }
    }
    const invitesSent = new Map<string, number>();
    for (const i of invites) invitesSent.set(i.visitorAccountId, (invitesSent.get(i.visitorAccountId) ?? 0) + 1);
    const inboxSent = new Map(inboxGroups.map((g) => [g.requesterAccountId, g._count]));
    const trustOut = new Map(trustGroups.map((g) => [g.accountId, g._count]));

    rows = accounts.map((a) => {
      const lastActiveMs = Math.max(lastAgentUse.get(a.id) ?? 0, a.apiKeyLastUsedAt?.getTime() ?? 0);
      const sessions_lifetime = sessLifetime.get(a.id) ?? 0;
      let status = "active";
      if (lastActiveMs === 0) status = sessions_lifetime === 0 ? "test? (no activity since signup)" : "no recent activity";
      else if (now - lastActiveMs > 30 * DAY) status = "dormant (>30d idle)";
      return {
        handle: a.handle, email: a.email, created_at: a.createdAt.toISOString(),
        last_active_at: lastActiveMs ? new Date(lastActiveMs).toISOString() : null,
        agent_count: agentCount.get(a.id) ?? 0,
        session_count: sessions_lifetime,
        session_count_7d: sess7d.get(a.id) ?? 0,
        trusted_peer_count: trustOut.get(a.id) ?? 0,
        invites_sent_lifetime: invitesSent.get(a.id) ?? 0,
        inbox_requests_sent_lifetime: inboxSent.get(a.id) ?? 0,
        inbox_check_installed: recentlyPolled.has(a.id),
        status_label: status,
      };
    });
    CACHE = { at: Date.now(), rows };
  }

  let view = rows;
  if (filter === "zero_activity") view = view.filter((r) => !r.last_active_at && r.session_count === 0);
  else if (filter === "new_7d") view = view.filter((r) => Date.now() - new Date(r.created_at).getTime() <= 7 * DAY);
  else if (filter === "heavy") view = view.filter((r) => r.session_count > 10);

  const cmp: Record<string, (a: UserRow, b: UserRow) => number> = {
    last_active: (a, b) => (new Date(b.last_active_at ?? 0).getTime()) - (new Date(a.last_active_at ?? 0).getTime()),
    created: (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    sessions: (a, b) => b.session_count - a.session_count,
  };
  view = [...view].sort(cmp[sort] ?? cmp.last_active);

  const total = view.length;
  const page = view.slice(offset, offset + limit);
  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "admin.users_viewed", detail: { count: page.length } } }).catch(() => {});
  return NextResponse.json({ total, limit, offset, sort, filter: filter || null, users: page });
}
