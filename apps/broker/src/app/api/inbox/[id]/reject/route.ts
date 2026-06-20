import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * POST /api/inbox/:id/reject — recipient declines a request (cookie + CSRF).
 * Marks it rejected; nothing is minted. Idempotent-ish (only flips a pending row).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return NextResponse.json({ error: "csrf" }, { status: 403 });

  const { id } = await params;
  const reqRow = await prisma.inboxRequest.findUnique({ where: { id } });
  if (!reqRow || reqRow.recipientAccountId !== account.id) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await prisma.inboxRequest.updateMany({ where: { id, status: "pending" }, data: { status: "rejected", resolvedAt: new Date() } });
  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "inbox.rejected", detail: { request: id } } });
  return NextResponse.json({ ok: true, status: "rejected" });
}
