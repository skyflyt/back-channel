/**
 * How often agents check the Inbox (Settings → Agents & Inbox → Inbox checks), and how that interval is
 * scheduled on the agent's machine.
 *
 * Only intervals that divide the day evenly are offered and stored, so every check is the same distance
 * from the last one, and every value has a schedule that cron and Windows Task Scheduler both run exactly:
 *   - under an hour: minutes that divide 60   → cron `*\/N * * * *`, schtasks `/sc minute /mo N`
 *   - 1 to 12 hours: hours that divide 24      → cron `0 *\/H * * *`, schtasks `/sc hourly /mo H`
 *   - once a day: 9 a.m. on the agent's machine → cron `0 9 * * *`,  schtasks `/sc daily /st 09:00`
 * (`*\/45` in cron runs at :00 and :45, 45 then 15 minutes apart, and `*\/N` can't express N over 59: that
 * is why other values are snapped rather than stored.)
 *
 * The schedule strings are handed to agents in `GET /api/sessions/active` → `inbox_check`, so the skill
 * (SKILL.md § bc-inbox-check, REFERENCE.md § Recipes) copies them instead of working them out.
 */

export const CHECK_INTERVALS = [5, 6, 10, 12, 15, 20, 30, 60, 120, 180, 240, 360, 480, 720, 1440] as const;
export const CHECK_DEFAULT = 10;

/** The nearest offered interval; a tie goes to the longer one (fewer checks, less of the plan). */
export function snapCheckMinutes(m: number): number {
  let best: number = CHECK_INTERVALS[0];
  for (const v of CHECK_INTERVALS) if (Math.abs(v - m) <= Math.abs(best - m)) best = v;
  return best;
}

export type CheckSchedule = { minutes: number; cron: string; schtasks: string };

/** The schedule for an interval (snapped first, so a legacy stored value still gets a correct one). */
export function checkSchedule(stored: number): CheckSchedule {
  const minutes = snapCheckMinutes(stored);
  if (minutes < 60) return { minutes, cron: `*/${minutes} * * * *`, schtasks: `/sc minute /mo ${minutes}` };
  if (minutes < 1440) {
    const h = minutes / 60;
    return { minutes, cron: h === 1 ? "0 * * * *" : `0 */${h} * * *`, schtasks: `/sc hourly /mo ${h}` };
  }
  return { minutes, cron: "0 9 * * *", schtasks: "/sc daily /st 09:00" };
}

export function checkLabel(n: number): string {
  if (n === 1440) return "Once a day";
  if (n % 60 === 0) return n === 60 ? "Every hour" : `Every ${n / 60} hours`;
  return `Every ${n} min`;
}
