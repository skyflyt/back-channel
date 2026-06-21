import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromAuth, getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid } from "@/lib/auth";

export const runtime = "nodejs";

// Resolve the caller from EITHER bearer (agent) or bc_session cookie (dashboard).
async function caller(req: NextRequest) {
  return (await getAccountFromAuth(req.headers.get("authorization"))) ?? (await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value));
}

/**
 * GET /api/skills — the caller's own skills + who each is shared with.
 * (bearer or cookie). The owner agent uses this to answer a peer's skills.list;
 * the dashboard uses it for the "Your Skills" section.
 */
export async function GET(req: NextRequest) {
  const account = await caller(req);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const skills = await prisma.userSkill.findMany({
    where: { accountId: account.id },
    include: { shares: { include: { sharedWith: true } } },
    orderBy: { updatedAt: "desc" },
  });
  return NextResponse.json({
    skills: skills.map((s) => ({
      id: s.id, name: s.name, description: s.description, kind: s.kind, version: s.version,
      param_schema: s.paramSchema ?? null,
      discoverable: s.discoverable,
      shared_with: s.shares.map((sh) => sh.sharedWith.handle),
      updated_at: s.updatedAt.toISOString(),
    })),
  });
}

/**
 * POST /api/skills — publish a capability (agent-side, bearer). Tier 2-RPC:
 * kind defaults to "rpc" (runs on the owner's side). Templates (kind:"template")
 * must carry a signature (enforced when Tier 2-Template ships).
 */
export async function POST(req: NextRequest) {
  // Agent (bearer) is the normal publisher; allow cookie+CSRF too for a future UI.
  const bearer = await getAccountFromAuth(req.headers.get("authorization"));
  const account = bearer ?? (await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value));
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!bearer && !csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return NextResponse.json({ error: "csrf" }, { status: 403 });

  let body: { name?: string; description?: string; kind?: string; body?: string; param_schema?: unknown; signature?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  if (!body.name || !body.body) return NextResponse.json({ error: "name_and_body_required" }, { status: 400 });
  const kind = body.kind === "template" ? "template" : "rpc";
  if (kind === "template" && !body.signature) return NextResponse.json({ error: "template_requires_signature" }, { status: 400 });

  const skill = await prisma.userSkill.create({
    data: {
      accountId: account.id, name: body.name, description: body.description ?? null,
      kind, body: body.body, signature: body.signature ?? null,
      paramSchema: body.param_schema === undefined ? undefined : (body.param_schema as object),
    },
  });
  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "skill.published", detail: { skill: skill.id, name: skill.name, kind } } }).catch(() => {});
  return NextResponse.json({ ok: true, id: skill.id, name: skill.name, kind: skill.kind });
}
