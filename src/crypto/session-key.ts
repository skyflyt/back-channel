/**
 * Back Channel — Session key derivation (ECDH + HKDF).
 *
 * Each agent generates an ephemeral P-256 keypair at session start. They
 * exchange public keys (clear-text on the wire — this is fine because we
 * derive the session key locally via ECDH). The shared secret is fed through
 * HKDF-SHA-256 to produce an AES-256 key.
 *
 * Phase 2: pre-encrypted at the envelope layer. Phase 3 will additionally
 * authenticate the public keys against the Broker's registered keys per
 * account (so an attacker who MITMs the WS connection can't substitute keys).
 */

import { createECDH, createHmac, randomBytes } from "node:crypto";

const CURVE = "prime256v1"; // a.k.a. P-256, NIST curve, widely supported
const HKDF_INFO = Buffer.from("back-channel/v1/session-key");
const SESSION_KEY_BYTES = 32; // AES-256

export interface EphemeralKeypair {
  /** Base64-encoded uncompressed public key. Send this to the peer. */
  readonly publicKey: string;
  /** Opaque internal handle — feed it to deriveSessionKey along with peer's pubkey. */
  readonly _handle: ReturnType<typeof createECDH>;
}

/** Create a fresh ephemeral keypair for one session. */
export function newEphemeralKeypair(): EphemeralKeypair {
  const ecdh = createECDH(CURVE);
  const pub = ecdh.generateKeys();
  return {
    publicKey: pub.toString("base64"),
    _handle: ecdh,
  };
}

/**
 * Given your keypair and the peer's public key (base64), derive a 32-byte
 * symmetric session key. Both sides will compute the same value.
 */
export function deriveSessionKey(
  own: EphemeralKeypair,
  peerPublicKeyB64: string,
): Buffer {
  const peerPub = Buffer.from(peerPublicKeyB64, "base64");
  const sharedSecret = own._handle.computeSecret(peerPub);
  return hkdf(sharedSecret, SESSION_KEY_BYTES);
}

/**
 * Minimal HKDF-SHA-256 (RFC 5869) — extract + expand.
 * Public-domain implementation, no salt (which is fine when extracting from
 * a high-entropy ECDH shared secret).
 */
function hkdf(ikm: Buffer, length: number): Buffer {
  // Extract: PRK = HMAC-SHA256(salt = zeros, ikm)
  const salt = Buffer.alloc(32, 0);
  const prk = createHmac("sha256", salt).update(ikm).digest();

  // Expand: T(1) = HMAC-SHA256(PRK, info || 0x01)
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

/** For testing only — generate a random session key without ECDH. */
export function randomSessionKey(): Buffer {
  return randomBytes(SESSION_KEY_BYTES);
}
