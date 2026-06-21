import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromAuth, getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * DELETE /api/skills/:id — remove one of my own skills (bearer or cookie+CSRF).
 * Cascades its shares + (for templates) does not claw back already-imported
 * copies (you can't un-copy — see skill-sharing-epic §8.6).
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const bearer = await getAccountFromAuth(req.headers.get("authorization"));
  const account = bearer ?? (await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value));
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!bearer && !csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return NextResponse.json({ error: "csrf" }, { status: 403 });

  const { id } = await params;
  const skill = await prisma.userSkill.findUnique({ where: { id } });
  if (!skill || skill.accountId !== account.id) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await prisma.userSkill.delete({ where: { id } });
  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "skill.deleted", detail: { skill: id } } }).catch(() => {});
  return NextResponse.json({ ok: true });
}

/**
 * PATCH /api/skills/:id { discoverable?, name?, description? } — update your own
 * skill. `discoverable` is the Tier 2.5 trust-circle toggle (name+description
 * visible to peers you trust; still NOT accessible without a direct share).
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const bearer = await getAccountFromAuth(req.headers.get("authorization"));
  const account = bearer ?? (await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value));
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!bearer && !csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return NextResponse.json({ error: "csrf" }, { status: 403 });

  const { id } = await params;
  const skill = await prisma.userSkill.findUnique({ where: { id } });
  if (!skill || skill.accountId !== account.id) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: { discoverable?: boolean; name?: string; description?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  const data: { discoverable?: boolean; name?: string; description?: string } = {};
  if (typeof body.discoverable === "boolean") data.discoverable = body.discoverable;
  if (typeof body.name === "string" && body.name) data.name = body.name;
  if (typeof body.description === "string") data.description = body.description;
  if (Object.keys(data).length === 0) return NextResponse.json({ error: "no_valid_fields" }, { status: 400 });

  const updated = await prisma.userSkill.update({ where: { id }, data });
  return NextResponse.json({ ok: true, id, discoverable: updated.discoverable, name: updated.name });
}
