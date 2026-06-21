import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromAuth, getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * POST /api/favors/mute { peer_handle, hours } — pause favors from a peer for a
 * while WITHOUT revoking trust (sessions/inbox still work). bearer or cookie+CSRF.
 */
export async function POST(req: NextRequest) {
  const bearer = await getAccountFromAuth(req.headers.get("authorization"));
  const me = bearer ?? (await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value));
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!bearer && !csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return NextResponse.json({ error: "csrf" }, { status: 403 });

  let body: { peer_handle?: string; hours?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  if (!body.peer_handle) return NextResponse.json({ error: "peer_handle_required" }, { status: 400 });
  const hours = Math.min(Math.max(Number(body.hours) || 24, 1), 24 * 90);
  const peer = await prisma.account.findUnique({ where: { handle: body.peer_handle } });
  if (!peer) return NextResponse.json({ error: "unknown_peer" }, { status: 400 });

  const until = new Date(Date.now() + hours * 60 * 60 * 1000);
  await prisma.favorMute.upsert({
    where: { accountId_mutedAccountId: { accountId: me.id, mutedAccountId: peer.id } },
    update: { until }, create: { accountId: me.id, mutedAccountId: peer.id, until },
  });
  await prisma.accountAudit.create({ data: { accountId: me.id, eventType: "favor.muted", detail: { peer: peer.handle, hours } } }).catch(() => {});
  return NextResponse.json({ ok: true, peer: peer.handle, until: until.toISOString() });
}
