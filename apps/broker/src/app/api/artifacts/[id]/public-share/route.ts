import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { genPublicToken, ttlToExpiry } from "@/lib/artifact";

export const runtime = "nodejs";
const APP_URL = process.env.PUBLIC_APP_URL ?? "https://back-channel.app";

/**
 * POST /api/artifacts/:id/public-share — owner mints a one-paste public share link
 * (spec §3). Decided gates: signature required on every public artifact; RPC skills
 * are session-scoped and cannot be public-shared; a scheduled_task needs the author's
 * explicit public_share_allowed opt-in (server-enforced). Returns { token, url, expires_at }.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return NextResponse.json({ error: "csrf" }, { status: 403 });

  // Per-author cap on link minting (spec §3.6).
  const rl = rateLimit("publicshare", account.id, 30, 60_000);
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });

  const { id } = await params;
  let body: { ttl?: string } = {};
  try { body = await req.json(); } catch { /* default ttl */ }

  const art = await prisma.userSkill.findUnique({ where: { id } });
  if (!art || art.accountId !== account.id) return NextResponse.json({ error: "not_found" }, { status: 404 }); // owner-only, opaque

  const type = art.type || "skill";
  // Decided rules:
  if (type === "skill" && art.kind === "rpc") {
    return NextResponse.json({ error: "rpc_not_shareable", message: "RPC skills run during a live session and can't be shared by public link." }, { status: 400 });
  }
  if (!art.signature) {
    return NextResponse.json({ error: "signature_required", message: "This artifact must be signed by its author before it can be publicly shared." }, { status: 409 });
  }
  if (type === "scheduled_task") {
    const m = (art.manifest && typeof art.manifest === "object" ? art.manifest : {}) as Record<string, unknown>;
    if (m.public_share_allowed !== true) {
      return NextResponse.json({ error: "opt_in_required", message: "A scheduled task installs a recurring job on a stranger's agent — enable public sharing for it first." }, { status: 403 });
    }
  }

  // Reuse an active token; otherwise mint a fresh one.
  const active = art.publicToken && !art.publicRevokedAt && (!art.publicExpiresAt || art.publicExpiresAt > new Date());
  const token = active ? art.publicToken! : genPublicToken();
  const expiresAt = ttlToExpiry(body.ttl ?? "7d");
  await prisma.userSkill.update({ where: { id }, data: { publicToken: token, publicExpiresAt: expiresAt, publicRevokedAt: null } });
  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "artifact.public_shared", detail: { artifact: id, type, ttl: body.ttl ?? "7d" } } }).catch(() => {});

  return NextResponse.json({ token, url: `${APP_URL}/a/${token}`, expires_at: expiresAt?.toISOString() ?? null });
}
