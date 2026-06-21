import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER, csrfValid } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * POST /api/skills/:id/send-to-me — "Send to my agent" (inbox-model pivot §5).
 * Cookie-auth + CSRF. The caller must be someone the skill was shared WITH.
 * Drops a self-addressed `agent.payload` (kind="skill") into the caller's own
 * inbox; their next bc-inbox-check picks it up and installs/handles the skill.
 *
 * Opaque by design: the skill's OWNER never gets a signal that the recipient
 * pulled it (opaqueness invariant). We audit it on the recipient's own log only.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!csrfValid(req.headers.get(CSRF_HEADER), req.cookies.get(CSRF_COOKIE_NAME)?.value)) return NextResponse.json({ error: "csrf" }, { status: 403 });

  const { id } = await params;
  // Must be a skill shared WITH me (not just any id) — otherwise 404 (no leak).
  const share = await prisma.skillShare.findUnique({
    where: { skillId_sharedWithAccountId: { skillId: id, sharedWithAccountId: account.id } },
    include: { skill: { include: { account: true } } },
  });
  if (!share) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await prisma.agentPayload.create({
    data: {
      accountId: account.id,
      kind: "skill",
      ref: {
        skillId: share.skill.id,
        name: share.skill.name,
        skillKind: share.skill.kind,
        ownerHandle: share.skill.account.handle,
      },
      note: `${share.skill.account.handle} shared the "${share.skill.name}" skill with you.`,
    },
  });
  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "skill.sent_to_self", detail: { skill: share.skill.name } } }).catch(() => {});

  return NextResponse.json({ queued: true });
}
