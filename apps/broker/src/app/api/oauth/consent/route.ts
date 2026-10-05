import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { OAUTH_CODE_PURPOSE, OAUTH_CODE_TTL_MS, oauthCodeKey, redirectWith, runtimeTypeFor, validateAuthorizeRequest } from "@/lib/oauth.mjs";
import { publicOrigin } from "@/lib/oauth-http";

export const runtime = "nodejs";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * The server half of the consent screen at /oauth/authorize. Human tier only:
 * the bc_session cookie, never a bearer key, and NO CORS headers — an agent
 * must not be able to approve its own connection.
 *
 * GET  ?<the authorize query>   what to show: is the request valid, who is
 *                               signed in, which app is asking, where an
 *                               approval sends them.
 * POST { params, decision }     "approve" (cookie + CSRF) mints the single-use
 *                               code and returns where to go; "deny" returns
 *                               the access_denied redirect and needs no session.
 *
 * Both validate the full authorize request from scratch — the page is a thin
 * client and nothing it sends is trusted. A request whose client or redirect
 * is bad gets `fatal` and no redirect of any kind (see validateAuthorizeRequest).
 */
export async function GET(req: NextRequest) {
  const origin = publicOrigin(req);
  const v = validateAuthorizeRequest(Object.fromEntries(req.nextUrl.searchParams), origin);
  if (!v.ok) return json(v.fatal ? { status: "invalid", message: v.fatal } : { status: "redirect", redirect_to: v.redirect });

  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  return json({
    status: "consent",
    client_name: v.client.name,
    destination: v.destination,
    signed_in: !!account,
    handle: account?.handle ?? null,
    verified: account ? !!account.emailVerifiedAt : null,
  });
}

export async function POST(req: NextRequest) {
  const origin = publicOrigin(req);
  let body: { params?: unknown; decision?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const params = body.params && typeof body.params === "object" && !Array.isArray(body.params) ? (body.params as Record<string, unknown>) : {};
  const v = validateAuthorizeRequest(params, origin);
  if (!v.ok) return json(v.fatal ? { status: "invalid", message: v.fatal } : { status: "redirect", redirect_to: v.redirect });

  if (body.decision === "deny") {
    return json({ status: "redirect", redirect_to: redirectWith(v.redirectUri, { error: "access_denied", state: v.state, iss: origin }) });
  }
  if (body.decision !== "approve") return json({ error: "invalid_decision" }, 400);

  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return json({ error: "unauthorized" }, 401);
  if (!csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return json({ error: "csrf" }, 403);
  if (!account.emailVerifiedAt) return json({ error: "unverified", message: "Verify your email first, then connect again." }, 409);

  const rl = rateLimit("oauth:approve", account.id, 20, 60 * 60 * 1000);
  if (!rl.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });

  // The raw code exists only in this response. What is stored is a hash over
  // the code and the request it belongs to, so it can only be redeemed by the
  // same client, to the same redirect, with the matching PKCE verifier.
  const code = randomBytes(32).toString("base64url");
  await prisma.exchangeCode.create({
    data: {
      codeHash: oauthCodeKey({ code, clientId: v.client.clientId, redirectUri: v.redirectUri, codeChallenge: v.codeChallenge }),
      accountId: account.id,
      purpose: OAUTH_CODE_PURPOSE,
      agentName: v.client.name,
      runtimeType: runtimeTypeFor(v.redirectUri) as "chatgpt" | "other",
      expiresAt: new Date(Date.now() + OAUTH_CODE_TTL_MS),
    },
  });
  await prisma.accountAudit
    .create({ data: { accountId: account.id, eventType: "oauth.approved", detail: { client_name: v.client.name, destination: v.destination.host, destination_kind: v.destination.kind } } })
    .catch(() => {});

  return json({ status: "redirect", redirect_to: redirectWith(v.redirectUri, { code, state: v.state, iss: origin }) });
}
