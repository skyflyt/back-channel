import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * POST /api/account/agents/:id/rename { name } — relabel one of your agents
 * (cookie + CSRF). Naming mistakes happen; this doesn't touch the key.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return NextResponse.json({ error: "csrf" }, { status: 403 });

  let body: { name?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  const name = (body.name ?? "").trim().slice(0, 80);
  if (!name) return NextResponse.json({ error: "name_required" }, { status: 400 });

  const { id } = await params;
  const agent = await prisma.agentToken.findUnique({ where: { id } });
  if (!agent || agent.accountId !== account.id) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await prisma.agentToken.update({ where: { id }, data: { name } });
  return NextResponse.json({ ok: true, id, name });
}
