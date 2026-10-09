/**
 * Lists templates (Phase 3, docs/lists.md): the starter lists everyone gets,
 * and the rules for a person's own saved templates. Pure module, covered by
 * `node --test`; src/lib/lists.ts does the I/O.
 *
 * A template is a name, an emoji and 1 to 200 items, each a title and notes.
 * Starting a list from one makes a new list whose tasks are those items, in
 * order, written by whoever started it. Nothing else carries over: no
 * assignees, claims, comments or history.
 *
 * Saving a list as a template keeps only the unfinished tasks the person (or
 * one of their agents) wrote. A friend's task is a request, not an instruction
 * (the OK rule), and a template has no author field, so copying a friend's
 * words into one would make them count as the person's own the next time a list
 * is started from it.
 */
import { ListRuleError, cleanText, LIMITS, ACTIVE } from "./rules.mjs";

export const TEMPLATE_LIMITS = Object.freeze({
  /** Items in one template, saved or built in. */
  items: 200,
  /** Saved templates per person. */
  perAccount: 50,
  /** Characters of titles and notes in one saved template, all items together. */
  totalChars: 100_000,
});

/** @typedef {{ title: string, notes: string }} TemplateItem */
/** @typedef {{ slug: string, name: string, emoji: string, items: TemplateItem[] }} BuiltinTemplate */

const item = (title, notes = "") => Object.freeze({ title, notes });

/** @type {readonly BuiltinTemplate[]} */
export const BUILTIN_TEMPLATES = Object.freeze([
  Object.freeze({
    slug: "trip-packing",
    name: "Trip packing",
    emoji: "🧳",
    items: Object.freeze([
      item("Passport or ID", "If you're crossing a border, check it's valid for six months past the day you fly home."),
      item("Tickets and bookings", "Save them offline too, in case there's no signal when you need them."),
      item("Phone, charger and a power bank"),
      item("Medications", "Enough for the trip plus two extra days. Keep them in your carry-on."),
      item("Clothes for each day, plus a spare set", "Check the weather the day before you pack."),
      item("Toiletries", "Liquids in a clear bag if you're flying."),
      item("Plug adapter", "Check which plug type your destination uses."),
      item("Cards and some cash"),
      item("Keys, and who has the spare"),
      item("Plants, mail and pets sorted while you're away"),
    ]),
  }),
  Object.freeze({
    slug: "new-hire-onboarding",
    name: "New hire onboarding",
    emoji: "👋",
    items: Object.freeze([
      item("Send the first-day plan", "Start time, where to go or which link to join, and who they'll meet first."),
      item("Order a laptop and accessories", "Order at least a week ahead."),
      item("Create accounts: email, chat and calendar"),
      item("Add them to the right groups, channels and meetings"),
      item("Pick an onboarding buddy"),
      item("Share the docs to read in week one"),
      item("Plan a first small task", "Something they can finish in their first few days."),
      item("First-week check-in"),
      item("30-day check-in", "What's going well, what's confusing, what they need."),
    ]),
  }),
  Object.freeze({
    slug: "move-out",
    name: "Move out",
    emoji: "📦",
    items: Object.freeze([
      item("Give notice to the landlord", "Check the lease for the notice period and how notice has to be sent."),
      item("Book movers or a van"),
      item("Get boxes, tape and markers"),
      item("Update your address", "Bank, employer, insurance, subscriptions, and mail forwarding."),
      item("Move or cancel utilities and internet", "Set the end date to the day after you leave."),
      item("Sell or donate what isn't coming"),
      item("Clean, then photograph every room", "The photos help if there's a question about the deposit."),
      item("Take final meter readings"),
      item("Return keys, fobs and parking passes"),
      item("Follow up on the deposit"),
    ]),
  }),
  Object.freeze({
    slug: "weekly-review",
    name: "Weekly review",
    emoji: "🗓️",
    items: Object.freeze([
      item("Clear your inboxes", "To zero, or to a short list of things that need a real answer."),
      item("Look back at last week's calendar", "Anything that needs a follow-up?"),
      item("Look ahead at next week's calendar", "Prepare what needs preparing. Decline what doesn't need you."),
      item("Go through your open tasks and lists", "Drop what no longer matters."),
      item("Note what you're waiting on from others"),
      item("Pick the three things that matter most next week"),
    ]),
  }),
]);

const BUILTIN_PREFIX = "builtin:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @param {number} status @param {string} code @param {string} message @returns {never} */
function fail(status, code, message) {
  throw new ListRuleError(status, code, message);
}

/** @param {string} slug */
export function builtinTemplate(slug) {
  return BUILTIN_TEMPLATES.find((t) => t.slug === slug) ?? null;
}

/**
 * What a `template` argument names: a built-in ("builtin:trip-packing"), a saved
 * template's id, or (for chat) a template's name, resolved by the caller.
 * @param {unknown} value
 * @returns {{ kind: "builtin", slug: string } | { kind: "saved", id: string } | { kind: "name", name: string }}
 */
export function parseTemplateRef(value) {
  if (typeof value !== "string" || !value.trim()) fail(400, "invalid_template", "template must be a template's id, \"builtin:<name>\", or a template's name.");
  const v = value.trim();
  if (v.toLowerCase().startsWith(BUILTIN_PREFIX)) {
    const slug = v.slice(BUILTIN_PREFIX.length).toLowerCase();
    if (!builtinTemplate(slug)) fail(404, "no_such_template", `There's no built-in template called "${slug}". ${builtinHint()}`);
    return { kind: "builtin", slug };
  }
  if (UUID.test(v)) return { kind: "saved", id: v };
  return { kind: "name", name: v.slice(0, 200) };
}

export const builtinHint = () => `Built-in templates: ${BUILTIN_TEMPLATES.map((t) => `builtin:${t.slug}`).join(", ")}.`;

/**
 * A template by name among the built-ins and a person's saved ones: the person's
 * own first (their "Trip packing" wins over the built-in), case-insensitive.
 * Returns null for no match; more than one saved template with the name is "ambiguous".
 * @param {string} name @param {Array<{ id: string, name: string }>} saved
 * @returns {{ kind: "builtin", slug: string } | { kind: "saved", id: string } | "ambiguous" | null}
 */
export function matchTemplateName(name, saved) {
  const want = name.trim().toLowerCase().replace(/\s+template$/, "");
  const mine = saved.filter((t) => t.name.toLowerCase() === want || t.name.toLowerCase() === name.trim().toLowerCase());
  if (mine.length > 1) return "ambiguous";
  if (mine.length === 1) return { kind: "saved", id: mine[0].id };
  const builtin = BUILTIN_TEMPLATES.find((t) => t.name.toLowerCase() === want || t.slug === want);
  return builtin ? { kind: "builtin", slug: builtin.slug } : null;
}

/**
 * Clean a template's items for saving or for making tasks: each a title (1 to
 * 200, one line) and notes (up to 20,000), secret-shaped text refused, 1 to 200
 * items, and at most TEMPLATE_LIMITS.totalChars characters in all.
 * @param {unknown} items
 * @returns {TemplateItem[]}
 */
export function cleanTemplateItems(items) {
  if (!Array.isArray(items)) fail(400, "invalid_template", "A template's items must be a list.");
  if (!items.length) fail(400, "empty_template", "There are no tasks to put in a template.");
  if (items.length > TEMPLATE_LIMITS.items) fail(400, "template_too_big", `A template holds up to ${TEMPLATE_LIMITS.items} tasks.`);
  let chars = 0;
  const out = items.map((raw) => {
    const it = raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : {};
    const title = /** @type {string} */ (cleanText(it.title, { field: "title", max: LIMITS.title, required: true, singleLine: true }));
    const notes = cleanText(it.notes, { field: "notes", max: LIMITS.notes }) ?? "";
    chars += [...title].length + [...notes].length;
    return { title, notes };
  });
  if (chars > TEMPLATE_LIMITS.totalChars) {
    fail(400, "template_too_big", `A template holds up to ${TEMPLATE_LIMITS.totalChars.toLocaleString("en-US")} characters of titles and notes. Shorten some notes first.`);
  }
  return out;
}

/**
 * The items to save from a list's tasks: unfinished tasks (open, in progress,
 * blocked or waiting for a check) in list order, only those this person or
 * their agents wrote. `skipped` counts the unfinished ones someone else wrote.
 * @param {any[]} tasks raw task rows @param {string} accountId
 * @returns {{ items: TemplateItem[], skipped: number }}
 */
export function itemsFromTasks(tasks, accountId) {
  const unfinished = tasks.filter((t) => ACTIVE.includes(t.status)).sort((a, b) => a.position - b.position);
  const mine = unfinished.filter((t) => t.createdByAccountId === accountId);
  return { items: mine.map((t) => ({ title: t.title, notes: t.notes ?? "" })), skipped: unfinished.length - mine.length };
}

/**
 * The tasks a duplicate gets: unfinished tasks in list order, title and notes
 * only. Each keeps who wrote it, so a friend's task stays a request on the copy.
 * @param {any[]} tasks raw task rows
 */
export function tasksToDuplicate(tasks) {
  return tasks
    .filter((t) => ACTIVE.includes(t.status))
    .sort((a, b) => a.position - b.position)
    .slice(0, LIMITS.openTasksPerList)
    .map((t) => ({ title: t.title, notes: t.notes ?? "", createdByAccountId: t.createdByAccountId, createdByAgentId: t.createdByAgentId ?? null }));
}

/** "Trip (copy)", kept within the 80-character name limit. @param {string} name */
export function copyName(name) {
  const suffix = " (copy)";
  const chars = [...String(name)];
  const room = LIMITS.listName - suffix.length;
  return (chars.length > room ? chars.slice(0, room).join("").trimEnd() : chars.join("")) + suffix;
}

const preview = (items) => items.slice(0, 5).map((i) => i.title);

/**
 * A template as the web app and agents see it. Built-ins have the id
 * "builtin:<slug>". `preview` is the first five titles.
 * @param {{ id?: string, slug?: string, name: string, emoji?: string | null, items: TemplateItem[], createdAt?: Date | string | null }} t
 */
export function templateView(t) {
  const items = Array.isArray(t.items) ? t.items : [];
  if (t.slug) return { id: `${BUILTIN_PREFIX}${t.slug}`, kind: "builtin", name: t.name, emoji: t.emoji ?? null, count: items.length, preview: preview(items) };
  return {
    id: t.id, kind: "saved", name: t.name, emoji: t.emoji ?? null, count: items.length, preview: preview(items),
    created_at: t.createdAt ? new Date(t.createdAt).toISOString() : null,
  };
}
