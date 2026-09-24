import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { verifyGoogleIdToken, resetGoogleKeyCache } from "@/lib/google-id-token";

const AUD = "https://back-channel.app";
const EMAIL = "backchannel-relay@proj.iam.gserviceaccount.com";
const google = generateKeyPairSync("rsa", { modulusLength: 2048 });
const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...google.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const realFetch = globalThis.fetch;
let fetches = 0;

function token(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}, key: KeyObject = google.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT", ...header })).toString("base64url");
  const p = Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: AUD, email: EMAIL, email_verified: true, iat: now, exp: now + 3600, ...claims })).toString("base64url");
  return `${h}.${p}.${sign("RSA-SHA256", Buffer.from(`${h}.${p}`), key).toString("base64url")}`;
}
beforeEach(() => {
  resetGoogleKeyCache(); fetches = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    fetches++;
    assert.equal(url, "https://www.googleapis.com/oauth2/v3/certs"); assert.equal(init.redirect, "error");
    return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json", "cache-control": "public, max-age=19000" } });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

test("a valid token for the relay's identity verifies, and the key set is cached", async () => {
  assert.equal(await verifyGoogleIdToken(token(), { audience: AUD, email: EMAIL }), true);
  assert.equal(await verifyGoogleIdToken(token(), { audience: AUD, email: EMAIL }), true);
  assert.equal(fetches, 1);
});

test("wrong audience, email, issuer, unverified email, expiry or lifetime are refused before any key fetch", async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const claims of [{ aud: "https://evil.example" }, { email: "someone@proj.iam.gserviceaccount.com" }, { iss: "https://evil.example" },
    { email_verified: false }, { exp: now - 1 }, { iat: now + 600 }, { iat: now - 10, exp: now + 7200 }, { exp: "soon" }]) {
    assert.equal(await verifyGoogleIdToken(token(claims), { audience: AUD, email: EMAIL }), false, JSON.stringify(claims));
  }
  assert.equal(fetches, 0);
});

test("a forged signature, another algorithm or a malformed token is refused", async () => {
  assert.equal(await verifyGoogleIdToken(token({}, {}, attacker.privateKey), { audience: AUD, email: EMAIL }), false);
  assert.equal(await verifyGoogleIdToken(token({}, { alg: "none" }), { audience: AUD, email: EMAIL }), false);
  assert.equal(await verifyGoogleIdToken(token({}, { alg: "HS256" }), { audience: AUD, email: EMAIL }), false);
  assert.equal(await verifyGoogleIdToken(token({}, { crit: ["x"] }), { audience: AUD, email: EMAIL }), false);
  const [h, p] = token().split(".");
  assert.equal(await verifyGoogleIdToken(`${h}.${p}.`, { audience: AUD, email: EMAIL }), false);
  assert.equal(await verifyGoogleIdToken("a.b", { audience: AUD, email: EMAIL }), false);
  assert.equal(await verifyGoogleIdToken("x".repeat(5000), { audience: AUD, email: EMAIL }), false);
});

test("an unknown key id refetches at most once a minute", async () => {
  assert.equal(await verifyGoogleIdToken(token({}, { kid: "unknown" }), { audience: AUD, email: EMAIL }), false);
  assert.equal(await verifyGoogleIdToken(token({}, { kid: "unknown" }), { audience: AUD, email: EMAIL }), false);
  assert.equal(fetches, 1);
});

test("a key-set outage is a refusal, never an exception", async () => {
  globalThis.fetch = (async () => { throw new TypeError("network down"); }) as typeof fetch;
  assert.equal(await verifyGoogleIdToken(token(), { audience: AUD, email: EMAIL }), false);
});
