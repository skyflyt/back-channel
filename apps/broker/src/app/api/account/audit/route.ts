import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, SESSION_COOKIE_NAME } from "@/lib/auth";

export const runtime = "nodejs";

// Friendly, plain-language label per event type (Rule #0 — no jargon).
const LABELS: Record<string, string> = {
  "view-token.issued": "A sign-in link was issued for your account",
  "view-token.consumed": "You signed in to your dashboard",
  "key.rotated": "You rotated your API key",
  "session.ended_manually": "You ended a session",
  "trust.enabled": "You turned on trust for an agent",
  "trust.revoked": "You turned off trust for an agent",
  "inbox.requested": "You asked a trusted agent to collaborate",
  "inbox.accepted": "You approved a collaboration request",
  "inbox.rejected": "You declined a collaboration request",
  "skill.published": "You published a skill",
  "skill.shared": "You shared a skill with an agent",
  "skill.unshared": "You stopped sharing a skill",
  "skill.deleted": "You deleted a skill",
  "skill.imported": "You imported a skill template",
  "favor.completed": "You did a favor for an agent",
  "favor.accepted": "You accepted a favor",
  "favor.declined": "You declined a favor",
  "favor.fulfilled_by_peer": "A trusted agent did a favor for you",
  "favor.muted": "You muted favors from an agent",
  "schedule.negotiated": "Your agent worked out a meeting time",
  "schedule.booked": "A meeting was booked",
  "dashboard.wake_prompt_revealed": "You got a wake prompt for a session",
};

// Only surface non-sensitive detail fields to the owner. (We never store raw
// tokens in `detail`, but allow-listing keeps it safe as new events are added.)
const SAFE_DETAIL = new Set(["peer", "to", "scopes", "sessionId", "request"]);
function maskDetail(detail: unknown): Record<string, unknown> {
  if (!detail || typeof detail !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail as Record<string, unknown>)) {
    if (SAFE_DETAIL.has(k)) out[k] = v;
  }
  return out;
}

/**
 * GET /api/account/audit?limit= — the signed-in account's own activity log
 * (cookie). Read-only, metadata only; sensitive detail fields are masked out.
 */
export async function GET(req: NextRequest) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const limit = Math.min(Math.max(Number(new URL(req.url).searchParams.get("limit")) || 50, 1), 200);
  const rows = await prisma.accountAudit.findMany({
    where: { accountId: account.id },
    orderBy: { ts: "desc" },
    take: limit,
  });
  const events = rows.map((r) => ({
    type: r.eventType,
    label: LABELS[r.eventType] ?? r.eventType,
    at: r.ts.toISOString(),
    detail: maskDetail(r.detail),
  }));
  return NextResponse.json({ events });
}
