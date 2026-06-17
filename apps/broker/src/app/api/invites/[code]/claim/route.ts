import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromAuth } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  const account = await getAccountFromAuth(req.headers.get("authorization"));
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { code } = await params;

  const invite = await prisma.invite.findUnique({
    where: { code },
    include: { host: true, visitor: true },
  });
  if (!invite) return NextResponse.json({ error: "invite_not_found" }, { status: 404 });

  if (invite.hostAccountId !== account.id) {
    return NextResponse.json({ error: "not_the_host" }, { status: 403 });
  }
  if (invite.status !== "pending") {
    return NextResponse.json({ error: "invite_not_pending", status: invite.status }, { status: 409 });
  }
  if (invite.expiresAt < new Date()) {
    await prisma.invite.update({ where: { id: invite.id }, data: { status: "expired" } });
    return NextResponse.json({ error: "invite_expired" }, { status: 410 });
  }

  // Phase 3 MVP: skip out-of-band confirm — claim == confirmed in v0.3
  // Phase 3.1: send push to host's email/SMS, require explicit confirmation
  const updated = await prisma.$transaction(async (tx) => {
    const inv = await tx.invite.update({
      where: { id: invite.id },
      data: { status: "confirmed", claimedAt: new Date(), confirmedAt: new Date() },
    });
    const session = await tx.session.create({
      data: {
        inviteId: inv.id,
        scopesGranted: inv.scopes,
      },
    });
    return { invite: inv, session };
  });

  return NextResponse.json({
    session_id: updated.session.id,
    relay_url: `${process.env.PUBLIC_APP_URL ?? "wss://backchannel.app"}/relay/${updated.session.id}`,
    scopes: updated.invite.scopes,
    visitor_handle: invite.visitor.handle,
    visitor_pubkey: invite.visitor.agentPubkey ?? null,
  });
}

