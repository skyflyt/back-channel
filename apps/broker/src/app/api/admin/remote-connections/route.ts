import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { adminJson, requireOwnerAdmin } from "@/lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WINDOW_MS = 7 * 86_400_000; // the connection log's own retention (src/lib/appbridge.ts)
const READ_LIMIT = 500;           // newest events read
const SHOW_LIMIT = 50;            // rows returned
const SAME_SESSION_MS = 120_000;  // one Remote session opens several relayed connections at once

/**
 * GET /api/admin/remote-connections — the owner's Back Channel Remote connection log.
 * Owner only (src/lib/admin.ts).
 *
 * Deliberately the least that answers "who used the relay, and when":
 *   - which account (its handle), when, and how many connection attempts that was;
 *   - nothing about devices. No device id, name or key is selected, so none can be returned.
 *     (The account's own Remote page shows its device names to that account; the owner does not
 *     need them to see that the relay is in use.)
 *   - nothing new is recorded. This reads the same AppBridgeConnectionEvent rows the account's
 *     own 7-day log reads; they hold an account, two device ids and a time, are written when a
 *     session pass is redeemed, and are deleted after 7 days. No IP address, location, duration
 *     or content exists to show.
 *
 * A phone opening one session redeems a handful of passes in the same second (its workspace
 * socket plus pooled HTTPS connections), so attempts by one account within two minutes of each
 * other are folded into one row with a count. At most 50 rows, from the newest 500 events.
 */
export type AdminRemoteConnection = { at: string; handle: string; attempts: number };

export async function GET(req: NextRequest) {
  const gate = await requireOwnerAdmin(req, { mutate: false });
  if (!gate.ok) return gate.response;

  const events = await prisma.appBridgeConnectionEvent.findMany({
    where: { at: { gte: new Date(Date.now() - WINDOW_MS) } },
    orderBy: { at: "desc" },
    take: READ_LIMIT,
    select: { accountId: true, at: true },
  });

  // Newest first. An event joins its account's most recent row if it is within two minutes of
  // that row's earliest event; otherwise it starts a new row.
  const rows: { accountId: string; latest: Date; earliest: Date; attempts: number }[] = [];
  const open = new Map<string, (typeof rows)[number]>();
  for (const e of events) {
    const row = open.get(e.accountId);
    if (row && row.earliest.getTime() - e.at.getTime() <= SAME_SESSION_MS) { row.attempts++; row.earliest = e.at; continue; }
    const next = { accountId: e.accountId, latest: e.at, earliest: e.at, attempts: 1 };
    rows.push(next); open.set(e.accountId, next);
  }
  const shown = rows.slice(0, SHOW_LIMIT);

  const ids = [...new Set(shown.map(r => r.accountId))];
  const accounts = ids.length ? await prisma.account.findMany({ where: { id: { in: ids } }, take: ids.length, select: { id: true, handle: true } }) : [];
  const handles = new Map(accounts.map(a => [a.id, a.handle]));

  const connections: AdminRemoteConnection[] = shown.map(r => ({
    at: r.latest.toISOString(),
    handle: handles.get(r.accountId) ?? "(deleted account)",
    attempts: r.attempts,
  }));

  await prisma.accountAudit.create({ data: { accountId: gate.account.id, eventType: "admin.remote_connections_viewed", detail: { count: connections.length } } }).catch(() => {});
  return adminJson({
    window_days: 7,
    // true when there was more than this response covers: either more events than were read, or more rows than are shown
    truncated: events.length === READ_LIMIT || rows.length > SHOW_LIMIT,
    connections,
  });
}
