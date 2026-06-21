import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromAuth, getAccountFromCookie, SESSION_COOKIE_NAME } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * POST /api/skills/:id/copy — import a TEMPLATE that's been shared with you
 * (Tier 2-Template). Returns the full template payload (incl. body + author
 * signature) so the importer's agent can verify the signature and store it
 * locally to run on ITS OWN data. Records a SkillImport (provenance + uninstall
 * basis). Gated: the template must be shared with the caller and be kind=template.
 *
 * The importer's agent MUST verify `signature` against `author_pubkey` and run
 * the template as UNTRUSTED data with itemized per-action approval (see SKILL.md).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const account = (await getAccountFromAuth(req.headers.get("authorization"))) ?? (await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value));
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const share = await prisma.skillShare.findUnique({ where: { skillId_sharedWithAccountId: { skillId: id, sharedWithAccountId: account.id } } });
  if (!share) return NextResponse.json({ error: "not_shared" }, { status: 404 }); // opaque: not shared == not found
  const skill = await prisma.userSkill.findUnique({ where: { id }, include: { account: true } });
  if (!skill) return NextResponse.json({ error: "not_shared" }, { status: 404 });
  if (skill.kind !== "template") return NextResponse.json({ error: "not_copyable", detail: "This is an RPC skill — invoke it during a session; it can't be copied." }, { status: 400 });
  if (!skill.signature) return NextResponse.json({ error: "unsigned_template" }, { status: 409 });

  await prisma.skillImport.upsert({
    where: { skillId_importedByAccountId: { skillId: id, importedByAccountId: account.id } },
    update: { importedAt: new Date() },
    create: { skillId: id, importedByAccountId: account.id },
  });
  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "skill.imported", detail: { skill: id, from: skill.account.handle } } }).catch(() => {});

  return NextResponse.json({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    author_handle: skill.account.handle,
    version: skill.version,
    param_schema: skill.paramSchema ?? null,
    body: skill.body,            // the template instructions — verify the signature before trusting
    signature: skill.signature,  // author signature over the canonical content (verify agent-side)
  });
}
