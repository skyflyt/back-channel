import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromAuth, getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid } from "@/lib/auth";
import { ARTIFACT_TYPES } from "@/lib/artifact";

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
      type: s.type || "skill",
      manifest: s.manifest ?? null,
      body: s.body, // owner-only authed list; the Library editor/inspector needs it
      signed: !!s.signature, // public-share requires a signature (spec §3); UI gates on this
      param_schema: s.paramSchema ?? null,
      discoverable: s.discoverable,
      shared_with: s.shares.map((sh) => sh.sharedWith.handle),
      // public-share state for the Library panel (token kept owner-only via this authed GET)
      public_token: s.publicToken && !s.publicRevokedAt && (!s.publicExpiresAt || s.publicExpiresAt > new Date()) ? s.publicToken : null,
      public_expires_at: s.publicExpiresAt?.toISOString() ?? null,
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

  let body: { name?: string; description?: string; kind?: string; type?: string; body?: string; param_schema?: unknown; signature?: string; manifest?: unknown; revision?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  if (!body.name || !body.body) return NextResponse.json({ error: "name_and_body_required" }, { status: 400 });

  // Polymorphic artifact type (spec §1.3). "skill" keeps the legacy rpc/template
  // semantics; "prompt"/"scheduled_task" are content artifacts (never RPC), so we
  // store them as kind:"template" and treat manifest as their typed payload.
  const type = ARTIFACT_TYPES.includes(body.type as never) ? body.type! : "skill";
  const kind = type === "skill" ? (body.kind === "template" ? "template" : "rpc") : "template";
  if (type === "skill" && kind === "template" && !body.signature) return NextResponse.json({ error: "template_requires_signature" }, { status: 400 });

  const manifest = body.manifest && typeof body.manifest === "object" ? (body.manifest as object) : undefined;
  // Type-specific manifest sanity (broker inspects, never executes).
  if (type === "scheduled_task") {
    const m = (manifest ?? {}) as Record<string, unknown>;
    if (typeof m.cron !== "string" || typeof m.prompt !== "string") {
      return NextResponse.json({ error: "scheduled_task_manifest_invalid", message: "scheduled_task manifest needs string `cron` and `prompt`." }, { status: 400 });
    }
  }

  const skill = await prisma.userSkill.create({
    data: {
      accountId: account.id, name: body.name, description: body.description ?? null,
      type, kind, body: body.body, signature: body.signature ?? null,
      manifest, revision: body.revision ?? null,
      paramSchema: body.param_schema === undefined ? undefined : (body.param_schema as object),
    },
  });
  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "skill.published", detail: { skill: skill.id, name: skill.name, kind, type } } }).catch(() => {});
  return NextResponse.json({ ok: true, id: skill.id, name: skill.name, kind: skill.kind, type });
}
