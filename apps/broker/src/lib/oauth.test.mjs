import { test } from "node:test";
import assert from "node:assert/strict";
import {
  protectedResourceMetadata, authorizationServerMetadata, wwwAuthenticate,
  parseRedirectUri, redirectUriRegistered, describeDestination, runtimeTypeFor, resourceIsThisServer,
  cleanClientName, registerClient, readClient,
  validCodeChallenge, validCodeVerifier, s256, oauthCodeKey,
  redirectWith, validateAuthorizeRequest,
} from "./oauth.mjs";

const ORIGIN = "https://back-channel.app";
const CLAUDE_CB = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "a".repeat(43);
const CHALLENGE = s256(VERIFIER);
const client = (uris = [CLAUDE_CB], name = "Claude") => registerClient({ client_name: name, redirect_uris: uris });
const RESOURCE = `${ORIGIN}/api/mcp`;
const authQuery = (over = {}) => ({ response_type: "code", client_id: client().client_id, redirect_uri: CLAUDE_CB, code_challenge: CHALLENGE, code_challenge_method: "S256", state: "xyz", resource: RESOURCE, ...over });

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
  assert.equal(wwwAuthenticate(ORIGIN), `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`);
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
  // Lookalikes are not the real thing — and neither is any OTHER url on the real sites.
  for (const fake of [
    "https://claude.ai.evil.example/api/mcp/auth_callback", "https://evil.example/claude.ai", "https://xclaude.ai/api/mcp/auth_callback", "https://chatgpt.com.evil.example/connector_platform_oauth_redirect",
    "https://claude.ai/", "https://claude.ai/some/other/path", "https://claude.ai:8443/api/mcp/auth_callback", "https://claude.ai/api/mcp/auth_callback?x=1", "https://claude.ai/api/mcp/auth_callback/", "https://chatgpt.com/g/some-gpt/callback",
  ]) {
    assert.equal(describeDestination(fake).kind, "unknown", fake);
  }
  assert.equal(describeDestination("https://claude.com/api/mcp/auth_callback").kind, "known");
  assert.equal(describeDestination("https://claude.ai.evil.example/cb").host, "claude.ai.evil.example", "the full host is what gets shown");
  assert.equal(describeDestination("https://xn--clude-0ra.ai/api/mcp/auth_callback").host, "xn--clude-0ra.ai", "an IDN lookalike is shown as punycode");
  assert.equal(describeDestination("javascript:alert(1)").kind, "invalid");
  assert.equal(runtimeTypeFor("https://chatgpt.com/x"), "chatgpt");
  assert.equal(runtimeTypeFor(CLAUDE_CB), "other");
  assert.equal(runtimeTypeFor("nope"), "other");
});

test("cleanClientName: one short line of plain ASCII — nothing that can restyle, reorder, impersonate by look-alike, or badge itself", () => {
  assert.equal(cleanClientName("  Claude  "), "Claude");
  assert.equal(cleanClientName("Acme\nApp\t(beta)"), "Acme App beta");
  assert.equal(cleanClientName("Evil‮edoc⁦ <b>x</b> \u0000"), "Evil edoc b x b");
  assert.equal(cleanClientName("x".repeat(200)).length, 60);
  for (const empty of ["", "   ", null, undefined, 42, {}, "‮​", "Клод"]) assert.equal(cleanClientName(empty), "An MCP client");
  // Look-alike letters from other scripts do not survive as letters.
  assert.equal(cleanClientName("Сlaude"), "laude", "Cyrillic Es is not Latin C");
  assert.equal(cleanClientName("Ｃｌａｕｄｅ"), "An MCP client", "fullwidth letters");
  // A name cannot hand itself a parenthesised badge.
  assert.equal(cleanClientName("Claude (verified by Back Channel)"), "Claude verified by Back Channel");
  assert.equal(cleanClientName("O'Reilly Build-Bot & Co. v2.1"), "O'Reilly Build-Bot & Co. v2.1");
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
  // resource may be written any way a URL parser reads as this server's MCP endpoint (or its origin).
  for (const resource of [`${ORIGIN}/api/mcp/`, `${ORIGIN}/`, ORIGIN, "https://BACK-CHANNEL.app/api/mcp", "https://back-channel.app:443/api/mcp"]) {
    assert.equal(validateAuthorizeRequest(authQuery({ resource }), ORIGIN).ok, true, resource);
  }
});

test("resourceIsThisServer: only this origin, only the MCP path or the bare origin", () => {
  for (const no of [
    "", null, undefined, 42, "not a url", "https://evil.example/api/mcp", "http://back-channel.app/api/mcp", "https://back-channel.app.evil.example/api/mcp",
    "https://back-channel.app:8443/api/mcp", "https://back-channel.app/api/mcp/extra", "https://back-channel.app/api", "https://back-channel.app/api/mcp?x=1",
    "https://back-channel.app/api/mcp#f", "https://user@back-channel.app/api/mcp", "https://www.back-channel.app/api/mcp",
  ]) {
    assert.equal(resourceIsThisServer(no, ORIGIN), false, String(no));
  }
});

test("validateAuthorizeRequest: resource is REQUIRED — a flow that does not say which server the key is for is refused", () => {
  // The mix-up this closes: a hostile MCP server names us as its authorization
  // server; the client runs an honest-looking flow here and carries the key there.
  const missing = validateAuthorizeRequest(authQuery({ resource: undefined }), ORIGIN);
  assert.equal(missing.ok, false);
  assert.equal(new URL(missing.redirect).searchParams.get("error"), "invalid_target");
  const theirs = validateAuthorizeRequest(authQuery({ resource: "https://evil.example/mcp" }), ORIGIN);
  assert.equal(new URL(theirs.redirect).searchParams.get("error"), "invalid_target");
  assert.equal(new URL(theirs.redirect).searchParams.get("code"), null);
});

test("validateAuthorizeRequest: a malformed request aimed at an UNKNOWN site is shown here, never bounced there (zero-click open redirect)", () => {
  // Anyone can mint a client_id for any https redirect, so "registered" proves nothing.
  const forged = "bcc_" + Buffer.from(JSON.stringify({ v: 1, n: "x", r: ["https://evil.example/phish"] })).toString("base64url");
  for (const q of [
    { client_id: forged },
    { client_id: forged, redirect_uri: "https://evil.example/phish", response_type: "token" },
    { client_id: forged, response_type: "code", code_challenge: CHALLENGE, code_challenge_method: "S256" }, // no resource
    { client_id: forged, response_type: "code", code_challenge: CHALLENGE, code_challenge_method: "S256", resource: "https://evil.example/mcp" },
  ]) {
    const v = validateAuthorizeRequest(q, ORIGIN);
    assert.equal(v.ok, false);
    assert.equal(v.redirect, undefined, JSON.stringify(q).slice(0, 90));
    assert.match(v.fatal, /incomplete/);
  }
  // A complete, well-formed request to an unknown site still reaches the consent screen (with its warning).
  const full = validateAuthorizeRequest({ client_id: forged, response_type: "code", code_challenge: CHALLENGE, code_challenge_method: "S256", resource: RESOURCE }, ORIGIN);
  assert.equal(full.ok, true);
  assert.equal(full.destination.kind, "unknown");
  // And a loopback client is still told about its mistakes the normal way.
  const cli = registerClient({ redirect_uris: ["http://localhost:7777/cb"] }).client_id;
  assert.equal(new URL(validateAuthorizeRequest({ client_id: cli, response_type: "token" }, ORIGIN).redirect).searchParams.get("error"), "unsupported_response_type");
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
