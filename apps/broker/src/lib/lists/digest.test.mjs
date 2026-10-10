import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validTimezone, localParts, digestDue, digestSince, overdueBefore, cleanPreference, preferenceView, digestContent, enableAnchor,
  MIN_GAP_MS, MAX_LOOKBACK_MS, DEFAULT_DIGEST_HOUR, TITLES_PER_SECTION,
} from "./digest.mjs";
import { ListRuleError } from "./rules.mjs";

const at = (iso) => new Date(iso);
const HOUR = 60 * 60_000;
const refusal = (fn, code) => assert.throws(fn, (e) => e instanceof ListRuleError && e.status === 400 && e.code === code);

test("validTimezone knows IANA names and refuses the rest", () => {
  assert.equal(validTimezone("America/Denver"), true);
  assert.equal(validTimezone("UTC"), true);
  assert.equal(validTimezone("Mars/Olympus"), false);
  assert.equal(validTimezone(""), false);
  assert.equal(validTimezone(null), false);
  assert.equal(validTimezone("x".repeat(65)), false);
});

test("localParts gives the person's own day and hour; an unknown zone reads as UTC", () => {
  const t = at("2026-10-09T05:30:00Z");
  assert.deepEqual(localParts(t, "UTC"), { day: "2026-10-09", hour: 5 });
  assert.deepEqual(localParts(t, "America/Denver"), { day: "2026-10-08", hour: 23 }, "MDT is UTC-6");
  assert.deepEqual(localParts(t, "Asia/Tokyo"), { day: "2026-10-09", hour: 14 });
  assert.deepEqual(localParts(t, "Nowhere/Special"), { day: "2026-10-09", hour: 5 });
  assert.deepEqual(localParts(at("2026-10-09T00:10:00Z"), null), { day: "2026-10-09", hour: 0 }, "midnight is hour 0, never 24");
});

test("digestDue: off is never due; daily is due at or after the hour, once per local day", () => {
  const pref = { digest: "daily", digestHour: 8, timezone: "America/Denver", lastDigestAt: null };
  assert.equal(digestDue({ ...pref, digest: "off" }, at("2026-10-09T15:00:00Z")), false);
  assert.equal(digestDue(pref, at("2026-10-09T13:59:00Z")), false, "07:59 in Denver");
  assert.equal(digestDue(pref, at("2026-10-09T14:00:00Z")), true, "08:00 in Denver");
  assert.equal(digestDue(pref, at("2026-10-10T03:00:00Z")), true, "21:00 the same day still counts (a missed run catches up)");
  const sent = { ...pref, lastDigestAt: at("2026-10-09T14:05:00Z") };
  assert.equal(digestDue(sent, at("2026-10-09T15:05:00Z")), false, "already had today's");
  assert.equal(digestDue(sent, at("2026-10-10T05:59:00Z")), false, "23:59 local: still the same day");
  assert.equal(digestDue(sent, at("2026-10-10T13:59:00Z")), false, "the next day, before the hour");
  assert.equal(digestDue(sent, at("2026-10-10T14:00:00Z")), true, "the next day, at the hour");
});

test("digestDue: never twice within twelve hours, even when the timezone or hour changes", () => {
  const last = at("2026-10-09T14:00:00Z");
  // Moving from Denver to Tokyo makes it "tomorrow" there at once; the gap still holds it back.
  const moved = { digest: "daily", digestHour: 0, timezone: "Asia/Tokyo", lastDigestAt: last };
  assert.equal(digestDue(moved, at("2026-10-09T16:00:00Z")), false);
  assert.equal(digestDue(moved, new Date(last.getTime() + MIN_GAP_MS)), true);
  assert.equal(digestDue({ ...moved, lastDigestAt: last.toISOString() }, new Date(last.getTime() + MIN_GAP_MS - 1)), false, "ISO strings work too");
});

test("enableAnchor: turned on after today's hour, the first digest waits for that hour tomorrow", () => {
  const now = at("2026-10-10T05:12:34.500Z"); // 23:12:34 on the 9th in Denver
  const anchor = enableAnchor(now, "America/Denver", 8);
  assert.equal(anchor.toISOString(), "2026-10-09T14:00:00.000Z", "08:00 today, Denver time");
  const pref = { digest: "daily", digestHour: 8, timezone: "America/Denver", lastDigestAt: anchor };
  assert.equal(digestDue(pref, at("2026-10-10T06:00:00Z")), false, "not tonight");
  assert.equal(digestDue(pref, at("2026-10-10T14:00:00Z")), true, "08:00 tomorrow");
  assert.equal(enableAnchor(at("2026-10-09T13:00:00Z"), "America/Denver", 8), null, "07:00 there: today's is still to come");
  assert.equal(enableAnchor(at("2026-10-09T09:30:00Z"), "Asia/Kolkata", 15).toISOString(), "2026-10-09T09:30:00.000Z", "half-hour zones: 15:00 IST is 09:30 UTC");
});

test("digestSince: the last digest, a day for the first one, never more than a week back", () => {
  const now = at("2026-10-09T14:00:00Z");
  assert.equal(digestSince(null, now).getTime(), now.getTime() - 24 * HOUR);
  assert.equal(digestSince(at("2026-10-08T14:00:00Z"), now).toISOString(), "2026-10-08T14:00:00.000Z");
  assert.equal(digestSince(at("2026-01-01T00:00:00Z"), now).getTime(), now.getTime() - MAX_LOOKBACK_MS);
});

test("overdueBefore: today's local date at 00:00 UTC, matching due dates stored at noon UTC", () => {
  assert.equal(overdueBefore(at("2026-10-09T05:30:00Z"), "America/Denver").toISOString(), "2026-10-08T00:00:00.000Z");
  assert.equal(overdueBefore(at("2026-10-09T05:30:00Z"), "UTC").toISOString(), "2026-10-09T00:00:00.000Z");
  // A task due 2026-10-08 is stored at 12:00 UTC: overdue in UTC on the 9th, not yet in Denver (still the 8th there).
  const due = at("2026-10-08T12:00:00Z");
  assert.ok(due < overdueBefore(at("2026-10-09T05:30:00Z"), "UTC"));
  assert.ok(!(due < overdueBefore(at("2026-10-09T05:30:00Z"), "America/Denver")));
});

test("cleanPreference validates each field and refuses an empty change", () => {
  assert.deepEqual(cleanPreference({ digest: "daily", digest_hour: 7, timezone: "Europe/London" }), { digest: "daily", digestHour: 7, timezone: "Europe/London" });
  assert.deepEqual(cleanPreference({ timezone: "" }), { timezone: null });
  assert.deepEqual(cleanPreference({ digest: "off" }), { digest: "off" });
  refusal(() => cleanPreference({ digest: "weekly" }), "invalid_digest");
  refusal(() => cleanPreference({ digest_hour: 24 }), "invalid_digest_hour");
  refusal(() => cleanPreference({ digest_hour: 7.5 }), "invalid_digest_hour");
  refusal(() => cleanPreference({ digest_hour: "8" }), "invalid_digest_hour");
  refusal(() => cleanPreference({ timezone: "Mars/Olympus" }), "invalid_timezone");
  refusal(() => cleanPreference({}), "nothing_to_change");
});

test("preferenceView: off at 08:00 by default", () => {
  assert.deepEqual(preferenceView(null, { emailReady: true }), { digest: "off", digest_hour: DEFAULT_DIGEST_HOUR, timezone: null, last_digest_at: null, email_ready: true });
  assert.deepEqual(preferenceView({ digest: "daily", digestHour: 6, timezone: "UTC", lastDigestAt: at("2026-10-09T06:00:00Z") }, { emailReady: false }), {
    digest: "daily", digest_hour: 6, timezone: "UTC", last_digest_at: "2026-10-09T06:00:00.000Z", email_ready: false,
  });
});

test("digestContent: titles and counts only, up to five titles a section, nothing at all on a quiet day", () => {
  assert.equal(digestContent({ finished: [], finishedCount: 0, needsYou: [], needsYouCount: 0, overdue: [], overdueCount: 0 }), null);
  const many = Array.from({ length: 7 }, (_, i) => ({ title: `Task ${i + 1}`, list: "Work" }));
  const c = digestContent({ finished: many, finishedCount: 7, needsYou: [{ title: "Check the cert", list: "Work" }], needsYouCount: 1, overdue: [], overdueCount: 0 });
  assert.equal(c.subject, "Your lists today: 7 finished, 1 for you");
  assert.deepEqual(c.sections.map((s) => s.heading), ["Your agents finished 7 tasks", "1 task needs your look or OK"]);
  assert.equal(c.sections[0].lines.length, TITLES_PER_SECTION + 1);
  assert.equal(c.sections[0].lines[0], "Task 1 (Work)");
  assert.equal(c.sections[0].lines.at(-1), "and 2 more");
  const o = digestContent({ finished: [], finishedCount: 0, needsYou: [], needsYouCount: 0, overdue: [{ title: "Renew", list: "House" }], overdueCount: 1 });
  assert.deepEqual(o.sections, [{ heading: "1 task is overdue", lines: ["Renew (House)"] }]);
});
