import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateViewToken, viewTokenExpiry, hashToken, generateMagicLinkToken, magicLinkExpiry } from "@/lib/auth";
import { sendViewTokenEmail, sendVerificationEmail } from "@/lib/email";
import { rateLimit, clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function tooMany(retryAfterSec: number) {
  return NextResponse.json({ error: "rate_limited", message: "Too many requests. Please try again later." }, { status: 429, headers: { "Retry-After": String(retryAfterSec) } });
}

// Always opaque — never reveal account existence/state to an unauthenticated caller.
const opaque = () => NextResponse.json({ status: "link_sent", message: "If that email has a Back Channel account, a link is on its way." });

/**
 * POST /api/auth/dashboard-link { email } — "send me a link to my dashboard,
 * no key rotation." Opaque. By account state:
 *   - verified  → emails a view-token link to /account (no key change)
 *   - pending   → resends the verify link (so a stuck signup still gets in)
 *   - absent    → no-op (still opaque)
 * The dashboard-only path the agent uses for "open my Back Channel" without
 * touching the API key.
 */
export async function POST(req: NextRequest) {
  let body: { email?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  if (!body.email || !body.email.includes("@")) return NextResponse.json({ error: "email_required" }, { status: 400 });
  const email = body.email.trim().toLowerCase();

  const ip = clientIp(req.headers.get("x-forwarded-for"));
  if (!rateLimit("dashlink:ip", ip, 30, HOUR).ok) return tooMany(3600);
  const el = rateLimit("dashlink:email", email, 5, DAY);
  if (!el.ok) return tooMany(el.retryAfterSec);

  const account = await prisma.account.findUnique({ where: { email } });
  if (!account) return opaque();

  if (account.emailVerifiedAt) {
    const raw = generateViewToken();
    await prisma.viewToken.create({ data: { token: hashToken(raw), accountId: account.id, purpose: "account", expiresAt: viewTokenExpiry() } });
    await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "view-token.issued", detail: { via: "dashboard-link" } } }).catch(() => {});
    await sendViewTokenEmail({ to: email, handle: account.handle, token: raw });
  } else {
    // Pending: resend a verification link so a stuck signup can still get in.
    const token = generateMagicLinkToken();
    await prisma.magicLink.updateMany({ where: { email, consumedAt: null }, data: { consumedAt: new Date() } });
    await prisma.magicLink.create({ data: { token: hashToken(token), email, expiresAt: magicLinkExpiry() } });
    await sendVerificationEmail({ to: email, handle: account.handle, token });
  }
  return opaque();
}
