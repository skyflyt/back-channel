import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, SESSION_COOKIE_NAME } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * GET /api/account/agents — the account's registered agents (cookie-auth).
 * Active (revokedAt IS NULL) by default, newest-active first; pass
 * ?include_revoked=true for full history. Metadata only — never a key/hash.
 */
export async function GET(req: NextRequest) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const includeRevoked = new URL(req.url).searchParams.get("include_revoked") === "true";
  const rows = await prisma.agentToken.findMany({
    where: { accountId: account.id, ...(includeRevoked ? {} : { revokedAt: null }) },
    orderBy: [{ lastUsedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
  });
  return NextResponse.json({
    agents: rows.map((a) => ({
      id: a.id,
      name: a.name,
      runtime_type: a.runtimeType,
      created_at: a.createdAt.toISOString(),
      last_used_at: a.lastUsedAt?.toISOString() ?? null,
      revoked_at: a.revokedAt?.toISOString() ?? null,
    })),
  });
}
