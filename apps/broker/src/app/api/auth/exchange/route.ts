import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/auth";
import { rateLimit, clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * POST /api/auth/exchange { code } — NO auth header. Trades a single-use
 * exchange code (minted at /api/auth/exchange-code) for the account's real bc_
 * API key, then burns the code. This is how an agent gets connected without the
 * user ever pasting their raw key into chat.
 *
 * Uniform opaque failure: no such code, already used, OR expired all return the
 * SAME 410 { error: "invalid_or_expired_code" } — the caller can't tell which,
 * so a code's prior existence is never confirmed. The raw code/key are NEVER logged.
 */
export async function POST(req: NextRequest) {
  // Per-IP brute-force guard: 20 attempts/hour.
  const ip = clientIp(req.headers.get("x-forwarded-for"));
  const rl = rateLimit("exchange:ip", ip, 20, 60 * 60 * 1000);
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });

  let code: string | undefined;
  try { code = (await req.json())?.code; } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  if (!code || typeof code !== "string") return NextResponse.json({ error: "code_required" }, { status: 400 });

  // Uniform opaque failure for every code-validity reason (unknown / used / expired):
  // same 410, same body — never reveal which, never confirm a code existed.
  const gone = () => NextResponse.json({ error: "invalid_or_expired_code" }, { status: 410 });

  const row = await prisma.exchangeCode.findUnique({ where: { codeHash: hashToken(code.trim().toUpperCase()) }, include: { account: true } });
  if (!row) return gone();                                  // no such code
  if (row.usedAt) return gone();                            // already spent
  if (row.expiresAt.getTime() < Date.now()) return gone();  // expired

  // Atomic single-use claim — first POST to flip usedAt wins (guards a race).
  const claim = await prisma.exchangeCode.updateMany({ where: { codeHash: row.codeHash, usedAt: null }, data: { usedAt: new Date() } });
  if (claim.count === 0) return gone();
  if (!row.account.apiKey) return gone();                   // account has no key — still opaque

  // Audit the consumption with the requesting IP (postmortem) — never the key.
  await prisma.accountAudit.create({ data: { accountId: row.accountId, eventType: "key.exchange_consumed", detail: { ip } } }).catch(() => {});

  return NextResponse.json({ api_key: row.account.apiKey, handle: row.account.handle });
}
