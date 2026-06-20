import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * DELETE /api/trust/:handle — disable/revoke trust for a peer (delete your
 * directed row). Instant, one-sided, no notice to the peer. Idempotent. Per the
 * resolved spec there's no cooldown — the pair stays eligible, so the user can
 * toggle it back on anytime.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ handle: string }> }) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return NextResponse.json({ error: "csrf" }, { status: 403 });

  const { handle } = await params;
  const peer = await prisma.account.findUnique({ where: { handle } });
  if (peer) {
    await prisma.trustedPeer.deleteMany({ where: { accountId: account.id, trustedAccountId: peer.id } });
    await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "trust.revoked", detail: { peer: handle } } });
  }
  // Opaque OK regardless (don't reveal whether the handle/row existed).
  return NextResponse.json({ ok: true, handle, trusted: false });
}
