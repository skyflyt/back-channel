import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, generateInviteCode, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid } from "@/lib/auth";

export const runtime = "nodejs";

const ACCEPT_TTL_MIN = 60;

/**
 * POST /api/inbox/:id/accept — recipient approves a trusted peer's request
 * (cookie + CSRF). Mints a NORMAL Invite+Session (no code): requester=visitor,
 * recipient=host, scopes=requestedScopes, pre-confirmed. Both agents then run
 * the usual handshake + one-yes flow. Trust waived only the code, not the
 * per-session work.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return NextResponse.json({ error: "csrf" }, { status: 403 });

  const { id } = await params;
  const reqRow = await prisma.inboxRequest.findUnique({ where: { id } });
  if (!reqRow || reqRow.recipientAccountId !== account.id) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (reqRow.status !== "pending" || reqRow.expiresAt < new Date()) return NextResponse.json({ error: "not_pending", status: reqRow.status }, { status: 409 });

  // Atomic claim so a double-click can't mint two sessions.
  const claim = await prisma.inboxRequest.updateMany({ where: { id, status: "pending" }, data: { status: "accepted", resolvedAt: new Date() } });
  if (claim.count === 0) return NextResponse.json({ error: "not_pending" }, { status: 409 });

  // Mint invite + session (requester is the visitor, I'm the host), pre-confirmed.
  const code = generateInviteCode();
  const expiresAt = new Date(Date.now() + ACCEPT_TTL_MIN * 60 * 1000);
  const { session } = await prisma.$transaction(async (tx) => {
    const inv = await tx.invite.create({
      data: {
        code,
        hostAccountId: account.id,
        visitorAccountId: reqRow.requesterAccountId,
        scopes: reqRow.requestedScopes,
        ttlMinutes: ACCEPT_TTL_MIN,
        message: reqRow.message,
        expiresAt,
        status: "confirmed",
        claimedAt: new Date(),
        confirmedAt: new Date(),
      },
    });
    const ses = await tx.session.create({ data: { inviteId: inv.id, scopesGranted: inv.scopes } });
    return { session: ses };
  });
  await prisma.inboxRequest.update({ where: { id }, data: { sessionId: session.id } });
  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "inbox.accepted", detail: { request: id, sessionId: session.id } } });

  const base = (process.env.PUBLIC_APP_URL ?? "https://back-channel.app").replace(/^https?:/, "wss:");
  return NextResponse.json({
    ok: true,
    session_id: session.id,
    relay_url: `${base}/relay/${session.id}?role=host&token=${session.id}`,
    scopes: session.scopesGranted,
  });
}
