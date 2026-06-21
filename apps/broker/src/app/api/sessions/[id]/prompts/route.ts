import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountDual, SESSION_COOKIE_NAME } from "@/lib/auth";
import { sessionStartPrompts } from "@/lib/notify.mjs";

export const runtime = "nodejs";

/**
 * GET /api/sessions/:id/prompts — the two canonical paste prompts for a session
 * the caller started (cookie or bearer; must be the VISITOR). { your_prompt }
 * goes to your own agent (visitor side); { friend_prompt } is texted to the
 * friend for their agent (host side). Same DRY pattern as the wake-prompt
 * endpoint — language lives once in notify.mjs.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const account = await getAccountDual(req.headers.get("authorization"), req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const session = await prisma.session.findUnique({ where: { id }, include: { invite: { include: { host: true, visitor: true } } } });
  if (!session) return NextResponse.json({ error: "session_not_found" }, { status: 404 });
  // Prompts are for the initiator (visitor). Only they should see the join code.
  if (session.invite.visitorAccountId !== account.id) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // Friend label: show the host handle only if they're a real (verified) account;
  // a freshly-created pending host (email invite) stays a generic "a friend".
  const friendLabel = session.invite.host.emailVerifiedAt ? session.invite.host.handle : null;
  const prompts = sessionStartPrompts({
    inviterHandle: session.invite.visitor.handle,
    friendLabel,
    sessionId: id,
    code: session.invite.code,
    scopes: session.invite.scopes,
    expiresAt: session.invite.expiresAt,
    topic: session.invite.message ?? null,
  });
  return NextResponse.json({ session_id: id, code: session.invite.code, ...prompts });
}
