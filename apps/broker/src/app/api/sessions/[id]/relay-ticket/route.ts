import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromAuth } from "@/lib/auth";
import { mintRelayTicket } from "@/lib/relay";

export const runtime = "nodejs";

/**
 * POST /api/sessions/:id/relay-ticket — mint a short-lived, single-use ticket
 * for the WS relay upgrade (C1 fix).
 *
 * The old WS upgrade authenticated with ONLY `token === sessionId` and a
 * client-asserted `role` — since the session id shows up in the /sessions/:id
 * watch URL, relay_url, Referer, and logs, anyone who learned it could connect
 * as EITHER party and read/inject frames on a live cross-account session.
 *
 * This endpoint is the only legitimate source of a ticket: bearer-authed,
 * participant-checked, and the role is DERIVED from the invite's
 * hostAccountId/visitorAccountId — never taken from a request param. The
 * ticket is redeemed exactly once by handleRelayUpgrade (src/lib/relay.mjs),
 * which is the only place role is ever assigned to a socket.
 *
 * Agent runtimes that reconnect per turn call this endpoint fresh each time
 * (a ticket is single-use and only lives ~60s) — that's expected, not a
 * workaround; see skill/REFERENCE.md's reconnect guidance.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const account = await getAccountFromAuth(req.headers.get("authorization"));
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const session = await prisma.session.findUnique({ where: { id }, include: { invite: true } });
  if (!session) return NextResponse.json({ error: "session_not_found" }, { status: 404 });
  if (session.endedAt) return NextResponse.json({ error: "session_ended" }, { status: 410 });

  const role =
    session.invite.visitorAccountId === account.id ? "visitor" :
    session.invite.hostAccountId === account.id ? "host" : null;
  if (!role) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { ticket, expiresAt } = mintRelayTicket({ sessionId: id, role, accountId: account.id });

  return NextResponse.json({
    ticket,
    role,
    session_id: id,
    expires_at: expiresAt.toISOString(),
  });
}
