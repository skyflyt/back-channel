import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAuthContext, generateViewToken, viewTokenExpiry, hashToken } from "@/lib/auth";
import { hasFullScope } from "@/lib/agent-scope";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * POST /api/account/view-token-self — bearer-authed. Mints a single-use view
 * token for the CALLER'S OWN account and returns the sign-in URL, so an agent
 * can deep-link its human to the dashboard without waiting on email. Also the
 * email-bypass path the test harness uses for accounts without a real mailbox.
 *
 * FULL-SCOPE KEYS ONLY. The link signs a browser in as the human, and the
 * dashboard can add agents and mint new keys — so whoever holds the calling key
 * can turn it into the whole account. That is acceptable for a key the user
 * gave to an agent they run themselves. It is not for a "connector" key, which
 * lives on a hosted app's servers (minted by the OAuth flow, /api/oauth/token):
 * those are refused here. An earlier version of this comment called the
 * dashboard tier "a strict subset" of what a bearer key authorizes; it is not —
 * no bearer route mints keys.
 *
 * Optional body: { purpose?: "account" | "session:<id>" }.
 */
export async function POST(req: NextRequest) {
  const ctx = await getAuthContext(req.headers.get("authorization"));
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const account = ctx.account;
  if (!hasFullScope(ctx)) {
    const appUrl = process.env.PUBLIC_APP_URL ?? new URL(req.url).origin;
    return NextResponse.json(
      { error: "not_available_to_connectors", message: `This connection can't open the account dashboard. The user can sign in themselves at ${appUrl}/login.` },
      { status: 403 },
    );
  }

  const rl = rateLimit("viewtoken:self", account.id, 20, 60 * 60 * 1000);
  if (!rl.ok) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  }

  let purpose = "account";
  try {
    const body = await req.json();
    if (typeof body?.purpose === "string" && /^(account|session:[\w-]+)$/.test(body.purpose)) purpose = body.purpose;
  } catch { /* no body is fine */ }

  const token = generateViewToken();
  const expiresAt = viewTokenExpiry();
  await prisma.viewToken.create({ data: { token: hashToken(token), accountId: account.id, purpose, expiresAt } });
  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "view-token.issued", detail: { via: "self" } } });

  const appUrl = process.env.PUBLIC_APP_URL ?? new URL(req.url).origin;
  return NextResponse.json({
    view_token: token,                                  // raw (handed to user/harness; only the hash is stored)
    view_url: `${appUrl}/account?vt=${encodeURIComponent(token)}`,   // human lands here; page POSTs consume
    consume_url: `${appUrl}/api/auth/view-token-consume`,            // POST {token} -> sets bc_session cookie
    expires_at: expiresAt.toISOString(),
  });
}
