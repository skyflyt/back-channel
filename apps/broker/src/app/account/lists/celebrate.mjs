/**
 * The small "All done" moment (Phase 3, docs/lists.md §8): when the last
 * unfinished task on the open list is finished, the list's header says so for
 * a few seconds, with who finished what this week. Computed from the list the
 * page already has; no request, no confetti. Pure, so `node --test` covers it.
 *
 * @typedef {{ person: string, handle: string | null, agent: string | null, is_you: boolean }} PersonRef
 * @typedef {{ status: string, completed_by?: PersonRef | null }} TaskLike
 */

const UNFINISHED = new Set(["open", "in_progress", "blocked", "needs_review"]);

/** How many tasks still need something from someone. @param {TaskLike[]} tasks */
export function unfinishedCount(tasks) {
  return tasks.filter((t) => UNFINISHED.has(t.status)).length;
}

/** "Claude Code", "A and B", "A, B and C". @param {string[]} names */
export function joinNames(names) {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

const shortName = (/** @type {PersonRef | null | undefined} */ ref) => (ref ? ref.person.replace(/@bc$/, "") : "someone");

/**
 * Who finished what, people before their agents: "You finished 2 and your
 * agents finished 3", "Alex finished 4, you finished 1 and Alex's agents finished 6".
 * @param {TaskLike[]} done finished tasks
 */
export function tally(done) {
  /** @type {Map<string, { label: string, n: number, you: boolean, agents: boolean }>} */
  const groups = new Map();
  for (const t of done) {
    const by = t.completed_by;
    const agents = !!by?.agent;
    const key = `${by?.handle ?? by?.person ?? "?"}|${agents ? 1 : 0}`;
    const label = by?.is_you ? (agents ? "your agents" : "you") : agents ? `${shortName(by)}'s agents` : shortName(by);
    const g = groups.get(key) ?? { label, n: 0, you: !!by?.is_you, agents };
    g.n += 1;
    groups.set(key, g);
  }
  const parts = [...groups.values()]
    .sort((a, b) => Number(a.agents) - Number(b.agents) || Number(b.you) - Number(a.you) || b.n - a.n)
    .map((g) => `${g.label} finished ${g.n}`);
  const text = joinNames(parts);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The line to show when the open list was just emptied, or null. Only for the
 * same list going from some unfinished tasks to none (not on first load, not
 * when switching lists), and only when something was finished this week.
 * @param {{ listId: string, unfinished: number } | null} before what the page showed last
 * @param {{ listId: string, unfinished: number, done: TaskLike[] }} now
 */
export function celebration(before, now) {
  if (!before || before.listId !== now.listId) return null;
  if (before.unfinished === 0 || now.unfinished !== 0 || !now.done.length) return null;
  return `All done. ${tally(now.done)}.`;
}

/** How long the line stays up. */
export const CELEBRATE_MS = 8_000;
