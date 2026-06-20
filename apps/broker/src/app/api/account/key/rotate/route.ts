import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, generateApiKey, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid } from "@/lib/auth";
import { sendKeyRotatedEmail } from "@/lib/email";

export const runtime = "nodejs";

/**
 * POST /api/account/key/rotate — dashboard key rotation (cookie auth).
 * Issues a brand-new API key, invalidates the old one, returns the new key
 * ONCE (the only time it's shown in full — the dashboard renders it once with a
 * "save it" callout, then only ever shows the masked form). Emails a security
 * notice + audits key.rotated.
 */
export async function POST(req: NextRequest) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return NextResponse.json({ error: "csrf" }, { status: 403 });

  const newKey = generateApiKey();
  await prisma.account.update({ where: { id: account.id }, data: { apiKey: newKey, apiKeyLastUsedAt: null } });
  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "key.rotated", detail: {} } });
  void sendKeyRotatedEmail(account.email, account.handle); // fire-and-forget notice

  // The ONLY response that ever contains the full key. Shown once, client-side.
  return NextResponse.json({ status: "rotated", api_key: newKey });
}
