import { NextRequest, NextResponse } from "next/server";
import { getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid } from "@/lib/auth";
import { STEP_UP_HEADER } from "@/lib/step-up";
import { turnOffVaultGrant, turnOnVaultGrant } from "@/lib/vault-grant";

export const runtime = "nodejs";

/**
 * POST /api/account/agents/:id/vault — let this connected app (a connector key) read the person's notes vault through
 * the bc_vault_* tools (src/lib/vault-grant.ts, docs/vault-bridge.md step 4). Cookie + CSRF, and always a passkey
 * step-up for exactly this connector (grant_vault, in the x-bc-step-up header).
 * DELETE /api/account/agents/:id/vault — stop it. Cookie + CSRF, no passkey. Idempotent.
 */
async function signedIn(req: NextRequest) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return { refused: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (!csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return { refused: NextResponse.json({ error: "csrf" }, { status: 403 }) };
  return { account };
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await signedIn(req);
  if ("refused" in s) return s.refused;
  const { id } = await params;
  const out = await turnOnVaultGrant(s.account.id, id, req.headers.get(STEP_UP_HEADER), new Date());
  return NextResponse.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await signedIn(req);
  if ("refused" in s) return s.refused;
  const { id } = await params;
  const out = await turnOffVaultGrant(s.account.id, id);
  return NextResponse.json(out.body, { status: out.status, headers: { "Cache-Control": "no-store" } });
}
