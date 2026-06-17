/**
 * Back Channel — Encrypted envelope for in-flight messages.
 *
 * Wire format:
 *   { v: 1, iv: <base64>, ct: <base64>, tag: <base64> }
 * Where:
 *   iv  = 12 random bytes (per-message nonce)
 *   ct  = AES-256-GCM ciphertext of the plaintext JSON
 *   tag = 16-byte authentication tag
 *
 * The session key is derived once via ECDH (see session-key.ts). Each
 * message gets a fresh IV. AEAD prevents tampering.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface SealedEnvelope {
  readonly v: 1;
  readonly iv: string;
  readonly ct: string;
  readonly tag: string;
}

/** Encrypt + authenticate a plaintext object. */
export function seal(plaintext: unknown, sessionKey: Buffer): SealedEnvelope {
  if (sessionKey.length !== 32) {
    throw new Error("Session key must be 32 bytes (AES-256)");
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, sessionKey, iv);
  const json = Buffer.from(JSON.stringify(plaintext), "utf8");
  const ct = Buffer.concat([cipher.update(json), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: tag.toString("base64"),
  };
}

/** Decrypt + verify an envelope. Throws on tag mismatch. */
export function open<T = unknown>(env: SealedEnvelope, sessionKey: Buffer): T {
  if (env.v !== 1) throw new Error(`Unsupported envelope version: ${env.v}`);
  if (sessionKey.length !== 32) {
    throw new Error("Session key must be 32 bytes (AES-256)");
  }
  const iv = Buffer.from(env.iv, "base64");
  const ct = Buffer.from(env.ct, "base64");
  const tag = Buffer.from(env.tag, "base64");
  if (iv.length !== IV_BYTES) throw new Error("Invalid IV length");
  if (tag.length !== TAG_BYTES) throw new Error("Invalid tag length");

  const decipher = createDecipheriv(ALGO, sessionKey, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString("utf8")) as T;
}
