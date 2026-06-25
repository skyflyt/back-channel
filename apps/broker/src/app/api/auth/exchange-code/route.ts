import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid, hashToken, generateExchangeCode, exchangeCodeExpiry } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { exchangePastePrompt } from "@/lib/notify.mjs";

export const runtime = "nodejs";

/**
 * POST /api/auth/exchange-code — mint a short-lived (15 min), single-use exchange
 * code for the signed-in account (cookie + CSRF). The user pastes ONLY the code
 * to their agent, which trades it at POST /api/auth/exchange for the real bc_
 * key — so the raw key never lands in a chat transcript. Stored hashed at rest.
 */
export async function POST(req: NextRequest) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return NextResponse.json({ error: "csrf" }, { status: 403 });
  if (!account.apiKey) return NextResponse.json({ error: "no_api_key", message: "Verify your email first — your account doesn't have a key yet." }, { status: 409 });

  // Cap pre-emptive code-grabbing: 15 mints/hour/account (5 was too low — a user
  // wiring several runtimes, each needing its own code, hit it; plus accidental
  // double-clicks. 15 still defends against pre-mint enumeration).
  const rl = rateLimit("exchange:mint", account.id, 15, 60 * 60 * 1000);
  if (!rl.ok) return NextResponse.json({ error: "rate_limited", message: "Too many codes generated — try again shortly." }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });

  // Per-agent-tokens: name + runtime label the AgentToken minted on redemption.
  let body: { agent_name?: string; runtime_type?: string } = {};
  try { body = await req.json(); } catch { /* empty body allowed */ }
  const RUNTIMES = ["cowork", "codex", "claude_code", "chatgpt", "other"];
  const agentName = (body.agent_name ?? "").trim().slice(0, 80) || "New agent";
  const runtimeType = RUNTIMES.includes(body.runtime_type ?? "") ? (body.runtime_type as "cowork" | "codex" | "claude_code" | "chatgpt" | "other") : "other";

  const code = generateExchangeCode();
  const expiresAt = exchangeCodeExpiry();
  await prisma.exchangeCode.create({ data: { codeHash: hashToken(code), accountId: account.id, purpose: "exchange", agentName, runtimeType, expiresAt } });
  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "key.exchange_initiated", detail: { agent_name: agentName } } }).catch(() => {});

  return NextResponse.json({ code, expires_at: expiresAt.toISOString(), expires_in_seconds: 900, agent_name: agentName, paste_prompt: exchangePastePrompt(code, agentName) });
}
