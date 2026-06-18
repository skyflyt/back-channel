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

  let body: { session_id?: string; role?: string; cursor?: number; send?: string; wait_seconds?: number };
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
  if (body.send != null && typeof body.send === "string" && Buffer.byteLength(body.send, "utf8") > MAX_FRAME_BYTES) {
    return NextResponse.json({ error: "frame_too_large", detail: `max ${MAX_FRAME_BYTES} bytes` }, { status: 413 });
  }

  const session = await prisma.session.findUnique({ where: { id: sessionId }, include: { invite: true } });
  if (!session) return NextResponse.json({ error: "session_not_found" }, { status: 404 });
  if (session.endedAt) return NextResponse.json({ error: "session_ended", reason: session.endReason }, { status: 410 });

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
    sendData: typeof body.send === "string" ? body.send : null,
    waitMs: typeof body.wait_seconds === "number" ? body.wait_seconds * 1000 : 0,
    session,
  });

  return NextResponse.json(result);
}
