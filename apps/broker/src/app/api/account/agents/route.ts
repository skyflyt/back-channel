import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid, generateApiKey, hashToken } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * GET /api/account/agents — the account's registered agents (cookie-auth).
 * Active (revokedAt IS NULL) by default, newest-active first; pass
 * ?include_revoked=true for full history. Metadata only — never a key/hash.
 */
export async function GET(req: NextRequest) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const includeRevoked = new URL(req.url).searchParams.get("include_revoked") === "true";
  const rows = await prisma.agentToken.findMany({
    where: { accountId: account.id, ...(includeRevoked ? {} : { revokedAt: null }) },
    orderBy: [{ lastUsedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
  });
  return NextResponse.json({
    agents: rows.map((a) => ({
      id: a.id,
      name: a.name,
      runtime_type: a.runtimeType,
      created_at: a.createdAt.toISOString(),
      last_used_at: a.lastUsedAt?.toISOString() ?? null,
      revoked_at: a.revokedAt?.toISOString() ?? null,
    })),
  });
}

/**
 * POST /api/account/agents — mint a per-agent bc_ key directly from the signed-in
 * dashboard (cookie + CSRF). This is the MCP-connector onboarding path: the
 * BROWSER mints and holds the raw key, the human pastes it into their MCP
 * client's own config — no exchange code / TTL / single-use latch, because
 * those only protected a key in transit through an untrusted agent chat.
 * The raw key is returned ONCE; only its hash is stored.
 */
export async function POST(req: NextRequest) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) {
    return NextResponse.json({ error: "csrf" }, { status: 403 });
  }
  // Gate on verification, NOT the legacy account.apiKey column (that column is
  // slated for removal in Phase 1.1 — new accounts must still be able to mint).
  if (!account.emailVerifiedAt) {
    return NextResponse.json({ error: "email_unverified", message: "Verify your email first." }, { status: 409 });
  }

  // Same ceiling as exchange-code minting: 15/hour covers wiring several
  // clients without enabling bulk key farming.
  const rl = rateLimit("key:mint", account.id, 15, 60 * 60 * 1000);
  if (!rl.ok) {
    return NextResponse.json({ error: "rate_limited", message: "Too many keys minted — try again shortly." }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  }

  let body: { agent_name?: string; runtime_type?: string } = {};
  try { body = await req.json(); } catch { /* empty body allowed */ }
  const RUNTIMES = ["cowork", "codex", "claude_code", "chatgpt", "other"] as const;
  const agentName = (body.agent_name ?? "").trim().slice(0, 80) || "New agent";
  const runtimeType = (RUNTIMES as readonly string[]).includes(body.runtime_type ?? "") ? (body.runtime_type as (typeof RUNTIMES)[number]) : "other";

  const apiKey = generateApiKey();
  const agent = await prisma.agentToken.create({
    data: { accountId: account.id, keyHash: hashToken(apiKey), name: agentName, runtimeType },
  });
  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "key.minted", detail: { via: "dashboard", agent_token_id: agent.id, agent_name: agentName } } }).catch(() => {});

  return NextResponse.json({ api_key: apiKey, agent_id: agent.id, agent_name: agentName, handle: account.handle });
}
