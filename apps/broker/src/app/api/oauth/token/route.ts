import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { hashToken, generateConnectorKey } from "@/lib/auth";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { seedWelcomeIfFirstConnect } from "@/lib/onboarding";
import { OAUTH_CODE_PURPOSE, OAUTH_SCOPE, oauthCodeKey, readClient, redirectUriRegistered, resourceIsThisServer, s256, validCodeVerifier } from "@/lib/oauth.mjs";
import { oauthJson, oauthPreflight, publicOrigin, readBoundedBody } from "@/lib/oauth-http";
import { AGENT_SCOPE_CONNECTOR } from "@/lib/agent-scope";

export const runtime = "nodejs";

/**
 * POST /api/oauth/token — trade an authorization code (+ PKCE verifier) for an
 * access token. No client authentication: clients are public, PKCE is the proof.
 *
 * The access token is a freshly minted per-agent bc_ key — the same AgentToken
 * every other connect path creates — so it shows up on the dashboard under the
 * client's name and is revoked there like any other agent. It does not expire
 * and there is no refresh token; revocation is the off switch. The one
 * difference from other keys is its scope, "connector": it cannot mint a
 * dashboard sign-in link or use dispatch.
 *
 * Every reason a code might be bad (unknown, used, expired, issued to a
 * different client or redirect, wrong verifier) is the same `invalid_grant`.
 * The lookup key is a hash over the code AND those values (oauthCodeKey), so
 * a mismatch on any of them is indistinguishable from "no such code" — here
 * and in the database. The raw code, verifier and key are never logged.
 */
export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers.get("x-forwarded-for"));
  // Per IP, and every user of a hosted client arrives from that client's few
  // egress addresses, so this is sized for a crowd. It is not what protects a
  // code — 256 bits and a two-minute life do that.
  const rl = rateLimit("oauth:token", ip, 1200, 60 * 60 * 1000);
  if (!rl.ok) return oauthJson({ error: "rate_limited" }, 429, { "Retry-After": String(rl.retryAfterSec) });

  // RFC 6749 says form-encoded; accept JSON too, since some MCP clients send it.
  const form = new Map<string, string>();
  try {
    const text = await readBoundedBody(req);
    if (text === null) return oauthJson({ error: "invalid_request", error_description: "request body is too large" }, 413);
    if ((req.headers.get("content-type") ?? "").includes("application/json")) {
      const body: unknown = JSON.parse(text);
      if (body && typeof body === "object") for (const [k, v] of Object.entries(body)) if (typeof v === "string") form.set(k, v);
    } else {
      for (const [k, v] of new URLSearchParams(text)) form.set(k, v);
    }
  } catch {
    return oauthJson({ error: "invalid_request", error_description: "unreadable request body" }, 400);
  }

  if (form.get("grant_type") !== "authorization_code") {
    return oauthJson({ error: "unsupported_grant_type", error_description: "only authorization_code is supported" }, 400);
  }
  const code = form.get("code") ?? "";
  const verifier = form.get("code_verifier") ?? "";
  // Clients are public, so there is no secret to check — but some send their
  // client_id as the HTTP Basic username anyway. Accept it from either place.
  let clientId = form.get("client_id") ?? "";
  const basic = /^Basic\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!clientId && basic) {
    try {
      clientId = decodeURIComponent(Buffer.from(basic[1], "base64").toString("utf8").split(":")[0]);
    } catch { /* leaves clientId empty -> invalid_client */ }
  }
  const client = readClient(clientId);
  if (!client) return oauthJson({ error: "invalid_client" }, 400);

  // RFC 8707: the authorize step required the resource to be this server. If the
  // client repeats it here, it has to say the same thing.
  const resource = form.get("resource");
  if (resource && !resourceIsThisServer(resource, publicOrigin(req))) {
    return oauthJson({ error: "invalid_target", error_description: "this server only issues tokens for its own MCP endpoint" }, 400);
  }

  const invalidGrant = () => oauthJson({ error: "invalid_grant" }, 400);
  if (!code || code.length > 200 || !validCodeVerifier(verifier)) return invalidGrant();

  let redirectUri = form.get("redirect_uri") ?? "";
  if (!redirectUri && client.redirectUris.length === 1) redirectUri = client.redirectUris[0];
  if (!redirectUriRegistered(client.redirectUris, redirectUri)) return invalidGrant();

  const codeHash = oauthCodeKey({ code, clientId: client.clientId, redirectUri, codeChallenge: s256(verifier) });
  const row = await prisma.exchangeCode.findUnique({ where: { codeHash }, include: { account: true } });
  if (!row || row.purpose !== OAUTH_CODE_PURPOSE || row.usedAt || row.expiresAt.getTime() < Date.now()) return invalidGrant();

  // Atomic single-use claim — the first request to flip usedAt wins.
  const claim = await prisma.exchangeCode.updateMany({ where: { codeHash, usedAt: null }, data: { usedAt: new Date() } });
  if (claim.count === 0) return invalidGrant();

  const priorAgentCount = await prisma.agentToken.count({ where: { accountId: row.accountId } });
  const accessToken = generateConnectorKey();
  const agent = await prisma.agentToken.create({
    // "connector": this key goes to a hosted app, not to an agent the user runs,
    // so it is held below a full key (src/lib/agent-scope.ts).
    data: { accountId: row.accountId, keyHash: hashToken(accessToken), name: row.agentName ?? client.name, runtimeType: row.runtimeType, scope: AGENT_SCOPE_CONNECTOR },
  });
  await prisma.accountAudit
    .create({ data: { accountId: row.accountId, eventType: "oauth.token_issued", detail: { ip, agent_token_id: agent.id, agent_name: agent.name } } })
    .catch(() => {});
  await seedWelcomeIfFirstConnect(row.accountId, priorAgentCount).catch(() => {});

  return oauthJson({ access_token: accessToken, token_type: "Bearer", scope: OAUTH_SCOPE });
}
export const OPTIONS = oauthPreflight;
