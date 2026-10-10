import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid, upsertOriginalAgentToken } from "@/lib/auth";
import { sendKeyRotatedEmail } from "@/lib/email";
import { requireConnectStepUp, STEP_UP_HEADER } from "@/lib/step-up";

export const runtime = "nodejs";

/**
 * POST /api/account/key/rotate — dashboard key rotation (cookie auth).
 * Issues a brand-new API key, invalidates the old one, returns the new key
 * ONCE (the only time it's shown in full — the dashboard renders it once with a
 * "save it" callout, then only ever shows the masked form). Emails a security
 * notice + audits key.rotated.
 *
 * SEC H1: the new key is minted as the account's "Original" AgentToken (see
 * upsertOriginalAgentToken in @/lib/auth) — only its SHA-256 hash persists.
 * Nothing writes Account.apiKey anymore.
 *
 * On an account with a PC in Back Channel Remote, needs the person's passkey step-up
 * (connect_agent, src/lib/step-up.ts): the new key is a full agent key, shown on
 * screen. Other accounts: as before.
 */
export async function POST(req: NextRequest) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return NextResponse.json({ error: "csrf" }, { status: 403 });
  const refusal = await requireConnectStepUp(prisma, { accountId: account.id, grant: req.headers.get(STEP_UP_HEADER), now: new Date() });
  if (refusal) return NextResponse.json({ error: refusal.error, message: refusal.message }, { status: refusal.status });

  const newKey = await upsertOriginalAgentToken(account.id);
  await prisma.account.update({ where: { id: account.id }, data: { apiKeyLastUsedAt: null } });
  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "key.rotated", detail: {} } });
  void sendKeyRotatedEmail(account.email, account.handle); // fire-and-forget notice

  // The ONLY response that ever contains the full key. Shown once, client-side.
  return NextResponse.json({ status: "rotated", api_key: newKey });
}
