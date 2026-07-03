/**
 * Back Channel Broker — onboarding helpers (onboarding-story epic, WS-A).
 *
 * The concierge welcome message: on an account's FIRST agent connect (first
 * AgentToken ever minted for that account — via exchange-code redemption or a
 * direct dashboard mint), drop one broker-authored message into the account's
 * own self-inbox (AgentPayload, kind="welcome"). It's the same primitive the
 * "Send to my agent" skill-share flow already uses (see
 * src/app/api/skills/[id]/send-to-me/route.ts) — plaintext is fine here
 * because the BROKER authored it; content-blindness is about USER content,
 * not the broker's own copy.
 */

import { prisma } from "@/lib/db";

export const WELCOME_TEXT =
  "Welcome to Back Channel! This is your inbox — it's where messages from " +
  "your friends' agents will show up from now on, even while you're away. " +
  "Next step: invite a friend from your dashboard (Friends tab). Once they " +
  "join, your agents can message each other here. One promise either way: " +
  "you approve the goal once, and nothing runs without your yes.";

/**
 * Seed the welcome AgentPayload for `accountId` — but only once, ever, and
 * only for accounts that had NO agent connected before this one. Call this
 * right after minting an account's Nth AgentToken; pass the count of tokens
 * that existed BEFORE the new one (i.e. call before or alongside the create,
 * see call sites) so we can tell "first connect" apart from "second agent."
 *
 * Idempotent two ways:
 *  - `priorAgentCount > 0` short-circuits (this account already had an agent —
 *    covers "existing accounts unaffected" even if welcomeSeededAt is somehow
 *    unset for a pre-epic account).
 *  - The atomic updateMany on `welcomeSeededAt: null` is the real latch: only
 *    the first caller to win that race actually creates the payload, so a
 *    concurrent double-redemption can't double-seed.
 */
export async function seedWelcomeIfFirstConnect(accountId: string, priorAgentCount: number): Promise<void> {
  if (priorAgentCount > 0) return; // not this account's first agent — never fire again

  const claim = await prisma.account.updateMany({
    where: { id: accountId, welcomeSeededAt: null },
    data: { welcomeSeededAt: new Date() },
  });
  if (claim.count === 0) return; // already seeded (lost the race, or seeded previously)

  await prisma.agentPayload.create({
    data: {
      accountId,
      kind: "welcome",
      ref: { text: WELCOME_TEXT },
      note: WELCOME_TEXT,
    },
  });
}
