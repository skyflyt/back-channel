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
    include: { host: true, visitor: true, session: true },
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

  if (!invite.session) {
    return NextResponse.json({ error: "session_missing", detail: "Invite has no session — re-create invite" }, { status: 500 });
  }

  // Phase 3 MVP: skip out-of-band confirm. Magic-link / push lands in v0.4.
  await prisma.invite.update({
    where: { id: invite.id },
    data: { status: "confirmed", claimedAt: new Date(), confirmedAt: new Date() },
  });

  const base = (process.env.PUBLIC_APP_URL ?? "https://backchannel.app").replace(/^https?:/, "wss:");

  return NextResponse.json({
    session_id: invite.session.id,
    relay_url: `${base}/relay/${invite.session.id}?role=host&token=${invite.session.id}`,
    scopes: invite.scopes,
    visitor_handle: invite.visitor.handle,
    visitor_pubkey: invite.visitor.agentPubkey ?? null,
    message: invite.message,
  });
}
