import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { relayUserFrame, recordAuthorCounter, authorCounterHighWater } from "@/lib/relay.mjs";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const MAX_FRAME_BYTES = 64 * 1024;   // matches the relay's per-frame cap
const ORIGIN_HUMAN = 1;

/** Parse the structured 96-bit IV (base64) → { origin, counter } without decrypting.
 *  The counter is AEAD-bound (GCM authenticates the IV), so reading it here is safe. */
function parseIv(ivB64: string): { origin: number; counter: bigint } | null {
  let b: Buffer;
  try { b = Buffer.from(ivB64, "base64"); } catch { return null; }
  if (b.length !== 12) return null;
  return { origin: (b[0] >> 7) & 1, counter: b.readBigUInt64BE(4) };
}

/**
 * GET /api/sessions/:id/frames?cursor=&limit= — cookie (browser). Streams the
 * session's sealed frame ciphertexts (BOTH directions) for the transcript view,
 * paginated by the global Frame.id cursor (docs/user-side-decryption.md §9).
 *
 * Returns CIPHERTEXT ONLY — the broker never decrypts. `role_dest` lets the client
 * map each frame to a side (a frame addressed to MY role was sent by the peer;
 * one addressed to the peer's role was sent by me). The client filters control
 * frames and orders by the inner authenticated timestamp — `seq` is broker-assigned
 * and NOT authenticated, so it's only a coarse signal. Ended sessions have no frames
 * (purged on end), so the transcript is open-session-only (§15).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const session = await prisma.session.findUnique({ where: { id }, include: { invite: true } });
  const opaque = () => NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!session) return opaque();
  const myRole = session.invite.hostAccountId === account.id ? "host"
    : session.invite.visitorAccountId === account.id ? "visitor" : null;
  if (!myRole) return opaque();

  const url = new URL(req.url);
  let cursor = 0n;
  try { cursor = BigInt(url.searchParams.get("cursor") ?? "0"); } catch { return NextResponse.json({ error: "bad_cursor" }, { status: 400 }); }
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT) || DEFAULT_LIMIT));

  const rows = await prisma.frame.findMany({
    where: { sessionId: id, id: { gt: cursor } },
    orderBy: { id: "asc" },
    take: limit,
  });

  return NextResponse.json({
    role: myRole,
    frames: rows.map((f) => ({ id: f.id.toString(), role_dest: f.roleDest, seq: f.seq, body: f.body, created_at: f.createdAt.toISOString() })),
    next_cursor: rows.length === limit ? rows[rows.length - 1].id.toString() : null,
    // Reseed source (§10): if the browser lost its local counter store, it resumes
    // above this high-water mark so it never reuses a (K, counter) it already burned.
    my_counter_high_water: authorCounterHighWater(id, account.id).toString(),
  });
}

/**
 * POST /api/sessions/:id/frames — cookie+CSRF (browser write path, "user takes the
 * wheel", §10). The browser posts a sealed frame it composed; the broker relays it
 * to the peer identically to an agent send. Broker stays content-blind: it reads the
 * monotonic counter from the (AEAD-bound) IV but never decrypts the body.
 *
 * Guards (B5): participant-only (opaque 404); CSRF; origin bit must be human;
 * per-author monotonic counter (replay/rollback → 409); send-rate-limited; size cap.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return NextResponse.json({ error: "csrf" }, { status: 403 });

  const { id } = await params;

  // Send-rate-limit (the agent-send analog): 60 frames/min/account/session.
  const rl = rateLimit("userframe", `${account.id}:${id}`, 60, 60_000);
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });

  let body: { frame?: { type?: unknown; v?: unknown; iv?: unknown; ct?: unknown; tag?: unknown } };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  const f = body.frame;
  if (!f || f.type !== "enc" || typeof f.iv !== "string" || typeof f.ct !== "string" || typeof f.tag !== "string") {
    return NextResponse.json({ error: "malformed_frame" }, { status: 400 });
  }
  const frameText = JSON.stringify({ type: "enc", v: f.v ?? 1, iv: f.iv, ct: f.ct, tag: f.tag });
  if (Buffer.byteLength(frameText, "utf8") > MAX_FRAME_BYTES) return NextResponse.json({ error: "frame_too_large" }, { status: 413 });

  const ivInfo = parseIv(f.iv);
  if (!ivInfo) return NextResponse.json({ error: "bad_iv" }, { status: 400 });
  // A browser frame MUST claim the human origin partition — it can't forge the
  // agent's IV space (collision-safety, §10).
  if (ivInfo.origin !== ORIGIN_HUMAN) return NextResponse.json({ error: "bad_origin" }, { status: 400 });

  const session = await prisma.session.findUnique({ where: { id }, include: { invite: true } });
  const opaque = () => NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!session) return opaque();
  if (session.endedAt) return NextResponse.json({ error: "session_ended" }, { status: 410 });
  const myRole = session.invite.hostAccountId === account.id ? "host"
    : session.invite.visitorAccountId === account.id ? "visitor" : null;
  if (!myRole) return opaque();

  // Monotonic per-author counter (replay/rollback defense, B5).
  if (!recordAuthorCounter(id, account.id, ivInfo.counter)) {
    return NextResponse.json({ error: "stale_counter", high_water: authorCounterHighWater(id, account.id).toString() }, { status: 409 });
  }

  try {
    const seq = await relayUserFrame({ sessionId: id, role: myRole, session, frameText });
    return NextResponse.json({ ok: true, seq });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "session_ended") return NextResponse.json({ error: "session_ended" }, { status: 410 });
    return NextResponse.json({ error: "relay_failed" }, { status: 500 });
  }
}
