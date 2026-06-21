import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromAuth, getAccountFromCookie, SESSION_COOKIE_NAME } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * GET /api/skills/discover — Tier 2.5 trust-circle discovery. Skills that
 * peers YOU trust have marked discoverable. Returns NAME + description + owner
 * handle ONLY (decision §8.4: no param_schema, no body). Discovery ≠ access —
 * to actually use one, ask the owner to share it with you (then it shows up in
 * /api/skills/shared-with-me). Nothing here is invocable/copyable yet.
 */
export async function GET(req: NextRequest) {
  const account = (await getAccountFromAuth(req.headers.get("authorization"))) ?? (await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value));
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // The peers I trust (my directed rows).
  const trusted = await prisma.trustedPeer.findMany({ where: { accountId: account.id } });
  const ownerIds = trusted.map((t) => t.trustedAccountId);
  if (ownerIds.length === 0) return NextResponse.json({ skills: [] });

  const skills = await prisma.userSkill.findMany({
    where: { accountId: { in: ownerIds }, discoverable: true },
    include: { account: true },
    orderBy: { updatedAt: "desc" },
  });
  return NextResponse.json({
    skills: skills.map((s) => ({
      id: s.id,
      owner_handle: s.account.handle,
      name: s.name,
      description: s.description,
      kind: s.kind,
      // deliberately NO param_schema / body — discovery is name + description only
    })),
  });
}
