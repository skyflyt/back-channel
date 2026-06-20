import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountDual, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid } from "@/lib/auth";
import { kickSession } from "@/lib/relay";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Dual-auth: the agent (bearer) OR the human dashboard (bc_session cookie) may
  // end a session — both are legitimate kick surfaces.
  const account = await getAccountDual(req.headers.get("authorization"), req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // CSRF only matters for the browser/cookie path; bearer (agent) calls skip it.
  const hasCookie = !!req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const hasBearer = /^Bearer\s/.test(req.headers.get("authorization") ?? "");
  if (hasCookie && !hasBearer && !csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) {
    return NextResponse.json({ error: "csrf" }, { status: 403 });
  }

  const { id } = await params;

  const session = await prisma.session.findUnique({
    where: { id },
    include: { invite: true },
  });
  if (!session) return NextResponse.json({ error: "session_not_found" }, { status: 404 });

  const isParticipant =
    session.invite.hostAccountId === account.id ||
    session.invite.visitorAccountId === account.id;
  if (!isParticipant) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  await kickSession(id, "kicked_by_user");
  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "session.ended_manually", detail: { sessionId: id } } }).catch(() => {});
  return NextResponse.json({ ok: true });
}

