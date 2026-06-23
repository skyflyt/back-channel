/**
 * Key-mirror crypto core (user-side decryption — docs/user-side-decryption.md v2.1).
 *
 * ISOMORPHIC: uses only WebCrypto (globalThis.crypto.subtle) + isomorphic libs
 * (@hpke/core, @scure/bip39, @noble/hashes), so the SAME module runs in the browser,
 * a Web Worker, and Node (tests / the .mjs API routes — same pattern as relay.mjs).
 *
 * This module is the decision-INDEPENDENT crypto (HPKE wrap of the session key,
 * structured-IV AES-256-GCM frame seal, KEK→mirror_priv AEAD wrap, BIP39 recovery).
 * The passphrase→KEK derivation (KMS pepper / OPAQUE) lives elsewhere and is gated
 * on the KMS provisioning decision; PRF→KEK (deriveKekFromSecret) is here and needs
 * no server secret.
 *
 * Invariants: no plaintext key/secret is ever returned in a form the broker stores;
 * all at-rest wraps are AEAD with explicit AAD; frame IVs can never collide between
 * the two writers (agent vs human) — see makeFrameIv.
 */
import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import { generateMnemonic, mnemonicToEntropy, entropyToMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

// HPKE suite: DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / ChaCha20-Poly1305 (RFC 9180).
const hpke = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Chacha20Poly1305() });

// ---- base64 helpers (isomorphic) -------------------------------------------------
export function b64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
export function unb64(s) {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

// ---- mirror keypair (X25519 via HPKE KEM) ----------------------------------------
/** Generate the per-account mirror keypair. Returns raw bytes for storage. */
export async function generateMirrorKeypair() {
  const kp = await hpke.kem.generateKeyPair();
  const pub = new Uint8Array(await hpke.kem.serializePublicKey(kp.publicKey));
  const priv = new Uint8Array(await hpke.kem.serializePrivateKey(kp.privateKey));
  return { mirrorPub: b64(pub), mirrorPrivRaw: priv };
}

// ---- HPKE wrap/open of the session content key K ---------------------------------
const wrapAad = (sessionId, accountId) => te.encode(`userwrap|${sessionId}|${accountId}`);

/** Agent side: seal K (raw bytes) to a recipient mirror public key. Needs only the PUBLIC key. */
export async function hpkeWrapK(mirrorPubB64, kRaw, sessionId, accountId) {
  const recipientPublicKey = await hpke.kem.deserializePublicKey(unb64(mirrorPubB64).buffer);
  const sender = await hpke.createSenderContext({ recipientPublicKey });
  const ct = new Uint8Array(await sender.seal(kRaw, wrapAad(sessionId, accountId)));
  const enc = new Uint8Array(sender.enc);
  return { v: 1, enc: b64(enc), ct: b64(ct) }; // stored as Session.userWrap[accountId]
}

/** Browser side: open a user_wrap with the (unwrapped) mirror private key → K bytes. */
export async function hpkeOpenK(mirrorPrivRaw, wrap, sessionId, accountId) {
  const recipientKey = await hpke.kem.deserializePrivateKey(toBuf(mirrorPrivRaw));
  const recipient = await hpke.createRecipientContext({ recipientKey, enc: unb64(wrap.enc).buffer });
  const pt = await recipient.open(unb64(wrap.ct), wrapAad(sessionId, accountId));
  return new Uint8Array(pt);
}

// ---- KEK derivation (PRF path; passphrase path adds a pepper elsewhere) -----------
/** HKDF-SHA256(secret) → non-extractable AES-256-GCM KEK used to wrap mirror_priv. */
export async function deriveKekFromSecret(secret) {
  const base = await subtle.importKey("raw", toBuf(secret), "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: te.encode("back-channel/v1/user-kek") },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

// ---- AEAD wrap of mirror_priv at rest (KEK, random 96-bit IV one-shot, AAD) -------
const privAad = (accountId) => te.encode(`mirror-priv-v1|${accountId}`);

export async function wrapMirrorPriv(kek, mirrorPrivRaw, accountId) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: privAad(accountId) }, kek, toBuf(mirrorPrivRaw)));
  return `${b64(iv)}.${b64(ct)}`;
}
/** Returns mirror_priv bytes, or throws on AEAD-tag failure (wrong KEK — the
 *  divergence / wrong-passkey signal, §4.1 / §16.5). Callers map throw → re-enroll. */
export async function unwrapMirrorPriv(kek, blob, accountId) {
  const [ivB64, ctB64] = String(blob).split(".");
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: unb64(ivB64), additionalData: privAad(accountId) }, kek, unb64(ctB64));
  return new Uint8Array(pt);
}

// ---- structured frame IV (B3): [1-bit origin | 31-bit random | 64-bit counter] ----
export const ORIGIN_AGENT = 0;
export const ORIGIN_HUMAN = 1;
const MAX_U64 = (1n << 64n) - 1n;

/** Build a 12-byte AES-GCM IV that can NEVER collide between the two writers
 *  (origin bit) nor within a writer (monotonic counter). Throws on rollover. */
export function makeFrameIv(origin, counter) {
  const c = BigInt(counter);
  if (c < 0n || c > MAX_U64) throw new Error("frame counter rollover");
  if (origin !== ORIGIN_AGENT && origin !== ORIGIN_HUMAN) throw new Error("bad origin");
  const iv = new Uint8Array(12);
  const r = globalThis.crypto.getRandomValues(new Uint8Array(4));
  // byte0 top bit = origin; remaining 31 bits = random
  iv[0] = (r[0] & 0x7f) | (origin << 7);
  iv[1] = r[1]; iv[2] = r[2]; iv[3] = r[3];
  new DataView(iv.buffer).setBigUint64(4, c, false); // big-endian 64-bit counter
  return iv;
}
export function ivOrigin(iv) { return (iv[0] >> 7) & 1; }
export function ivCounter(iv) { return new DataView(iv.buffer, iv.byteOffset, 12).getBigUint64(4, false); }

// ---- frame seal/open (AES-256-GCM, wire-compatible with the agent protocol) -------
/** Import raw 32-byte K as an AES-256-GCM key. */
export async function importK(kRaw) {
  return subtle.importKey("raw", toBuf(kRaw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Seal an inner frame object → { type:"enc", v:1, iv, ct, tag } (same wire format
 *  the agents use: ct/tag split so WebCrypto and the agent libs interop). */
export async function sealFrame(kKey, innerObj, origin, counter) {
  const iv = makeFrameIv(origin, counter);
  const pt = te.encode(JSON.stringify(innerObj));
  const out = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, kKey, pt));
  const ct = out.slice(0, out.length - 16);
  const tag = out.slice(out.length - 16);
  return { type: "enc", v: 1, iv: b64(iv), ct: b64(ct), tag: b64(tag) };
}
/** Open a sealed frame → inner object. Throws on AEAD-tag failure. */
export async function openFrame(kKey, frame) {
  const iv = unb64(frame.iv);
  const ct = unb64(frame.ct);
  const tag = unb64(frame.tag);
  const buf = new Uint8Array(ct.length + tag.length);
  buf.set(ct, 0); buf.set(tag, ct.length);
  const pt = await subtle.decrypt({ name: "AES-GCM", iv }, kKey, buf);
  return JSON.parse(td.decode(pt));
}

// ---- BIP39 recovery (24 words / 256-bit RK = the entropy itself, S3) --------------
/** Generate recovery: 256-bit RK + its 24-word mnemonic. RK IS the entropy. */
export function generateRecovery() {
  const mnemonic = generateMnemonic(wordlist, 256); // 24 words
  const rk = mnemonicToEntropy(mnemonic, wordlist);  // 32 bytes
  return { mnemonic, rk: new Uint8Array(rk) };
}
export function isValidRecovery(mnemonic) { return validateMnemonic(mnemonic, wordlist); }
/** Recover RK bytes from the 24 words. Throws if the mnemonic is invalid. */
export function rkFromMnemonic(mnemonic) {
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error("invalid_mnemonic");
  return new Uint8Array(mnemonicToEntropy(mnemonic, wordlist));
}
export { entropyToMnemonic }; // for tests / round-trip

function toBuf(x) {
  if (x instanceof ArrayBuffer) return x;
  if (ArrayBuffer.isView(x)) return x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength);
  throw new Error("expected bytes");
}
