import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateApiKey, isRecoveryToken, hashToken } from "@/lib/auth";
import { rateLimit, clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

const HOUR = 60 * 60 * 1000;

function ipLimit(req: NextRequest) {
  const ip = clientIp(req.headers.get("x-forwarded-for"));
  return rateLimit("verify:ip", ip, 60, HOUR);
}

function tooMany(retryAfterSec: number) {
  return NextResponse.json(
    { error: "rate_limited", message: "Too many requests. Please try again later." },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
  );
}

/**
 * GET — NON-consuming probe.
 *
 * Corporate email security (Mimecast, Microsoft Defender for O365, Google Safe
 * Browsing, etc.) pre-fetches every link in inbound mail to scan for malware.
 * If the GET consumed the token, the scanner would burn it before the human
 * ever clicked — the #1 reason magic links feel broken behind corp email.
 *
 * So GET only reports whether the token is still usable. It never marks the
 * token used and never issues an API key, making it safe to pre-fetch any
 * number of times. The browser page calls this to show the handle before the
 * human clicks "Verify". The token is only consumed by POST (below).
 */
export async function GET(req: NextRequest) {
  const limit = ipLimit(req);
  if (!limit.ok) return tooMany(limit.retryAfterSec);

  const token = new URL(req.url).searchParams.get("token");
  if (!token) return NextResponse.json({ error: "token_required" }, { status: 400 });

  const link = await prisma.magicLink.findUnique({ where: { token: hashToken(token) } });
  if (!link) return NextResponse.json({ error: "invalid_token" }, { status: 404 });
  if (link.consumedAt) return NextResponse.json({ error: "token_already_used" }, { status: 410 });
  if (link.expiresAt < new Date()) return NextResponse.json({ error: "token_expired" }, { status: 410 });

  const account = await prisma.account.findUnique({ where: { email: link.email } });
  if (!account) return NextResponse.json({ error: "account_not_found" }, { status: 404 });

  return NextResponse.json({ valid: true, handle: account.handle, email: account.email });
}

/**
 * POST { token } — the REAL consumer.
 *
 * Marks the token used, marks the account verified, and issues + returns the
 * API key. A human button click triggers this; headless scanners don't POST
 * or click buttons, so the token survives any number of GET pre-fetches.
 */
export async function POST(req: NextRequest) {
  const limit = ipLimit(req);
  if (!limit.ok) return tooMany(limit.retryAfterSec);

  let token: string | undefined;
  try {
    const body = await req.json();
    token = body?.token;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!token) return NextResponse.json({ error: "token_required" }, { status: 400 });
  // Recovery tokens must go through /api/auth/recover-key (which rotates the
  // key); they must not be consumable as a plain verification.
  if (isRecoveryToken(token)) return NextResponse.json({ error: "invalid_token" }, { status: 404 });

  const h = hashToken(token);
  const link = await prisma.magicLink.findUnique({ where: { token: h } });
  if (!link) return NextResponse.json({ error: "invalid_token" }, { status: 404 });
  if (link.expiresAt < new Date()) return NextResponse.json({ error: "token_expired" }, { status: 410 });

  // Atomically claim the token: only the first POST that flips consumedAt from
  // null wins. This is the lock — it stops a double-click (or a retry) from
  // rotating an already-issued API key.
  const claim = await prisma.magicLink.updateMany({
    where: { token: h, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (claim.count === 0) return NextResponse.json({ error: "token_already_used" }, { status: 410 });

  const account = await prisma.account.findUnique({ where: { email: link.email } });
  if (!account) return NextResponse.json({ error: "account_not_found" }, { status: 404 });

  const apiKey = account.apiKey ?? generateApiKey();
  const updated = await prisma.account.update({
    where: { id: account.id },
    data: {
      emailVerifiedAt: account.emailVerifiedAt ?? new Date(),
      apiKey: account.apiKey ?? apiKey,
    },
  });

  return NextResponse.json({
    status: "verified",
    handle: updated.handle,
    email: updated.email,
    api_key: updated.apiKey,
    account_id: updated.id,
  });
}
