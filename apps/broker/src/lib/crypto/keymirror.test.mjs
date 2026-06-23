// Unit tests for the key-mirror crypto core. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateMirrorKeypair, hpkeWrapK, hpkeOpenK, deriveKekFromSecret, wrapMirrorPriv,
  unwrapMirrorPriv, makeFrameIv, ivOrigin, ivCounter, ORIGIN_AGENT, ORIGIN_HUMAN,
  importK, sealFrame, openFrame, generateRecovery, rkFromMnemonic, isValidRecovery,
  b64, unb64,
} from "./keymirror.mjs";

const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

test("HPKE wrap/open round-trips the session key K (agent has only the public key)", async () => {
  const { mirrorPub, mirrorPrivRaw } = await generateMirrorKeypair();
  const K = rand(32);
  const wrap = await hpkeWrapK(mirrorPub, K, "sess-1", "acct-A");   // agent side (pub only)
  const out = await hpkeOpenK(mirrorPrivRaw, wrap, "sess-1", "acct-A"); // browser side
  assert.deepEqual(out, K);
});

test("HPKE open fails if the AAD (sessionId/accountId) is wrong — no cross-session reuse", async () => {
  const { mirrorPub, mirrorPrivRaw } = await generateMirrorKeypair();
  const wrap = await hpkeWrapK(mirrorPub, rand(32), "sess-1", "acct-A");
  await assert.rejects(() => hpkeOpenK(mirrorPrivRaw, wrap, "sess-2", "acct-A"));
  await assert.rejects(() => hpkeOpenK(mirrorPrivRaw, wrap, "sess-1", "acct-B"));
});

test("HPKE open fails with a different mirror private key", async () => {
  const a = await generateMirrorKeypair();
  const b = await generateMirrorKeypair();
  const wrap = await hpkeWrapK(a.mirrorPub, rand(32), "s", "acct");
  await assert.rejects(() => hpkeOpenK(b.mirrorPrivRaw, wrap, "s", "acct"));
});

test("KEK wrap/unwrap of mirror_priv round-trips; wrong KEK → AEAD-tag failure (re-enroll signal)", async () => {
  const kek = await deriveKekFromSecret(rand(32));
  const priv = rand(32);
  const blob = await wrapMirrorPriv(kek, priv, "acct-A");
  assert.deepEqual(await unwrapMirrorPriv(kek, blob, "acct-A"), priv);
  // wrong KEK (divergent PRF / wrong passkey) must THROW, not silently return junk
  const wrongKek = await deriveKekFromSecret(rand(32));
  await assert.rejects(() => unwrapMirrorPriv(wrongKek, blob, "acct-A"));
  // wrong AAD (accountId) must also throw
  await assert.rejects(() => unwrapMirrorPriv(kek, blob, "acct-B"));
});

test("same PRF secret → same KEK (determinism the cross-device path relies on)", async () => {
  const secret = rand(32);
  const k1 = await deriveKekFromSecret(secret);
  const k2 = await deriveKekFromSecret(secret);
  const priv = rand(32);
  const blob = await wrapMirrorPriv(k1, priv, "acct");
  assert.deepEqual(await unwrapMirrorPriv(k2, blob, "acct"), priv); // k2 opens k1's wrap
});

test("structured IV: origin bit + counter encode/decode; never collide across writers", () => {
  const a = makeFrameIv(ORIGIN_AGENT, 5n);
  const h = makeFrameIv(ORIGIN_HUMAN, 5n);
  assert.equal(ivOrigin(a), ORIGIN_AGENT);
  assert.equal(ivOrigin(h), ORIGIN_HUMAN);
  assert.equal(ivCounter(a), 5n);
  assert.equal(ivCounter(h), 5n);
  assert.notDeepEqual(a, h); // same counter, different origin → different IV (top bit)
});

test("IV uniqueness fuzz: 20k IVs across both writers, zero collisions", () => {
  const seen = new Set();
  let counter = 0n;
  for (let i = 0; i < 10000; i++) {
    for (const origin of [ORIGIN_AGENT, ORIGIN_HUMAN]) {
      const iv = makeFrameIv(origin, counter);
      const key = b64(iv);
      assert.ok(!seen.has(key), "IV collision");
      seen.add(key);
    }
    counter++;
  }
  assert.equal(seen.size, 20000);
});

test("frame counter rollover throws (never silently wraps)", () => {
  assert.throws(() => makeFrameIv(ORIGIN_HUMAN, (1n << 64n)));
  assert.throws(() => makeFrameIv(ORIGIN_HUMAN, -1n));
  assert.throws(() => makeFrameIv(2, 0n));
});

test("frame seal/open round-trips an inner object; tampered ct → tag failure", async () => {
  const kKey = await importK(rand(32));
  const inner = { type: "meta.dialog", origin: "human", text: "hello peer", ts: 123 };
  const frame = await sealFrame(kKey, inner, ORIGIN_HUMAN, 7n);
  assert.equal(frame.type, "enc");
  assert.equal(frame.v, 1);
  assert.deepEqual(await openFrame(kKey, frame), inner);
  // flip a ciphertext byte → must throw
  const ct = unb64(frame.ct); ct[0] ^= 0xff;
  await assert.rejects(() => openFrame(kKey, { ...frame, ct: b64(ct) }));
});

test("frame sealed by one writer opens with the same K regardless of origin (shared key)", async () => {
  const K = rand(32);
  const agentKey = await importK(K);
  const humanKey = await importK(K);
  const frame = await sealFrame(agentKey, { text: "from agent" }, ORIGIN_AGENT, 1n);
  assert.deepEqual(await openFrame(humanKey, frame), { text: "from agent" });
});

test("BIP39 recovery: 24-word mnemonic ↔ 256-bit RK round-trips; tamper rejected", () => {
  const { mnemonic, rk } = generateRecovery();
  assert.equal(mnemonic.trim().split(/\s+/).length, 24);
  assert.equal(rk.length, 32);
  assert.ok(isValidRecovery(mnemonic));
  assert.deepEqual(rkFromMnemonic(mnemonic), rk);
  assert.throws(() => rkFromMnemonic(mnemonic + " bogus"));
  assert.equal(isValidRecovery("not a real mnemonic at all"), false);
});

test("recovery RK can wrap/unwrap mirror_priv (the lost-device path)", async () => {
  const { mnemonic, rk } = generateRecovery();
  const kek = await deriveKekFromSecret(rk);
  const priv = rand(32);
  const recoveryWrap = await wrapMirrorPriv(kek, priv, "acct-A");
  // later, on a new device, from the 24 words:
  const rk2 = rkFromMnemonic(mnemonic);
  const kek2 = await deriveKekFromSecret(rk2);
  assert.deepEqual(await unwrapMirrorPriv(kek2, recoveryWrap, "acct-A"), priv);
});

test("full enroll→wrap→unlock→open chain (no server secrets)", async () => {
  // enroll
  const { mirrorPub, mirrorPrivRaw } = await generateMirrorKeypair();
  const prfSecret = rand(32);                       // from WebAuthn PRF
  const kek = await deriveKekFromSecret(prfSecret);
  const wrappedPriv = await wrapMirrorPriv(kek, mirrorPrivRaw, "acct-A");
  // agent wraps the session key
  const K = rand(32);
  const userWrap = await hpkeWrapK(mirrorPub, K, "sess-9", "acct-A");
  // browser unlock: PRF→KEK→mirror_priv→K
  const priv2 = await unwrapMirrorPriv(kek, wrappedPriv, "acct-A");
  const K2 = await hpkeOpenK(priv2, userWrap, "sess-9", "acct-A");
  assert.deepEqual(K2, K);
  // and decrypt a frame the agent sealed under K
  const frame = await sealFrame(await importK(K), { text: "agent says hi" }, ORIGIN_AGENT, 1n);
  assert.deepEqual(await openFrame(await importK(K2), frame), { text: "agent says hi" });
});
