/**
 * Back Channel Broker — Auth helpers.
 *
 * Phase 3.1: account creation goes through magic-link email verification.
 * - POST /api/accounts creates a pending Account (apiKey=null) + a MagicLink token
 * - GET  /api/auth/verify?token=...  marks the account verified, issues the account's key
 *
 * Tokens are random base64url strings, 32 bytes, stored in MagicLink table with 24h TTL.
 *
 * SEC H1 (2026-07-03): Account.apiKey used to store the raw bc_ key in plaintext.
 * It no longer does. verify/rotate/recover-key now mint (or replace) a single
 * per-account AgentToken named "Original" via upsertOriginalAgentToken() below —
 * same keyHash-only storage every other AgentToken uses. The raw key is still
 * generated and returned to the caller exactly once; only its hash is ever
 * persisted. Account.apiKey is written by nothing anymore; it is read only as a
 * fallback in getAuthContext() for accounts minted before this fix and not yet
 * covered by the H1 backfill migration (prisma/migrations/20260703221500_h1_apikey_hash_backfill).
 * Once Skylar confirms that backfill has run in prod, the fallback read (and
 * eventually the column itself) can be dropped in a follow-up.
 */

import { randomBytes, randomInt, createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import type { Account } from "@prisma/client";

const KEY_PREFIX = "bc_";
const TOKEN_TTL_HOURS = 24;
const ORIGINAL_AGENT_TOKEN_NAME = "Original";

/**
 * Hash a single-use/secret token for AT-REST storage. We hand the RAW token to
 * the user (email link, cookie) but only ever store/look up its SHA-256 hash —
 * so a DB read (or leak) never exposes a usable token. Lookup = hash the
 * incoming raw, query by hash. (bc_ API keys are hashed the exact same way as
 * of SEC H1 — see upsertOriginalAgentToken; the raw is still returned once at
 * issue time, it's just never written to a plaintext column anymore.)
 */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function generateApiKey(): string {
  return KEY_PREFIX + randomBytes(24).toString("base64url");
}

/**
 * SEC H1: mint a brand-new raw bc_ key for `accountId` and persist ONLY its
 * hash, as the account's single "Original" AgentToken — the per-agent-tokens
 * model's slot for the legacy one-key-per-account flows (verify, dashboard
 * rotate, email recovery). Mirrors exactly how /api/account/agents and
 * /api/auth/exchange mint per-agent AgentToken rows (generateApiKey() +
 * hashToken() + prisma.agentToken.create()) — one hashing scheme, not two.
 *
 * Safe to call repeatedly: any existing LIVE "Original" token for this account
 * is revoked (not deleted — keeps the audit trail) before the new one is
 * created, so there's never more than one live Original token and the
 * previous raw key stops authenticating immediately — matching the old
 * "rotating overwrites/invalidates the previous key" behavior.
 *
 * Returns the raw key — the ONLY place it exists outside a caller's local
 * scope. Callers must return it to the HTTP caller and must NOT persist it
 * anywhere themselves (no writing it to Account.apiKey or logging it).
 */
export async function upsertOriginalAgentToken(accountId: string): Promise<string> {
  const rawKey = generateApiKey();
  await prisma.agentToken.updateMany({
    where: { accountId, name: ORIGINAL_AGENT_TOKEN_NAME, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await prisma.agentToken.create({
    data: { accountId, keyHash: hashToken(rawKey), name: ORIGINAL_AGENT_TOKEN_NAME, runtimeType: "other" },
  });
  return rawKey;
}

export function generateMagicLinkToken(): string {
  return randomBytes(32).toString("base64url");
}

// Recovery tokens reuse the MagicLink table but carry a "rec_" prefix so we can
// tell them apart from verification tokens without a schema change. A recovery
// token, when consumed, ROTATES the API key (vs verification, which issues the
// first key). Keeping them in the same table keeps the schema small.
const RECOVERY_PREFIX = "rec_";
export function generateRecoveryToken(): string {
  return RECOVERY_PREFIX + randomBytes(32).toString("base64url");
}
export function isRecoveryToken(token: string): boolean {
  return token.startsWith(RECOVERY_PREFIX);
}

export function generateHandle(email: string): string {
  // skylar@example.com -> skylar@bc
  const local = email.split("@")[0]?.toLowerCase().replace(/[^a-z0-9-_.]/g, "");
  return `${local || "user"}@bc`;
}

// L6 (security-pass-2026-07-03.md): CSPRNG, not Math.random() — rate-limited so the practical
// risk was theoretical, but there's no reason a human-facing secret shouldn't use the same
// crypto-random source generateExchangeCode (below) already uses. randomInt(0, n) is Node's
// unbiased CSPRNG draw (internally rejection-samples, unlike a naive randomBytes(1)[0] % n,
// which is subtly biased for an alphabet length that doesn't evenly divide 256). Same
// alphabet, length, and BC-XXXX-XXXX format as before — only the entropy source changed.
export function generateInviteCode(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const part = (n: number) => Array.from({ length: n }, () => chars[randomInt(0, chars.length)]).join("");
  return `BC-${part(4)}-${part(4)}`;
}

export function magicLinkExpiry(): Date {
  return new Date(Date.now() + TOKEN_TTL_HOURS * 3600 * 1000);
}

// Exchange code (device-code flow): BCX-XXXX-XXXX, unambiguous base32. Short
// single-use code the dashboard mints; the agent trades it for the real bc_ key
// so the raw key never lands in a chat transcript. Crypto-random, hashed at rest.
// 15 minutes: covers the read-skill-decide-paste loop without feeling rushed (a
// fast-decaying timer reads to a security-tuned agent as manipulation). Codes are
// still single-use + atomic-claim, so the longer window isn't a real attack gain.
const EXCHANGE_CODE_TTL_MS = 900 * 1000;
export function generateExchangeCode(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const part = (n: number) => Array.from({ length: n }, () => chars[randomBytes(1)[0] % chars.length]).join("");
  return `BCX-${part(4)}-${part(4)}`;
}
export function exchangeCodeExpiry(): Date {
  return new Date(Date.now() + EXCHANGE_CODE_TTL_MS);
}

/**
 * Resolve a bearer key to its account AND the agent token it came from.
 * Per-agent-tokens: a bc_ key is first looked up as a live AgentToken (revoked
 * tokens 401). Falls back to the legacy plaintext Account.apiKey ONLY for
 * accounts minted before SEC H1 that the backfill migration hasn't reached yet
 * in prod — see prisma/migrations/20260703221500_h1_apikey_hash_backfill and
 * the loud note in that migration's header. Nothing writes Account.apiKey
 * anymore (verify/rotate/recover-key all mint an "Original" AgentToken via
 * upsertOriginalAgentToken instead), so this fallback strictly shrinks over
 * time and can be deleted once the backfill is confirmed complete.
 * Touches lastUsedAt (throttled ~1/min) so the dashboard shows per-agent "last
 * active" without a write per request.
 */
export async function getAuthContext(authHeader: string | null): Promise<{ account: Account; agentTokenId: string | null } | null> {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(\S+)$/);
  if (!m) return null;
  const key = m[1];
  if (!key.startsWith(KEY_PREFIX)) return null;

  // 1. Per-agent token (the canonical path). Revoked tokens do not authenticate.
  const tok = await prisma.agentToken.findUnique({ where: { keyHash: hashToken(key) }, include: { account: true } });
  if (tok && !tok.revokedAt) {
    const last = tok.lastUsedAt?.getTime() ?? 0;
    if (Date.now() - last > 60_000) {
      void prisma.agentToken.update({ where: { id: tok.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
    }
    return { account: tok.account, agentTokenId: tok.id };
  }
  if (tok && tok.revokedAt) return null; // explicitly revoked → no fallback

  // 2. Legacy fallback: pre-H1 plaintext Account.apiKey, for accounts the
  // backfill migration hasn't reached yet. READ-ONLY — nothing writes this
  // column anymore. Safe to delete once the backfill is confirmed done.
  const account = await prisma.account.findUnique({ where: { apiKey: key } });
  if (account) {
    const last = account.apiKeyLastUsedAt?.getTime() ?? 0;
    if (Date.now() - last > 60_000) {
      void prisma.account.update({ where: { id: account.id }, data: { apiKeyLastUsedAt: new Date() } }).catch(() => {});
    }
    return { account, agentTokenId: null };
  }
  return null;
}

/** Pull the bearer token from an incoming request and return the account, or null. */
export async function getAccountFromAuth(authHeader: string | null): Promise<Account | null> {
  return (await getAuthContext(authHeader))?.account ?? null;
}

// ── Account Dashboard: view-tokens + browser session cookies ────────────────

const VIEW_TOKEN_PREFIX = "vt_";
const COOKIE_TOKEN_PREFIX = "cs_";
/** httpOnly cookie name backing a dashboard browser session. */
export const SESSION_COOKIE_NAME = "bc_session";
const VIEW_TOKEN_TTL_MS = 15 * 60 * 1000;       // single-use, 15 min
const SESSION_COOKIE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export function generateViewToken(): string {
  return VIEW_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}
export function generateSessionCookieToken(): string {
  return COOKIE_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}
export function viewTokenExpiry(): Date {
  return new Date(Date.now() + VIEW_TOKEN_TTL_MS);
}
export function sessionCookieExpiry(): Date {
  return new Date(Date.now() + SESSION_COOKIE_TTL_MS);
}
export const SESSION_COOKIE_MAX_AGE_SEC = SESSION_COOKIE_TTL_MS / 1000;

// ── CSRF (double-submit) for cookie-authed mutations ───────────────────────
// bc_csrf is a NON-httpOnly cookie set alongside bc_session; the dashboard JS
// reads it and echoes it in the x-bc-csrf header on state-changing requests.
// A cross-site attacker can ride the bc_session cookie (SameSite=Lax helps but
// isn't airtight) but cannot read bc_csrf to forge the matching header.
export const CSRF_COOKIE_NAME = "bc_csrf";
export const CSRF_HEADER = "x-bc-csrf";
export function generateCsrfToken(): string {
  return randomBytes(18).toString("base64url");
}
/** True if the header token matches the cookie token (both present, equal). */
export function csrfValid(headerToken: string | null | undefined, cookieToken: string | null | undefined): boolean {
  return !!headerToken && !!cookieToken && headerToken === cookieToken;
}

/**
 * Resolve an account from EITHER the bearer key OR the bc_session cookie.
 * For endpoints that legitimately serve both the agent (bearer) and the human
 * dashboard (cookie) — e.g. ending a session. Bearer wins if both present.
 */
export async function getAccountDual(authHeader: string | null, cookieToken: string | null | undefined): Promise<Account | null> {
  return (await getAccountFromAuth(authHeader)) ?? (await getAccountFromCookie(cookieToken));
}

/** Mask an API key for display: bc_••••••••G7Yx (never reveal the full key). */
export function maskApiKey(key: string | null): string | null {
  if (!key) return null;
  const tail = key.slice(-4);
  return `${KEY_PREFIX}${"•".repeat(8)}${tail}`;
}

/**
 * Resolve the dashboard browser session from the bc_session cookie value.
 * Returns the account if the cookie maps to a live (non-expired) SessionCookie,
 * else null. Touches lastUsedAt (throttled). This is the HUMAN tier — callers
 * must NOT treat it as the agent bearer (no invite/claim/poll/send).
 */
export async function getAccountFromCookie(cookieToken: string | null | undefined): Promise<Account | null> {
  if (!cookieToken || !cookieToken.startsWith(COOKIE_TOKEN_PREFIX)) return null;
  const h = hashToken(cookieToken); // stored as a hash; look up by hash
  const sc = await prisma.sessionCookie.findUnique({ where: { token: h }, include: { account: true } });
  if (!sc) return null;
  if (sc.expiresAt.getTime() < Date.now()) {
    void prisma.sessionCookie.delete({ where: { token: h } }).catch(() => {});
    return null;
  }
  const last = sc.lastUsedAt?.getTime() ?? 0;
  if (Date.now() - last > 60_000) {
    void prisma.sessionCookie.update({ where: { token: h }, data: { lastUsedAt: new Date() } }).catch(() => {});
  }
  return sc.account;
}
