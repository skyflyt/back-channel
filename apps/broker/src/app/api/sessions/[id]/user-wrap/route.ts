import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { getAccountFromAuth } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

// HPKE wrap of a 32-byte K: enc (X25519, ~44 b64 chars) + ct (~64 b64 chars). Cap
// well above that but bounded, so a compromised agent token can't store junk (nit §6).
const MAX_WRAP_CHARS = 600;

/**
 * POST /api/sessions/:id/user-wrap — bearer (agent). The agent posts the session
 * content key K, HPKE-sealed to its OWN user's mirror pubkey, so the user's browser
 * can later decrypt the thread (docs/user-side-decryption.md §7.1/§8).
 *
 * Guards (B4/B5): participant-only; version must equal the account's current
 * mirrorPubVersion (else 409 → agent refetches the pub); rate-limited so a stolen
 * agent token can't flood userWrap rewrites. The broker stores an opaque blob it
 * cannot open (I1).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const account = await getAccountFromAuth(req.headers.get("authorization"));
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;

  // ≤ 10 wrap-writes/min/account/session (a wrap is written ~once per session, twice
  // across a rotation — so a tight cap is safe and stops log-flooding).
  const rl = rateLimit("userwrap", `${account.id}:${id}`, 10, 60_000);
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });

  let body: { wrap?: { v?: number; enc?: unknown; ct?: unknown }; version?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }

  const enc = body.wrap?.enc, ct = body.wrap?.ct;
  if (typeof enc !== "string" || typeof ct !== "string" || !enc || !ct) {
    return NextResponse.json({ error: "malformed_wrap" }, { status: 400 });
  }
  if (enc.length + ct.length > MAX_WRAP_CHARS) {
    return NextResponse.json({ error: "wrap_too_large" }, { status: 413 });
  }

  // Version gate (B4): refuse a wrap sealed to a stale mirror pubkey.
  const version = account.mirrorPubVersion ?? 0;
  if (body.version !== version) {
    return NextResponse.json({ error: "stale_mirror_version", current: version }, { status: 409 });
  }
  // If the user never enrolled, there's nothing to wrap to — opaque success-skip.
  if (!account.mirrorPub) return NextResponse.json({ ok: true, skipped: "no_mirror" });

  const session = await prisma.session.findUnique({ where: { id }, include: { invite: true } });
  // Opaque 404 for both "no such session" and "not a participant" — don't confirm existence.
  if (!session) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const isParticipant = session.invite.hostAccountId === account.id || session.invite.visitorAccountId === account.id;
  if (!isParticipant) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Merge into the per-account map; never touch the peer's entry.
  const cur = (session.userWrap && typeof session.userWrap === "object" && !Array.isArray(session.userWrap))
    ? (session.userWrap as Record<string, unknown>) : {};
  const next = { ...cur, [account.id]: { v: version, enc, ct } };
  await prisma.session.update({ where: { id }, data: { userWrap: next as Prisma.InputJsonValue } });

  return NextResponse.json({ ok: true });
}
