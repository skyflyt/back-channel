import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromAuth } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * GET /api/inbox/agent-payloads — the agent's self-inbox (inbox-model pivot §5).
 * Bearer-auth. Returns the caller's PENDING agent.payload items (things the user
 * queued for their own agent — e.g. a skill a peer shared, sent via the dashboard
 * "Send to my agent" button) and marks them delivered.
 *
 * This is the Tier-2 consuming fetch: bc-inbox-check spends an agent turn only
 * when the cheap Tier-1 check (`agent_payloads_pending` on /api/sessions/active)
 * is > 0. Marking delivered on read is safe — each payload is a reference to
 * data the broker still holds, so a mid-turn crash loses nothing actionable.
 */
export async function GET(req: NextRequest) {
  const account = await getAccountFromAuth(req.headers.get("authorization"));
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const pending = await prisma.agentPayload.findMany({
    where: { accountId: account.id, deliveredAt: null },
    orderBy: { createdAt: "asc" },
    take: 50,
  });

  if (pending.length > 0) {
    await prisma.agentPayload.updateMany({
      where: { id: { in: pending.map((p) => p.id) } },
      data: { deliveredAt: new Date() },
    });
  }

  return NextResponse.json({
    payloads: pending.map((p) => ({
      id: p.id,
      kind: p.kind,
      ref: p.ref,
      note: p.note,
      created_at: p.createdAt.toISOString(),
    })),
  });
}
