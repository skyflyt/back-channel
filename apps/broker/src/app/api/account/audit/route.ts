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
  "inbox.requested": "You sent a friend a message request",
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
  "favor.fulfilled_by_peer": "A friend did a favor for you",
  "favor.muted": "You muted favors from an agent",
  "schedule.negotiated": "Your agent worked out a meeting time",
  "schedule.booked": "A meeting was booked",
  "dashboard.wake_prompt_revealed": "You got a wake prompt for a session",
  "dashboard.session_started": "You started a session from the dashboard",
  "dashboard.bootstrap_prompt_revealed": "You revealed a setup prompt to connect an agent",
  "key.exchange_initiated": "You created a code to connect a new agent",
  "key.exchange_consumed": "A new agent connected to your account",
  "friend.invited": "You invited a friend",
  "friend.accepted": "You became friends with someone who invited you",
  "friend.added": "Someone you invited accepted — you're now friends",
  "agent_token.revoked": "You revoked an agent's access",
  "passkey.added": "You added a passkey",
  "passkey.removed": "You removed a passkey",
  "step_up.confirmed": "You confirmed an action with your passkey",
  // Secrets (docs/secrets-epic.md): metadata only, never a value.
  "secret.requested": "An agent on one of your PCs asked to use a secret",
  "secret.approved": "You approved a secret request with your passkey",
  "secret.denied": "You denied a secret request",
  "secret.install_requested": "You asked a PC to install the secret broker",
  "secret.install_done": "A PC installed the secret broker",
  "secret.install_failed": "A PC couldn't install the secret broker",
  "secret.update_requested": "You asked a PC to update its secret broker",
  "secret.update_done": "A PC updated its secret broker",
  "secret.update_failed": "A PC couldn't update its secret broker",
  "secret.enrol_requested": "You asked a PC's secret broker to trust a passkey",
  "secret.enrol_done": "A PC's secret broker now trusts your passkey",
  "secret.enrol_failed": "A PC's secret broker didn't trust the passkey",
  "secret.lockdown_requested": "You locked down a PC's secret broker",
  "secret.lockdown_done": "A PC's secret broker is locked down",
  "secret.lockdown_failed": "A PC's secret broker couldn't be locked down",
};

// Only surface non-sensitive detail fields to the owner. (We never store raw
// tokens in `detail`, but allow-listing keeps it safe as new events are added.)
const SAFE_DETAIL = new Set(["peer", "to", "scopes", "sessionId", "request", "agent_name", "name", "agent_token_id",
  "code", "mode", "tier", "option", "failure"]);
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
