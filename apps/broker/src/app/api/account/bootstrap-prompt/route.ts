import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, SESSION_COOKIE_NAME } from "@/lib/auth";
import { bootstrapPrompt } from "@/lib/notify.mjs";

export const runtime = "nodejs";

/**
 * GET /api/account/bootstrap-prompt — cookie-authed. Returns the paste-ready
 * "connect a new agent" prompt, which includes the caller's FULL API key.
 * Cookie tier only (the human who owns the account); the key is a strict subset
 * of what that human can already do, but revealing it is a deliberate action so
 * we audit it (dashboard.bootstrap_prompt_revealed). Same DRY pattern as the
 * wake-prompt / session-prompts endpoints — text lives once in notify.mjs.
 */
export async function GET(req: NextRequest) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!account.apiKey) return NextResponse.json({ error: "no_api_key", message: "Your account doesn't have an API key yet — verify your email first." }, { status: 409 });

  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "dashboard.bootstrap_prompt_revealed", detail: {} } }).catch(() => {});

  return NextResponse.json({ prompt: bootstrapPrompt(account.apiKey) });
}
