/**
 * Back Channel Broker — Auth helpers.
 *
 * Phase 3.1: account creation goes through magic-link email verification.
 * - POST /api/accounts creates a pending Account (apiKey=null) + a MagicLink token
 * - GET  /api/auth/verify?token=...  marks the account verified, issues + returns the apiKey
 *
 * Tokens are random base64url strings, 32 bytes, stored in MagicLink table with 24h TTL.
 */

import { randomBytes, createHash } from "node:crypto";
import { prisma } from "./db";
import type { Account } from "@prisma/client";

const KEY_PREFIX = "bc_";
const TOKEN_TTL_HOURS = 24;

/**
 * Hash a single-use/secret token for AT-REST storage. We hand the RAW token to
 * the user (email link, cookie) but only ever store/look up its SHA-256 hash —
 * so a DB read (or leak) never exposes a usable token. Lookup = hash the
 * incoming raw, query by hash. (API keys are intentionally NOT hashed: they're
 * long-lived bearer creds the agent presents on every call and that we must
 * return at issue time; tokens here are short-lived secrets.)
 */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function generateApiKey(): string {
  return KEY_PREFIX + randomBytes(24).toString("base64url");
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

export function generateInviteCode(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const part = (n: number) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `BC-${part(4)}-${part(4)}`;
}

export function magicLinkExpiry(): Date {
  return new Date(Date.now() + TOKEN_TTL_HOURS * 3600 * 1000);
}

/** Pull the bearer token from an incoming request and return the account, or null. */
export async function getAccountFromAuth(authHeader: string | null): Promise<Account | null> {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(\S+)$/);
  if (!m) return null;
  const key = m[1];
  if (!key.startsWith(KEY_PREFIX)) return null;
  const account = await prisma.account.findUnique({ where: { apiKey: key } });
  // Touch apiKeyLastUsedAt (throttled to ~once/min) so the dashboard can show
  // "last used" without a write on every authed call.
  if (account) {
    const last = account.apiKeyLastUsedAt?.getTime() ?? 0;
    if (Date.now() - last > 60_000) {
      void prisma.account.update({ where: { id: account.id }, data: { apiKeyLastUsedAt: new Date() } }).catch(() => {});
    }
  }
  return account;
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
