/**
 * Lists daily digest (Phase 3, docs/lists.md): when one is due, and what it
 * says. Pure module, covered by `node --test`; nothing here reads the clock
 * (callers pass `now`). The I/O is in src/lib/lists-digest.ts, run by
 * POST /api/lists/digest/run.
 *
 * The digest is opt-in and off by default. A person picks the hour, in their
 * own timezone; the run (Cloud Scheduler, hourly) sends it at the first run at
 * or after that hour, at most once per local day, and never twice within
 * MIN_GAP_MS. A day with nothing to say sends nothing.
 *
 * What it says: titles and counts only. What the person's agents finished since
 * the last digest, what needs their look or OK, and what's overdue, each with
 * up to TITLES_PER_SECTION titles, plus one link back to the Lists tab.
 */
import { ListRuleError } from "./rules.mjs";

export const DIGEST = Object.freeze(["off", "daily"]);
export const DEFAULT_DIGEST_HOUR = 8;
/** Never two digests closer together than this, whatever the timezone or hour does. */
export const MIN_GAP_MS = 12 * 60 * 60_000;
/** "Since the last digest" never reaches back further than this. */
export const MAX_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
export const TITLES_PER_SECTION = 5;

/** @param {number} status @param {string} code @param {string} message @returns {never} */
function fail(status, code, message) {
  throw new ListRuleError(status, code, message);
}

/** Is this an IANA timezone this runtime knows? @param {unknown} tz */
export function validTimezone(tz) {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The calendar day ("2026-10-09") and hour (0 to 23) at `date` in `tz` (UTC when unknown).
 * @param {Date} date @param {string | null | undefined} tz
 */
export function localParts(date, tz) {
  const zone = validTimezone(tz) ? /** @type {string} */ (tz) : "UTC";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
}

/**
 * Should this person get a digest now? Daily, at or after their hour on a local
 * day they haven't had one, and at least MIN_GAP_MS after the last one.
 * @param {{ digest: string, digestHour: number, timezone?: string | null, lastDigestAt?: Date | string | null }} pref
 * @param {Date} now
 */
export function digestDue(pref, now) {
  if (!pref || pref.digest !== "daily") return false;
  const here = localParts(now, pref.timezone);
  if (here.hour < pref.digestHour) return false;
  if (!pref.lastDigestAt) return true;
  const last = new Date(pref.lastDigestAt);
  if (now.getTime() - last.getTime() < MIN_GAP_MS) return false;
  return localParts(last, pref.timezone).day !== here.day;
}

/**
 * Turning the digest on after today's hour has passed shouldn't send one at the
 * next run: the first one comes at the chosen hour tomorrow. This is the
 * instant to record as the last digest so that happens: today's digest hour,
 * local time. null when the hour hasn't come yet today (the first one comes
 * today, at the hour).
 * @param {Date} now @param {string | null | undefined} tz @param {number} digestHour
 */
export function enableAnchor(now, tz, digestHour) {
  const zone = validTimezone(tz) ? /** @type {string} */ (tz) : "UTC";
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((x) => [x.type, Number(x.value)]),
  );
  const hour = p.hour % 24;
  if (hour < digestHour) return null;
  const sinceHour = ((hour - digestHour) * 3600 + p.minute * 60 + p.second) * 1000 + now.getUTCMilliseconds();
  return new Date(now.getTime() - sinceHour);
}

/**
 * Where "since the last digest" starts: the last digest, or a day ago for the
 * first one, never more than MAX_LOOKBACK_MS back.
 * @param {Date | string | null | undefined} lastDigestAt @param {Date} now
 */
export function digestSince(lastDigestAt, now) {
  const floor = now.getTime() - MAX_LOOKBACK_MS;
  const from = lastDigestAt ? new Date(lastDigestAt).getTime() : now.getTime() - 24 * 60 * 60_000;
  return new Date(Math.max(floor, from));
}

/**
 * A task is overdue when its due day is before today where the person is. Due
 * dates are stored at 12:00 UTC, so a task's day is its UTC date (the same
 * rule the web app uses); this is the instant before which a due date is
 * overdue: today's local date at 00:00 UTC.
 * @param {Date} now @param {string | null | undefined} tz
 */
export function overdueBefore(now, tz) {
  return new Date(`${localParts(now, tz).day}T00:00:00.000Z`);
}

/**
 * Clean a PATCH to the preference. Each field is optional; unknown values are refused.
 * @param {Record<string, unknown>} input
 * @returns {{ digest?: string, digestHour?: number, timezone?: string | null }}
 */
export function cleanPreference(input) {
  /** @type {{ digest?: string, digestHour?: number, timezone?: string | null }} */
  const out = {};
  if (input.digest !== undefined) {
    if (!DIGEST.includes(/** @type {string} */ (input.digest))) fail(400, "invalid_digest", "digest must be off or daily");
    out.digest = /** @type {string} */ (input.digest);
  }
  if (input.digest_hour !== undefined) {
    const h = input.digest_hour;
    if (typeof h !== "number" || !Number.isInteger(h) || h < 0 || h > 23) fail(400, "invalid_digest_hour", "digest_hour must be a whole hour from 0 to 23");
    out.digestHour = /** @type {number} */ (h);
  }
  if (input.timezone !== undefined) {
    if (input.timezone === null || input.timezone === "") out.timezone = null;
    else if (!validTimezone(input.timezone)) fail(400, "invalid_timezone", "timezone must be a name like America/Denver");
    else out.timezone = /** @type {string} */ (input.timezone);
  }
  if (!Object.keys(out).length) fail(400, "nothing_to_change", "Pass digest, digest_hour or timezone.");
  return out;
}

/** The preference as the web app sees it. @param {any} row @param {{ emailReady: boolean }} extra */
export function preferenceView(row, { emailReady }) {
  return {
    digest: row?.digest ?? "off",
    digest_hour: row?.digestHour ?? DEFAULT_DIGEST_HOUR,
    timezone: row?.timezone ?? null,
    last_digest_at: row?.lastDigestAt ? new Date(row.lastDigestAt).toISOString() : null,
    email_ready: emailReady,
  };
}

/**
 * @typedef {{ title: string, list: string }} DigestTask
 * @typedef {{ finished: DigestTask[], finishedCount: number, needsYou: DigestTask[], needsYouCount: number, overdue: DigestTask[], overdueCount: number }} DigestData
 */

/** @param {number} n @param {string} one @param {string} many */
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** One section: a heading with its count, then up to TITLES_PER_SECTION titles and "and N more". @param {string} heading @param {DigestTask[]} tasks @param {number} total */
function section(heading, tasks, total) {
  const shown = tasks.slice(0, TITLES_PER_SECTION);
  const lines = shown.map((t) => `${t.title} (${t.list})`);
  if (total > shown.length) lines.push(`and ${total - shown.length} more`);
  return { heading, lines };
}

/**
 * The digest's words, or null when there's nothing to say. Titles and counts
 * only: no notes, comments, progress or summaries.
 * @param {DigestData} d
 */
export function digestContent(d) {
  const sections = [];
  if (d.finishedCount) sections.push(section(`Your agents finished ${count(d.finishedCount, "task", "tasks")}`, d.finished, d.finishedCount));
  if (d.needsYouCount) sections.push(section(`${count(d.needsYouCount, "task needs", "tasks need")} your look or OK`, d.needsYou, d.needsYouCount));
  if (d.overdueCount) sections.push(section(`${count(d.overdueCount, "task is", "tasks are")} overdue`, d.overdue, d.overdueCount));
  if (!sections.length) return null;
  const parts = [];
  if (d.finishedCount) parts.push(`${d.finishedCount} finished`);
  if (d.needsYouCount) parts.push(`${d.needsYouCount} for you`);
  if (d.overdueCount) parts.push(`${d.overdueCount} overdue`);
  return { subject: `Your lists today: ${parts.join(", ")}`, sections };
}
