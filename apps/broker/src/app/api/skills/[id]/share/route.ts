import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromAuth, getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * POST /api/skills/:id/share { peer_handle } — let a trusted peer invoke (RPC)
 * or copy (template) this skill. Gated: you must currently TRUST the peer
 * (your directed TrustedPeer row exists). bearer or cookie+CSRF. Idempotent.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const bearer = await getAccountFromAuth(req.headers.get("authorization"));
  const account = bearer ?? (await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value));
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!bearer && !csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return NextResponse.json({ error: "csrf" }, { status: 403 });

  const { id } = await params;
  let peerHandle: string | undefined;
  try { peerHandle = (await req.json())?.peer_handle; } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  if (!peerHandle) return NextResponse.json({ error: "peer_handle_required" }, { status: 400 });

  const skill = await prisma.userSkill.findUnique({ where: { id } });
  if (!skill || skill.accountId !== account.id) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const peer = await prisma.account.findUnique({ where: { handle: peerHandle } });
  if (!peer) return NextResponse.json({ error: "not_eligible" }, { status: 400 });
  // Must trust the peer to share with them (one-sided trust suffices to share;
  // invocation still happens inside a session both sides consent to).
  const trust = await prisma.trustedPeer.findUnique({ where: { accountId_trustedAccountId: { accountId: account.id, trustedAccountId: peer.id } } });
  if (!trust) return NextResponse.json({ error: "not_trusted", detail: "Turn on trust for this agent before sharing a skill with them." }, { status: 400 });

  await prisma.skillShare.upsert({
    where: { skillId_sharedWithAccountId: { skillId: id, sharedWithAccountId: peer.id } },
    update: {},
    create: { skillId: id, sharedWithAccountId: peer.id, sharedBy: account.id },
  });
  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "skill.shared", detail: { skill: id, with: peerHandle } } }).catch(() => {});
  return NextResponse.json({ ok: true, skill_id: id, shared_with: peerHandle });
}
