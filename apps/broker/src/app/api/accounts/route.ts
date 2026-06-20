import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateHandle, generateMagicLinkToken, magicLinkExpiry, hashToken } from "@/lib/auth";
import { sendVerificationEmail } from "@/lib/email";
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

export async function POST(req: NextRequest) {
  let body: { email?: string; display_name?: string; agent_endpoint?: string; agent_pubkey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.email || !body.email.includes("@")) {
    return NextResponse.json({ error: "email_required" }, { status: 400 });
  }

  const email = body.email.trim().toLowerCase();
  const handle = generateHandle(email);

  // Abuse guard: every successful path below sends an email (Resend quota +
  // domain reputation) and may create an account. The per-target-email cap
  // (3/24h) is the real anti-spam control. The per-IP cap is loosened to 30/hr
  // because corporate users onboard from behind a shared office NAT (one
  // egress IP for the whole company) — 5/hr would 429 the 6th coworker.
  const ip = clientIp(req.headers.get("x-forwarded-for"));
  const ipLimit = rateLimit("accounts:ip", ip, 30, HOUR);
  if (!ipLimit.ok) return tooMany(ipLimit.retryAfterSec);

  const emailLimit = rateLimit("accounts:email", email, 3, DAY);
  if (!emailLimit.ok) return tooMany(emailLimit.retryAfterSec);

  // Phase 3.1: account is created PENDING with no apiKey. Verified at the magic-link step.
  // If account already exists:
  //   - verified: tell them to use the existing API key (don't reveal whether it exists for privacy)
  //   - pending:  resend the magic link
  let account = await prisma.account.findUnique({ where: { email } });
  let isResend = false;

  if (account) {
    if (account.emailVerifiedAt) {
      // Already verified — for security, don't reveal that the account exists. Just say "check your email" anyway.
      // (We could send a "you already have an account, here's how to reset" email, but for MVP, opaque is fine.)
      return NextResponse.json({
        handle: account.handle,
        status: "verification_sent",
        message: "If this email isn't already verified, you'll get a verification link shortly.",
      });
    }
    // Account exists but unverified -> resend
    isResend = true;
  } else {
    // Create new pending account
    try {
      account = await prisma.account.create({
        data: {
          email,
          handle,
          displayName: body.display_name,
          agentEndpoint: body.agent_endpoint,
          agentPubkey: body.agent_pubkey,
          // apiKey is null until verification
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Unique constraint")) {
        return NextResponse.json({ error: "handle_taken", detail: "That handle is taken. Try a different email local part." }, { status: 409 });
      }
      return NextResponse.json({ error: "server_error", detail: msg }, { status: 500 });
    }
  }

  // Generate a fresh magic-link token (invalidate old one if resending)
  const token = generateMagicLinkToken();
  if (isResend) {
    // Mark any existing tokens for this email as consumed
    await prisma.magicLink.updateMany({
      where: { email, consumedAt: null },
      data: { consumedAt: new Date() },
    });
  }
  await prisma.magicLink.create({
    data: {
      token: hashToken(token),   // store the hash; the raw token only travels in the email link
      email,
      expiresAt: magicLinkExpiry(),
    },
  });

  const sent = await sendVerificationEmail({ to: email, handle: account.handle, token });

  return NextResponse.json({
    handle: account.handle,
    status: "verification_sent",
    email_provider: sent ? "resend" : "log_only",
    message: sent
      ? `Check ${email} for a verification link. Expires in 24h.`
      : "Verification link logged to broker stdout (no email provider configured yet).",
  });
}
