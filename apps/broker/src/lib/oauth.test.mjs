import { test } from "node:test";
import assert from "node:assert/strict";
import {
  protectedResourceMetadata, authorizationServerMetadata, wwwAuthenticate,
  parseRedirectUri, redirectUriRegistered, describeDestination, runtimeTypeFor,
  cleanClientName, registerClient, readClient,
  validCodeChallenge, validCodeVerifier, s256, oauthCodeKey,
  redirectWith, validateAuthorizeRequest,
} from "./oauth.mjs";

const ORIGIN = "https://back-channel.app";
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "a".repeat(43);
const CHALLENGE = s256(VERIFIER);
const client = (uris = [CLAUDE_CB], name = "Claude") => registerClient({ client_name: name, redirect_uris: uris });
const authQuery = (over = {}) => ({ response_type: "code", client_id: client().client_id, redirect_uri: CLAUDE_CB, code_challenge: CHALLENGE, code_challenge_method: "S256", state: "xyz", ...over });

test("metadata: the documents agree with each other and advertise only what is implemented", () => {
  const prm = protectedResourceMetadata(ORIGIN);
  const as = authorizationServerMetadata(ORIGIN);
  assert.equal(prm.resource, `${ORIGIN}/api/mcp`);
  assert.deepEqual(prm.authorization_servers, [as.issuer]);
  assert.equal(as.issuer, ORIGIN);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"], "no plain PKCE");
  assert.deepEqual(as.grant_types_supported, ["authorization_code"], "no refresh, no implicit, no client_credentials");
  assert.deepEqual(as.response_types_supported, ["code"]);
  assert.deepEqual(as.token_endpoint_auth_methods_supported, ["none"]);
  for (const k of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) assert.ok(as[k].startsWith(ORIGIN + "/"), k);
  assert.equal(wwwAuthenticate(ORIGIN), `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`);
});

test("parseRedirectUri: https anywhere, http only on loopback, nothing else", () => {
  for (const ok of [CLAUDE_CB, "https://chatgpt.com/connector_platform_oauth_redirect", "http://localhost:53124/callback", "http://127.0.0.1:8080/cb", "http://[::1]:9/cb"]) {
    assert.equal(parseRedirectUri(ok).ok, true, ok);
  }
  for (const bad of [
    "http://evil.example/cb", "http://localhost.evil.example/cb", "javascript:alert(1)", "data:text/html,x", "cursor://anysphere/cb", "file:///etc/passwd",
    "https://user:pw@claude.ai/cb", "https://claude.ai/cb#frag", "not a url", "", null, 42, "https://a.example/" + "x".repeat(500),
  ]) {
    assert.equal(parseRedirectUri(bad).ok, false, String(bad));
  }
  assert.equal(parseRedirectUri("http://localhost:1/cb").loopback, true);
  assert.equal(parseRedirectUri(CLAUDE_CB).loopback, false);
});

test("redirectUriRegistered: exact match, except the port of a loopback URI", () => {
  assert.equal(redirectUriRegistered([CLAUDE_CB], CLAUDE_CB), true);
  for (const near of [CLAUDE_CB + "/", CLAUDE_CB + "?x=1", "https://claude.ai/api/mcp/auth_callback2", "https://claude.ai.evil.example/api/mcp/auth_callback", "https://CLAUDE.ai/api/mcp/auth_callback/..", "http://claude.ai/api/mcp/auth_callback"]) {
    assert.equal(redirectUriRegistered([CLAUDE_CB], near), false, near);
  }
  // A native app picks its port at run time (RFC 8252 §7.3).
  assert.equal(redirectUriRegistered(["http://localhost:1111/callback"], "http://localhost:53124/callback"), true);
  assert.equal(redirectUriRegistered(["http://localhost:1111/callback"], "http://localhost:53124/other"), false, "path still has to match");
  assert.equal(redirectUriRegistered(["http://localhost:1111/callback"], "http://127.0.0.1:1111/callback"), false, "host still has to match");
  assert.equal(redirectUriRegistered(["http://localhost:1111/callback"], "https://localhost:1111/callback"), false, "scheme still has to match");
  // The port exception is for loopback only.
  assert.equal(redirectUriRegistered(["https://app.example:8443/cb"], "https://app.example:9999/cb"), false);
});

test("describeDestination: known apps, this computer, and everything else called out as unknown", () => {
  assert.deepEqual(describeDestination(CLAUDE_CB), { kind: "known", host: "claude.ai", label: "Claude" });
  assert.equal(describeDestination("https://chatgpt.com/connector_platform_oauth_redirect").label, "ChatGPT");
  assert.equal(describeDestination("http://localhost:5000/cb").kind, "loopback");
  // Lookalikes are not the real thing.
  for (const fake of ["https://claude.ai.evil.example/cb", "https://evil.example/claude.ai", "https://xclaude.ai/cb", "https://chatgpt.com.evil.example/cb"]) {
    assert.equal(describeDestination(fake).kind, "unknown", fake);
  }
  assert.equal(describeDestination("https://claude.ai.evil.example/cb").host, "claude.ai.evil.example", "the full host is what gets shown");
  assert.equal(describeDestination("javascript:alert(1)").kind, "invalid");
  assert.equal(runtimeTypeFor("https://chatgpt.com/x"), "chatgpt");
  assert.equal(runtimeTypeFor(CLAUDE_CB), "other");
  assert.equal(runtimeTypeFor("nope"), "other");
});

test("cleanClientName: one short line of plain text — nothing that can restyle or reorder what the user reads", () => {
  assert.equal(cleanClientName("  Claude  "), "Claude");
  assert.equal(cleanClientName("Acme\nApp\t(beta)"), "Acme App (beta)");
  assert.equal(cleanClientName("Evil‮edoc⁦ <b>x</b> \u0000"), "Evil edoc b x b");
  assert.equal(cleanClientName("x".repeat(200)).length, 60);
  for (const empty of ["", "   ", null, undefined, 42, {}, "‮​"]) assert.equal(cleanClientName(empty), "An MCP client");
  assert.equal(cleanClientName("Zoë's Résumé-Bot & Co. 2"), "Zoë's Résumé-Bot & Co. 2");
});

test("registerClient / readClient: the client_id round-trips its own registration", () => {
  const reg = registerClient({ client_name: "Claude", redirect_uris: [CLAUDE_CB, "http://localhost:1/cb"], client_uri: "ignored", token_endpoint_auth_method: "client_secret_basic" }, 1700000000);
  assert.equal(reg.client_id_issued_at, 1700000000);
  assert.equal(reg.token_endpoint_auth_method, "none", "answered, not negotiated: there are only public clients");
  assert.equal(reg.client_secret, undefined);
  assert.deepEqual(readClient(reg.client_id), { clientId: reg.client_id, name: "Claude", redirectUris: [CLAUDE_CB, "http://localhost:1/cb"] });
});

test("registerClient: rejects bad registrations with RFC 7591 error codes", () => {
  assert.equal(registerClient(null).error, "invalid_client_metadata");
  assert.equal(registerClient([]).error, "invalid_client_metadata");
  assert.equal(registerClient({}).error, "invalid_redirect_uri");
  assert.equal(registerClient({ redirect_uris: [] }).error, "invalid_redirect_uri");
  assert.equal(registerClient({ redirect_uris: "https://a.example/cb" }).error, "invalid_redirect_uri");
  assert.equal(registerClient({ redirect_uris: [CLAUDE_CB, "http://evil.example/cb"] }).error, "invalid_redirect_uri", "one bad URI fails the whole registration");
  assert.equal(registerClient({ redirect_uris: Array(6).fill(CLAUDE_CB) }).error, "invalid_redirect_uri");
});

test("readClient: a client_id is caller input — forged or damaged ones are re-validated or refused", () => {
  const forge = (obj) => "bcc_" + Buffer.from(JSON.stringify(obj)).toString("base64url");
  for (const bad of [
    "", null, 42, "abc", "bcc_", "bcc_!!!", "bcc_" + Buffer.from("not json").toString("base64url"),
    forge({ v: 2, n: "x", r: [CLAUDE_CB] }), forge({ v: 1, n: "x" }), forge({ v: 1, n: "x", r: [] }),
    forge({ v: 1, n: "x", r: ["javascript:alert(1)"] }), forge({ v: 1, n: "x", r: ["http://evil.example/cb"] }),
    forge({ v: 1, n: "x", r: Array(6).fill(CLAUDE_CB) }), "bcc_" + "A".repeat(5000),
  ]) {
    assert.equal(readClient(bad), null, String(bad).slice(0, 40));
  }
  // Forging is allowed to *work* — registration is open — but the name is still cleaned on the way back in.
  assert.equal(readClient(forge({ v: 1, n: "Totally‮ Claude\n", r: ["https://evil.example/cb"] })).name, "Totally Claude");
});

test("PKCE: S256 only, RFC 7636 lengths and alphabet, known answer", () => {
  // RFC 7636 appendix B.
  assert.equal(s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  assert.equal(validCodeChallenge(CHALLENGE), true);
  for (const bad of ["", "short", CHALLENGE + "=", CHALLENGE.slice(1), "+".repeat(43), null]) assert.equal(validCodeChallenge(bad), false, String(bad));
  assert.equal(validCodeVerifier(VERIFIER), true);
  assert.equal(validCodeVerifier("a".repeat(128)), true);
  for (const bad of ["a".repeat(42), "a".repeat(129), "a".repeat(42) + " ", "a".repeat(42) + "/", null]) assert.equal(validCodeVerifier(bad), false, String(bad));
});

test("oauthCodeKey: changing ANY bound value gives a different key, and fields can't be smuggled across boundaries", () => {
  const base = { code: "c0de", clientId: "bcc_x", redirectUri: CLAUDE_CB, codeChallenge: CHALLENGE };
  const k = oauthCodeKey(base);
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.equal(oauthCodeKey({ ...base }), k);
  for (const field of Object.keys(base)) assert.notEqual(oauthCodeKey({ ...base, [field]: base[field] + "x" }), k, field);
  assert.notEqual(oauthCodeKey({ ...base, code: 'c0de","bcc_x', clientId: "" }), k, "no separator ambiguity");
});

test("validateAuthorizeRequest: a good request yields everything the consent screen and the code need", () => {
  const v = validateAuthorizeRequest(authQuery(), ORIGIN);
  assert.equal(v.ok, true);
  assert.equal(v.client.name, "Claude");
  assert.equal(v.redirectUri, CLAUDE_CB);
  assert.equal(v.state, "xyz");
  assert.equal(v.codeChallenge, CHALLENGE);
  assert.equal(v.destination.kind, "known");
  // redirect_uri may be omitted when exactly one is registered.
  assert.equal(validateAuthorizeRequest(authQuery({ redirect_uri: undefined }), ORIGIN).redirectUri, CLAUDE_CB);
  // resource, when given, must be this server's MCP endpoint (or its origin).
  assert.equal(validateAuthorizeRequest(authQuery({ resource: `${ORIGIN}/api/mcp` }), ORIGIN).ok, true);
  assert.equal(validateAuthorizeRequest(authQuery({ resource: `${ORIGIN}/` }), ORIGIN).ok, true);
});

test("validateAuthorizeRequest: a bad client or redirect is FATAL — it must never produce a redirect (open-redirector guard)", () => {
  const two = client([CLAUDE_CB, "http://localhost:1/cb"]).client_id;
  for (const q of [
    authQuery({ client_id: "nope" }),
    authQuery({ client_id: undefined }),
    authQuery({ redirect_uri: "https://evil.example/cb" }),
    authQuery({ redirect_uri: CLAUDE_CB + "?next=https://evil.example" }),
    authQuery({ client_id: two, redirect_uri: undefined }), // ambiguous: two registered, none named
    authQuery({ client_id: ["a", "b"] }),
  ]) {
    const v = validateAuthorizeRequest(q, ORIGIN);
    assert.equal(v.ok, false);
    assert.equal(typeof v.fatal, "string");
    assert.equal(v.redirect, undefined, JSON.stringify(q).slice(0, 80));
  }
});

test("validateAuthorizeRequest: a bad request from a good client is returned to that client's own redirect, with state and iss", () => {
  const cases = [
    [authQuery({ response_type: "token" }), "unsupported_response_type"],
    [authQuery({ code_challenge_method: "plain" }), "invalid_request"],
    [authQuery({ code_challenge_method: undefined }), "invalid_request"],
    [authQuery({ code_challenge: undefined }), "invalid_request"],
    [authQuery({ code_challenge: "tooshort" }), "invalid_request"],
    [authQuery({ state: "s".repeat(1025) }), "invalid_request"],
    [authQuery({ resource: "https://other.example/mcp" }), "invalid_target"],
  ];
  for (const [q, error] of cases) {
    const v = validateAuthorizeRequest(q, ORIGIN);
    assert.equal(v.ok, false);
    assert.equal(v.fatal, undefined);
    const u = new URL(v.redirect);
    assert.equal(u.origin + u.pathname, CLAUDE_CB, "only ever the registered redirect");
    assert.equal(u.searchParams.get("error"), error);
    assert.equal(u.searchParams.get("iss"), ORIGIN);
    assert.equal(u.searchParams.get("code"), null);
  }
});

test("redirectWith: appends to the redirect's own query, skips empty values, encodes hostile state", () => {
  assert.equal(redirectWith("http://localhost:1/cb?a=1", { code: "c", state: "", iss: ORIGIN }), "http://localhost:1/cb?a=1&code=c&iss=https%3A%2F%2Fback-channel.app");
  const u = new URL(redirectWith(CLAUDE_CB, { state: "x&code=stolen#frag" }));
  assert.equal(u.searchParams.get("state"), "x&code=stolen#frag");
  assert.equal(u.searchParams.get("code"), null);
  assert.equal(u.hash, "");
});
