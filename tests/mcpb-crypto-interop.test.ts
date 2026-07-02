// Cross-implementation interop check: the .mcpb bridge (apps/broker/connector)
// reimplements the E2E crypto with zero npm deps (only node:crypto), since the
// bridge ships without node_modules. This test imports the REAL canonical
// implementation from src/index.ts on one side and the bridge's port on the
// other, and proves they interoperate byte-for-byte — not just that each is
// internally self-consistent (see tests/crypto.test.ts for that).
import { describe, it, expect } from "vitest";
import { newEphemeralKeypair as realKeypair, deriveSessionKey as realDerive, seal as realSeal, openEnvelope as realOpen } from "../src/index.js";
import { newEphemeralKeypair as bridgeKeypair, loadKeypair as bridgeLoadKeypair, deriveSessionKey as bridgeDerive, seal as bridgeSeal, open as bridgeOpen, PLAINTEXT_CONTROL_TYPES } from "../apps/broker/connector/server/crypto.js";

describe("mcpb bridge crypto interop with the real implementation", () => {
  it("both sides derive the identical session key from a cross-implementation handshake", () => {
    const real = realKeypair();     // as if a full agent runtime
    const bridge = bridgeKeypair(); // as if the .mcpb bridge

    const realSideKey = realDerive(real, bridge.publicKey);
    const bridgeSideKey = bridgeDerive(bridge.handle, real.publicKey);

    expect(Buffer.from(bridgeSideKey).equals(Buffer.from(realSideKey))).toBe(true);
    expect(bridgeSideKey.length).toBe(32);
  });

  it("a frame sealed by the REAL implementation opens correctly in the bridge", () => {
    const real = realKeypair();
    const bridge = bridgeKeypair();
    const key = realDerive(real, bridge.publicKey);

    const frame = { type: "meta.dialog", text: "hello from a full agent runtime" };
    const sealed = realSeal(frame, key);

    expect(sealed.type).toBe("enc");
    expect(sealed.v).toBe(1);

    const bridgeKey = bridgeDerive(bridge.handle, real.publicKey);
    const opened = bridgeOpen(sealed, bridgeKey);
    expect(opened).toEqual(frame);
  });

  it("a frame sealed by the BRIDGE opens correctly in the real implementation", () => {
    const real = realKeypair();
    const bridge = bridgeKeypair();
    const bridgeKey = bridgeDerive(bridge.handle, real.publicKey);

    const frame = { type: "invoke.request", capability: "config.read", id: "m_1" };
    const sealed = bridgeSeal(frame, bridgeKey);

    const realKey = realDerive(real, bridge.publicKey);
    const opened = realOpen(sealed, realKey);
    expect(opened).toEqual(frame);
  });

  it("bridge round-trips its own persisted private key (loadKeypair reconstitutes the same identity)", () => {
    const original = bridgeKeypair();
    const reloaded = bridgeLoadKeypair(original.privateKey);
    expect(reloaded.publicKey).toBe(original.publicKey);

    // A peer deriving against the reloaded identity's public key must get the
    // same shared key as one derived against the original handle — proves
    // setPrivateKey() reconstitutes a functionally identical ECDH state after
    // a bridge process restart (the real-world case this exists for).
    const real = realKeypair();
    const keyViaOriginal = bridgeDerive(original.handle, real.publicKey);
    const keyViaReloaded = bridgeDerive(reloaded.handle, real.publicKey);
    expect(Buffer.from(keyViaReloaded).equals(Buffer.from(keyViaOriginal))).toBe(true);
  });

  it("rejects a tampered ciphertext across implementations", () => {
    const real = realKeypair();
    const bridge = bridgeKeypair();
    const key = bridgeDerive(bridge.handle, real.publicKey);
    const sealed = bridgeSeal({ hello: "world" }, key);
    const ctBytes = Buffer.from(sealed.ct, "base64");
    ctBytes[0] ^= 0xff;
    const tampered = { ...sealed, ct: ctBytes.toString("base64") };
    expect(() => realOpen(tampered, realDerive(real, bridge.publicKey))).toThrow();
  });

  it("handshake.pubkey and other control frames are on the never-seal list", () => {
    expect(PLAINTEXT_CONTROL_TYPES.has("handshake.pubkey")).toBe(true);
    expect(PLAINTEXT_CONTROL_TYPES.has("session.end")).toBe(true);
    expect(PLAINTEXT_CONTROL_TYPES.has("invoke.request")).toBe(false);
    expect(PLAINTEXT_CONTROL_TYPES.has("meta.dialog")).toBe(false);
  });
});
