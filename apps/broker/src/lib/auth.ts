/**
 * Back Channel Broker — Auth helpers.
 *
 * Phase 3 MVP uses API keys. Magic-link flow lands in v0.4.
 * API key is returned at account creation and required as
 * `Authorization: Bearer <key>` on all account-scoped endpoints.
 */

import { randomBytes } from "node:crypto";
import { prisma } from "./db";
import type { Account } from "@prisma/client";

const KEY_PREFIX = "bc_";

export function generateApiKey(): string {
  return KEY_PREFIX + randomBytes(24).toString("base64url");
}

export function generateHandle(email: string): string {
  // skylar@example.com -> skylar@bc
  const local = email.split("@")[0]?.toLowerCase().replace(/[^a-z0-9-_.]/g, "");
  return `${local || "user"}@bc`;
}

export function generateInviteCode(): string {
  // BC-XXXX-XXXX, only confusable-free chars
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const part = (n: number) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `BC-${part(4)}-${part(4)}`;
}

/** Pull the bearer token from an incoming request and return the account, or null. */
export async function getAccountFromAuth(authHeader: string | null): Promise<Account | null> {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(\S+)$/);
  if (!m) return null;
  const key = m[1];
  return prisma.account.findUnique({ where: { apiKey: key } });
}

