import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, SESSION_COOKIE_NAME } from "@/lib/auth";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

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
  });
}
