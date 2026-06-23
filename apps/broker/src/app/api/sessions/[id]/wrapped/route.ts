import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, SESSION_COOKIE_NAME } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * GET /api/sessions/:id/wrapped — cookie (browser). Returns the caller's own
 * HPKE-sealed session key K (Session.userWrap[myAccountId]) so the browser can
 * unwrap it with its mirror private key and decrypt the thread
 * (docs/user-side-decryption.md §8/§9).
 *
 * Opaque 404 for: no such session, not a participant, no real wrap, or a decoy
 * (decoys exist only so wrap *presence* never leaks per-session enrollment — S1).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const session = await prisma.session.findUnique({ where: { id }, include: { invite: true } });
  const opaque = () => NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!session) return opaque();
  const isParticipant = session.invite.hostAccountId === account.id || session.invite.visitorAccountId === account.id;
  if (!isParticipant) return opaque();

  const uw = (session.userWrap && typeof session.userWrap === "object" && !Array.isArray(session.userWrap))
    ? (session.userWrap as Record<string, { v?: number; enc?: unknown; ct?: unknown; decoy?: boolean }>) : null;
  const entry = uw?.[account.id];
  if (!entry || entry.decoy || typeof entry.enc !== "string" || typeof entry.ct !== "string") return opaque();

  return NextResponse.json({ wrap: { v: entry.v ?? 0, enc: entry.enc, ct: entry.ct } });
}
