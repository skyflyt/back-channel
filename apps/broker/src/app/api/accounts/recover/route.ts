import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateMagicLinkToken, generateRecoveryToken, magicLinkExpiry } from "@/lib/auth";
import { sendVerificationEmail, sendRecoveryEmail } from "@/lib/email";
import { rateLimit, clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function tooMany(retryAfterSec: number) {
  return NextResponse.json(
    { error: "rate_limited", message: "Too many requests. Please try again later." },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
  );
}

// Opaque response — identical regardless of whether the account exists, is
// verified, or is pending. We never reveal account existence to the caller.
function opaque(emailProvider: string | null) {
  return NextResponse.json({
    status: "recovery_sent",
    email_provider: emailProvider,
    message: "If an account exists for that email, a recovery link is on its way. Check your inbox.",
  });
}

export async function POST(req: NextRequest) {
  let body: { email?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.email || !body.email.includes("@")) {
    return NextResponse.json({ error: "email_required" }, { status: 400 });
  }
  const email = body.email.trim().toLowerCase();

  // Same abuse profile as /api/accounts: sends email + can be sprayed at a
  // victim inbox. Per-IP loosened to 30/hr for corporate-NAT onboarding; the
  // per-target-email cap (3/24h) is the real anti-spam control.
  const ip = clientIp(req.headers.get("x-forwarded-for"));
  const ipLimit = rateLimit("accounts:ip", ip, 30, HOUR);
  if (!ipLimit.ok) return tooMany(ipLimit.retryAfterSec);
  const emailLimit = rateLimit("recover:email", email, 3, DAY);
  if (!emailLimit.ok) return tooMany(emailLimit.retryAfterSec);

  const account = await prisma.account.findUnique({ where: { email } });

  // Account doesn't exist — opaque success, send nothing.
  if (!account) return opaque(null);

  // Invalidate any outstanding tokens for this email, then mint a fresh one.
  await prisma.magicLink.updateMany({
    where: { email, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  if (account.emailVerifiedAt) {
    // Verified -> recovery token that ROTATES the key when consumed.
    const token = generateRecoveryToken();
    await prisma.magicLink.create({ data: { token, email, expiresAt: magicLinkExpiry() } });
    const sent = await sendRecoveryEmail({ to: email, handle: account.handle, token });
    return opaque(sent ? "resend" : "log_only");
  }

  // Pending (never verified) -> normal verification token, so a user stuck in
  // either state gets a working link from this one endpoint.
  const token = generateMagicLinkToken();
  await prisma.magicLink.create({ data: { token, email, expiresAt: magicLinkExpiry() } });
  const sent = await sendVerificationEmail({ to: email, handle: account.handle, token });
  return opaque(sent ? "resend" : "log_only");
}
