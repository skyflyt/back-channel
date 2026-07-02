/**
 * Back Channel .mcpb bridge — agent-to-agent E2E crypto.
 *
 * Faithful, zero-dependency port of the canonical protocol implemented at
 * ../../../../../src/crypto/{session-key,envelope}.ts and documented in
 * skill/REFERENCE.md's "Encryption (REQUIRED)" section. This is NOT the
 * WebSocket-relay transport's handshake (src/transport/broker.ts uses a
 * different, incompatible `{kind:"handshake",publicKey}` frame for that
 * separate Phase-3 real-time path) — bc_send_message/bc_read_messages ride
 * the HTTP poll transport, whose wire format is the one below. Cross-checked
 * against tests/mcpb-crypto-interop.test.ts, which imports the REAL
 * src/index.ts implementation and proves byte-for-byte interop, not just
 * internal self-consistency.
 *
 * Primitives (must match byte-for-byte or nothing decrypts):
 *   ECDH on P-256 (prime256v1/secp256r1) → HKDF-SHA-256 (salt=32 zero bytes,
 *   info="back-channel/v1/session-key", 32B output) → AES-256-GCM with a
 *   fresh random 12B IV + 16B tag per frame, no AAD. Plaintext is
 *   JSON.stringify(frame). Public keys are the uncompressed point, base64.
 */

import { createECDH, createHmac, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const CURVE = "prime256v1";
const HKDF_INFO = Buffer.from("back-channel/v1/session-key");
const SESSION_KEY_BYTES = 32;
const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Control frame types that are NEVER sealed (mirrors relay.mjs / REFERENCE.md §Encryption). */
export const PLAINTEXT_CONTROL_TYPES = new Set([
  "ping", "hello", "peer.joined", "peer.left", "skill.revision",
  "handshake.pubkey", "handshake.replaced", "session.start", "session.end",
]);

function hkdf(ikm, length) {
  const salt = Buffer.alloc(32, 0);
  const prk = createHmac("sha256", salt).update(ikm).digest();
  const out = Buffer.alloc(length);
  let prev = Buffer.alloc(0);
  let written = 0;
  let counter = 1;
  while (written < length) {
    const input = Buffer.concat([prev, HKDF_INFO, Buffer.from([counter])]);
    prev = createHmac("sha256", prk).update(input).digest();
    const toCopy = Math.min(prev.length, length - written);
    prev.copy(out, written, 0, toCopy);
    written += toCopy;
    counter++;
  }
  return out;
}

/** Fresh ephemeral P-256 keypair. Returns the ECDH handle plus both keys as base64 (private key is a raw scalar — persist it to reconstitute the same identity later via loadKeypair). */
export function newEphemeralKeypair() {
  const ecdh = createECDH(CURVE);
  const publicKey = ecdh.generateKeys().toString("base64");
  const privateKey = ecdh.getPrivateKey().toString("base64");
  return { handle: ecdh, publicKey, privateKey };
}

/** Reconstitute a previously-generated keypair from its persisted private key. */
export function loadKeypair(privateKeyB64) {
  const ecdh = createECDH(CURVE);
  ecdh.setPrivateKey(Buffer.from(privateKeyB64, "base64"));
  return { handle: ecdh, publicKey: ecdh.getPublicKey().toString("base64"), privateKey: privateKeyB64 };
}

/** Derive the 32-byte AES session key from our keypair + the peer's public key. */
export function deriveSessionKey(ownHandle, peerPublicKeyB64) {
  const peerPub = Buffer.from(peerPublicKeyB64, "base64");
  const sharedSecret = ownHandle.computeSecret(peerPub);
  return hkdf(sharedSecret, SESSION_KEY_BYTES);
}

/** Encrypt + authenticate a plaintext frame object. */
export function seal(plaintext, sessionKey) {
  if (sessionKey.length !== 32) throw new Error("Session key must be 32 bytes (AES-256)");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, sessionKey, iv);
  const json = Buffer.from(JSON.stringify(plaintext), "utf8");
  const ct = Buffer.concat([cipher.update(json), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { type: "enc", v: 1, iv: iv.toString("base64"), ct: ct.toString("base64"), tag: tag.toString("base64") };
}

/** Decrypt + verify an envelope. Throws on tag mismatch, bad version, or malformed lengths. */
export function open(env, sessionKey) {
  if (env.v !== 1) throw new Error(`Unsupported envelope version: ${env.v}`);
  if (sessionKey.length !== 32) throw new Error("Session key must be 32 bytes (AES-256)");
  const iv = Buffer.from(env.iv, "base64");
  const ct = Buffer.from(env.ct, "base64");
  const tag = Buffer.from(env.tag, "base64");
  if (iv.length !== IV_BYTES) throw new Error("Invalid IV length");
  if (tag.length !== TAG_BYTES) throw new Error("Invalid tag length");
  const decipher = createDecipheriv(ALGO, sessionKey, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString("utf8"));
}
