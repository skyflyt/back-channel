import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromAuth } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * POST /api/favors/log { requester_handle, status, tokens_used? } — bearer (the
 * RECIPIENT records a favor outcome). Metadata only — status + token count +
 * who, never the task or result. Feeds the daily caps, the both-sides audit,
 * and the (advisory) reciprocity view.
 */
export async function POST(req: NextRequest) {
  const me = await getAccountFromAuth(req.headers.get("authorization"));
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { requester_handle?: string; status?: string; tokens_used?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  if (!body.requester_handle || !["accepted", "declined", "completed"].includes(body.status ?? "")) {
    return NextResponse.json({ error: "requester_handle_and_status_required" }, { status: 400 });
  }
  const peer = await prisma.account.findUnique({ where: { handle: body.requester_handle } });
  if (!peer) return NextResponse.json({ error: "unknown_peer" }, { status: 400 });

  await prisma.favorLog.create({
    data: { recipientAccountId: me.id, requesterAccountId: peer.id, status: body.status!, tokensUsed: Math.max(0, Number(body.tokens_used) || 0) },
  });
  // Both-sides audit: recipient ("I did X for peer") + requester ("peer did X for me").
  await prisma.accountAudit.create({ data: { accountId: me.id, eventType: `favor.${body.status}`, detail: { peer: peer.handle, tokens_used: body.tokens_used ?? 0 } } }).catch(() => {});
  if (body.status !== "declined") {
    await prisma.accountAudit.create({ data: { accountId: peer.id, eventType: "favor.fulfilled_by_peer", detail: { peer: me.handle, tokens_used: body.tokens_used ?? 0 } } }).catch(() => {});
  }
  return NextResponse.json({ ok: true });
}
