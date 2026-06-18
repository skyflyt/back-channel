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
  return prisma.account.findUnique({ where: { apiKey: key } });
}
