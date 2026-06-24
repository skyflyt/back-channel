import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { getAccountFromCookie, SESSION_COOKIE_NAME } from "@/lib/auth";
import { isPublicToken, buildEnvelope, landingHtml } from "@/lib/artifact";

export const runtime = "nodejs";

// Uniform-opaque response for unknown / revoked / expired / ineligible tokens (spec §3.7):
// every failure looks identical so a token can't be probed for existence or state.
function gone(wantsJson: boolean) {
  if (wantsJson) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const html = `<!doctype html><meta charset="utf-8"><title>Not found · Back Channel</title>
<body style="font:16px/1.5 -apple-system,Segoe UI,sans-serif;max-width:520px;margin:80px auto;padding:0 20px;text-align:center;color:#444">
<h1 style="font-size:22px">This link isn't available</h1>
<p>It may have expired, been revoked, or never existed. Ask whoever shared it for a fresh link.</p>
<p style="margin-top:28px"><a href="https://back-channel.app" style="color:#4351e8">Back Channel</a></p></body>`;
  return new NextResponse(html, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
}

/**
 * GET /a/<token> — public recipient endpoint for a one-paste artifact share (spec §3.2).
 * Content-negotiates: agents (Accept: application/json) get the signed envelope JSON;
 * browsers get a human landing page with the universal paste prompt. No BC account needed.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const accept = req.headers.get("accept") ?? "";
  const wantsJson = accept.includes("application/json");

  // IP-scoped rate limit blunts enumeration of the 160-bit token space.
  const rl = rateLimit("artifact-fetch", clientIp(req.headers.get("x-forwarded-for")), 60, 60_000);
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });

  const { token } = await params;
  if (!isPublicToken(token)) return gone(wantsJson);

  const art = await prisma.userSkill.findUnique({ where: { publicToken: token } });
  if (!art) return gone(wantsJson);

  // State gates — all collapse to the same opaque 404.
  if (art.publicRevokedAt) return gone(wantsJson);
  if (art.publicExpiresAt && art.publicExpiresAt <= new Date()) return gone(wantsJson);
  if (!art.signature) return gone(wantsJson); // public artifacts must be signed
  const type = art.type || "skill";
  if (type === "skill" && art.kind === "rpc") return gone(wantsJson); // session-scoped, never public
  if (type === "scheduled_task") {
    const m = (art.manifest && typeof art.manifest === "object" ? art.manifest : {}) as Record<string, unknown>;
    if (m.public_share_allowed !== true) return gone(wantsJson);
  }

  const author = await prisma.account.findUnique({ where: { id: art.accountId }, select: { handle: true, agentPubkey: true, reserved: true } });
  if (!author || author.reserved) return gone(wantsJson); // author vanished or is a placeholder hold

  const row = {
    id: art.id, type, name: art.name, description: art.description, kind: art.kind,
    body: art.body, signature: art.signature, paramSchema: art.paramSchema, manifest: art.manifest,
    version: art.version, revision: art.revision, publicToken: art.publicToken, publicExpiresAt: art.publicExpiresAt,
  };

  if (wantsJson) {
    const envelope = buildEnvelope(row, { handle: author.handle, pubkey: author.agentPubkey }, token);
    return NextResponse.json(envelope, { headers: { "cache-control": "no-store" } });
  }
  // Swap the signup CTA for a "save to my library" affordance when a visitor is signed in.
  const signedIn = !!(await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value));
  return new NextResponse(landingHtml(row, { handle: author.handle }, token, { signedIn }), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
