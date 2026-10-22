import { NextRequest, NextResponse } from "next/server";
import { getAccountFromAuth } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/account/identity — bearer-only account identity for trusted service
 * adapters. The bearer resolver remains the single authority for key format,
 * hashing, revocation, and legacy migration behavior. Cookies are deliberately
 * ignored so a browser session cannot satisfy this service contract.
 */
export async function GET(req: NextRequest) {
  const account = await getAccountFromAuth(req.headers.get("authorization"));
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });

  return NextResponse.json({ accountId: account.id }, { headers: NO_STORE });
}
