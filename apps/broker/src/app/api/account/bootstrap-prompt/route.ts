import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, SESSION_COOKIE_NAME, upsertOriginalAgentToken } from "@/lib/auth";
import { bootstrapPrompt } from "@/lib/notify.mjs";

export const runtime = "nodejs";

/**
 * GET /api/account/bootstrap-prompt — cookie-authed. Returns the paste-ready
 * "connect a new agent" prompt, which includes a FRESH bc_ key for the caller.
 * Cookie tier only (the human who owns the account); the key is a strict subset
 * of what that human can already do, but revealing it is a deliberate action so
 * we audit it (dashboard.bootstrap_prompt_revealed). Same DRY pattern as the
 * wake-prompt / session-prompts endpoints — text lives once in notify.mjs.
 *
 * SEC H1: there is no persisted raw key to read back anymore (Account.apiKey
 * is never written). Gate on emailVerifiedAt — same signal
 * /api/account/agents already uses ("Gate on verification, NOT the legacy
 * account.apiKey column") — and mint a fresh "Original" AgentToken on demand,
 * same helper /api/account/key/rotate uses. Each call to this endpoint
 * therefore rotates the caller's Original key; that's an acceptable behavior
 * change for a "reveal my bootstrap prompt" action and keeps this endpoint
 * from being the one place that still needs a plaintext column to read.
 */
export async function GET(req: NextRequest) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!account.emailVerifiedAt) return NextResponse.json({ error: "no_api_key", message: "Your account doesn't have an API key yet — verify your email first." }, { status: 409 });

  const apiKey = await upsertOriginalAgentToken(account.id);

  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "dashboard.bootstrap_prompt_revealed", detail: {} } }).catch(() => {});

  return NextResponse.json({ prompt: bootstrapPrompt(apiKey) });
}
