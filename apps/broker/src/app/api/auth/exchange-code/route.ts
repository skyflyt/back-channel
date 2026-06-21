import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid, hashToken, generateExchangeCode, exchangeCodeExpiry } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { exchangePastePrompt } from "@/lib/notify.mjs";

export const runtime = "nodejs";

/**
 * POST /api/auth/exchange-code — mint a short-lived (60s), single-use exchange
 * code for the signed-in account (cookie + CSRF). The user pastes ONLY the code
 * to their agent, which trades it at POST /api/auth/exchange for the real bc_
 * key — so the raw key never lands in a chat transcript. Stored hashed at rest.
 */
export async function POST(req: NextRequest) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return NextResponse.json({ error: "csrf" }, { status: 403 });
  if (!account.apiKey) return NextResponse.json({ error: "no_api_key", message: "Verify your email first — your account doesn't have a key yet." }, { status: 409 });

  // Cap pre-emptive code-grabbing: 5 mints/hour/account.
  const rl = rateLimit("exchange:mint", account.id, 5, 60 * 60 * 1000);
  if (!rl.ok) return NextResponse.json({ error: "rate_limited", message: "Too many codes generated — try again shortly." }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });

  const code = generateExchangeCode();
  const expiresAt = exchangeCodeExpiry();
  await prisma.exchangeCode.create({ data: { codeHash: hashToken(code), accountId: account.id, purpose: "exchange", expiresAt } });
  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "key.exchange_initiated", detail: {} } }).catch(() => {});

  return NextResponse.json({ code, expires_at: expiresAt.toISOString(), expires_in_seconds: 60, paste_prompt: exchangePastePrompt(code) });
}
