import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromAuth } from "@/lib/auth";

export const runtime = "nodejs";
const DAY = 24 * 60 * 60 * 1000;

/**
 * POST /api/favors/check { requester_handle, est_tokens? } — bearer (the
 * RECIPIENT's agent calls this BEFORE surfacing/approving a sealed favor.request).
 * Content-free gate: returns whether accepting is allowed given mutual trust,
 * the mute list, the per-peer daily favor cap, and the global daily token cap.
 * The favor's task + result never touch the broker — only these counters do.
 */
export async function POST(req: NextRequest) {
  const me = await getAccountFromAuth(req.headers.get("authorization"));
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { requester_handle?: string; est_tokens?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  if (!body.requester_handle) return NextResponse.json({ error: "requester_handle_required" }, { status: 400 });
  const est = Math.max(0, Number(body.est_tokens) || 0);

  const peer = await prisma.account.findUnique({ where: { handle: body.requester_handle } });
  if (!peer) return NextResponse.json({ allowed: false, reason: "unknown_peer" });

  // Mutual trust required.
  const [iTrust, trustsMe] = await Promise.all([
    prisma.trustedPeer.findUnique({ where: { accountId_trustedAccountId: { accountId: me.id, trustedAccountId: peer.id } } }),
    prisma.trustedPeer.findUnique({ where: { accountId_trustedAccountId: { accountId: peer.id, trustedAccountId: me.id } } }),
  ]);
  if (!iTrust || !trustsMe) return NextResponse.json({ allowed: false, reason: "not_mutually_trusted" });

  // Muted?
  const mute = await prisma.favorMute.findUnique({ where: { accountId_mutedAccountId: { accountId: me.id, mutedAccountId: peer.id } } });
  if (mute && mute.until > new Date()) return NextResponse.json({ allowed: false, reason: "muted", until: mute.until.toISOString() });

  const since = new Date(Date.now() - DAY);
  // Per-peer daily favor count.
  const peerCount = await prisma.favorLog.count({ where: { recipientAccountId: me.id, requesterAccountId: peer.id, status: { in: ["accepted", "completed"] }, at: { gte: since } } });
  if (peerCount >= me.favorPerPeerDaily) return NextResponse.json({ allowed: false, reason: "per_peer_cap", cap: me.favorPerPeerDaily });

  // Global daily token budget.
  const agg = await prisma.favorLog.aggregate({ _sum: { tokensUsed: true }, where: { recipientAccountId: me.id, at: { gte: since } } });
  const spent = agg._sum.tokensUsed ?? 0;
  if (spent + est > me.favorGlobalTokensDaily) return NextResponse.json({ allowed: false, reason: "global_token_cap", cap: me.favorGlobalTokensDaily, spent });

  return NextResponse.json({ allowed: true, remaining_today_tokens: me.favorGlobalTokensDaily - spent, peer_favors_today: peerCount });
}
