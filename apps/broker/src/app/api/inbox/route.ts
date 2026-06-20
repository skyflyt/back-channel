import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, SESSION_COOKIE_NAME } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * GET /api/inbox — dashboard Inbox (cookie). Pending, non-expired session
 * requests from trusted peers, newest first. Metadata only (requester handle,
 * scopes, message, timestamps) — never content.
 */
export async function GET(req: NextRequest) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Lazy expiry sweep: flip this recipient's stale pending rows to `expired` on
  // read (no scheduler needed; they already self-hide via the expiresAt filter).
  await prisma.inboxRequest.updateMany({
    where: { recipientAccountId: account.id, status: "pending", expiresAt: { lte: new Date() } },
    data: { status: "expired", resolvedAt: new Date() },
  }).catch(() => {});

  const rows = await prisma.inboxRequest.findMany({
    where: { recipientAccountId: account.id, status: "pending", expiresAt: { gt: new Date() } },
    include: { requester: true },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const requests = rows.map((r) => ({
    id: r.id,
    requester_handle: r.requester.handle,
    scopes: r.requestedScopes,
    message: r.message,
    created_at: r.createdAt.toISOString(),
    expires_at: r.expiresAt.toISOString(),
  }));
  return NextResponse.json({ requests });
}
