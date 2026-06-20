import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromAuth } from "@/lib/auth";
import { pollSession } from "@/lib/relay";

export const runtime = "nodejs";
// Long-poll waits up to 25s; give the route headroom.
export const maxDuration = 30;

const MAX_FRAME_BYTES = 64 * 1024;

/**
 * POST /api/poll — HTTP transport for agents that can't hold a WebSocket.
 * Body: { session_id, role, cursor?, send?, wait_seconds? }
 *   - cursor: last seq the caller has seen (omit/0 = everything buffered)
 *   - send:   optional text frame to dispatch to the peer on this same call
 *   - wait_seconds: long-poll up to N seconds (capped at 25) for new frames
 * Returns: { frames: string[], next_cursor, peer_present }
 */
export async function POST(req: NextRequest) {
  const account = await getAccountFromAuth(req.headers.get("authorization"));
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { session_id?: string; role?: string; cursor?: number; send?: unknown; wait_seconds?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { session_id: sessionId, role } = body;
  if (!sessionId) return NextResponse.json({ error: "session_id_required" }, { status: 400 });
  if (role !== "visitor" && role !== "host") {
    return NextResponse.json({ error: "role_required", detail: "role must be 'visitor' or 'host'" }, { status: 400 });
  }

  // `send` may be a string (already a frame) OR an object/array (agents send
  // JSON frames as objects — the common case). Frames are stored as text, so
  // serialize non-strings rather than silently dropping them.
  let sendData: string | null = null;
  if (body.send != null && body.send !== "") {
    sendData = typeof body.send === "string" ? body.send : JSON.stringify(body.send);
    if (Buffer.byteLength(sendData, "utf8") > MAX_FRAME_BYTES) {
      return NextResponse.json({ error: "frame_too_large", detail: `max ${MAX_FRAME_BYTES} bytes` }, { status: 413 });
    }
  }

  const session = await prisma.session.findUnique({ where: { id: sessionId }, include: { invite: true } });
  if (!session) return NextResponse.json({ error: "session_not_found" }, { status: 404 });
  // C4: an ended session returns a clean, success-shaped end signal (not a bare
  // 410) so a polling agent can surface "the session has ended" in one read,
  // mirroring the `session.end` control frame WS peers receive.
  if (session.endedAt) {
    return NextResponse.json({
      ended: true,
      end_reason: session.endReason ?? "ended",
      frames: [],
      next_cursor: typeof body.cursor === "number" ? body.cursor : 0,
      peer_status: "asleep",
    });
  }

  // Participant + role check: the caller's account must own the role it claims.
  const expectedRole =
    session.invite.visitorAccountId === account.id ? "visitor" :
    session.invite.hostAccountId === account.id ? "host" : null;
  if (!expectedRole) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (expectedRole !== role) {
    return NextResponse.json({ error: "role_mismatch", detail: `your account is the ${expectedRole} on this session` }, { status: 403 });
  }

  const result = await pollSession({
    sessionId,
    role,
    cursor: typeof body.cursor === "number" ? body.cursor : 0,
    sendData,
    waitMs: typeof body.wait_seconds === "number" ? body.wait_seconds * 1000 : 0,
    session,
  });

  return NextResponse.json(result);
}
