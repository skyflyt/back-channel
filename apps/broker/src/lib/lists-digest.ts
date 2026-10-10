/**
 * Lists daily digest (Phase 3, docs/lists.md): the run behind POST /api/lists/digest/run.
 *
 * Cloud Scheduler calls the route hourly with the shared secret. Each run walks
 * the people who turned the digest on (ListsPreference.digest = "daily"), in
 * batches and with a bound on how many it looks at and sends, and for each one
 * whose local hour has come and who hasn't had today's:
 *   1. claims today's digest with a conditional write on lastDigestAt, so two
 *      overlapping runs can't both send it (idempotent per account per local day);
 *   2. gathers what to say through lists.ts digestFor(), as that person, under
 *      the same rules as their plate;
 *   3. emails titles and counts with one link back to the Lists tab and a
 *      one-time sign-in (log-only without RESEND_API_KEY).
 * A quiet day sends nothing. A failure before sending puts the claim back so
 * the next run tries again; once an email has been handed to the sender it is
 * never retried (at most one a day beats a second copy).
 *
 * The route does the secret check (digestSecretValid below): constant time, and
 * everything is refused while LISTS_DIGEST_SECRET is unset.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
// Namespace imports: route tests replace these modules with a few named exports.
import * as auth from "@/lib/auth";
import * as email from "@/lib/email";
import { digestFor } from "@/lib/lists";
import * as D from "@/lib/lists/digest.mjs";

export const DIGEST_SECRET_HEADER = "x-lists-digest-secret";
/** A secret shorter than this is treated as unset: `openssl rand -base64 32` gives 44 characters. */
export const MIN_SECRET_LENGTH = 32;

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

/**
 * Does the header carry the shared secret? Both sides are hashed first, so the
 * comparison takes the same time whatever was sent, its length included.
 * False for everything while the secret is unset or too short.
 */
export function digestSecretValid(given: string | null | undefined, expected: string | undefined = process.env.LISTS_DIGEST_SECRET): boolean {
  if (!expected || expected.length < MIN_SECRET_LENGTH) return false;
  if (typeof given !== "string" || !given) return false;
  return timingSafeEqual(sha256(given), sha256(expected));
}

export type DigestLimits = { batch: number; maxScan: number; maxSends: number };
/** Per run: read preferences 100 at a time, look at up to 2,000, and handle up to 200 that are due. */
export const DIGEST_LIMITS: DigestLimits = { batch: 100, maxScan: 2_000, maxSends: 200 };

export type DigestRun = {
  /** Preferences looked at. */
  checked: number;
  /** Due now and handled this run. */
  due: number;
  sent: number;
  /** Handed to the sender but not delivered (log-only without RESEND_API_KEY, or the provider refused). */
  not_sent: number;
  /** Nothing to say today: no email, and today counts as done. */
  empty: number;
  /** Another run claimed it first, or there's no verified email. */
  skipped: number;
  /** Something broke before sending; the claim was put back for the next run. */
  failed: number;
  /** The run stopped at a bound; the next run carries on. */
  more: boolean;
};

const appUrl = () => process.env.PUBLIC_APP_URL ?? "https://back-channel.app";

type Pref = { accountId: string; digest: string; digestHour: number; timezone: string | null; lastDigestAt: Date | null };

async function digestOne(pref: Pref, now: Date): Promise<"sent" | "not_sent" | "empty" | "skipped" | "failed"> {
  // Claim today's digest: only the run whose write still sees the value it read gets it.
  const claimed = await prisma.listsPreference.updateMany({
    where: { accountId: pref.accountId, digest: "daily", lastDigestAt: pref.lastDigestAt ?? null },
    data: { lastDigestAt: now },
  });
  if (claimed.count !== 1) return "skipped";
  let handedOver = false;
  try {
    const account = await prisma.account.findFirst({ where: { id: pref.accountId }, select: { handle: true, email: true, emailVerifiedAt: true } });
    if (!account?.email || !account.emailVerifiedAt) return "skipped";
    const data = await digestFor(pref.accountId, { since: D.digestSince(pref.lastDigestAt, now), overdueBefore: D.overdueBefore(now, pref.timezone) });
    const content = D.digestContent(data);
    if (!content) return "empty";
    const raw = auth.generateViewToken();
    await prisma.viewToken.create({ data: { token: auth.hashToken(raw), accountId: pref.accountId, purpose: "account", expiresAt: auth.viewTokenExpiry() } });
    handedOver = true;
    const ok = await email.sendListDigestEmail({
      to: account.email, handle: account.handle, subject: content.subject, sections: content.sections,
      url: `${appUrl()}/account?vt=${encodeURIComponent(raw)}&tab=lists`,
    });
    return ok ? "sent" : "not_sent";
  } catch (e) {
    // Never log list content or tokens: the error's name only.
    console.error("[lists-digest] one digest failed:", e instanceof Error ? e.name : typeof e);
    if (handedOver) return "not_sent";
    await prisma.listsPreference
      .updateMany({ where: { accountId: pref.accountId, lastDigestAt: now }, data: { lastDigestAt: pref.lastDigestAt ?? null } })
      .catch(() => {});
    return "failed";
  }
}

/**
 * One run: every person whose digest is due now gets it, up to the limits. Safe to call as often as
 * you like; a person gets at most one a local day and never two within 12 hours.
 */
export async function runListsDigest(now: Date = new Date(), limits: DigestLimits = DIGEST_LIMITS): Promise<DigestRun> {
  const out: DigestRun = { checked: 0, due: 0, sent: 0, not_sent: 0, empty: 0, skipped: 0, failed: 0, more: false };
  // Nobody who had one in the last 12 hours can be due, so they're not even read.
  const quiet = new Date(now.getTime() - D.MIN_GAP_MS);
  let cursor: string | null = null;
  for (;;) {
    const batch = (await prisma.listsPreference.findMany({
      where: { digest: "daily", ...(cursor ? { accountId: { gt: cursor } } : {}), OR: [{ lastDigestAt: null }, { lastDigestAt: { lte: quiet } }] },
      orderBy: { accountId: "asc" },
      take: limits.batch,
    })) as Pref[];
    for (const pref of batch) {
      cursor = pref.accountId;
      out.checked++;
      if (!D.digestDue(pref, now)) continue;
      if (out.due >= limits.maxSends) {
        out.more = true;
        return out;
      }
      out.due++;
      out[await digestOne(pref, now)]++;
    }
    if (batch.length < limits.batch) return out;
    if (out.checked >= limits.maxScan) {
      out.more = true;
      return out;
    }
  }
}
