import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateViewToken, viewTokenExpiry } from "@/lib/auth";
import { sendViewTokenEmail } from "@/lib/email";
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

// Opaque success — never reveal whether an account exists for this email.
const OPAQUE = {
  status: "link_sent",
  message: "If that email has a Back Channel account, a sign-in link is on its way.",
};

/**
 * POST /api/auth/view-token-request { email }
 * Emails a single-use, 15-min view-token link to a VERIFIED account so the
 * human can reach /account without pasting their API key. Always returns the
 * same opaque response (account existence is never disclosed).
 */
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

  // Same abuse posture as /api/accounts: per-IP (loose, shared office NAT) +
  // per-email (the real anti-spam cap). Every success path sends an email.
  const ip = clientIp(req.headers.get("x-forwarded-for"));
  const ipLimit = rateLimit("viewtoken:ip", ip, 30, HOUR);
  if (!ipLimit.ok) return tooMany(ipLimit.retryAfterSec);
  const emailLimit = rateLimit("viewtoken:email", email, 5, DAY);
  if (!emailLimit.ok) return tooMany(emailLimit.retryAfterSec);

  const account = await prisma.account.findUnique({ where: { email } });
  // Only verified accounts get a link; anything else returns OPAQUE silently.
  if (!account || !account.emailVerifiedAt) {
    return NextResponse.json(OPAQUE);
  }

  const token = generateViewToken();
  await prisma.viewToken.create({ data: { token, accountId: account.id, expiresAt: viewTokenExpiry() } });
  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "view-token.issued", detail: { ip } } });

  await sendViewTokenEmail({ to: email, handle: account.handle, token });
  return NextResponse.json(OPAQUE);
}
