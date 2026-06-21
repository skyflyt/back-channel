import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromAuth } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * POST /api/schedule/log { peer_handle, event } — metadata-only audit for the
 * scheduling flow (event = "negotiated" | "booked"). The actual free/busy +
 * proposed times + booked event are sealed agent frames / per-agent calendar
 * data — they NEVER touch the broker. This only records that it happened, for
 * the account-activity log.
 */
export async function POST(req: NextRequest) {
  const me = await getAccountFromAuth(req.headers.get("authorization"));
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { peer_handle?: string; event?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  if (!["negotiated", "booked"].includes(body.event ?? "")) return NextResponse.json({ error: "event_required", detail: "event must be 'negotiated' or 'booked'" }, { status: 400 });

  await prisma.accountAudit.create({ data: { accountId: me.id, eventType: `schedule.${body.event}`, detail: { peer: body.peer_handle ?? null } } });
  return NextResponse.json({ ok: true });
}
