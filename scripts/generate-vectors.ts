/**
 * Back Channel — deterministic generator for the crypto-v1 known-answer vectors.
 *
 *   npx tsx scripts/generate-vectors.ts
 *
 * Writes vectors/crypto-v1.json and a byte-identical copy to
 * apps/broker/public/interop/crypto-v1.json (served at /interop/crypto-v1.json).
 *
 * DESIGN RULE — INDEPENDENCE. Every expected value is computed WITHOUT the code
 * the vectors certify: HKDF comes from node:crypto's OpenSSL-backed hkdfSync
 * (not the library's hand-rolled HMAC expand loop), and ciphertexts come from
 * createCipheriv directly (not seal()/sealWithIv()). A bug mirrored across both
 * in-repo implementations therefore cannot self-certify. The library and the
 * .mcpb bridge appear only in the post-generation self-check phase below, as
 * assertions — never as a source of expected values. Any self-check failure
 * aborts before writing, because such a failure means a real implementation bug.
 *
 * Fully deterministic: no randomBytes anywhere. Re-running must produce
 * byte-identical output.
 *
 * Regenerating is a COMPATIBILITY EVENT — see docs/interop-vectors.md. While
 * v:1 crypto is live, vectors may be appended but never changed.
 */

import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  hkdfSync,
} from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The implementations under test — self-check use ONLY.
import {
  loadEphemeralKeypair,
  deriveSessionKey,
  deriveSessionKeyFromSharedSecret,
} from "../src/crypto/session-key.js";
import { sealWithIv, open as openEnvelope } from "../src/crypto/envelope.js";
import {
  loadKeypair as bridgeLoadKeypair,
  deriveSessionKey as bridgeDerive,
  seal as bridgeSeal,
  open as bridgeOpen,
} from "../apps/broker/connector/server/crypto.js";

const CURVE = "prime256v1";
const HKDF_SALT = Buffer.alloc(32, 0);
const HKDF_INFO = Buffer.from("back-channel/v1/session-key");
const KEY_BYTES = 32;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Independent HKDF-SHA-256 — OpenSSL's, not the library's. */
function independentHkdf(ikm: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, HKDF_SALT, HKDF_INFO, KEY_BYTES));
}

const sha256 = (s: string): Buffer => createHash("sha256").update(s).digest();

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`vector generation aborted: ${msg}`);
}

// ---------------------------------------------------------------- hkdf

const HKDF_IKMS: ReadonlyArray<{ name: string; ikm: Buffer }> = [
  { name: "all-zero ikm", ikm: Buffer.alloc(32, 0x00) },
  { name: "all-0xff ikm", ikm: Buffer.alloc(32, 0xff) },
  {
    name: "counting ikm 0x01..0x20",
    ikm: Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)),
  },
  { name: "fixed arbitrary ikm", ikm: sha256("back-channel-hkdf-vector-4") },
];

const hkdfVectors = HKDF_IKMS.map(({ name, ikm }) => ({
  name,
  ikm_hex: ikm.toString("hex"),
  session_key_hex: independentHkdf(ikm).toString("hex"),
}));

// ------------------------------------------------------------ ecdh_p256

const ECDH_PAIRS: ReadonlyArray<{ name: string; alice: string; bob: string }> = [
  {
    name: "fixed keypair 1",
    alice: "back-channel-vector-alice-1",
    bob: "back-channel-vector-bob-1",
  },
  {
    name: "fixed keypair 2",
    alice: "back-channel-vector-alice-2",
    bob: "back-channel-vector-bob-2",
  },
  {
    name: "fixed keypair 3",
    alice: "back-channel-vector-alice-3",
    bob: "back-channel-vector-bob-3",
  },
];

const ecdhVectors = ECDH_PAIRS.map(({ name, alice, bob }) => {
  // setPrivateKey throws if the scalar is not in [1, n-1]; none of the fixed
  // seeds below have ever produced one. If a future seed does, append a suffix
  // to that seed string and note it here rather than reusing a scalar.
  const alicePriv = sha256(alice);
  const bobPriv = sha256(bob);

  const aliceEcdh = createECDH(CURVE);
  aliceEcdh.setPrivateKey(alicePriv);
  const bobEcdh = createECDH(CURVE);
  bobEcdh.setPrivateKey(bobPriv);

  const alicePub = aliceEcdh.getPublicKey();
  const bobPub = bobEcdh.getPublicKey();

  const secretA = aliceEcdh.computeSecret(bobPub);
  const secretB = bobEcdh.computeSecret(alicePub);
  assert(secretA.equals(secretB), `${name}: ECDH sides disagree`);

  return {
    name,
    // The ACTUAL scalars in use — consumers must not re-derive them.
    alice_private_hex: aliceEcdh.getPrivateKey().toString("hex"),
    alice_public_b64: alicePub.toString("base64"),
    bob_private_hex: bobEcdh.getPrivateKey().toString("hex"),
    bob_public_b64: bobPub.toString("base64"),
    shared_secret_hex: secretA.toString("hex"),
    session_key_hex: independentHkdf(secretA).toString("hex"),
  };
});

// ------------------------------------------------------------- envelope

interface EnvelopeSeed {
  name: string;
  keySeed: string;
  ivHex: string;
  plaintext: unknown;
}

const ENVELOPE_SEEDS: ReadonlyArray<EnvelopeSeed> = [
  {
    name: "simple frame",
    keySeed: "back-channel-vector-envelope-key-1",
    ivHex: "000102030405060708090a0b",
    plaintext: { type: "meta.dialog", text: "hello" },
  },
  {
    name: "multi-byte utf-8 (emoji + CJK)",
    keySeed: "back-channel-vector-envelope-key-2",
    ivHex: "0b0a09080706050403020100",
    plaintext: { type: "meta.dialog", text: "hello 👋 世界 — café" },
  },
  {
    name: "realistic invoke.request frame",
    keySeed: "back-channel-vector-envelope-key-3",
    ivHex: "aabbccddeeff001122334455",
    plaintext: {
      type: "invoke.request",
      id: "m_vector_3",
      capability: "config.read",
      args: { path: "package.json", maxBytes: 4096 },
    },
  },
  {
    name: "empty object",
    keySeed: "back-channel-vector-envelope-key-4",
    ivHex: "0102030405060708090a0b0c",
    plaintext: {},
  },
];

const envelopeVectors = ENVELOPE_SEEDS.map(
  ({ name, keySeed, ivHex, plaintext }) => {
    const key = sha256(keySeed);
    const iv = Buffer.from(ivHex, "hex");
    assert(iv.length === 12, `${name}: IV must be 12 bytes`);

    const plaintextJson = JSON.stringify(plaintext);

    // Canonical-plaintext rules (docs/interop-vectors.md, "Layer 1"): the
    // recorded bytes must survive a JSON round-trip unchanged, so that a
    // conforming implementation encrypting JSON.stringify(plaintext) lands on
    // exactly these bytes.
    assert(
      JSON.stringify(JSON.parse(plaintextJson)) === plaintextJson,
      `${name}: plaintext_json is not round-trip stable`,
    );

    // Expected ciphertext from the primitive directly — never via seal().
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([
      cipher.update(Buffer.from(plaintextJson, "utf8")),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return {
      name,
      key_hex: key.toString("hex"),
      iv_b64: iv.toString("base64"),
      plaintext,
      plaintext_json: plaintextJson,
      envelope: {
        type: "enc" as const,
        v: 1 as const,
        iv: iv.toString("base64"),
        ct: ct.toString("base64"),
        tag: tag.toString("base64"),
      },
    };
  },
);

// No key+IV pair may ever repeat across vectors (GCM nonce-reuse hygiene).
{
  const pairs = new Set(
    envelopeVectors.map((v) => `${v.key_hex}:${v.envelope.iv}`),
  );
  assert(pairs.size === envelopeVectors.length, "duplicate key+IV pair");
}

// -------------------------------------------------------- envelope_reject

const base = envelopeVectors[0]!;

function flipLastByte(b64: string): string {
  const buf = Buffer.from(b64, "base64");
  buf[buf.length - 1] ^= 0xff;
  return buf.toString("base64");
}

function flipFirstByte(b64: string): string {
  const buf = Buffer.from(b64, "base64");
  buf[0] ^= 0xff;
  return buf.toString("base64");
}

const envelopeRejectVectors = [
  {
    name: "tampered tag (last byte flipped)",
    key_hex: base.key_hex,
    envelope: { ...base.envelope, tag: flipLastByte(base.envelope.tag) },
    reason: "auth tag does not verify",
  },
  {
    name: "tampered ciphertext (first byte flipped)",
    key_hex: base.key_hex,
    envelope: { ...base.envelope, ct: flipFirstByte(base.envelope.ct) },
    reason: "auth tag does not verify over the modified ciphertext",
  },
  {
    name: "wrong key",
    key_hex: sha256("back-channel-vector-wrong-key").toString("hex"),
    envelope: { ...base.envelope },
    reason: "envelope is valid but the session key is different",
  },
  {
    name: "8-byte IV (wrong length)",
    key_hex: base.key_hex,
    envelope: {
      ...base.envelope,
      iv: Buffer.from("0001020304050607", "hex").toString("base64"),
    },
    reason: "IV must be exactly 12 bytes",
  },
  {
    name: "unsupported envelope version",
    key_hex: base.key_hex,
    envelope: { ...base.envelope, v: 2 as unknown as 1 },
    reason: "only envelope v:1 is defined by this spec",
  },
];

// -------------------------------------------------------------- assemble

const vectors = {
  _meta: {
    name: "back-channel crypto-v1 known-answer vectors",
    version: 1,
    spec: {
      curve: "prime256v1 (P-256), uncompressed points, base64 on the wire",
      kdf: 'HKDF-SHA-256, salt = 32 zero bytes, info = "back-channel/v1/session-key", L = 32',
      aead: "AES-256-GCM, 12-byte IV, 16-byte tag, no AAD, plaintext = UTF-8 JSON",
      envelope: '{ type: "enc", v: 1, iv: b64, ct: b64, tag: b64 }',
      contract:
        "Layer 1: encrypting the exact plaintext_json bytes with key+iv MUST yield exactly ct+tag (and decrypting MUST yield those bytes). Layer 2: receivers compare decrypted JSON semantically; key order/whitespace are not part of the contract.",
    },
    generator: "scripts/generate-vectors.ts",
    docs: "docs/interop-vectors.md",
    published: "https://back-channel.app/interop/crypto-v1.json",
  },
  hkdf: hkdfVectors,
  ecdh_p256: ecdhVectors,
  envelope: envelopeVectors,
  envelope_reject: envelopeRejectVectors,
};

// ------------------------------------------------- self-check (assertions)
// The implementations under test are exercised HERE ONLY, against values they
// did not produce. A failure here is a real bug; abort without writing.

for (const v of vectors.hkdf) {
  const got = deriveSessionKeyFromSharedSecret(Buffer.from(v.ikm_hex, "hex"));
  assert(
    got.toString("hex") === v.session_key_hex,
    `hkdf self-check failed: ${v.name}`,
  );
}

for (const v of vectors.ecdh_p256) {
  const alicePrivB64 = Buffer.from(v.alice_private_hex, "hex").toString(
    "base64",
  );
  const bobPrivB64 = Buffer.from(v.bob_private_hex, "hex").toString("base64");

  const alice = loadEphemeralKeypair(alicePrivB64);
  const bob = loadEphemeralKeypair(bobPrivB64);
  assert(alice.publicKey === v.alice_public_b64, `${v.name}: alice pubkey`);
  assert(bob.publicKey === v.bob_public_b64, `${v.name}: bob pubkey`);
  assert(
    deriveSessionKey(alice, v.bob_public_b64).toString("hex") ===
      v.session_key_hex,
    `ecdh self-check failed (library, alice side): ${v.name}`,
  );
  assert(
    deriveSessionKey(bob, v.alice_public_b64).toString("hex") ===
      v.session_key_hex,
    `ecdh self-check failed (library, bob side): ${v.name}`,
  );

  const bridgeAlice = bridgeLoadKeypair(alicePrivB64);
  assert(
    bridgeDerive(bridgeAlice.handle, v.bob_public_b64).toString("hex") ===
      v.session_key_hex,
    `ecdh self-check failed (bridge): ${v.name}`,
  );
}

for (const v of vectors.envelope) {
  const key = Buffer.from(v.key_hex, "hex");
  const iv = Buffer.from(v.iv_b64, "base64");

  // Canonical rule, checked against the value as it will be re-parsed.
  assert(
    JSON.stringify(v.plaintext) === v.plaintext_json,
    `${v.name}: JSON.stringify(plaintext) !== plaintext_json`,
  );

  // Decrypt direction: raw primitive recovers the exact canonical bytes.
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(Buffer.from(v.envelope.tag, "base64"));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(v.envelope.ct, "base64")),
    decipher.final(),
  ]);
  assert(
    pt.toString("utf8") === v.plaintext_json,
    `${v.name}: raw decrypt mismatch`,
  );

  assert(
    JSON.stringify(openEnvelope(v.envelope, key)) === v.plaintext_json,
    `envelope self-check failed (library open): ${v.name}`,
  );
  assert(
    JSON.stringify(bridgeOpen(v.envelope, key)) === v.plaintext_json,
    `envelope self-check failed (bridge open): ${v.name}`,
  );

  const libSealed = sealWithIv(v.plaintext, key, iv);
  assert(
    libSealed.ct === v.envelope.ct && libSealed.tag === v.envelope.tag,
    `envelope self-check failed (library sealWithIv): ${v.name}`,
  );
  const bridgeSealed = bridgeSeal(v.plaintext, key, iv);
  assert(
    bridgeSealed.ct === v.envelope.ct && bridgeSealed.tag === v.envelope.tag,
    `envelope self-check failed (bridge seal): ${v.name}`,
  );
}

for (const v of vectors.envelope_reject) {
  const key = Buffer.from(v.key_hex, "hex");
  let libThrew = false;
  let bridgeThrew = false;
  try {
    openEnvelope(v.envelope, key);
  } catch {
    libThrew = true;
  }
  try {
    bridgeOpen(v.envelope, key);
  } catch {
    bridgeThrew = true;
  }
  assert(libThrew, `reject self-check failed (library accepted): ${v.name}`);
  assert(bridgeThrew, `reject self-check failed (bridge accepted): ${v.name}`);
}

// ----------------------------------------------------------------- write

const json = `${JSON.stringify(vectors, null, 2)}\n`;

const targets = [
  join(repoRoot, "vectors", "crypto-v1.json"),
  join(repoRoot, "apps", "broker", "public", "interop", "crypto-v1.json"),
];

for (const target of targets) {
  mkdirSync(dirname(target), { recursive: true });
  // Explicit LF, no BOM — the two copies must be byte-identical everywhere.
  writeFileSync(target, json, { encoding: "utf8" });
}

console.log(
  `wrote ${vectors.hkdf.length} hkdf, ${vectors.ecdh_p256.length} ecdh_p256, ` +
    `${vectors.envelope.length} envelope, ${vectors.envelope_reject.length} envelope_reject vectors`,
);
for (const t of targets) console.log(`  → ${t}`);
