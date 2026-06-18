import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateApiKey, isRecoveryToken } from "@/lib/auth";
import { rateLimit, clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

const HOUR = 60 * 60 * 1000;

/**
 * POST { token } — consume a recovery token and ROTATE the API key.
 *
 * Hard rotation (always a brand-new key, old one invalidated) is the point of
 * recovery: if the old key leaked, it must stop working once the owner
 * recovers. Mirrors /api/auth/verify's scanner-tolerant model — the GET probe
 * (shared with /api/auth/verify) never consumes; only this POST does.
 */
export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers.get("x-forwarded-for"));
  const limit = rateLimit("verify:ip", ip, 60, HOUR);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }

  let token: string | undefined;
  try {
    token = (await req.json())?.token;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!token) return NextResponse.json({ error: "token_required" }, { status: 400 });
  // Only recovery tokens belong here; verification tokens go to /api/auth/verify.
  if (!isRecoveryToken(token)) return NextResponse.json({ error: "invalid_token" }, { status: 404 });

  const link = await prisma.magicLink.findUnique({ where: { token } });
  if (!link) return NextResponse.json({ error: "invalid_token" }, { status: 404 });
  if (link.expiresAt < new Date()) return NextResponse.json({ error: "token_expired" }, { status: 410 });

  // Atomic claim: first POST to flip consumedAt wins (stops double-click double-rotate).
  const claim = await prisma.magicLink.updateMany({
    where: { token, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (claim.count === 0) return NextResponse.json({ error: "token_already_used" }, { status: 410 });

  const account = await prisma.account.findUnique({ where: { email: link.email } });
  if (!account) return NextResponse.json({ error: "account_not_found" }, { status: 404 });

  // Rotate: brand-new key, old one is overwritten (and thus invalidated).
  const newKey = generateApiKey();
  const updated = await prisma.account.update({
    where: { id: account.id },
    data: { apiKey: newKey, emailVerifiedAt: account.emailVerifiedAt ?? new Date() },
  });

  return NextResponse.json({
    status: "key_rotated",
    handle: updated.handle,
    email: updated.email,
    api_key: updated.apiKey,
    account_id: updated.id,
    note: "Your previous API key has been invalidated. Update your agent with this new key.",
  });
}
