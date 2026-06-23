/**
 * Browser-side key-mirror client (user-side decryption — docs/user-side-decryption.md).
 * Wraps WebAuthn PRF + the tested isomorphic crypto core (keymirror.mjs) into the
 * flows the /account UI calls: enroll, unlock, open a thread, compose+send.
 *
 * WebAuthn is used PURELY as a KEK source (the PRF output → KEK). We do NOT verify
 * attestation server-side — the credential's only job is to deterministically yield
 * the PRF secret that unlocks the AEAD-wrapped mirror private key. (Possession +
 * user-verification are still enforced by the authenticator on every get().)
 *
 * All key material stays in this module's memory; nothing secret is sent to the server.
 */
import {
  generateMirrorKeypair, deriveKekFromSecret, wrapMirrorPriv, unwrapMirrorPriv,
  hpkeOpenK, importK, sealFrame, openFrame, generateRecovery, b64, unb64,
  ORIGIN_HUMAN,
} from "@/lib/crypto/keymirror.mjs";

const te = new TextEncoder();
const RP_ID = typeof location !== "undefined" ? location.hostname : "back-channel.app";
const b64urlToBytes = (s: string) => unb64(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
const bytesToB64url = (b: Uint8Array) => b64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

type PrfExtResults = { prf?: { results?: { first?: ArrayBuffer } } };

/** Run a WebAuthn assertion with the PRF extension and return the 32-byte PRF output. */
async function prfAssertion(prfSaltBytes: Uint8Array, allowCredentialId?: string): Promise<Uint8Array> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: RP_ID,
      userVerification: "required",
      allowCredentials: allowCredentialId ? [{ id: b64urlToBytes(allowCredentialId), type: "public-key" }] : [],
      extensions: { prf: { eval: { first: prfSaltBytes } } } as AuthenticationExtensionsClientInputs,
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("assertion_cancelled");
  const ext = cred.getClientExtensionResults() as PrfExtResults;
  const first = ext.prf?.results?.first;
  if (!first) throw new Error("prf_unsupported"); // authenticator/browser without PRF (S8 → fall back)
  return new Uint8Array(first);
}

/** Detect whether this device can do WebAuthn PRF (used to gate to the passphrase
 *  fallback, which is itself gated until KMS lands — path C). */
export function platformAuthAvailable(): boolean {
  return typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials?.create;
}

export interface EnrollResult { mnemonic: string }

/**
 * First-time enrollment: create a passkey, derive the KEK via PRF, generate the
 * mirror keypair + recovery, and POST to /api/account/key-mirror. Returns the 24-word
 * recovery mnemonic to display ONCE.
 */
export async function enroll(accountId: string, displayName: string, csrf: string): Promise<EnrollResult> {
  // 1. Create a discoverable passkey with the PRF extension enabled.
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const created = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "Back Channel", id: RP_ID },
      user: { id: userId, name: displayName || "Back Channel", displayName: displayName || "Back Channel" },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!created) throw new Error("create_cancelled");
  const credentialId = bytesToB64url(new Uint8Array(created.rawId));

  // 2. Derive the KEK from a fresh PRF salt (a separate get() — create() PRF results
  //    aren't reliably available across platforms, so we always derive via get()).
  const prfSalt = crypto.getRandomValues(new Uint8Array(32));
  const prfOut = await prfAssertion(prfSalt, credentialId);
  const kek = await deriveKekFromSecret(prfOut);

  // 3. Mirror keypair + recovery.
  const { mirrorPub, mirrorPrivRaw } = await generateMirrorKeypair();
  const wrappedMirrorPriv = await wrapMirrorPriv(kek, mirrorPrivRaw, accountId);
  const { mnemonic, rk } = generateRecovery();
  const recKek = await deriveKekFromSecret(rk);
  const recoveryWrap = await wrapMirrorPriv(recKek, mirrorPrivRaw, accountId);
  const recoveryCodeHash = b64(new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(mnemonic)))); // typo-check only (S3)

  // 4. Persist (server stores only public/opaque material).
  const r = await fetch("/api/account/key-mirror", {
    method: "POST", credentials: "include",
    headers: { "content-type": "application/json", "x-bc-csrf": csrf },
    body: JSON.stringify({
      mirror_pub: mirrorPub, prf_salt: b64(prfSalt),
      recovery_wrap: recoveryWrap, recovery_code_hash: recoveryCodeHash,
      wrap: { method: "prf", label: deviceLabel(), credential_id: credentialId, wrapped_mirror_priv: wrappedMirrorPriv },
    }),
  });
  if (!r.ok) throw new Error(`enroll_failed_${r.status}`);
  return { mnemonic };
}

/** In-memory unlocked state (never persisted). */
let unlocked: { accountId: string; mirrorPrivRaw: Uint8Array } | null = null;

/** Unlock on this device: fetch the wrap material, derive the KEK via PRF, unwrap the
 *  mirror private key into memory. Throws "prf_unsupported" or AEAD-tag failure → the
 *  caller shows the re-enroll / recovery path (§4.1, S8). */
export async function unlock(accountId: string): Promise<void> {
  const km = await fetch("/api/account/key-mirror", { credentials: "include" }).then((r) => r.json());
  if (!km?.enrolled || !km.prf_salt) throw new Error("not_enrolled");
  const prfWrap = (km.wraps ?? []).find((w: { method: string }) => w.method === "prf");
  if (!prfWrap) throw new Error("no_prf_wrap");
  const prfOut = await prfAssertion(unb64(km.prf_salt), prfWrap.credential_id ?? undefined);
  const kek = await deriveKekFromSecret(prfOut);
  const mirrorPrivRaw = await unwrapMirrorPriv(kek, prfWrap.wrapped_mirror_priv, accountId); // throws on wrong device key
  unlocked = { accountId, mirrorPrivRaw };
}

export function isUnlocked(): boolean { return !!unlocked; }
export function lock(): void { if (unlocked) unlocked.mirrorPrivRaw.fill(0); unlocked = null; }

export interface Bubble { side: "me" | "peer"; text: string; ts: number; raw: unknown }

/** Open a thread: unwrap K, fetch + decrypt frames into ordered bubbles. Decryption
 *  is paginated; the AES loop yields so the main thread stays responsive (a Web Worker
 *  is the S6 follow-up; documented). */
export async function openThread(sessionId: string): Promise<{ bubbles: Bubble[]; counterHighWater: bigint }> {
  if (!unlocked) throw new Error("locked");
  const wrapResp = await fetch(`/api/sessions/${sessionId}/wrapped`, { credentials: "include" });
  if (!wrapResp.ok) throw new Error("no_wrap");
  const { wrap } = await wrapResp.json();
  const K = await hpkeOpenK(unlocked.mirrorPrivRaw, wrap, sessionId, unlocked.accountId);
  const kKey = await importK(K);

  const bubbles: Bubble[] = [];
  let cursor = "0", high = 0n;
  for (let page = 0; page < 50; page++) {
    const data = await fetch(`/api/sessions/${sessionId}/frames?cursor=${cursor}&limit=100`, { credentials: "include" }).then((r) => r.json());
    high = BigInt(data.my_counter_high_water ?? "0");
    for (const f of data.frames ?? []) {
      let inner: { text?: string; type?: string; ts?: number } | null = null;
      try { inner = await openFrame(kKey, JSON.parse(f.body)); } catch { continue; } // skip control / non-K frames
      if (!inner || typeof inner.text !== "string") continue;
      bubbles.push({ side: f.role_dest === data.role ? "peer" : "me", text: inner.text, ts: inner.ts ?? Date.parse(f.created_at), raw: inner });
      if ((page & 1) === 0) await new Promise((r) => setTimeout(r, 0)); // yield (S6)
    }
    if (!data.next_cursor) break;
    cursor = data.next_cursor;
  }
  bubbles.sort((a, b) => a.ts - b.ts);
  return { bubbles, counterHighWater: high };
}

const COUNTER_KEY = (sessionId: string) => `bc.km.ctr.${sessionId}`;

/** Compose + send a plain-text human frame: seal under K with a structured human-origin
 *  IV + monotonic counter (persisted; reseeded from the broker high-water on store loss). */
export async function sendMessage(sessionId: string, text: string, csrf: string, brokerHighWater: bigint): Promise<void> {
  if (!unlocked) throw new Error("locked");
  const { wrap } = await fetch(`/api/sessions/${sessionId}/wrapped`, { credentials: "include" }).then((r) => r.json());
  const K = await hpkeOpenK(unlocked.mirrorPrivRaw, wrap, sessionId, unlocked.accountId);
  const kKey = await importK(K);

  const local = BigInt(localStorage.getItem(COUNTER_KEY(sessionId)) ?? "0");
  let counter = (local > brokerHighWater ? local : brokerHighWater) + 1n;

  for (let attempt = 0; attempt < 2; attempt++) {
    const frame = await sealFrame(kKey, { type: "meta.dialog", origin: "human", text, ts: Date.now() }, ORIGIN_HUMAN, counter);
    const r = await fetch(`/api/sessions/${sessionId}/frames`, {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json", "x-bc-csrf": csrf },
      body: JSON.stringify({ frame }),
    });
    if (r.ok) { localStorage.setItem(COUNTER_KEY(sessionId), counter.toString()); return; }
    if (r.status === 409) { // stale_counter — reseed above broker high-water and retry once
      const j = await r.json().catch(() => ({}));
      counter = BigInt(j.high_water ?? counter.toString()) + 1n;
      continue;
    }
    throw new Error(`send_failed_${r.status}`);
  }
  throw new Error("send_failed_counter");
}

function deviceLabel(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/iPhone|iPad/.test(ua)) return "iPhone/iPad";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  if (/Android/.test(ua)) return "Android";
  return "This device";
}
