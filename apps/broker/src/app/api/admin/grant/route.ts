import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromAuth, getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * POST /api/admin/grant { handle } and /api/admin/revoke (same handler shape) —
 * any admin can grant/revoke admin. Guard: you cannot revoke the LAST admin
 * (lockout protection). Every grant/revoke is audited.
 */
export async function POST(req: NextRequest) {
  const bearer = await getAccountFromAuth(req.headers.get("authorization"));
  const me = bearer ?? (await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value));
  if (!me) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!me.admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!bearer && !csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return NextResponse.json({ error: "csrf" }, { status: 403 });

  let handle: string | undefined;
  try { handle = (await req.json())?.handle; } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  if (!handle) return NextResponse.json({ error: "handle_required" }, { status: 400 });
  const target = await prisma.account.findUnique({ where: { handle } });
  if (!target) return NextResponse.json({ error: "account_not_found" }, { status: 404 });

  await prisma.account.update({ where: { id: target.id }, data: { admin: true } });
  await prisma.accountAudit.create({ data: { accountId: me.id, eventType: "admin.granted", detail: { handle } } }).catch(() => {});
  return NextResponse.json({ ok: true, handle, admin: true });
}
