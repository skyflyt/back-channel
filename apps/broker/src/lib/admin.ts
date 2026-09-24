/**
 * Owner-only admin gate. Every admin surface goes through checkOwnerAdmin():
 *   - src/app/api/admin/** (analytics, users, grant, revoke)
 *   - PUT /api/appbridge/v1/admin/entitlements (src/lib/appbridge.ts setEntitlement)
 *   - the /admin page itself (src/app/admin/page.tsx, server-side)
 *
 * A caller passes only when ALL of these hold:
 *   1. No Authorization header at all. A bc_ agent key (or any bearer) never
 *      reaches admin; it is refused before it is even resolved, so an agent key
 *      is not looked up and its lastUsedAt is not touched.
 *   2. A live dashboard session: the httpOnly bc_session cookie, resolved by
 *      getAccountFromCookie(). Otherwise 401.
 *   3. The account's email, trimmed and lowercased, is in ADMIN_EMAILS
 *      (comma-separated; production: skyflyt86@gmail.com). If ADMIN_EMAILS is
 *      unset or empty, admin is closed to everyone (fail closed).
 *   4. The email is verified (emailVerifiedAt set) and the row is not a
 *      reserved-handle placeholder.
 *   5. For mutations only: the CSRF double-submit (x-bc-csrf header equals the
 *      bc_csrf cookie), the same check every other cookie-authed mutation uses.
 *
 * Account.admin is deliberately NOT consulted. The column stays for schema
 * compatibility, but it grants nothing: an account with admin=true whose email
 * is not in ADMIN_EMAILS gets 403 like anyone else.
 *
 * Responses: 401 {error:"unauthorized"} when signed out, 403 {error:"forbidden"}
 * for every non-owner (bearer, unverified, not allowlisted, allowlist unset),
 * 403 {error:"csrf"} only for the owner on a mutation without a matching token.
 * No path looks an email up in the database, so nothing here can reveal
 * whether some email has an account.
 */
import type { Account } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import { getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid } from "@/lib/auth";

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

export type OwnerGateInput = {
  authorization?: string | null;
  sessionCookie?: string | null;
  csrfHeader?: string | null;
  csrfCookie?: string | null;
};
export type OwnerGate =
  | { ok: true; account: Account }
  | { ok: false; status: 401 | 403; error: "unauthorized" | "forbidden" | "csrf" };

export async function checkOwnerAdmin(input: OwnerGateInput, mutate: boolean): Promise<OwnerGate> {
  if (input.authorization) return { ok: false, status: 403, error: "forbidden" };
  const account = await getAccountFromCookie(input.sessionCookie);
  if (!account) return { ok: false, status: 401, error: "unauthorized" };
  if (!isOwnerAccount(account)) return { ok: false, status: 403, error: "forbidden" };
  if (mutate && !csrfValid(input.csrfHeader, input.csrfCookie)) return { ok: false, status: 403, error: "csrf" };
  return { ok: true, account };
}

/** The gate's inputs, read from a route handler's request. */
export function ownerGateInput(req: NextRequest): OwnerGateInput {
  return {
    authorization: req.headers.get("authorization"),
    sessionCookie: req.cookies.get(SESSION_COOKIE_NAME)?.value,
    csrfHeader: req.headers.get(CSRF_HEADER),
    csrfCookie: req.cookies.get(CSRF_COOKIE_NAME)?.value,
  };
}

/** No-store JSON, the only way admin routes answer. */
export function adminJson(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Route-handler form. Use it first in every admin handler:
 *   const gate = await requireOwnerAdmin(req, { mutate: true });
 *   if (!gate.ok) return gate.response;
 * GET reads pass mutate:false (cookie only); every other method passes true.
 */
export async function requireOwnerAdmin(req: NextRequest, opts: { mutate: boolean }): Promise<{ ok: true; account: Account } | { ok: false; response: NextResponse }> {
  const gate = await checkOwnerAdmin(ownerGateInput(req), opts.mutate);
  if (gate.ok) return gate;
  return { ok: false, response: adminJson({ error: gate.error }, gate.status) };
}
