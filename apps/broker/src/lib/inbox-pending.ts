import { prisma } from "@/lib/db";
import { sessionUnread } from "@/lib/relay";
import { setPendingCounter, type InboxKind } from "@/lib/inbox-bus";

/**
 * Content-blind pending count for the inbox doorbell (design spec S4.3): sum
 * of unread CONTENT frames across the account's live sessions + undelivered
 * agent.payload rows + pending, non-expired inbox requests. No frame bodies
 * are read - sessionUnread already separates content_unread_count (real
 * messages) from protocol-noise unread_count (handshake/control frames).
 *
 * Shared by both /api/inbox/events and /api/inbox/check so there is exactly
 * ONE definition of "pending" for the doorbell (registered with inbox-bus at
 * import time via setPendingCounter - importing this module is what wires it
 * up; both routes import it for that side effect).
 */
async function pendingCount(accountId: string): Promise<{ count: number; kinds: InboxKind[] }> {
  const sessions = await prisma.session.findMany({
    where: {
      endedAt: null,
      invite: {
        expiresAt: { gt: new Date() },
        OR: [{ hostAccountId: accountId }, { visitorAccountId: accountId }],
      },
    },
    include: { invite: true },
  });

  let frameCount = 0;
  for (const s of sessions) {
    const role = s.invite.visitorAccountId === accountId ? "visitor" : "host";
    const u = await sessionUnread(s.id, role, s, { includeFrames: false });
    frameCount += u.content_unread_count;
  }

  const [payloadCount, inviteCount] = await Promise.all([
    prisma.agentPayload.count({ where: { accountId, deliveredAt: null } }),
    prisma.inboxRequest.count({ where: { recipientAccountId: accountId, status: "pending", expiresAt: { gt: new Date() } } }),
  ]);

  const kinds: InboxKind[] = [];
  if (frameCount > 0) kinds.push("frame");
  if (payloadCount > 0) kinds.push("payload");
  if (inviteCount > 0) kinds.push("invite");

  return { count: frameCount + payloadCount + inviteCount, kinds };
}

setPendingCounter(pendingCount);

// Re-exported for tests that want to call the counter directly without
// spinning up a request.
export { pendingCount };