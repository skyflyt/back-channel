import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { adminJson, requireOwnerAdmin } from "@/lib/admin";
import { activitySignals, activityStatus, remoteByAccount, type RemoteSummary } from "@/lib/admin-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LIMIT = 200;
const MAX_QUERY = 100;

/**
 * GET /api/admin/users?q=&page=&limit=&sort=created|handle — the owner's users table.
 * Owner only (src/lib/admin.ts). One page (at most 200 accounts), found by
 * handle or email substring, then a fixed handful of aggregate queries keyed
 * by that page's ids: no per-user queries, no unbounded scans.
 *
 * Returns identity (handle, email), timestamps, counts and Back Channel Remote
 * state. Never returns a key hash, credential, cookie, connector key, message,
 * payload or artifact: none is selected.
 */
export type AdminUserRow = {
  handle: string; email: string; created_at: string; email_verified_at: string | null; reserved: boolean;
  last_active_at: string | null; status: ReturnType<typeof activityStatus> | "reserved";
  active_via: string[];
  agents: number;
  plan: string | null; // paid "Remote" tier: filled in once the billing model exists
  remote: RemoteSummary;
};

export async function GET(req: NextRequest) {
  const gate = await requireOwnerAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;

  const u = new URL(req.url);
  const limit = Math.min(Math.max(Math.trunc(Number(u.searchParams.get("limit"))) || MAX_LIMIT, 1), MAX_LIMIT);
  const page = Math.min(Math.max(Math.trunc(Number(u.searchParams.get("page"))) || 1, 1), 10_000);
  const sort = u.searchParams.get("sort") === "handle" ? "handle" : "created";
  const q = (u.searchParams.get("q") ?? "").trim().slice(0, MAX_QUERY);

  const where: Prisma.AccountWhereInput = q
    ? { OR: [{ handle: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }] }
    : {};
  const orderBy: Prisma.AccountOrderByWithRelationInput[] = sort === "handle" ? [{ handle: "asc" }] : [{ createdAt: "desc" }, { handle: "asc" }];

  const [total, accounts] = await Promise.all([
    prisma.account.count({ where }),
    prisma.account.findMany({
      where, orderBy, skip: (page - 1) * limit, take: limit,
      select: { id: true, handle: true, email: true, createdAt: true, emailVerifiedAt: true, reserved: true },
    }),
  ]);
  const ids = accounts.map(a => a.id);

  const now = Date.now();
  const [signals, remote, agentGroups] = ids.length
    ? await Promise.all([
      activitySignals(ids),
      remoteByAccount(ids, now),
      prisma.agentToken.groupBy({ by: ["accountId"], where: { accountId: { in: ids }, revokedAt: null }, _count: { _all: true } }),
    ])
    : [new Map(), new Map(), []];
  const agents = new Map(agentGroups.map(g => [g.accountId, g._count._all]));

  const users: AdminUserRow[] = accounts.map(a => {
    const s = signals.get(a.id);
    const last = s?.lastActive ?? null;
    const via = s ? (["agent", "dashboard", "remote", "legacyKey"] as const).filter(k => s[k]) : [];
    return {
      handle: a.handle,
      email: a.email,
      created_at: a.createdAt.toISOString(),
      email_verified_at: a.emailVerifiedAt ? a.emailVerifiedAt.toISOString() : null,
      reserved: a.reserved,
      last_active_at: last ? last.toISOString() : null,
      status: a.reserved ? "reserved" : activityStatus(last, now),
      active_via: [...via],
      agents: agents.get(a.id) ?? 0,
      plan: null,
      remote: remote.get(a.id)!,
    };
  });

  await prisma.accountAudit.create({ data: { accountId: gate.account.id, eventType: "admin.users_viewed", detail: { count: users.length, page } } }).catch(() => {});
  return adminJson({ total, page, limit, sort, q: q || null, users });
}
