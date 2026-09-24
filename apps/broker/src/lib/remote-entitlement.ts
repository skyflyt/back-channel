/**
 * Who may use Back Channel Remote through the relay: the one place that decides it.
 * Spec: docs/remote-paid-tier.md.
 *
 * An account is entitled to `appbridge.remote_access` when EITHER
 *   - an admin grant is active (AppBridgeEntitlement.active — the owner's own accounts and comps), OR
 *   - it has a Remote subscription in an entitling state (RemoteSubscription, mirrored from
 *     signature-verified Stripe webhooks).
 *
 * Nothing is copied between the two. The admin row is written only by the admin route and the
 * subscription row only by the Stripe webhook, and the answer is computed from both at read time,
 * inside the caller's transaction (the relay gate's serializable one). So there is no third,
 * derived "entitled" flag that could disagree with either source, and the time-based rules below
 * (period end, past_due grace) take effect on their own, even if a webhook never arrives.
 */
import type { Prisma, RemoteSubscription } from "@prisma/client";

export const REMOTE_ACCESS_FEATURE = "appbridge.remote_access";

/**
 * past_due keeps access for 3 days from the first failed payment we saw (Stripe keeps retrying
 * the card meanwhile). After that the account is refused until the invoice is paid and the
 * subscription is active again.
 */
export const PAST_DUE_GRACE_MS = 3 * 86_400_000;

/**
 * A subscription stops entitling 3 days after the end of the period we last heard about, whatever
 * its status says. A renewal moves the period end forward (customer.subscription.updated), and
 * Stripe retries a webhook for up to 3 days, so this only bites when Stripe has gone silent: it is
 * the backstop that stops a missed cancellation from granting access for ever.
 */
export const PERIOD_END_SLACK_MS = 3 * 86_400_000;

export type RemoteAccessSource = "admin" | "subscription";
type Reader = Pick<Prisma.TransactionClient, "appBridgeEntitlement" | "remoteSubscription">;

/** Does this subscription row grant Remote right now? */
export function subscriptionEntitles(s: Pick<RemoteSubscription, "status" | "currentPeriodEnd" | "pastDueSince">, now = new Date()): boolean {
  const t = now.getTime();
  if (!(s.currentPeriodEnd instanceof Date) || s.currentPeriodEnd.getTime() + PERIOD_END_SLACK_MS <= t) return false;
  if (s.status === "active" || s.status === "trialing") return true;
  if (s.status === "past_due") return s.pastDueSince instanceof Date && s.pastDueSince.getTime() + PAST_DUE_GRACE_MS > t;
  return false; // canceled, unpaid, incomplete, incomplete_expired, paused, anything new
}

/** The account's subscriptions (at most a handful), newest first. */
export async function remoteSubscriptions(db: Pick<Prisma.TransactionClient, "remoteSubscription">, accountId: string): Promise<RemoteSubscription[]> {
  const rows = await db.remoteSubscription.findMany({ where: { accountId }, take: 20 });
  return rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/** Why this account may use the relay, or null. Read fresh; pass the caller's transaction. */
export async function remoteAccessSource(db: Reader, accountId: string, now = new Date()): Promise<RemoteAccessSource | null> {
  const grant = await db.appBridgeEntitlement.findUnique({ where: { accountId_feature: { accountId, feature: REMOTE_ACCESS_FEATURE } } });
  if (grant?.active) return "admin";
  const subs = await remoteSubscriptions(db, accountId);
  return subs.some(s => subscriptionEntitles(s, now)) ? "subscription" : null;
}
