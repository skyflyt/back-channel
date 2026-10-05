/**
 * Route tests for the OAuth 2.1 authorization server in front of /api/mcp
 * (design: src/lib/oauth.mjs). Runs the REAL handlers — metadata, dynamic
 * registration, the consent endpoint, the token endpoint, and the pre-existing
 * /api/auth/exchange — against an in-memory @/lib/db, with the real @/lib/auth,
 * so the issued access token is proven by authenticating with it.
 *
 * The properties these tests exist to pin:
 *  - an approval needs a signed-in, verified human AND the CSRF header;
 *  - a code is single-use, short-lived, and only redeemable by the same client,
 *    to the same redirect, with the matching PKCE verifier — and a wrong guess
 *    does not burn it;
 *  - a bad client or redirect never produces a redirect;
 *  - OAuth codes and BCX exchange codes cannot be redeemed at each other's
 *    endpoints, even though they share a table.
 *
 * Run with: npm run test:routes
 */
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";

const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");

const ORIGIN = "https://back-channel.app";
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(64);
const CHALLENGE = s256(VERIFIER);
const COOKIE = "cs_good";
const CSRF = "csrf-token-value";

let accounts: Record<string, any> = {};
let sessionCookies: Record<string, any> = {};
let exchangeCodes: Record<string, any> = {};
let agentTokens: any[] = [];
let audits: any[] = [];
let viewTokens: any[] = [];
let limited = false;
let welcomeSeeded: unknown[] = [];

const prismaMock = {
  sessionCookie: {
    findUnique: async ({ where }: any) => {
      const row = sessionCookies[where.token];
      return row ? { ...row, account: accounts[row.accountId] } : null;
    },
    update: async () => ({}),
    delete: async () => ({}),
  },
  exchangeCode: {
    create: async ({ data }: any) => { exchangeCodes[data.codeHash] = { purpose: "exchange", agentName: null, runtimeType: "other", usedAt: null, ...data }; return exchangeCodes[data.codeHash]; },
    findUnique: async ({ where }: any) => {
      const row = exchangeCodes[where.codeHash];
      return row ? { ...row, account: accounts[row.accountId] } : null;
    },
    updateMany: async ({ where, data }: any) => {
      const row = exchangeCodes[where.codeHash];
      if (!row || (where.usedAt === null && row.usedAt !== null)) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  },
  agentToken: {
    count: async ({ where }: any) => agentTokens.filter((t) => t.accountId === where.accountId).length,
    create: async ({ data }: any) => { const row = { id: `agt_${agentTokens.length + 1}`, revokedAt: null, lastUsedAt: null, scope: "full", ...data }; agentTokens.push(row); return row; },
    findUnique: async ({ where }: any) => {
      const row = agentTokens.find((t) => t.keyHash === where.keyHash);
      return row ? { ...row, account: accounts[row.accountId] } : null;
    },
    update: async () => ({}),
  },
  accountAudit: { create: async ({ data }: any) => { audits.push(data); return data; } },
  viewToken: { create: async ({ data }: any) => { viewTokens.push(data); return data; } },
};

before(() => {
  process.env.PUBLIC_APP_URL = ORIGIN;
  mock.module("@/lib/db", { namedExports: { prisma: prismaMock } });
  mock.module("@/lib/onboarding", { namedExports: { seedWelcomeIfFirstConnect: async (...a: unknown[]) => { welcomeSeeded.push(a); } } });
  mock.module("@/lib/rate-limit", {
    namedExports: {
      rateLimit: () => (limited ? { ok: false, retryAfterSec: 7 } : { ok: true, retryAfterSec: 0 }),
      rateLimitPeek: () => ({ ok: true, retryAfterSec: 0 }),
      clientIp: () => "203.0.113.9",
    },
  });
});

beforeEach(() => {
  accounts = { a1: { id: "a1", handle: "tester@bc", email: "t@example.com", emailVerifiedAt: new Date() } };
  sessionCookies = { [sha(COOKIE)]: { token: sha(COOKIE), accountId: "a1", expiresAt: new Date(Date.now() + 3600_000), lastUsedAt: new Date() } };
  exchangeCodes = {};
  agentTokens = [];
  audits = [];
  viewTokens = [];
  limited = false;
  welcomeSeeded = [];
});

const routes = {
  prm: () => import("@/app/.well-known/oauth-protected-resource/route"),
  prmSuffixed: () => import("@/app/.well-known/oauth-protected-resource/api/mcp/route"),
  as: () => import("@/app/.well-known/oauth-authorization-server/route"),
  register: () => import("@/app/api/oauth/register/route"),
  consent: () => import("@/app/api/oauth/consent/route"),
  token: () => import("@/app/api/oauth/token/route"),
  exchange: () => import("@/app/api/auth/exchange/route"),
  viewTokenSelf: () => import("@/app/api/account/view-token-self/route"),
};

const get = (path: string, headers: Record<string, string> = {}) => new NextRequest(`${ORIGIN}${path}`, { headers });
const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const postForm = (path: string, fields: Record<string, string>) =>
  new NextRequest(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
const signedIn = { cookie: `bc_session=${COOKIE}; bc_csrf=${CSRF}`, "x-bc-csrf": CSRF };

async function register(redirect_uris = [CLAUDE_CB], client_name = "Claude") {
  const res = await (await routes.register()).POST(postJson("/api/oauth/register", { client_name, redirect_uris }));
  return { res, body: await res.json() };
}
async function authParams(over: Record<string, string | undefined> = {}) {
  const { body } = await register();
  const p: Record<string, string | undefined> = { response_type: "code", client_id: body.client_id, redirect_uri: CLAUDE_CB, code_challenge: CHALLENGE, code_challenge_method: "S256", state: "st4te", ...over };
  return Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) as Record<string, string>;
}
async function approve(params: Record<string, string>, headers: Record<string, string> = signedIn) {
  const res = await (await routes.consent()).POST(postJson("/api/oauth/consent", { params, decision: "approve" }, headers));
  return { res, body: await res.json() };
}
/** Approve and pull the code out of the redirect, the way a client would. */
async function obtainCode(params: Record<string, string>) {
  const { body } = await approve(params);
  return new URL(body.redirect_to).searchParams.get("code")!;
}
const redeem = async (fields: Record<string, string>) => {
  const res = await (await routes.token()).POST(postForm("/api/oauth/token", { grant_type: "authorization_code", ...fields }));
  return { res, body: await res.json() };
};

// ── Discovery ───────────────────────────────────────────────────────────────

test("discovery: both metadata documents are served, CORS-open, cacheable, and built from PUBLIC_APP_URL — never the request host", async () => {
  for (const load of [routes.prm, routes.prmSuffixed]) {
    const res = (await load()).GET(new NextRequest("https://attacker.example/.well-known/oauth-protected-resource"));
    const body = await res.json();
    assert.equal(body.resource, `${ORIGIN}/api/mcp`);
    assert.deepEqual(body.authorization_servers, [ORIGIN]);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.match(res.headers.get("cache-control")!, /max-age/);
  }
  const as = await (await routes.as()).GET(get("/.well-known/oauth-authorization-server")).json();
  assert.equal(as.issuer, ORIGIN);
  assert.equal(as.authorization_endpoint, `${ORIGIN}/oauth/authorize`);
  assert.equal(as.token_endpoint, `${ORIGIN}/api/oauth/token`);
  assert.equal(as.registration_endpoint, `${ORIGIN}/api/oauth/register`);
  assert.equal((await routes.as()).OPTIONS().status, 204);
});

// ── Registration ────────────────────────────────────────────────────────────

test("register: 201 with a public client; nothing is stored; bad metadata 400; over the limit 429", async () => {
  const { res, body } = await register([CLAUDE_CB, "http://localhost:4000/cb"]);
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.match(body.client_id, /^bcc_/);
  assert.equal(body.client_secret, undefined);
  assert.equal(body.token_endpoint_auth_method, "none");
  assert.deepEqual([Object.keys(exchangeCodes).length, agentTokens.length, audits.length], [0, 0, 0]);

  assert.equal((await register(["http://evil.example/cb"])).res.status, 400);
  const notJson = await (await routes.register()).POST(new NextRequest(`${ORIGIN}/api/oauth/register`, { method: "POST", body: "nope" }));
  assert.equal(notJson.status, 400);
  limited = true;
  const shed = (await register()).res;
  assert.equal(shed.status, 429);
  assert.equal(shed.headers.get("retry-after"), "7");
});

// ── Consent ─────────────────────────────────────────────────────────────────

test("consent GET: describes the request, and says who is signed in — without CORS headers", async () => {
  const qs = new URLSearchParams(await authParams()).toString();
  const out = await (await routes.consent()).GET(get(`/api/oauth/consent?${qs}`));
  assert.equal(out.headers.get("access-control-allow-origin"), null, "the cookie-authed endpoint must not be CORS-open");
  assert.deepEqual(await out.json(), { status: "consent", client_name: "Claude", destination: { kind: "known", host: "claude.ai", label: "Claude" }, signed_in: false, handle: null, verified: null });

  const inn = await (await (await routes.consent()).GET(get(`/api/oauth/consent?${qs}`, { cookie: `bc_session=${COOKIE}` }))).json();
  assert.deepEqual([inn.signed_in, inn.handle, inn.verified], [true, "tester@bc", true]);
});

test("consent: a bad client or redirect is 'invalid' on GET and POST — never a redirect, even for a signed-in approve", async () => {
  const good = await authParams();
  for (const bad of [{ ...good, client_id: "bcc_garbage" }, { ...good, redirect_uri: "https://evil.example/cb" }]) {
    const g = await (await (await routes.consent()).GET(get(`/api/oauth/consent?${new URLSearchParams(bad)}`, { cookie: `bc_session=${COOKIE}` }))).json();
    assert.equal(g.status, "invalid");
    assert.equal(g.redirect_to, undefined);
    const p = (await approve(bad)).body;
    assert.equal(p.status, "invalid");
    assert.equal(p.redirect_to, undefined);
  }
  assert.equal(Object.keys(exchangeCodes).length, 0);
});

test("consent: a malformed request from a valid client goes back to that client with an error, and mints nothing", async () => {
  const params = await authParams({ code_challenge_method: "plain" });
  const { body } = await approve(params);
  assert.equal(body.status, "redirect");
  const u = new URL(body.redirect_to);
  assert.equal(u.origin + u.pathname, CLAUDE_CB);
  assert.equal(u.searchParams.get("error"), "invalid_request");
  assert.equal(u.searchParams.get("state"), "st4te");
  assert.equal(u.searchParams.get("code"), null);
  assert.equal(Object.keys(exchangeCodes).length, 0);
});

test("consent approve needs a signed-in, VERIFIED human and the CSRF header — each missing piece fails closed", async () => {
  const params = await authParams();
  assert.equal((await approve(params, {})).res.status, 401, "no session");
  assert.equal((await approve(params, { authorization: "Bearer bc_anything" })).res.status, 401, "a bearer key is not a human: an agent cannot approve itself");
  assert.equal((await approve(params, { cookie: `bc_session=${COOKIE}; bc_csrf=${CSRF}` })).res.status, 403, "cookie without the header");
  assert.equal((await approve(params, { cookie: `bc_session=${COOKIE}; bc_csrf=${CSRF}`, "x-bc-csrf": "wrong-token-value" })).res.status, 403);
  assert.equal((await approve(params, { cookie: `bc_session=cs_unknown; bc_csrf=${CSRF}`, "x-bc-csrf": CSRF })).res.status, 401, "unknown session");
  sessionCookies[sha(COOKIE)].expiresAt = new Date(Date.now() - 1000);
  assert.equal((await approve(params)).res.status, 401, "expired session");
  sessionCookies[sha(COOKIE)].expiresAt = new Date(Date.now() + 3600_000);
  accounts.a1.emailVerifiedAt = null;
  assert.equal((await approve(params)).res.status, 409, "unverified account");
  accounts.a1.emailVerifiedAt = new Date();
  limited = true;
  assert.equal((await approve(params)).res.status, 429);
  assert.equal(Object.keys(exchangeCodes).length, 0, "none of those minted a code");

  const bad = await (await routes.consent()).POST(postJson("/api/oauth/consent", { params, decision: "maybe" }, signedIn));
  assert.equal(bad.status, 400);
});

test("consent approve: redirects to the registered URI with code + state + iss; stores only a bound hash, for two minutes", async () => {
  const params = await authParams();
  const t0 = Date.now();
  const { res, body } = await approve(params);
  assert.equal(res.status, 200);
  const u = new URL(body.redirect_to);
  assert.equal(u.origin + u.pathname, CLAUDE_CB);
  assert.equal(u.searchParams.get("state"), "st4te");
  assert.equal(u.searchParams.get("iss"), ORIGIN);
  const code = u.searchParams.get("code")!;
  assert.ok(code.length >= 40);

  const [[key, row]] = Object.entries(exchangeCodes) as [string, any][];
  assert.equal(row.purpose, "oauth");
  assert.equal(row.accountId, "a1");
  assert.equal(row.agentName, "Claude");
  assert.notEqual(key, code);
  assert.notEqual(key, sha(code), "the stored key is not a bare hash of the code — it is bound to the request");
  assert.equal(JSON.stringify(exchangeCodes).includes(code), false, "the raw code is never stored");
  const ttl = row.expiresAt.getTime() - t0;
  assert.ok(ttl > 60_000 && ttl <= 121_000, `ttl ${ttl}`);
  assert.deepEqual(audits.map((a) => [a.eventType, a.detail.destination, a.detail.destination_kind]), [["oauth.approved", "claude.ai", "known"]]);
});

test("consent deny: sends access_denied back to the client; needs no session; mints nothing", async () => {
  const params = await authParams();
  const res = await (await routes.consent()).POST(postJson("/api/oauth/consent", { params, decision: "deny" }));
  const u = new URL((await res.json()).redirect_to);
  assert.equal(u.searchParams.get("error"), "access_denied");
  assert.equal(u.searchParams.get("state"), "st4te");
  assert.equal(u.searchParams.get("code"), null);
  assert.equal(Object.keys(exchangeCodes).length, 0);
});

// ── Token ───────────────────────────────────────────────────────────────────

test("token: the full flow issues a bc_ agent key that authenticates, named after the client, visible in the audit trail", async () => {
  const params = await authParams();
  const code = await obtainCode(params);
  const { res, body } = await redeem({ code, client_id: params.client_id, redirect_uri: CLAUDE_CB, code_verifier: VERIFIER });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(Object.keys(body).sort(), ["access_token", "scope", "token_type"]);
  assert.equal(body.token_type, "Bearer");
  assert.match(body.access_token, /^bc_/);

  // It is a real agent key: the REAL getAuthContext accepts it.
  const { getAuthContext } = await import("@/lib/auth");
  const ctx = await getAuthContext(`Bearer ${body.access_token}`);
  assert.equal(ctx?.account.id, "a1");
  assert.deepEqual(agentTokens.map((t) => [t.name, t.runtimeType, t.accountId, t.scope]), [["Claude", "other", "a1", "connector"]]);
  assert.equal(ctx?.scope, "connector");
  assert.equal(agentTokens[0].keyHash, sha(body.access_token), "hash at rest, like every other agent key");
  assert.equal(JSON.stringify([agentTokens, audits, exchangeCodes]).includes(body.access_token), false, "the raw key is stored and logged nowhere");
  assert.deepEqual(audits.map((a) => a.eventType), ["oauth.approved", "oauth.token_issued"]);
  assert.equal(welcomeSeeded.length, 1);
});

test("token: a code is single-use — the second redemption is invalid_grant and mints nothing", async () => {
  const params = await authParams();
  const code = await obtainCode(params);
  const fields = { code, client_id: params.client_id, redirect_uri: CLAUDE_CB, code_verifier: VERIFIER };
  assert.equal((await redeem(fields)).res.status, 200);
  const again = await redeem(fields);
  assert.equal(again.res.status, 400);
  assert.deepEqual(again.body, { error: "invalid_grant" });
  assert.equal(agentTokens.length, 1);
});

test("token: wrong verifier / other client / other redirect / unknown code are all the same invalid_grant — and none of them burns the code", async () => {
  const params = await authParams();
  const code = await obtainCode(params);
  const good = { code, client_id: params.client_id, redirect_uri: CLAUDE_CB, code_verifier: VERIFIER };
  const otherClient = (await register([CLAUDE_CB], "Someone Else")).body.client_id;
  const twoUris = (await register([CLAUDE_CB, "https://claude.ai/other"])).body.client_id;

  for (const [why, fields] of [
    ["wrong verifier", { ...good, code_verifier: "w".repeat(64) }],
    ["malformed verifier", { ...good, code_verifier: "short" }],
    ["a different client with the same redirect", { ...good, client_id: otherClient }],
    ["a different (registered) redirect", { ...good, client_id: twoUris, redirect_uri: "https://claude.ai/other" }],
    ["an unregistered redirect", { ...good, redirect_uri: "https://evil.example/cb" }],
    ["an unknown code", { ...good, code: "nope" }],
    ["no code", { ...good, code: "" }],
  ] as [string, Record<string, string>][]) {
    const r = await redeem(fields);
    assert.equal(r.res.status, 400, why);
    assert.deepEqual(r.body, { error: "invalid_grant" }, why);
  }
  assert.equal(agentTokens.length, 0);
  // The legitimate client can still finish: an attacker's guesses cost it nothing.
  assert.equal((await redeem(good)).res.status, 200);
});

test("token: an expired code is invalid_grant", async () => {
  const params = await authParams();
  const code = await obtainCode(params);
  for (const row of Object.values(exchangeCodes) as any[]) row.expiresAt = new Date(Date.now() - 1);
  assert.deepEqual((await redeem({ code, client_id: params.client_id, redirect_uri: CLAUDE_CB, code_verifier: VERIFIER })).body, { error: "invalid_grant" });
  assert.equal(agentTokens.length, 0);
});

test("token: JSON bodies work; unknown client and other grant types are refused; over the limit 429", async () => {
  const params = await authParams();
  const code = await obtainCode(params);
  const asJson = await (await routes.token()).POST(postJson("/api/oauth/token", { grant_type: "authorization_code", code, client_id: params.client_id, redirect_uri: CLAUDE_CB, code_verifier: VERIFIER }));
  assert.equal(asJson.status, 200);

  assert.deepEqual((await redeem({ code: "x", client_id: "nope", code_verifier: VERIFIER })).body, { error: "invalid_client" });
  for (const grant_type of ["refresh_token", "client_credentials", "password", ""]) {
    const r = await (await routes.token()).POST(postForm("/api/oauth/token", { grant_type, code: "x", client_id: params.client_id }));
    assert.equal((await r.json()).error, "unsupported_grant_type", grant_type);
  }
  limited = true;
  assert.equal((await redeem({ code: "x", client_id: params.client_id, code_verifier: VERIFIER })).res.status, 429);
});

test("token: a loopback client may come back on a different port than it registered, as long as it uses the same one for both steps", async () => {
  const reg = (await register(["http://localhost:1111/callback"], "A CLI")).body;
  const redirect_uri = "http://localhost:53124/callback";
  const params = { response_type: "code", client_id: reg.client_id, redirect_uri, code_challenge: CHALLENGE, code_challenge_method: "S256", state: "s" };
  const code = await obtainCode(params);
  assert.equal(audits[0].detail.destination_kind, "loopback");
  assert.deepEqual((await redeem({ code, client_id: reg.client_id, redirect_uri: "http://localhost:9/callback", code_verifier: VERIFIER })).body, { error: "invalid_grant" }, "not a different port at the token step");
  assert.equal((await redeem({ code, client_id: reg.client_id, redirect_uri, code_verifier: VERIFIER })).res.status, 200);
});

// ── The two code types stay apart ───────────────────────────────────────────

test("OAuth codes and BCX exchange codes share a table but cannot be redeemed at each other's endpoint", async () => {
  // A BCX code at the token endpoint: there is no row under any OAuth key for it.
  exchangeCodes[sha("BCX-AAAA-BBBB")] = { codeHash: sha("BCX-AAAA-BBBB"), accountId: "a1", purpose: "exchange", agentName: "x", runtimeType: "other", usedAt: null, expiresAt: new Date(Date.now() + 60_000) };
  const params = await authParams();
  assert.deepEqual((await redeem({ code: "BCX-AAAA-BBBB", client_id: params.client_id, redirect_uri: CLAUDE_CB, code_verifier: VERIFIER })).body, { error: "invalid_grant" });
  assert.equal(exchangeCodes[sha("BCX-AAAA-BBBB")].usedAt, null, "and it is not burned");

  // An OAuth-purpose row at /api/auth/exchange — forced under a BCX-shaped key,
  // which real issuance can never produce — is still refused, opaquely.
  exchangeCodes[sha("BCX-CCCC-DDDD")] = { codeHash: sha("BCX-CCCC-DDDD"), accountId: "a1", purpose: "oauth", agentName: "x", runtimeType: "other", usedAt: null, expiresAt: new Date(Date.now() + 60_000) };
  const res = await (await routes.exchange()).POST(postJson("/api/auth/exchange", { code: "BCX-CCCC-DDDD" }));
  assert.equal(res.status, 410);
  assert.deepEqual(await res.json(), { error: "invalid_or_expired_code" });
  assert.equal(agentTokens.length, 0);

  // The ordinary BCX flow is unchanged.
  const ok = await (await routes.exchange()).POST(postJson("/api/auth/exchange", { code: "BCX-AAAA-BBBB" }));
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).api_key, /^bc_/);
});

// ── What an OAuth-issued key cannot do ──────────────────────────────────────

test("a connector key cannot mint a dashboard sign-in link; a full key still can; anything but 'full' fails closed", async () => {
  const params = await authParams();
  const code = await obtainCode(params);
  const { body } = await redeem({ code, client_id: params.client_id, redirect_uri: CLAUDE_CB, code_verifier: VERIFIER });
  const link = async (key: string) => (await routes.viewTokenSelf()).POST(postJson("/api/account/view-token-self", {}, { authorization: `Bearer ${key}` }));

  const refused = await link(body.access_token);
  assert.equal(refused.status, 403);
  const refusedBody = await refused.json();
  assert.equal(refusedBody.error, "not_available_to_connectors");
  assert.match(refusedBody.message, /sign in themselves at https:\/\/back-channel\.app\/login/);
  assert.equal(refusedBody.view_url, undefined);
  assert.equal(viewTokens.length, 0, "no sign-in token was created");

  // An unknown or blank scope is not "full" either.
  for (const scope of ["read-only", "", null]) {
    agentTokens[0].scope = scope;
    assert.equal((await link(body.access_token)).status, 403, String(scope));
  }
  assert.equal(viewTokens.length, 0);

  // A key the user minted for their own agent (BCX exchange) is "full" and unaffected.
  exchangeCodes[sha("BCX-AAAA-BBBB")] = { codeHash: sha("BCX-AAAA-BBBB"), accountId: "a1", purpose: "exchange", agentName: "My laptop", runtimeType: "claude_code", usedAt: null, expiresAt: new Date(Date.now() + 60_000) };
  const full = await (await (await routes.exchange()).POST(postJson("/api/auth/exchange", { code: "BCX-AAAA-BBBB" }))).json();
  assert.equal(agentTokens.find((t) => t.name === "My laptop").scope, "full");
  const ok = await link(full.api_key);
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).view_url, /^https:\/\/back-channel\.app\/account\?vt=vt_/);
  assert.equal(viewTokens.length, 1);

  assert.equal((await link("bc_not_a_key")).status, 401);
});
