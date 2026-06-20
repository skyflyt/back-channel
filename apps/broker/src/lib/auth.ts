/**
 * Back Channel Broker — Auth helpers.
 *
 * Phase 3.1: account creation goes through magic-link email verification.
 * - POST /api/accounts creates a pending Account (apiKey=null) + a MagicLink token
 * - GET  /api/auth/verify?token=...  marks the account verified, issues + returns the apiKey
 *
 * Tokens are random base64url strings, 32 bytes, stored in MagicLink table with 24h TTL.
 */

import { randomBytes } from "node:crypto";
import { prisma } from "./db";
import type { Account } from "@prisma/client";

const KEY_PREFIX = "bc_";
const TOKEN_TTL_HOURS = 24;

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
  const sc = await prisma.sessionCookie.findUnique({ where: { token: cookieToken }, include: { account: true } });
  if (!sc) return null;
  if (sc.expiresAt.getTime() < Date.now()) {
    void prisma.sessionCookie.delete({ where: { token: cookieToken } }).catch(() => {});
    return null;
  }
  const last = sc.lastUsedAt?.getTime() ?? 0;
  if (Date.now() - last > 60_000) {
    void prisma.sessionCookie.update({ where: { token: cookieToken }, data: { lastUsedAt: new Date() } }).catch(() => {});
  }
  return sc.account;
}
