import { describe, it, expect } from "vitest";
import {
  newEphemeralKeypair,
  deriveSessionKey,
  randomSessionKey,
  seal,
  openEnvelope,
} from "../src/index.js";

describe("crypto/session-key", () => {
  it("two parties derive the same session key from ECDH", () => {
    const alice = newEphemeralKeypair();
    const bob = newEphemeralKeypair();
    const aliceKey = deriveSessionKey(alice, bob.publicKey);
    const bobKey = deriveSessionKey(bob, alice.publicKey);
    expect(aliceKey.equals(bobKey)).toBe(true);
    expect(aliceKey.length).toBe(32);
  });

  it("different sessions produce different keys", () => {
    const alice1 = newEphemeralKeypair();
    const bob1 = newEphemeralKeypair();
    const alice2 = newEphemeralKeypair();
    const bob2 = newEphemeralKeypair();
    const k1 = deriveSessionKey(alice1, bob1.publicKey);
    const k2 = deriveSessionKey(alice2, bob2.publicKey);
    expect(k1.equals(k2)).toBe(false);
  });
});

describe("crypto/envelope", () => {
  it("round-trips a message through seal/open", () => {
    const key = randomSessionKey();
    const original = { type: "invoke.request", capability: "config.read", id: "m_1" };
    const sealed = seal(original, key);
    expect(sealed.v).toBe(1);
    expect(typeof sealed.iv).toBe("string");
    expect(typeof sealed.ct).toBe("string");
    expect(typeof sealed.tag).toBe("string");
    const opened = openEnvelope(sealed, key);
    expect(opened).toEqual(original);
  });

  it("rejects a tampered ciphertext", () => {
    const key = randomSessionKey();
    const sealed = seal({ hello: "world" }, key);
    // flip a byte in the ciphertext
    const ctBytes = Buffer.from(sealed.ct, "base64");
    ctBytes[0] = ctBytes[0] ^ 0xff;
    const tampered = { ...sealed, ct: ctBytes.toString("base64") };
    expect(() => openEnvelope(tampered, key)).toThrow();
  });

  it("rejects a tampered auth tag", () => {
    const key = randomSessionKey();
    const sealed = seal({ hello: "world" }, key);
    const tagBytes = Buffer.from(sealed.tag, "base64");
    tagBytes[0] = tagBytes[0] ^ 0xff;
    const tampered = { ...sealed, tag: tagBytes.toString("base64") };
    expect(() => openEnvelope(tampered, key)).toThrow();
  });

  it("rejects a different key", () => {
    const k1 = randomSessionKey();
    const k2 = randomSessionKey();
    const sealed = seal({ secret: "shh" }, k1);
    expect(() => openEnvelope(sealed, k2)).toThrow();
  });
});
