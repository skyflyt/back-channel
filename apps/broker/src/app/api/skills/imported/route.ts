import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromAuth, getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * GET /api/skills/imported — templates this account has imported (provenance /
 * audit). Metadata only; the actual copy lives on the importer's local agent.
 * Reversible: DELETE /api/skills/imported?id=<importId> removes the record (the
 * agent deletes its local copy alongside).
 */
export async function GET(req: NextRequest) {
  const account = (await getAccountFromAuth(req.headers.get("authorization"))) ?? (await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value));
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rows = await prisma.skillImport.findMany({ where: { importedByAccountId: account.id }, orderBy: { importedAt: "desc" } });
  // Best-effort enrich with the source skill's name/author (may be gone if deleted).
  const out = await Promise.all(rows.map(async (r) => {
    const sk = await prisma.userSkill.findUnique({ where: { id: r.skillId }, include: { account: true } });
    return { import_id: r.id, skill_id: r.skillId, name: sk?.name ?? null, author_handle: sk?.account.handle ?? null, imported_at: r.importedAt.toISOString() };
  }));
  return NextResponse.json({ imports: out });
}

export async function DELETE(req: NextRequest) {
  const bearer = await getAccountFromAuth(req.headers.get("authorization"));
  const account = bearer ?? (await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value));
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // L4 (security-pass-2026-07-03.md): missing CSRF guard on the cookie-auth path — matches
  // the copy/route.ts fix and sibling routes' bearer-or-cookie+CSRF pattern.
  if (!bearer && !csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return NextResponse.json({ error: "csrf" }, { status: 403 });
  const importId = new URL(req.url).searchParams.get("id");
  if (!importId) return NextResponse.json({ error: "id_required" }, { status: 400 });
  await prisma.skillImport.deleteMany({ where: { id: importId, importedByAccountId: account.id } });
  return NextResponse.json({ ok: true });
}
