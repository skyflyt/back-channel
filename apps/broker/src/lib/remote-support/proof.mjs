/**
 * Remote support: the temporary client's key and its signatures (docs/remote-support.md).
 *
 * The same encodings AppBridge devices use (src/lib/appbridge.ts parseConnectorSpki / proofValid, and
 * docs/appbridge-remote-access.md "Proofs"), so the client can reuse its connector-key code:
 *  - the key: P-256, sent as base64 DER SubjectPublicKeyInfo, identified by the uppercase hex SHA-256 of
 *    that DER;
 *  - a proof: ECDSA P-256 / SHA-256 in IEEE P1363 form (r||s, 64 bytes), base64url without padding, over
 *    a UTF-8, domain-separated message (remote-support/rules.mjs builds the messages).
 *
 * Kept apart from appbridge.ts on purpose: this is loaded (through remote-support.ts) by the MCP route,
 * and appbridge.ts named-imports modules that route tests replace. Pure: node:crypto only, no I/O.
 */
import { createHash, createPublicKey, verify } from "node:crypto";

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const PROOF = /^[A-Za-z0-9_-]{86}$/;

/**
 * A P-256 public key, or null when it is anything else (another curve, RSA, malformed, not canonical base64).
 * @param {unknown} value
 * @returns {{ spki: string, sha256: string, key: import("node:crypto").KeyObject } | null}
 */
export function parseP256Spki(value) {
  if (typeof value !== "string" || value.length > 512 || !BASE64.test(value)) return null;
  const der = Buffer.from(value, "base64");
  if (der.toString("base64") !== value) return null;
  let key;
  try { key = createPublicKey({ key: der, format: "der", type: "spki" }); } catch { return null; }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return null;
  return { spki: value, sha256: createHash("sha256").update(der).digest("hex").toUpperCase(), key };
}

/**
 * Does `proof` sign `message` with this key? Never throws.
 * @param {string | import("node:crypto").KeyObject} key a base64 SPKI (as stored) or a parsed key
 * @param {string} message
 * @param {unknown} proof
 */
export function proofValid(key, message, proof) {
  if (typeof proof !== "string" || !PROOF.test(proof)) return false;
  const signature = Buffer.from(proof, "base64url");
  if (signature.length !== 64) return false;
  const k = typeof key === "string" ? parseP256Spki(key)?.key : key;
  if (!k) return false;
  try { return verify("sha256", Buffer.from(message, "utf8"), { key: k, dsaEncoding: "ieee-p1363" }, signature); }
  catch { return false; }
}
