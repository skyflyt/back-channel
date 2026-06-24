import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromAuth, getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { genPublicToken, ttlToExpiry, contentHash, ARTIFACT_TYPES, TTL_HUMAN } from "@/lib/artifact";

export const runtime = "nodejs";
const APP_URL = process.env.PUBLIC_APP_URL ?? "https://back-channel.app";

/**
 * POST /api/artifacts/share — the agent-side "share this" magic moment. One call:
 * dedup against the caller's library, create-if-new, mint (or reuse) a public link,
 * and return a paste-prompt + summary the agent reads back to the user.
 *
 * The CALLER (the user's agent) signs the artifact with its own key before calling —
 * the broker never holds a private key. `signature` is required to mint a public link;
 * a scheduled_task additionally needs `public_share_allowed`.
 *
 * Body: { type, name, description?, body, manifest?, param_schema?, signature?, ttl? }
 */
export async function POST(req: NextRequest) {
  const bearer = await getAccountFromAuth(req.headers.get("authorization"));
  const account = bearer ?? (await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value));
  if (!account) {
    // Friendly, not a bare 401 — the agent surfaces this to the user (edge case: not connected).
    return NextResponse.json({ error: "not_connected", message: "This agent isn't connected to Back Channel yet. Ask the user to open back-channel.app/account, generate a connection code, and connect you first." }, { status: 401 });
  }
  if (!bearer && !csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return NextResponse.json({ error: "csrf" }, { status: 403 });

  const rl = rateLimit("artifact-share", account.id, 30, 60_000);
  if (!rl.ok) return NextResponse.json({ error: "rate_limited", message: "You're sharing a lot quickly — give it a minute." }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });

  let b: { type?: string; name?: string; description?: string; body?: string; manifest?: unknown; param_schema?: unknown; signature?: string; ttl?: string };
  try { b = await req.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  if (!b.name || !b.body) return NextResponse.json({ error: "name_and_body_required", message: "An artifact needs a name and a body to share." }, { status: 400 });

  const type = ARTIFACT_TYPES.includes(b.type as never) ? b.type! : "skill";
  const ttl = ["24h", "7d", "30d", "never"].includes(b.ttl ?? "") ? b.ttl! : "7d";
  const manifest = b.manifest && typeof b.manifest === "object" ? (b.manifest as Record<string, unknown>) : undefined;

  if (type === "scheduled_task") {
    const m = (manifest ?? {}) as Record<string, unknown>;
    if (typeof m.cron !== "string" || typeof m.prompt !== "string") {
      return NextResponse.json({ error: "scheduled_task_manifest_invalid", message: "A scheduled task needs a cron schedule and a prompt." }, { status: 400 });
    }
    if (m.public_share_allowed !== true) {
      return NextResponse.json({ error: "scheduled_task_opt_in_required", message: "A public link would install this recurring task on a stranger's agent, so it's opt-in. Set public_share_allowed on the task to share it publicly — or share it with a trusted friend instead.", alternative: "share_with_trusted_friends" }, { status: 403 });
    }
  }

  // 1. Dedup: is an identical artifact already in this library?
  const hash = contentHash(type, b.name, b.body);
  const mine = await prisma.userSkill.findMany({ where: { accountId: account.id }, select: { id: true, name: true, type: true, body: true, signature: true, publicToken: true, publicExpiresAt: true, publicRevokedAt: true } });
  const existing = mine.find((s) => contentHash(s.type || "skill", s.name, s.body) === hash);

  let artifactId: string;
  let status: string;
  let token: string | null = null;
  let expiresAt: Date | null = null;

  if (existing) {
    artifactId = existing.id;
    const activeToken = existing.publicToken && !existing.publicRevokedAt && (!existing.publicExpiresAt || existing.publicExpiresAt > new Date());
    if (!existing.signature && !b.signature) {
      return NextResponse.json({ error: "signature_required", message: `“${existing.name}” is already in your library but isn't signed yet. Sign it with your agent key, then share.` }, { status: 409 });
    }
    if (activeToken) {
      token = existing.publicToken!; expiresAt = existing.publicExpiresAt; status = "already_in_library_existing_share";
    } else {
      token = genPublicToken(); expiresAt = ttlToExpiry(ttl);
      await prisma.userSkill.update({ where: { id: existing.id }, data: { publicToken: token, publicExpiresAt: expiresAt, publicRevokedAt: null, ...(b.signature ? { signature: b.signature } : {}) } });
      status = "already_in_library_shared";
    }
  } else {
    if (!b.signature) {
      return NextResponse.json({ error: "signature_required", message: "Sign the artifact with your agent key before sharing it publicly (see the skill's Share recipe)." }, { status: 409 });
    }
    token = genPublicToken(); expiresAt = ttlToExpiry(ttl);
    const created = await prisma.userSkill.create({ data: {
      accountId: account.id, name: b.name, description: b.description ?? null,
      type, kind: type === "skill" ? "template" : "template", body: b.body, signature: b.signature,
      manifest: manifest === undefined ? undefined : (manifest as object), paramSchema: b.param_schema === undefined ? undefined : (b.param_schema as object),
      publicToken: token, publicExpiresAt: expiresAt,
    } });
    artifactId = created.id;
    status = "created_and_shared";
    await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "artifact.shared_via_agent", detail: { artifact: artifactId, type, ttl } } }).catch(() => {});
  }

  const url = `${APP_URL}/a/${token}`;
  const paste = `Add this to my agent: ${url}`;
  const typeWord = type === "scheduled_task" ? "scheduled task" : type;
  const ttlH = TTL_HUMAN[ttl];
  const verb = status === "created_and_shared" ? `Saved “${b.name}” to your library and made a share link` : status === "already_in_library_shared" ? `“${b.name}” was already in your library — made a fresh share link` : `“${b.name}” is already in your library with an active share link`;
  return NextResponse.json({
    status,
    artifact: { id: artifactId, name: b.name, type, library_url: `${APP_URL}/account?artifact=${artifactId}` },
    share: { url, expires_at: expiresAt?.toISOString() ?? null, ttl_human: ttlH },
    paste_prompt_for_recipient: paste,
    summary: `${verb}${ttlH === "never" ? "" : `, expires in ${ttlH}`}. Send your friend the link, or have them paste this to their agent to get the ${typeWord}: "${paste}". No Back Channel account needed to receive it.`,
  });
}
