import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromAuth, generateViewToken, viewTokenExpiry } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * POST /api/account/view-token-self — bearer-authed. Mints a single-use view
 * token for the CALLER'S OWN account and returns the sign-in URL, so an agent
 * can deep-link its human to the dashboard without waiting on email. Safe by
 * construction: the resulting cookie grants the human dashboard tier, which is
 * a strict SUBSET of what the bearer key already authorizes (no invite/claim/
 * poll/send). Also the email-bypass path the test harness uses for accounts
 * without a real mailbox.
 * Optional body: { purpose?: "account" | "session:<id>" }.
 */
export async function POST(req: NextRequest) {
  const account = await getAccountFromAuth(req.headers.get("authorization"));
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

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
  await prisma.viewToken.create({ data: { token, accountId: account.id, purpose, expiresAt } });
  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "view-token.issued", detail: { via: "self" } } });

  const appUrl = process.env.PUBLIC_APP_URL ?? new URL(req.url).origin;
  return NextResponse.json({
    view_token: token,
    view_url: `${appUrl}/api/auth/view-verify?token=${encodeURIComponent(token)}`,
    expires_at: expiresAt.toISOString(),
  });
}
