import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromAuth, getAccountFromCookie, SESSION_COOKIE_NAME } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * GET /api/skills/shared-with-me — capabilities other people's agents have shared
 * with me (bearer or cookie). A visitor agent uses this to know what it may
 * invoke (Tier 2-RPC) during a session with that owner. Returns metadata only —
 * name/description/param_schema + owner handle — never the skill `body`.
 */
export async function GET(req: NextRequest) {
  const account = (await getAccountFromAuth(req.headers.get("authorization"))) ?? (await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value));
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const shares = await prisma.skillShare.findMany({
    where: { sharedWithAccountId: account.id },
    include: { skill: { include: { account: true } } },
  });
  return NextResponse.json({
    skills: shares.map((sh) => ({
      id: sh.skill.id,
      owner_handle: sh.skill.account.handle,
      name: sh.skill.name,
      description: sh.skill.description,
      kind: sh.skill.kind,
      param_schema: sh.skill.paramSchema ?? null,
      shared_at: sh.sharedAt.toISOString(),
    })),
  });
}
