import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromAuth } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const account = await getAccountFromAuth(req.headers.get("authorization"));
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const session = await prisma.session.findUnique({
    where: { id },
    include: { invite: { include: { host: true, visitor: true } } },
  });
  if (!session) return NextResponse.json({ error: "session_not_found" }, { status: 404 });

  const isParticipant =
    session.invite.hostAccountId === account.id ||
    session.invite.visitorAccountId === account.id;
  if (!isParticipant) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  return NextResponse.json({
    id: session.id,
    started_at: session.startedAt.toISOString(),
    ended_at: session.endedAt?.toISOString() ?? null,
    end_reason: session.endReason,
    scopes_granted: session.scopesGranted,
    host_handle: session.invite.host.handle,
    visitor_handle: session.invite.visitor.handle,
  });
}

