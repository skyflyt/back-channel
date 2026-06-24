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
 * PATCH /api/skills/:id — update your own artifact (bearer or cookie+CSRF).
 * Light fields: `discoverable` (Tier 2.5 trust-circle toggle), `name`, `description`.
 * Full edit (UI CRUD): `body`, `manifest`, `param_schema`, `revision`, plus an
 * agent-supplied `signature`.
 *
 * Content edits (body/manifest/name/param_schema) bump `version` and INVALIDATE any
 * existing signature: the broker can't re-sign (it holds no private key — only the
 * author's agent can), so it clears the stale signature and, if the artifact had a
 * live public link, revokes it rather than serving content the recipient can't verify.
 * The artifact then needs the agent to re-sign before it can be public-shared again.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const bearer = await getAccountFromAuth(req.headers.get("authorization"));
  const account = bearer ?? (await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value));
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!bearer && !csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return NextResponse.json({ error: "csrf" }, { status: 403 });

  const { id } = await params;
  const skill = await prisma.userSkill.findUnique({ where: { id } });
  if (!skill || skill.accountId !== account.id) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: { discoverable?: boolean; name?: string; description?: string; body?: string; manifest?: unknown; param_schema?: unknown; revision?: string; signature?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }

  const data: Record<string, unknown> = {};
  if (typeof body.discoverable === "boolean") data.discoverable = body.discoverable;
  if (typeof body.name === "string" && body.name) data.name = body.name;
  if (typeof body.description === "string") data.description = body.description;
  if (typeof body.body === "string" && body.body) data.body = body.body;
  if (body.manifest !== undefined) data.manifest = body.manifest && typeof body.manifest === "object" ? (body.manifest as object) : null;
  if (body.param_schema !== undefined) data.paramSchema = body.param_schema === null ? null : (body.param_schema as object);
  if (typeof body.revision === "string") data.revision = body.revision;

  // scheduled_task manifest sanity (mirror the create gate).
  if ((skill.type || "skill") === "scheduled_task" && data.manifest) {
    const m = data.manifest as Record<string, unknown>;
    if (typeof m.cron !== "string" || typeof m.prompt !== "string") {
      return NextResponse.json({ error: "scheduled_task_manifest_invalid", message: "scheduled_task manifest needs string `cron` and `prompt`." }, { status: 400 });
    }
  }

  const contentChanged = "body" in data || "manifest" in data || "name" in data || "paramSchema" in data;
  if (contentChanged) {
    if (typeof body.signature === "string" && body.signature) {
      data.signature = body.signature; // caller re-signed in the same request
    } else {
      data.signature = null;            // stale — agent must re-sign before public-share
      if (skill.publicToken && !skill.publicRevokedAt) data.publicRevokedAt = new Date(); // don't serve unverifiable content
    }
    data.version = { increment: 1 };
  } else if (typeof body.signature === "string" && body.signature) {
    data.signature = body.signature;    // pure (re-)sign with no content change
  }

  if (Object.keys(data).length === 0) return NextResponse.json({ error: "no_valid_fields" }, { status: 400 });

  const updated = await prisma.userSkill.update({ where: { id }, data });
  if (contentChanged) await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "skill.edited", detail: { skill: id, version: updated.version, public_revoked: !!data.publicRevokedAt } } }).catch(() => {});
  return NextResponse.json({ ok: true, id, discoverable: updated.discoverable, name: updated.name, version: updated.version, signed: !!updated.signature, public_revoked: !!data.publicRevokedAt });
}
