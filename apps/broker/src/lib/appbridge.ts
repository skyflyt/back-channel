/**
 * Back Channel Remote (AppBridge) remote access — the broker side of the relay.
 * Spec: docs/appbridge-remote-access.md (the AppBridge repo's
 * docs/REMOTE_ACCESS_BROKER_API.md is the relay's half of the same contract).
 *
 * What the broker decides: may this phone reach this PC through the relay right
 * now? It issues one-use relay passes, and the relay redeems them and renews a
 * 2-minute lease for as long as the pair is connected. The screen, keystrokes
 * and everything else stay end-to-end encrypted between the two AppBridge
 * devices; nothing here ever sees them.
 *
 * Rules this file keeps (see the spec):
 * - Separate credentials. Devices authenticate with an `ab_` bearer, resolved
 *   only by deviceContext(). A `bc_` agent key or the dashboard cookie can never
 *   obtain a pass; the relay-facing routes accept only requests signed with the
 *   relay's Ed25519 key (relayRequest()).
 * - The gate is read fresh, inside the same serializable transaction, on every
 *   pass, redemption and renewal: rollout flag, entitlement, host relay switch,
 *   device state and the host's enrollment attestation, all in one account.
 * - Privacy. No IP, user agent, query or body is stored or logged. The only
 *   history is the owner's 7-day connection log (device, PC, time).
 */
import { createHash, createPublicKey, randomBytes, randomInt, timingSafeEqual, verify as verifySignature, type KeyObject } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { AppBridgeDevice, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { rateLimit, rateLimitPeek } from "@/lib/rate-limit";
import { getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid } from "@/lib/auth";
import { checkOwnerAdmin, ownerGateInput } from "@/lib/admin";
import { REMOTE_ACCESS_FEATURE, remoteAccessSource } from "@/lib/remote-entitlement";
import { isSerializationFailure, withSerializableRetry } from "@/lib/serializable";

export const FEATURE = REMOTE_ACCESS_FEATURE;
const CREDENTIAL_PREFIX = "ab_";
const CREDENTIAL_TTL_MS = 365 * 86_400_000;
const CODE_TTL_MS = 10 * 60_000;
const PASS_TTL_MS = 60_000;
const LEASE_TTL_MS = 120_000;
const CONNECTION_LOG_MS = 7 * 86_400_000;
// Session (pair) cost guard, checked at redeem (Skylar, 2026-09-24):
const MAX_REMOTES_PER_ACCOUNT = 3;   // phones or laptops relayed at once, per account
const MAX_PAIRS_PER_REMOTE_HOST = 4; // one remote's live pairs to one PC: its workspace socket plus pooled HTTPS connections
const MAX_PAIRS_PER_REMOTE = 8;      // one remote's live pairs across all its PCs (a laptop on two PCs at once)
const MAX_PRESENCE_PER_ACCOUNT = 4;
// A rotated credential's predecessor stays valid until the new one is first used, or this long at most.
const CREDENTIAL_GRACE_MS = 86_400_000;
// Rate budgets, per minute. The "failed" budgets are spent only by refusals (see budget()/spend()).
const EXCHANGE_FAILURES = 1000;
const REDEEMS_PER_KEY = 60;          // pass issuance allows 30/min per device; never below that
const REDEEM_FAILURES = 600;         // global: every junk client connect the relay signs lands here
const REDEEM_FAILURES_PER_KEY = 10;
const LEASE_CALLS_PER_LEASE = 30;    // renew + release; the relay renews each lease about once a minute
const MAX_BODY = 4096;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const HEX64 = /^[0-9A-F]{64}$/;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE = /^ABD-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}$/;
const CREDENTIAL = /^ab_[A-Za-z0-9_-]{43}$/;
export const SCOPES = {
  host: ["appbridge.device", "appbridge.host.relay", "appbridge.relay.presence"],
  remote: ["appbridge.device", "appbridge.relay.pass"],
} as const;
type Role = keyof typeof SCOPES;
type Scope = "appbridge.device" | "appbridge.host.relay" | "appbridge.relay.presence" | "appbridge.relay.pass";
type Body = Record<string, unknown>;
type Refusal = "rollout_off" | "not_entitled" | "relay_off" | "device_revoked" | "not_paired" | "not_found";

export class AppBridgeError extends Error {
  status: number; retryAfter?: number;
  constructor(status: number, code: string, retryAfter?: number) { super(code); this.status = status; this.retryAfter = retryAfter; }
}
export function fail(status: number, code: string, retryAfter?: number): never { throw new AppBridgeError(status, code, retryAfter); }
export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}
export function limit(bucket: string, key: string, max: number, windowMs: number): void {
  const r = rateLimit(bucket, key, max, windowMs);
  if (!r.ok) fail(429, "rate_limited", r.retryAfterSec);
}
// Budgets only refusals spend: budget() checks before the work without counting, spend() records a
// refusal. A caller who succeeds is never charged for an attacker's junk, and is turned away only once
// the budget itself is used up.
function budget(bucket: string, key: string, max: number): void {
  const r = rateLimitPeek(bucket, key, max);
  if (!r.ok) fail(429, "rate_limited", r.retryAfterSec);
}
function spend(bucket: string, key: string, max: number): void { rateLimit(bucket, key, max, 60_000); }
const sha256Hex = (raw: string) => createHash("sha256").update(raw).digest("hex");
const newId = () => randomBytes(16).toString("base64url");

/** Every AppBridge route runs inside this: fixed error shape, no-store, nothing logged. */
export async function handle(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof AppBridgeError) {
      const res = json({ error: e.message }, e.status);
      if (e.retryAfter !== undefined) res.headers.set("Retry-After", String(e.retryAfter));
      return res;
    }
    // Still conflicting after serializableTx's retry budget (or a unique race outside one): safe for the
    // client to retry, whichever shape Prisma used for the abort. Never log bodies, passes, credentials or keys.
    if (isConflict(e)) {
      const res = json({ error: "retry" }, 503); res.headers.set("Retry-After", "1"); return res;
    }
    return json({ error: "unavailable" }, 503);
  }
}

/** The raw request body, at most 4 KiB. */
async function readRaw(req: NextRequest): Promise<string> {
  if (Number(req.headers.get("content-length")) > MAX_BODY) fail(413, "too_large");
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); fail(413, "too_large"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseBody(raw: string): Body {
  if (!raw) return {};
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return fail(400, "invalid_request"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) fail(400, "invalid_request");
  return body as Body;
}

async function readBody(req: NextRequest): Promise<Body> { return parseBody(await readRaw(req)); }

/** The body must have exactly the required members, plus any of the optional ones. */
function exact(body: Body, required: string[], optional: string[] = []): void {
  const names = Object.keys(body);
  if (!required.every(n => n in body) || !names.every(n => required.includes(n) || optional.includes(n))) fail(400, "invalid_request");
}
function id(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) fail(400, "invalid_request");
  return value;
}

// ── Keys and proofs ─────────────────────────────────────────────────────────

/** A connector key: base64 DER SubjectPublicKeyInfo of a P-256 key. Fingerprint = uppercase hex SHA-256 of the DER. */
export function parseConnectorSpki(value: unknown): { spki: string; sha256: string; key: KeyObject } {
  if (typeof value !== "string" || value.length > 512 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail(400, "invalid_key");
  const der = Buffer.from(value, "base64");
  if (der.toString("base64") !== value) fail(400, "invalid_key");
  let key: KeyObject;
  try { key = createPublicKey({ key: der, format: "der", type: "spki" }); } catch { return fail(400, "invalid_key"); }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") fail(400, "invalid_key");
  return { spki: value, sha256: createHash("sha256").update(der).digest("hex").toUpperCase(), key };
}

/** The device's proof of its connector key: ECDSA P-256 / SHA-256, IEEE P1363 (r||s), base64url, over a domain-separated message. */
export const exchangeProofMessage = (code: string) => `appbridge-device-exchange-v1:${code}`;
export const rotateProofMessage = (deviceId: string, newFingerprint: string) => `appbridge-connector-rotate-v1:${deviceId}:${newFingerprint}`;
function proofValid(key: KeyObject, message: string, proof: unknown): boolean {
  if (typeof proof !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(proof)) return false;
  const signature = Buffer.from(proof, "base64url");
  if (signature.length !== 64) return false;
  try { return verifySignature("sha256", Buffer.from(message, "utf8"), { key, dsaEncoding: "ieee-p1363" }, signature); }
  catch { return false; }
}
function sameFingerprint(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ── Environment ─────────────────────────────────────────────────────────────

/** The relay-wide kill switch: remote access works only while this is exactly "on". */
export const rolloutOn = () => process.env.APPBRIDGE_REMOTE_ACCESS === "on";
const relayUrl = () => process.env.APPBRIDGE_RELAY_URL || "wss://relay.back-channel.app/v1/connect";

// ── Housekeeping ────────────────────────────────────────────────────────────

let lastSweep = 0;
/** Deletes spent passes and leases, old device codes, and connection-log rows past 7 days. Never throws. */
export async function sweep(now = Date.now()): Promise<void> {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  try {
    await Promise.all([
      prisma.appBridgePass.deleteMany({ where: { expiresAt: { lt: new Date(now - 5 * 60_000) } } }),
      prisma.appBridgeLease.deleteMany({ where: { expiresAt: { lt: new Date(now - 5 * 60_000) } } }),
      prisma.appBridgeDeviceCode.deleteMany({ where: { expiresAt: { lt: new Date(now - 86_400_000) } } }),
      prisma.appBridgeConnectionEvent.deleteMany({ where: { at: { lt: new Date(now - CONNECTION_LOG_MS) } } }),
    ]);
  } catch { /* the next sweep retries */ }
}
if (process.env.NODE_ENV === "production") setInterval(() => void sweep(), 10 * 60_000).unref?.();

// ── Auth ────────────────────────────────────────────────────────────────────

type CredentialRow = Prisma.AppBridgeCredentialGetPayload<{ include: { device: true } }>;
/** The `ab_` bearer's credential row, live or not; a malformed bearer, an unknown one or an account mismatch is 401. */
async function bearerCredential(req: NextRequest): Promise<CredentialRow> {
  const m = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "");
  if (!m || !CREDENTIAL.test(m[1])) fail(401, "unauthorized");
  const cred = await prisma.appBridgeCredential.findUnique({ where: { keyHash: sha256Hex(m[1]) }, include: { device: true } });
  if (!cred || cred.device.accountId !== cred.accountId) fail(401, "unauthorized");
  return cred;
}

/** Resolve an `ab_` device credential. Anything else — a bc_ key, a cookie, no header — is 401. */
async function deviceContext(req: NextRequest, scope: Scope): Promise<{ device: AppBridgeDevice; keyHash: string; scopes: string[] }> {
  const cred = await bearerCredential(req);
  if (cred.revokedAt || cred.expiresAt.getTime() <= Date.now() || cred.device.revokedAt || !cred.device.enabled) fail(401, "unauthorized");
  if (!cred.scopes.includes(scope)) fail(403, "scope");
  limit("appbridge:device", cred.deviceId, 60, 60_000);
  if (cred.replacesKeyHash) {
    // First use of a rotated credential: the device has certainly saved it, so the one it replaced
    // (kept alive in case the device crashed before saving this one) ends now.
    const replaced = cred.replacesKeyHash;
    await serializableTx(async tx => {
      const now = new Date();
      await tx.appBridgeCredential.updateMany({ where: { keyHash: replaced, deviceId: cred.deviceId, revokedAt: null }, data: { revokedAt: now } });
      await tx.appBridgeCredential.updateMany({ where: { keyHash: cred.keyHash, replacesKeyHash: replaced }, data: { replacesKeyHash: null } });
    });
  }
  return { device: cred.device, keyHash: cred.keyHash, scopes: cred.scopes };
}

// The relay (a Cloudflare Worker) signs every request with its Ed25519 key; the broker holds only the
// public half (APPBRIDGE_RELAY_PUBLIC_KEY, base64 DER SubjectPublicKeyInfo). Header:
//   Authorization: AppBridge-Relay v1.<unix seconds>.<22-char nonce>.<base64url signature>
// over "appbridge-relay-broker-v1\n" METHOD "\n" PATH "\n" seconds "\n" nonce "\n" hex(SHA-256(body)).
// A request more than 60 s from now, or a nonce seen in the last 2 minutes, is refused. The nonce
// cache is in memory: the broker runs as exactly one Cloud Run instance.
const RELAY_SIGNATURE = /^AppBridge-Relay v1\.(\d{1,12})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{86})$/;
const RELAY_SKEW_SEC = 60;
const NONCE_TTL_MS = 120_000;
const MAX_NONCES = 20_000;
const seenNonces = new Map<string, number>();
let relayKey: { source: string; key: KeyObject } | null = null;

function relayPublicKey(): KeyObject {
  const source = process.env.APPBRIDGE_RELAY_PUBLIC_KEY ?? "";
  if (!source) fail(503, "unavailable");
  if (relayKey?.source !== source) {
    let key: KeyObject;
    try { key = createPublicKey({ key: Buffer.from(source, "base64"), format: "der", type: "spki" }); } catch { return fail(503, "unavailable"); }
    if (key.asymmetricKeyType !== "ed25519") fail(503, "unavailable");
    relayKey = { source, key };
  }
  return relayKey.key;
}

/** The relay's signed request: verifies the signature over the exact body, then parses it. */
async function relayRequest(req: NextRequest): Promise<Body> {
  const key = relayPublicKey();
  const m = RELAY_SIGNATURE.exec(req.headers.get("authorization") ?? "");
  if (!m) fail(401, "unauthorized");
  const [, seconds, nonce, signature] = m;
  const now = Date.now();
  if (Math.abs(now / 1000 - Number(seconds)) > RELAY_SKEW_SEC) fail(401, "unauthorized");
  const raw = await readRaw(req);
  const signed = `appbridge-relay-broker-v1\n${req.method}\n${req.nextUrl.pathname}\n${seconds}\n${nonce}\n${sha256Hex(raw)}`;
  let valid = false;
  try { valid = verifySignature(null, Buffer.from(signed, "utf8"), key, Buffer.from(signature, "base64url")); } catch { valid = false; }
  if (!valid) fail(401, "unauthorized");
  for (const [n, expires] of seenNonces) { if (expires > now && seenNonces.size < MAX_NONCES) break; seenNonces.delete(n); }
  if (seenNonces.has(nonce)) fail(401, "unauthorized");
  seenNonces.set(nonce, now + NONCE_TTL_MS);
  // No shared bucket here (H1): one bucket for redeem, renew and release let a flood of fake client
  // connects — each one a redeem the relay signs — 429 the renewals and tear down every live session.
  // Each route applies its own budget: redeem by presented key and by failures, renew/release per lease.
  return parseBody(raw);
}

/** Dashboard session (cookie); mutations also need the double-submit CSRF header. */
export async function accountContext(req: NextRequest, mutate: boolean) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) fail(401, "unauthorized");
  if (mutate && !csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) fail(403, "csrf");
  return account;
}

// ── The gate ────────────────────────────────────────────────────────────────

type Binding = { accountId: string; hostDeviceId: string; remoteDeviceId: string | null; enrollmentId: string | null };
type Admitted = { host: AppBridgeDevice; remote: AppBridgeDevice | null };

/** Every condition for relay access, read fresh in the caller's transaction. */
async function gate(tx: Prisma.TransactionClient, b: Binding): Promise<Admitted | { refused: Refusal }> {
  if (!rolloutOn()) return { refused: "rollout_off" };
  // An active admin grant OR an entitling Remote subscription, both read in this transaction.
  if (!(await remoteAccessSource(tx, b.accountId))) return { refused: "not_entitled" };
  const host = await tx.appBridgeDevice.findUnique({ where: { id: b.hostDeviceId } });
  if (!host || host.accountId !== b.accountId || host.role !== "host") return { refused: "not_found" };
  if (host.revokedAt || !host.enabled) return { refused: "device_revoked" };
  if (!host.relayEnabled) return { refused: "relay_off" };
  if (b.remoteDeviceId === null) return { host, remote: null };
  const remote = await tx.appBridgeDevice.findUnique({ where: { id: b.remoteDeviceId } });
  if (!remote || remote.accountId !== b.accountId || remote.role !== "remote") return { refused: "not_found" };
  if (remote.revokedAt || !remote.enabled) return { refused: "device_revoked" };
  if (b.enrollmentId === null) return { refused: "not_paired" };
  const pairing = await tx.appBridgePairing.findUnique({ where: { hostDeviceId_enrollmentId: { hostDeviceId: host.id, enrollmentId: b.enrollmentId } } });
  if (!pairing || pairing.withdrawnAt || pairing.remoteDeviceId !== remote.id) return { refused: "not_paired" };
  return { host, remote };
}
function refuse(r: Refusal): never { return r === "not_found" ? fail(404, "not_found") : fail(403, r); }

// ── Serializable transactions ───────────────────────────────────────────────

/** A serialization abort (40001/40P01, in any Prisma shape) or a unique race (P2002): the whole transaction may be re-run. */
const isConflict = (e: unknown): boolean =>
  isSerializationFailure(e) || (!!e && typeof e === "object" && "code" in e && e.code === "P2002");

/**
 * Every AppBridge (and billing) transaction runs through this: SERIALIZABLE, and on a conflict the WHOLE
 * transaction is re-run under serializable.ts's small bounded budget (5 attempts, <=150 ms of backoff).
 * An aborted attempt rolled back completely, so a re-run is exactly-once for everything the callback
 * writes (a pass or device code is consumed once, a lease or credential created once), and every gate,
 * cap and one-use check is read again, fresh, by the attempt that commits. Contention here is routine:
 * a phone's pooled connections redeem at once and race on the account's lease rows, a rotated
 * credential's first uses race each other, two deliveries of one Stripe event race on its id. Before
 * this retry each of those surfaced as a 503. Unique races retry too: the re-run finds the committed
 * row and takes the idempotent or refusing path. Once the budget is spent, handle() answers the fixed
 * retryable 503.
 *
 * The callback must stay pure database work through `tx`. Rate-limit counting, body reading, auth,
 * audit rows written after the transaction, and anything else that must happen once stay outside it;
 * time is read inside it, so each attempt checks expiry against its own clock.
 */
export function serializableTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return withSerializableRetry(() => prisma.$transaction(fn, { isolationLevel: "Serializable" }), { retryable: isConflict });
}

// ── Device-facing routes ────────────────────────────────────────────────────

/**
 * POST /devices/exchange — trade a dashboard-minted code and a key proof for a device credential.
 * Unauthenticated by nature, so only FAILED exchanges spend its global budget (M1): junk can no longer
 * block registration until it has used up the whole budget. Guessing stays hopeless — a code is one
 * of 31^8, lives 10 minutes and works once — and minting codes stays limited per account.
 */
export const exchangeDevice = (req: NextRequest) => handle(async () => {
  budget("appbridge:exchange-failed", "all", EXCHANGE_FAILURES);
  try { return await exchange(req); }
  catch (e) {
    if (e instanceof AppBridgeError && e.status < 500 && e.status !== 429) spend("appbridge:exchange-failed", "all", EXCHANGE_FAILURES);
    throw e;
  }
});
async function exchange(req: NextRequest): Promise<NextResponse> {
  const body = await readBody(req);
  exact(body, ["code", "role", "connectorSpki", "proof"]);
  if (typeof body.code !== "string" || !CODE.test(body.code)) fail(400, "invalid_request");
  if (body.role !== "host" && body.role !== "remote") fail(400, "invalid_request");
  const role: Role = body.role; const code = body.code;
  const key = parseConnectorSpki(body.connectorSpki);
  if (!proofValid(key.key, exchangeProofMessage(code), body.proof)) fail(400, "invalid_proof");
  const credential = CREDENTIAL_PREFIX + randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + CREDENTIAL_TTL_MS);
  const codeHash = sha256Hex(code);
  type Exchanged = { device: AppBridgeDevice } | { error: number; code: string };
  const result = await serializableTx(async (tx): Promise<Exchanged> => {
    const now = new Date();
    const row = await tx.appBridgeDeviceCode.findUnique({ where: { codeHash } });
    if (!row || row.usedAt || row.expiresAt <= now) return { error: 410, code: "code_invalid" };
    if (row.role !== role) return { error: 409, code: "wrong_role" };
    if (await tx.appBridgeDevice.findFirst({ where: { connectorSpkiSha256: key.sha256, revokedAt: null } })) return { error: 409, code: "key_in_use" };
    const claimed = await tx.appBridgeDeviceCode.updateMany({ where: { codeHash, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
    if (claimed.count !== 1) return { error: 410, code: "code_invalid" };
    const device = await tx.appBridgeDevice.create({ data: { id: newId(), accountId: row.accountId, role, label: row.label, connectorSpki: key.spki, connectorSpkiSha256: key.sha256 } });
    await tx.appBridgeCredential.create({ data: { keyHash: sha256Hex(credential), deviceId: device.id, accountId: row.accountId, scopes: [...SCOPES[role]], expiresAt } });
    return { device };
  });
  if ("error" in result) fail(result.error, result.code);
  await prisma.accountAudit.create({ data: { accountId: result.device.accountId, eventType: "appbridge.device_registered", detail: { deviceId: result.device.id, role } } }).catch(() => {});
  return json({ deviceId: result.device.id, credential, expiresAt: expiresAt.toISOString(), scopes: [...SCOPES[role]] });
}

/** GET /devices/self — the device's own record and whether remote access is available to it. */
export const getSelf = (req: NextRequest) => handle(async () => {
  const { device } = await deviceContext(req, "appbridge.device");
  const source = await remoteAccessSource(prisma, device.accountId);
  return json({ deviceId: device.id, role: device.role, label: device.label, relayEnabled: device.relayEnabled, connectorSpkiSha256: device.connectorSpkiSha256,
    remoteAccess: !rolloutOn() ? "rollout_off" : !source ? "not_entitled" : "available" });
});

/**
 * POST /devices/self/credential — replace the calling credential with a fresh one (same scopes, new expiry).
 * Crash-safe: the calling credential keeps working until the new one is first used (deviceContext then
 * revokes it), or for CREDENTIAL_GRACE_MS at most, so a PC that dies before saving the reply is not locked out.
 */
export const rotateCredential = (req: NextRequest) => handle(async () => {
  const { device, keyHash, scopes } = await deviceContext(req, "appbridge.device");
  const credential = CREDENTIAL_PREFIX + randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + CREDENTIAL_TTL_MS);
  await serializableTx(async tx => {
    const now = new Date();
    const current = await tx.appBridgeCredential.findUnique({ where: { keyHash } });
    if (!current || current.revokedAt || current.expiresAt <= now) fail(401, "unauthorized");
    // A successor minted earlier from this credential was never used (its reply was lost): it ends now.
    await tx.appBridgeCredential.updateMany({ where: { replacesKeyHash: keyHash, revokedAt: null }, data: { revokedAt: now } });
    // The grace is bounded from the first rotation: a repeat never extends it.
    await tx.appBridgeCredential.update({ where: { keyHash }, data: { expiresAt: new Date(Math.min(current.expiresAt.getTime(), now.getTime() + CREDENTIAL_GRACE_MS)) } });
    await tx.appBridgeCredential.create({ data: { keyHash: sha256Hex(credential), deviceId: device.id, accountId: device.accountId, scopes, expiresAt, replacesKeyHash: keyHash } });
  });
  return json({ credential, expiresAt: expiresAt.toISOString() });
});

/**
 * DELETE /devices/self — the device unregisters itself (the Windows host's Unregister; a phone may too):
 * the device, all its credentials, its pairings and live leases end in one transaction. 204. Idempotent:
 * a retry with the credential that did it (live at the moment of revocation) is 204 again; any other
 * dead or unknown credential is 401, so a rotated-away credential can never unregister a live device.
 */
export const deleteSelf = (req: NextRequest) => handle(async () => {
  const cred = await bearerCredential(req);
  const revokedAt = cred.device.revokedAt;
  if (revokedAt) {
    const wasLive = cred.revokedAt?.getTime() === revokedAt.getTime() && cred.expiresAt > revokedAt;
    if (!wasLive) fail(401, "unauthorized");
    limit("appbridge:device", cred.deviceId, 60, 60_000);
    return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
  const { device } = await deviceContext(req, "appbridge.device");
  await serializableTx(async tx => {
    const fresh = await tx.appBridgeDevice.findUnique({ where: { id: device.id } });
    if (!fresh || fresh.revokedAt) return;
    await revokeInTx(tx, device.id, new Date());
  });
  await prisma.accountAudit.create({ data: { accountId: device.accountId, eventType: "appbridge.device_unregistered", detail: { deviceId: device.id, role: device.role } } }).catch(() => {});
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
});

/** PUT /devices/self/connector — rotate the connector key, proven by both the old and the new key. */
export const rotateConnector = (req: NextRequest) => handle(async () => {
  const { device } = await deviceContext(req, "appbridge.device");
  const body = await readBody(req);
  exact(body, ["connectorSpki", "proofOld", "proofNew"]);
  const next = parseConnectorSpki(body.connectorSpki);
  const message = rotateProofMessage(device.id, next.sha256);
  const old = parseConnectorSpki(device.connectorSpki);
  if (!proofValid(old.key, message, body.proofOld) || !proofValid(next.key, message, body.proofNew)) fail(400, "invalid_proof");
  await serializableTx(async tx => {
    const other = await tx.appBridgeDevice.findFirst({ where: { connectorSpkiSha256: next.sha256, revokedAt: null } });
    if (other && other.id !== device.id) fail(409, "key_in_use");
    await tx.appBridgeDevice.update({ where: { id: device.id }, data: { connectorSpki: next.spki, connectorSpkiSha256: next.sha256 } });
  });
  // Live leases end at their next renewal: the relay compares the keys renew returns.
  return json({ connectorSpkiSha256: next.sha256 });
});

/** PUT /hosts/self/relay — the owner's "allow internet access through the relay" switch. Off never touches pairings. */
export const setRelay = (req: NextRequest) => handle(async () => {
  const { device } = await deviceContext(req, "appbridge.host.relay");
  const body = await readBody(req);
  exact(body, ["enabled"]);
  if (typeof body.enabled !== "boolean" || device.role !== "host") fail(400, "invalid_request");
  await prisma.appBridgeDevice.update({ where: { id: device.id }, data: { relayEnabled: body.enabled } });
  return json({ enabled: body.enabled });
});

/** PUT /hosts/self/pairings/{enrollmentId} — the host attests its owner approved this remote on the LAN. */
export const attestPairing = (req: NextRequest, enrollmentId: string) => handle(async () => {
  const { device } = await deviceContext(req, "appbridge.host.relay");
  if (device.role !== "host") fail(403, "scope"); // defence in depth: the scope already implies it
  id(enrollmentId);
  const body = await readBody(req);
  exact(body, ["remoteDeviceId"]);
  const remoteDeviceId = id(body.remoteDeviceId);
  await serializableTx(async tx => {
    const remote = await tx.appBridgeDevice.findUnique({ where: { id: remoteDeviceId } });
    if (!remote || remote.accountId !== device.accountId || remote.role !== "remote" || remote.revokedAt) fail(404, "not_found");
    const existing = await tx.appBridgePairing.findUnique({ where: { hostDeviceId_enrollmentId: { hostDeviceId: device.id, enrollmentId } } });
    if (existing) {
      // Idempotent for the same remote; an enrollment is never re-pointed or revived.
      if (existing.remoteDeviceId !== remoteDeviceId || existing.withdrawnAt) fail(409, "enrollment_conflict");
      return;
    }
    await tx.appBridgePairing.create({ data: { hostDeviceId: device.id, enrollmentId, remoteDeviceId } });
  });
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
});

/** DELETE /hosts/self/pairings/{enrollmentId} — the owner revoked that device on the PC. Idempotent. */
export const withdrawPairing = (req: NextRequest, enrollmentId: string) => handle(async () => {
  const { device } = await deviceContext(req, "appbridge.host.relay");
  if (device.role !== "host") fail(403, "scope");
  id(enrollmentId);
  const existing = await prisma.appBridgePairing.findUnique({ where: { hostDeviceId_enrollmentId: { hostDeviceId: device.id, enrollmentId } } });
  if (!existing) fail(404, "not_found");
  if (!existing.withdrawnAt) await prisma.appBridgePairing.updateMany({ where: { hostDeviceId: device.id, enrollmentId, withdrawnAt: null }, data: { withdrawnAt: new Date() } });
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
});

async function issuePass(req: NextRequest, purpose: "session" | "presence"): Promise<NextResponse> {
  const { device } = await deviceContext(req, purpose === "presence" ? "appbridge.relay.presence" : "appbridge.relay.pass");
  limit("appbridge:pass", device.id, 30, 60_000);
  const body = await readBody(req);
  let binding: Binding;
  if (purpose === "presence") {
    exact(body, []);
    if (device.role !== "host") fail(400, "invalid_request");
    binding = { accountId: device.accountId, hostDeviceId: device.id, remoteDeviceId: null, enrollmentId: null };
  } else {
    exact(body, ["hostDeviceId", "enrollmentId"]);
    if (device.role !== "remote") fail(400, "invalid_request");
    binding = { accountId: device.accountId, hostDeviceId: id(body.hostDeviceId), remoteDeviceId: device.id, enrollmentId: id(body.enrollmentId) };
  }
  const pass = randomBytes(32).toString("hex").toUpperCase();
  const expiresAt = new Date(Date.now() + PASS_TTL_MS);
  const result = await serializableTx(async tx => {
    const g = await gate(tx, binding);
    if ("refused" in g) return g;
    await tx.appBridgePass.create({ data: { passHash: sha256Hex(pass), purpose, ...binding, expiresAt } });
    return { ok: true } as const;
  });
  if ("refused" in result) refuse(result.refused);
  void sweep();
  return json({ pass, expiresAt: expiresAt.toISOString(), relay: relayUrl() });
}
/** POST /relay/presence-passes — a host's pass to keep its waiting connection at the relay. */
export const issuePresencePass = (req: NextRequest) => handle(() => issuePass(req, "presence"));
/** POST /relay/passes — a remote's pass to reach one PC, for one of that PC's attested enrollments. */
export const issueSessionPass = (req: NextRequest) => handle(() => issuePass(req, "session"));

// ── Relay-facing routes ─────────────────────────────────────────────────────

/**
 * POST /relay/redeem — consume a pass (always, whatever follows) and open a 2-minute lease.
 * Budgets (H1), all apart from renew/release: every attempt counts against the presented key
 * (REDEEMS_PER_KEY); refusals also spend a per-key and a global failure budget. Anyone can make the
 * relay sign a redeem (a client connect with a throwaway key and a junk pass), so once the global
 * failure budget is spent, only keys registered to a live device get through to the transaction —
 * the flood is shed with one indexed read, and real devices keep connecting.
 */
export const redeemPass = (req: NextRequest) => handle(async () => {
  const body = await relayRequest(req);
  const flood = rateLimitPeek("appbridge:redeem-failed", "all", REDEEM_FAILURES);
  const names = Object.keys(body);
  if (names.length !== 3 || typeof body.pass !== "string" || !HEX64.test(body.pass) || (body.purpose !== "session" && body.purpose !== "presence") ||
    typeof body.connectorSpkiSha256 !== "string" || !HEX64.test(body.connectorSpkiSha256)) {
    spend("appbridge:redeem-failed", "all", REDEEM_FAILURES);
    return fail(400, "invalid_request");
  }
  const passHash = sha256Hex(body.pass); const purpose = body.purpose; const presented = body.connectorSpkiSha256;
  budget("appbridge:redeem-failed", presented, REDEEM_FAILURES_PER_KEY);
  if (!flood.ok && !(await prisma.appBridgeDevice.findFirst({ where: { connectorSpkiSha256: presented, revokedAt: null }, select: { id: true } }))) fail(429, "rate_limited", flood.retryAfterSec);
  limit("appbridge:redeem", presented, REDEEMS_PER_KEY, 60_000);
  const refused = (): NextResponse => {
    spend("appbridge:redeem-failed", "all", REDEEM_FAILURES); spend("appbridge:redeem-failed", presented, REDEEM_FAILURES_PER_KEY);
    return json({ error: "refused" }, 403);
  };
  // Refusals are returned as values, never thrown, so the pass's consumption always commits. A conflict
  // aborts the whole attempt, consumption included, and serializableTx re-runs it: the pass is consumed
  // by exactly the attempt that commits (if a concurrent redeem won it, the re-run finds it consumed and
  // refuses), the caps are counted again, and refused() spends the failure budgets once, after the commit.
  const grant = await serializableTx(async tx => {
    const now = new Date();
    const consumed = await tx.appBridgePass.updateMany({ where: { passHash, consumedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now } });
    if (consumed.count !== 1) return null;
    const pass = await tx.appBridgePass.findUnique({ where: { passHash } });
    if (!pass || pass.purpose !== purpose) return null;
    const binding: Binding = { accountId: pass.accountId, hostDeviceId: pass.hostDeviceId, remoteDeviceId: pass.remoteDeviceId, enrollmentId: pass.enrollmentId };
    if ((purpose === "session") !== (binding.remoteDeviceId !== null)) return null;
    const g = await gate(tx, binding);
    if ("refused" in g) return null;
    const presenter = purpose === "session" ? g.remote! : g.host;
    if (!sameFingerprint(presenter.connectorSpkiSha256, presented)) return null;
    if (purpose === "session") {
      // Cost guard: at most MAX_REMOTES_PER_ACCOUNT remotes relayed at once; each holds at most
      // MAX_PAIRS_PER_REMOTE_HOST connections to one PC and MAX_PAIRS_PER_REMOTE across all its PCs.
      // Counted from the account's live leases in this transaction, so racing redeems cannot overshoot:
      // they conflict, and the re-run counts again.
      const live = await tx.appBridgeLease.findMany({ where: { accountId: binding.accountId, purpose: "session", expiresAt: { gt: now } }, select: { remoteDeviceId: true, hostDeviceId: true } });
      const remotes = new Set(live.map(l => l.remoteDeviceId));
      const mine = live.filter(l => l.remoteDeviceId === binding.remoteDeviceId);
      if (mine.filter(l => l.hostDeviceId === binding.hostDeviceId).length >= MAX_PAIRS_PER_REMOTE_HOST || mine.length >= MAX_PAIRS_PER_REMOTE ||
        (!remotes.has(binding.remoteDeviceId) && remotes.size >= MAX_REMOTES_PER_ACCOUNT)) return "capacity" as const;
    } else {
      // Presence cap: each PC keeps one waiting connection; the spares cover a PC reconnecting before
      // the relay has released its old lease. Nothing else bounds presence leases per account.
      const live = await tx.appBridgeLease.findMany({ where: { accountId: binding.accountId, purpose: "presence", expiresAt: { gt: now } }, select: { id: true } });
      if (live.length >= MAX_PRESENCE_PER_ACCOUNT) return "capacity" as const;
    }
    const lease = await tx.appBridgeLease.create({ data: { id: newId(), purpose, ...binding, expiresAt: new Date(now.getTime() + LEASE_TTL_MS) } });
    // The log records an admitted attempt: it is written here, so a pair the relay then fails to
    // join still appears (the page and docs call these "connection attempts").
    if (purpose === "session") await tx.appBridgeConnectionEvent.create({ data: { accountId: binding.accountId, hostDeviceId: binding.hostDeviceId, remoteDeviceId: binding.remoteDeviceId!, at: now } });
    return {
      leaseId: lease.id, accountId: binding.accountId, hostDeviceId: binding.hostDeviceId,
      clientDeviceId: binding.remoteDeviceId, enrollmentId: binding.enrollmentId,
      hostConnectorSpkiSha256: g.host.connectorSpkiSha256, clientConnectorSpkiSha256: g.remote?.connectorSpkiSha256 ?? null,
    };
  });
  if (!grant) return refused();
  if (grant === "capacity") return json({ error: "refused" }, 409);
  void sweep();
  return json(grant);
});

/** POST /relay/release — the relay ended a pair or presence: free its lease (and the account's slot) now. Idempotent. */
export const releaseLease = (req: NextRequest) => handle(async () => {
  const body = await relayRequest(req);
  exact(body, ["leaseId"]);
  const leaseId = id(body.leaseId);
  limit("appbridge:lease", leaseId, LEASE_CALLS_PER_LEASE, 60_000);
  await prisma.appBridgeLease.deleteMany({ where: { id: leaseId } });
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
});

/** POST /relay/renew — recheck the gate for a live lease and extend it by 120 s; a refusal deletes the lease. */
export const renewLease = (req: NextRequest) => handle(async () => {
  const body = await relayRequest(req);
  exact(body, ["leaseId"]);
  const leaseId = id(body.leaseId);
  // Per lease only: renewals touch leases the broker granted, which the caps already bound, and no
  // other route's traffic (least of all a redeem flood) can ever spend this budget.
  limit("appbridge:lease", leaseId, LEASE_CALLS_PER_LEASE, 60_000);
  const result = await serializableTx(async tx => {
    const now = new Date();
    const lease = await tx.appBridgeLease.findUnique({ where: { id: leaseId } });
    if (!lease) return { status: 404 } as const;
    if (lease.expiresAt <= now) { await tx.appBridgeLease.deleteMany({ where: { id: leaseId } }); return { status: 410 } as const; }
    const g = await gate(tx, { accountId: lease.accountId, hostDeviceId: lease.hostDeviceId, remoteDeviceId: lease.remoteDeviceId, enrollmentId: lease.enrollmentId });
    if ("refused" in g) { await tx.appBridgeLease.deleteMany({ where: { id: leaseId } }); return { status: 403 } as const; }
    const extended = await tx.appBridgeLease.updateMany({ where: { id: leaseId, expiresAt: { gt: now } }, data: { expiresAt: new Date(now.getTime() + LEASE_TTL_MS) } });
    if (extended.count !== 1) return { status: 410 } as const;
    return { keys: { hostConnectorSpkiSha256: g.host.connectorSpkiSha256, clientConnectorSpkiSha256: g.remote?.connectorSpkiSha256 ?? null } };
  });
  if ("status" in result) return json({ error: "refused" }, result.status);
  return json(result.keys);
});

// ── Account (dashboard) routes ──────────────────────────────────────────────

/** POST /account/device-codes — mint a one-use, 10-minute code for registering a PC (host) or a phone (remote). */
export const mintDeviceCode = (req: NextRequest) => handle(async () => {
  const account = await accountContext(req, true);
  if (!account.emailVerifiedAt) fail(409, "email_unverified");
  limit("appbridge:code", account.id, 15, 60 * 60_000);
  const body = await readBody(req);
  exact(body, ["role"], ["label"]);
  if (body.role !== "host" && body.role !== "remote") fail(400, "invalid_request");
  let label: string | null = null;
  if (body.label !== undefined) {
    if (typeof body.label !== "string" || /[\u0000-\u001f\u007f]/.test(body.label)) fail(400, "invalid_request");
    label = body.label.trim().slice(0, 80) || null;
  }
  const part = () => Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)]).join("");
  const code = `ABD-${part()}-${part()}`;
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  await prisma.appBridgeDeviceCode.create({ data: { codeHash: sha256Hex(code), accountId: account.id, role: body.role, label, expiresAt } });
  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "appbridge.device_code_minted", detail: { role: body.role } } }).catch(() => {});
  return json({ code, expiresAt: expiresAt.toISOString() });
});

/** GET /account/devices — the account's AppBridge devices and remote-access state. */
export const listDevices = (req: NextRequest) => handle(async () => {
  const account = await accountContext(req, false);
  const [devices, source] = await Promise.all([
    prisma.appBridgeDevice.findMany({ where: { accountId: account.id }, orderBy: { createdAt: "asc" }, take: 200 }),
    remoteAccessSource(prisma, account.id),
  ]);
  return json({
    rollout: rolloutOn(), entitled: !!source,
    devices: devices.map(d => ({ id: d.id, role: d.role, label: d.label, relayEnabled: d.relayEnabled, enabled: d.enabled,
      connectorSpkiSha256: d.connectorSpkiSha256, createdAt: d.createdAt, revokedAt: d.revokedAt })),
  });
});

/**
 * Revoke a device inside the caller's transaction: the device, every credential, its pairings, and its
 * live leases (as host or remote). Deleting the leases makes the relay's next renewal a 404, so a live
 * session ends within one renewal interval (about a minute) instead of riding out a refused renewal.
 */
async function revokeInTx(tx: Prisma.TransactionClient, deviceId: string, now: Date): Promise<void> {
  await tx.appBridgeDevice.update({ where: { id: deviceId }, data: { revokedAt: now, enabled: false, relayEnabled: false } });
  await tx.appBridgeCredential.updateMany({ where: { deviceId, revokedAt: null }, data: { revokedAt: now } });
  await tx.appBridgePairing.updateMany({ where: { OR: [{ hostDeviceId: deviceId }, { remoteDeviceId: deviceId }], withdrawnAt: null }, data: { withdrawnAt: now } });
  await tx.appBridgeLease.deleteMany({ where: { OR: [{ hostDeviceId: deviceId }, { remoteDeviceId: deviceId }] } });
}

/** DELETE /account/devices/{id} — revoke a device: its credentials stop, its pairings are withdrawn, its live leases are deleted. */
export const revokeDevice = (req: NextRequest, deviceId: string) => handle(async () => {
  const account = await accountContext(req, true);
  id(deviceId);
  await serializableTx(async tx => {
    const device = await tx.appBridgeDevice.findUnique({ where: { id: deviceId } });
    if (!device || device.accountId !== account.id) fail(404, "not_found");
    if (device.revokedAt) return;
    await revokeInTx(tx, deviceId, new Date());
  });
  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "appbridge.device_revoked", detail: { deviceId } } }).catch(() => {});
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
});

/** GET /account/connections — the 7-day log: which device reached which PC, and when. Nothing else is recorded. */
export const listConnections = (req: NextRequest) => handle(async () => {
  const account = await accountContext(req, false);
  void sweep();
  const events = await prisma.appBridgeConnectionEvent.findMany({
    where: { accountId: account.id, at: { gte: new Date(Date.now() - CONNECTION_LOG_MS) } }, orderBy: { at: "desc" }, take: 500,
  });
  return json({ connections: events.map(e => ({ hostDeviceId: e.hostDeviceId, remoteDeviceId: e.remoteDeviceId, at: e.at })) });
});

// ── Admin ───────────────────────────────────────────────────────────────────

/**
 * PUT /admin/entitlements { handle, active } — the owner only (src/lib/admin.ts
 * checkOwnerAdmin: dashboard session + ADMIN_EMAILS + verified email + CSRF).
 * Account.admin grants nothing, and any bearer key is refused before lookup.
 */
export const setEntitlement = (req: NextRequest) => handle(async () => {
  const gate = await checkOwnerAdmin(ownerGateInput(req), true);
  if (!gate.ok) fail(gate.status, gate.error);
  const me = gate.account;
  const body = await readBody(req);
  exact(body, ["handle", "active"]);
  if (typeof body.handle !== "string" || !body.handle || body.handle.length > 128 || typeof body.active !== "boolean") fail(400, "invalid_request");
  const target = await prisma.account.findUnique({ where: { handle: body.handle } });
  if (!target) fail(404, "not_found");
  await prisma.appBridgeEntitlement.upsert({
    where: { accountId_feature: { accountId: target.id, feature: FEATURE } },
    create: { accountId: target.id, feature: FEATURE, active: body.active }, update: { active: body.active },
  });
  await prisma.accountAudit.create({ data: { accountId: me.id, eventType: "appbridge.entitlement_set", detail: { handle: body.handle, active: body.active } } }).catch(() => {});
  return json({ handle: body.handle, active: body.active });
});
