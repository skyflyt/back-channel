import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { rateLimit, clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * GET /api/invites/:code — public probe for the /signup-and-claim page (QA round 3
 * HIGH #1). Confirms a code is a REAL, pending, unexpired invite before the page
 * shows a "you're invited" welcome — so a mistyped/bogus code can't render a fake
 * legit-looking welcome. Opaque: any invalid/expired/claimed/unknown code returns the
 * SAME 404 (no code-existence oracle). On success returns just the inviter handle +
 * the plaintext invite topic (the invitee already holds the code, so this is theirs).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  // Light rate-limit so the probe can't be used to brute-force codes.
  const rl = rateLimit("inviteprobe", clientIp(req.headers.get("x-forwarded-for")), 60, 60_000);
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });

  const { code } = await params;
  const gone = () => NextResponse.json({ error: "invalid_or_expired" }, { status: 404 });
  if (!code || !/^[A-Za-z0-9._-]{6,64}$/.test(code)) return gone();

  const invite = await prisma.invite.findUnique({ where: { code }, include: { host: true } });
  if (!invite || invite.status !== "pending" || invite.expiresAt < new Date()) return gone();

  return NextResponse.json({ valid: true, inviter_handle: invite.host.handle, message: invite.message ?? null });
}
