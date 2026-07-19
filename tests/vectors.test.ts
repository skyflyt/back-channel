// Known-answer tests against the frozen crypto-v1 vectors.
//
// tests/crypto.test.ts proves the library round-trips with itself, and
// tests/mcpb-crypto-interop.test.ts proves the library and the .mcpb bridge
// agree with each other. Both would still pass if a bug were mirrored across
// the two implementations — they were written in the same repo, from the same
// reading of the spec. This suite closes that hole: every expected value in
// vectors/crypto-v1.json was computed by an INDEPENDENT implementation (Node's
// OpenSSL-backed hkdfSync and raw createCipheriv — see scripts/generate-vectors.ts),
// and both in-repo implementations are checked against it, in BOTH directions.
//
// The contract has two layers (docs/interop-vectors.md):
//   Layer 1 — byte-exact: encrypting the exact plaintext_json bytes with the
//             vector's key+IV must yield exactly ct+tag, and decrypting must
//             recover those exact bytes.
//   Layer 2 — semantic: receivers compare decrypted JSON by value; key order
//             and whitespace are not part of the contract.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createDecipheriv } from "node:crypto";

import {
  loadEphemeralKeypair,
  deriveSessionKey,
  deriveSessionKeyFromSharedSecret,
} from "../src/crypto/session-key.js";
import {
  seal,
  sealWithIv,
  open as openEnvelope,
  type SealedEnvelope,
} from "../src/crypto/envelope.js";
import {
  loadKeypair as bridgeLoadKeypair,
  deriveSessionKey as bridgeDerive,
  seal as bridgeSeal,
  open as bridgeOpen,
} from "../apps/broker/connector/server/crypto.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const CANONICAL_PATH = join(repoRoot, "vectors", "crypto-v1.json");
const PUBLISHED_PATH = join(
  repoRoot,
  "apps",
  "broker",
  "public",
  "interop",
  "crypto-v1.json",
);

interface HkdfVector {
  name: string;
  ikm_hex: string;
  session_key_hex: string;
}
interface EcdhVector {
  name: string;
  alice_private_hex: string;
  alice_public_b64: string;
  bob_private_hex: string;
  bob_public_b64: string;
  shared_secret_hex: string;
  session_key_hex: string;
}
interface EnvelopeVector {
  name: string;
  key_hex: string;
  iv_b64: string;
  plaintext: unknown;
  plaintext_json: string;
  envelope: SealedEnvelope;
}
interface RejectVector {
  name: string;
  key_hex: string;
  envelope: SealedEnvelope;
  reason: string;
}
interface VectorFile {
  _meta: { version: number };
  hkdf: HkdfVector[];
  ecdh_p256: EcdhVector[];
  envelope: EnvelopeVector[];
  envelope_reject: RejectVector[];
}

const vectors = JSON.parse(
  readFileSync(CANONICAL_PATH, "utf8"),
) as VectorFile;

/** The JSON stores private scalars as hex; the ECDH loaders take base64. */
const hexToB64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");

describe("crypto-v1 vectors — file shape", () => {
  it("has every section populated at version 1", () => {
    expect(vectors._meta.version).toBe(1);
    expect(vectors.hkdf.length).toBeGreaterThan(0);
    expect(vectors.ecdh_p256.length).toBeGreaterThan(0);
    expect(vectors.envelope.length).toBeGreaterThan(0);
    expect(vectors.envelope_reject.length).toBeGreaterThan(0);
  });

  it("the published broker copy is BYTE-identical to the canonical copy", () => {
    // Raw bytes, not parsed equality — the generator writes both copies from
    // one buffer and .gitattributes pins both to LF, so any difference here is
    // a real drift (or a checkout that mangled line endings; fix the checkout,
    // never this assertion).
    const canonical = readFileSync(CANONICAL_PATH);
    const published = readFileSync(PUBLISHED_PATH);
    expect(canonical.equals(published)).toBe(true);
  });
});

describe("crypto-v1 vectors — hkdf", () => {
  // The library's hand-rolled HMAC expand loop meets an OpenSSL-derived
  // expected value. This is the mirrored-bug detector.
  it.each(vectors.hkdf)("$name", (v) => {
    const got = deriveSessionKeyFromSharedSecret(Buffer.from(v.ikm_hex, "hex"));
    expect(got.toString("hex")).toBe(v.session_key_hex);
    expect(got.length).toBe(32);
  });
});

describe("crypto-v1 vectors — ecdh_p256", () => {
  it.each(vectors.ecdh_p256)("$name — library, both directions", (v) => {
    const alice = loadEphemeralKeypair(hexToB64(v.alice_private_hex));
    const bob = loadEphemeralKeypair(hexToB64(v.bob_private_hex));

    // The recorded public keys must be what the scalars actually produce.
    expect(alice.publicKey).toBe(v.alice_public_b64);
    expect(bob.publicKey).toBe(v.bob_public_b64);

    expect(deriveSessionKey(alice, v.bob_public_b64).toString("hex")).toBe(
      v.session_key_hex,
    );
    expect(deriveSessionKey(bob, v.alice_public_b64).toString("hex")).toBe(
      v.session_key_hex,
    );
  });

  it.each(vectors.ecdh_p256)("$name — bridge, both directions", (v) => {
    const alice = bridgeLoadKeypair(hexToB64(v.alice_private_hex));
    const bob = bridgeLoadKeypair(hexToB64(v.bob_private_hex));

    expect(alice.publicKey).toBe(v.alice_public_b64);
    expect(bob.publicKey).toBe(v.bob_public_b64);

    expect(bridgeDerive(alice.handle, v.bob_public_b64).toString("hex")).toBe(
      v.session_key_hex,
    );
    expect(bridgeDerive(bob.handle, v.alice_public_b64).toString("hex")).toBe(
      v.session_key_hex,
    );
  });

  it.each(vectors.ecdh_p256)("$name — shared secret feeds the same key", (v) => {
    const fromSecret = deriveSessionKeyFromSharedSecret(
      Buffer.from(v.shared_secret_hex, "hex"),
    );
    expect(fromSecret.toString("hex")).toBe(v.session_key_hex);
  });
});

describe("crypto-v1 vectors — envelope, DECRYPT direction", () => {
  it.each(vectors.envelope)("$name — raw bytes (Layer 1)", (v) => {
    // Decrypt with the primitive directly: pins the byte layer without
    // trusting either implementation's JSON.parse step.
    const decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(v.key_hex, "hex"),
      Buffer.from(v.iv_b64, "base64"),
    );
    decipher.setAuthTag(Buffer.from(v.envelope.tag, "base64"));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(v.envelope.ct, "base64")),
      decipher.final(),
    ]);
    expect(pt.toString("utf8")).toBe(v.plaintext_json);
  });

  it.each(vectors.envelope)("$name — both implementations (Layer 2)", (v) => {
    const key = Buffer.from(v.key_hex, "hex");
    expect(openEnvelope(v.envelope, key)).toEqual(v.plaintext);
    expect(bridgeOpen(v.envelope, key)).toEqual(v.plaintext);
  });
});

describe("crypto-v1 vectors — envelope, ENCRYPT direction (Layer 1)", () => {
  it.each(vectors.envelope)("$name — canonical plaintext precondition", (v) => {
    // If this fails the encrypt assertions below are meaningless: the
    // implementations encrypt JSON.stringify(value), so the recorded bytes
    // must be exactly what JSON.stringify produces for the recorded value.
    expect(JSON.stringify(v.plaintext)).toBe(v.plaintext_json);
  });

  it.each(vectors.envelope)("$name — library sealWithIv", (v) => {
    const sealed = sealWithIv(
      v.plaintext,
      Buffer.from(v.key_hex, "hex"),
      Buffer.from(v.iv_b64, "base64"),
    );
    expect(sealed.ct).toBe(v.envelope.ct);
    expect(sealed.tag).toBe(v.envelope.tag);
    expect(sealed.iv).toBe(v.envelope.iv);
    expect(sealed.v).toBe(1);
    expect(sealed.type).toBe("enc");
  });

  it.each(vectors.envelope)("$name — bridge seal with fixed IV", (v) => {
    const sealed = bridgeSeal(
      v.plaintext,
      Buffer.from(v.key_hex, "hex"),
      Buffer.from(v.iv_b64, "base64"),
    );
    expect(sealed.ct).toBe(v.envelope.ct);
    expect(sealed.tag).toBe(v.envelope.tag);
    expect(sealed.iv).toBe(v.envelope.iv);
  });
});

describe("crypto-v1 vectors — envelope_reject", () => {
  it.each(vectors.envelope_reject)("$name — library refuses", (v) => {
    expect(() => openEnvelope(v.envelope, Buffer.from(v.key_hex, "hex"))).toThrow();
  });

  it.each(vectors.envelope_reject)("$name — bridge refuses", (v) => {
    expect(() => bridgeOpen(v.envelope, Buffer.from(v.key_hex, "hex"))).toThrow();
  });
});

describe("fixed-IV seal hooks reject wrong-length IVs", () => {
  const key = Buffer.from(vectors.envelope[0]!.key_hex, "hex");
  const frame = { type: "meta.dialog", text: "nope" };

  // A wrong-length caller-supplied IV must fail loudly at seal time. Node's
  // AES-GCM would otherwise accept it and emit an envelope that open() rejects
  // with "Invalid IV length" — a failure at the far end of the wire instead of
  // at the call site.
  it.each([8, 16])("library sealWithIv throws on a %i-byte IV", (n) => {
    expect(() => sealWithIv(frame, key, Buffer.alloc(n, 0))).toThrow(/IV/i);
  });

  it.each([8, 16])("bridge seal throws on a %i-byte IV", (n) => {
    expect(() => bridgeSeal(frame, key, Buffer.alloc(n, 0))).toThrow(/IV/i);
  });
});

describe("seal() random-IV path is unchanged by the sealWithIv refactor", () => {
  const key = Buffer.from(vectors.envelope[0]!.key_hex, "hex");

  it("round-trips through open()", () => {
    const frame = { type: "meta.dialog", text: "still works" };
    expect(openEnvelope(seal(frame, key), key)).toEqual(frame);
  });

  it("draws a fresh IV per call", () => {
    const a = seal({ n: 1 }, key);
    const b = seal({ n: 1 }, key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });
});
