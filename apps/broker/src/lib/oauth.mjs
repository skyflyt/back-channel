/**
 * Back Channel Broker — OAuth 2.1 authorization server for /api/mcp.
 *
 * Why this exists: every one-click path into Claude and ChatGPT (their
 * connector dialogs and both plugin directories) wants a remote MCP endpoint
 * that speaks OAuth. /api/mcp only took a static bearer key, which a person
 * has to mint and paste.
 *
 * What it is: a new way to MINT an agent key, not a new kind of credential.
 * The access token this server issues is an ordinary per-agent bc_ key — an
 * AgentToken row, hashed at rest, listed and revocable on the dashboard like
 * every other agent. So /api/mcp's auth path does not change at all, there is
 * nothing to refresh, and "revoke" already exists. The one difference is its
 * scope: "connector" (src/lib/agent-scope.ts), which keeps a key that lives on
 * a hosted app's servers away from the dashboard and from dispatch.
 *
 * No new tables:
 *  - Clients are stateless. Dynamic registration (RFC 7591) returns a
 *    client_id that IS the registration (name + redirect URIs, base64url).
 *    It is deliberately unsigned: registration is open, so anyone can already
 *    register any name with any redirect URI. A signature would prove only
 *    that we echoed it. What protects the user is the consent screen showing
 *    where they are being sent, and exact redirect matching.
 *  - Authorization codes reuse ExchangeCode (single-use, atomic claim, expiry)
 *    with purpose "oauth". The row is keyed by a hash over the code AND the
 *    client_id, redirect_uri and PKCE challenge it was issued for, so a code
 *    presented with any of those changed simply does not exist.
 *
 * Pure module (no Next/Prisma imports) so `node --test` can exercise it; the
 * routes under src/app/api/oauth and src/app/.well-known do the I/O.
 */

import { createHash } from "node:crypto";

export const OAUTH_CODE_PURPOSE = "oauth";
export const OAUTH_CODE_TTL_MS = 2 * 60 * 1000; // a code is redeemed by the client within seconds
export const OAUTH_SCOPE = "mcp";
export const MCP_PATH = "/api/mcp";

const CLIENT_ID_PREFIX = "bcc_";
const MAX_REDIRECT_URIS = 5;
const MAX_REDIRECT_URI_LENGTH = 400;
const MAX_CLIENT_NAME_LENGTH = 60;
const MAX_CLIENT_ID_LENGTH = 4000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Callback hosts of the first-party apps this was built for. Being on this
// list changes one thing: the consent screen says the destination is a known
// app instead of warning that it is not. It grants nothing else.
const KNOWN_DESTINATIONS = new Map([
  ["claude.ai", "Claude"],
  ["claude.com", "Claude"],
  ["chatgpt.com", "ChatGPT"],
]);

const b64url = (buf) => Buffer.from(buf).toString("base64url");

// ── Metadata (RFC 9728 protected resource, RFC 8414 authorization server) ────

export function protectedResourceMetadata(origin) {
  return {
    resource: `${origin}${MCP_PATH}`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: [OAUTH_SCOPE],
    resource_name: "Back Channel",
    resource_documentation: `${origin}/how-it-works`,
  };
}

export function authorizationServerMetadata(origin) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [OAUTH_SCOPE],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${origin}/how-it-works`,
  };
}

/** The WWW-Authenticate value a 401 from /api/mcp carries so a client can find the above. */
export function wwwAuthenticate(origin) {
  return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`;
}

// ── Redirect URIs ───────────────────────────────────────────────────────────

/**
 * A redirect URI we are willing to send an authorization code to: https to any
 * host, or http to this machine (a native app's loopback listener, RFC 8252).
 * Nothing else — no custom schemes, no credentials, no fragment.
 * @returns {{ ok: true, uri: string, loopback: boolean } | { ok: false, reason: string }}
 */
export function parseRedirectUri(value) {
  if (typeof value !== "string" || !value || value.length > MAX_REDIRECT_URI_LENGTH) return { ok: false, reason: "redirect_uri must be a URL of reasonable length" };
  let u;
  try {
    u = new URL(value);
  } catch {
    return { ok: false, reason: "redirect_uri is not a valid URL" };
  }
  if (u.username || u.password) return { ok: false, reason: "redirect_uri must not contain credentials" };
  if (u.hash) return { ok: false, reason: "redirect_uri must not contain a fragment" };
  const loopback = LOOPBACK_HOSTS.has(u.hostname);
  if (u.protocol === "https:") return { ok: true, uri: value, loopback };
  if (u.protocol === "http:" && loopback) return { ok: true, uri: value, loopback: true };
  return { ok: false, reason: "redirect_uri must be https, or http on localhost" };
}

/**
 * Exact match, with the one exception RFC 8252 §7.3 calls for: a native app
 * picks its loopback port at run time, so for loopback URIs the port is not
 * compared. Everything else — scheme, host, path, query — must be identical.
 */
export function redirectUriRegistered(registered, requested) {
  const want = parseRedirectUri(requested);
  if (!want.ok) return false;
  for (const candidate of registered) {
    if (candidate === requested) return true;
    const have = parseRedirectUri(candidate);
    if (!have.ok || !have.loopback || !want.loopback) continue;
    const a = new URL(candidate);
    const b = new URL(requested);
    if (a.protocol === b.protocol && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search) return true;
  }
  return false;
}

/**
 * How the consent screen should describe where an approval sends the user.
 * @returns {{ kind: "known" | "loopback" | "unknown" | "invalid", host: string, label: string }}
 */
export function describeDestination(redirectUri) {
  const parsed = parseRedirectUri(redirectUri);
  if (!parsed.ok) return { kind: "invalid", host: "", label: "" };
  const u = new URL(redirectUri);
  if (parsed.loopback) return { kind: "loopback", host: u.host, label: "an app running on this computer" };
  const known = KNOWN_DESTINATIONS.get(u.hostname);
  if (known) return { kind: "known", host: u.hostname, label: known };
  return { kind: "unknown", host: u.hostname, label: u.hostname };
}

/** The agent-token runtime label for a connection made through this redirect. */
export function runtimeTypeFor(redirectUri) {
  try {
    return new URL(redirectUri).hostname === "chatgpt.com" ? "chatgpt" : "other";
  } catch {
    return "other";
  }
}

// ── Clients (stateless dynamic registration) ────────────────────────────────

/** A display name is shown to the user on the consent screen: plain text, one line, short. */
export function cleanClientName(value) {
  const s = typeof value === "string" ? value : "";
  // Letters, digits and ordinary punctuation only. Dropping everything else
  // removes control and bidirectional-override characters, which is what would
  // let a name render as something other than what it is.
  const plain = s.replace(/[^\p{L}\p{N} .,_()&+'-]/gu, " ").replace(/\s+/g, " ").trim();
  return plain.slice(0, MAX_CLIENT_NAME_LENGTH) || "An MCP client";
}

/**
 * RFC 7591 registration. Returns the response body, or { error, error_description }.
 * Only public clients using the authorization-code grant with PKCE exist here,
 * so auth-method and grant fields are answered, never negotiated.
 */
export function registerClient(body, nowSec = Math.floor(Date.now() / 1000)) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "invalid_client_metadata", error_description: "body must be a JSON object" };
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
    return { error: "invalid_redirect_uri", error_description: `redirect_uris must be an array of 1 to ${MAX_REDIRECT_URIS} URLs` };
  }
  for (const uri of uris) {
    const parsed = parseRedirectUri(uri);
    if (!parsed.ok) return { error: "invalid_redirect_uri", error_description: parsed.reason };
  }
  const client_name = cleanClientName(body.client_name);
  const client_id = CLIENT_ID_PREFIX + b64url(JSON.stringify({ v: 1, n: client_name, r: uris }));
  if (client_id.length > MAX_CLIENT_ID_LENGTH) return { error: "invalid_client_metadata", error_description: "registration is too large" };
  return {
    client_id,
    client_id_issued_at: nowSec,
    client_name,
    redirect_uris: uris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: OAUTH_SCOPE,
  };
}

/**
 * Read a client_id back into its registration. Everything in it is re-validated
 * exactly as at registration: the value comes from the caller, not from us.
 * @returns {{ clientId: string, name: string, redirectUris: string[] } | null}
 */
export function readClient(clientId) {
  if (typeof clientId !== "string" || !clientId.startsWith(CLIENT_ID_PREFIX) || clientId.length > MAX_CLIENT_ID_LENGTH) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(clientId.slice(CLIENT_ID_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || data.v !== 1 || !Array.isArray(data.r)) return null;
  if (data.r.length === 0 || data.r.length > MAX_REDIRECT_URIS || !data.r.every((u) => parseRedirectUri(u).ok)) return null;
  return { clientId, name: cleanClientName(data.n), redirectUris: data.r };
}

// ── PKCE and codes ──────────────────────────────────────────────────────────

const PKCE_VALUE = /^[A-Za-z0-9._~-]{43,128}$/;

export function validCodeChallenge(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value); // base64url(SHA-256) is always 43 chars
}
export function validCodeVerifier(value) {
  return typeof value === "string" && PKCE_VALUE.test(value);
}
export function s256(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * The ExchangeCode key for an authorization code. Hashing the request it was
 * issued for into the key is what binds them: redeeming needs the same
 * client_id and redirect_uri and a verifier whose S256 is the same challenge.
 * JSON array encoding keeps the fields unambiguous (no separator games).
 */
export function oauthCodeKey({ code, clientId, redirectUri, codeChallenge }) {
  return createHash("sha256").update(JSON.stringify(["bc-oauth-code-v1", code, clientId, redirectUri, codeChallenge])).digest("hex");
}

// ── The authorization request ───────────────────────────────────────────────

export function redirectWith(redirectUri, params) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  return u.toString();
}

/**
 * Validate /oauth/authorize's query. Three outcomes:
 *  - { ok: true, … }            show the consent screen
 *  - { ok: false, redirect }    the client and redirect are good, the request
 *                               is not: send the error back to the client
 *  - { ok: false, fatal }       the client or redirect itself is bad. NEVER
 *                               redirect — that is how an authorization server
 *                               becomes an open redirector. Show the reason.
 *
 * @typedef {{ kind: "known" | "loopback" | "unknown" | "invalid", host: string, label: string }} Destination
 * @typedef {{ ok: true, client: { clientId: string, name: string, redirectUris: string[] }, redirectUri: string, state: string, codeChallenge: string, destination: Destination }
 *   | { ok: false, fatal: string, redirect?: undefined }
 *   | { ok: false, redirect: string, fatal?: undefined }} AuthorizeCheck
 * @param {Record<string, unknown>} q
 * @param {string} origin
 * @returns {AuthorizeCheck}
 */
export function validateAuthorizeRequest(q, origin) {
  const get = (k) => (typeof q[k] === "string" ? q[k] : "");
  const client = readClient(get("client_id"));
  if (!client) return { ok: false, fatal: "This connection request names an app Back Channel doesn't recognize. Start again from the app you were connecting." };

  let redirectUri = get("redirect_uri");
  if (!redirectUri && client.redirectUris.length === 1) redirectUri = client.redirectUris[0];
  if (!redirectUri || !redirectUriRegistered(client.redirectUris, redirectUri)) {
    return { ok: false, fatal: "This connection request would send you somewhere the app didn't register." };
  }

  const state = get("state");
  /** @returns {AuthorizeCheck} */
  const fail = (error, error_description) => ({ ok: false, redirect: redirectWith(redirectUri, { error, error_description, state, iss: origin }) });

  if (get("response_type") !== "code") return fail("unsupported_response_type", "only response_type=code is supported");
  if (get("code_challenge_method") !== "S256") return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
  if (!validCodeChallenge(get("code_challenge"))) return fail("invalid_request", "code_challenge is missing or malformed");
  if (state.length > 1024) return fail("invalid_request", "state is too long");

  // RFC 8707: if the client names the resource it wants the token for, it must be this one.
  const resource = get("resource");
  if (resource && resource.replace(/\/$/, "") !== `${origin}${MCP_PATH}` && resource.replace(/\/$/, "") !== origin) {
    return fail("invalid_target", "this server only issues tokens for its own MCP endpoint");
  }

  return { ok: true, client, redirectUri, state, codeChallenge: get("code_challenge"), destination: describeDestination(redirectUri) };
}
