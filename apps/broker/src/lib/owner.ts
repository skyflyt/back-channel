/**
 * Who the owner is: the ADMIN_EMAILS allowlist (src/lib/admin.ts explains the whole admin gate).
 *
 * Split out of admin.ts so modules the MCP route loads can ask "is this account the owner?" without
 * importing admin.ts, which named-imports @/lib/auth: route tests replace @/lib/auth with a few named
 * exports, and a named import of one they left out fails at link time for every module that loads it.
 * This file imports nothing at runtime. admin.ts re-exports both functions unchanged.
 *
 * Remote support (docs/remote-support.md) is owner-only in v1 and asks isOwnerAccount() here.
 */
import type { Account } from "@prisma/client";

const EMAIL = /^[^@\s]+@[^@\s]+$/;

/** The owner allowlist from ADMIN_EMAILS. Empty (admin closed) when unset. */
export function ownerEmails(): Set<string> {
  const raw = process.env.ADMIN_EMAILS ?? "";
  // Commas are the documented separator; semicolons and whitespace are also
  // accepted because gcloud --set-env-vars reserves the comma.
  return new Set(raw.split(/[,;\s]+/).map(s => s.trim().toLowerCase()).filter(s => EMAIL.test(s)));
}

/** True only for a verified, non-reserved account whose email is allowlisted. */
export function isOwnerAccount(account: Pick<Account, "email" | "emailVerifiedAt"> & { reserved?: boolean | null }): boolean {
  const allow = ownerEmails();
  if (allow.size === 0) return false;
  if (!account.emailVerifiedAt || account.reserved) return false;
  return typeof account.email === "string" && allow.has(account.email.trim().toLowerCase());
}
