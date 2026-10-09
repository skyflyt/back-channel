/**
 * Quick add for Lists: "Renew Mimecast cert fri @claude-code".
 *
 * Pure module (no React, no clock): the caller passes `now` and the person's
 * agents. It reads words off the END of what was typed, so a word in the
 * middle of a title is never touched:
 *   - a due date: today, tomorrow, a weekday (monday or mon), or YYYY-MM-DD,
 *     optionally after "by" or "due";
 *   - who it's for: @me, @agents, or @<agent-name-slug> ("Claude Code" is
 *     @claude-code; a unique start like @claude works too).
 * The web app shows what was read as chips before saving, so nothing is
 * guessed silently, and either chip can be dismissed to keep the words in the
 * title. Anything that looks like a mention but doesn't match comes back as a
 * problem and stays in the title.
 *
 * Covered by quick-add.test.mjs (node --test).
 */

/**
 * @typedef {{ id: string, name: string, access?: string }} QuickAddAgent
 * @typedef {{ kind: "me" } | { kind: "my_agents" } | { kind: "agent", id: string, name: string }} QuickAddAssignee
 * @typedef {{ kind: "unknown_agent" | "ambiguous_agent" | "agent_no_access" | "bad_date", token: string, message: string }} QuickAddProblem
 * @typedef {{
 *   title: string,
 *   due: string | null,
 *   dueToken: string | null,
 *   assignee: QuickAddAssignee | null,
 *   assigneeToken: string | null,
 *   problems: QuickAddProblem[],
 * }} QuickAddResult
 */

const WEEKDAYS = [
  ["sunday", "sun"],
  ["monday", "mon"],
  ["tuesday", "tue", "tues"],
  ["wednesday", "wed"],
  ["thursday", "thu", "thur", "thurs"],
  ["friday", "fri"],
  ["saturday", "sat"],
];

const CONNECTORS = new Set(["by", "due"]);

/** "2026-10-09" from a Date, in the caller's local calendar. @param {Date} d */
export function ymdLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** @param {Date} d @param {number} days */
function addDays(d, days) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, 12);
}

/**
 * What a URL-safe mention of an agent name looks like: "Claude Code" is
 * "claude-code", "Skylar's Codex" is "skylars-codex".
 * @param {string} name
 */
export function agentSlug(name) {
  return String(name)
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const compact = (s) => s.replace(/-/g, "");

/**
 * A date word as "YYYY-MM-DD", null when the word isn't a date, or a problem
 * when it has the shape of a date but isn't a real one.
 * @param {string} word @param {Date} now
 * @returns {string | null | { bad: true }}
 */
export function readDateWord(word, now) {
  const w = word.toLowerCase();
  if (w === "today") return ymdLocal(addDays(now, 0));
  if (w === "tomorrow") return ymdLocal(addDays(now, 1));
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(w);
  if (iso) {
    const [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    const date = new Date(y, m - 1, d, 12);
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return { bad: true };
    return w;
  }
  const day = WEEKDAYS.findIndex((names) => names.includes(w));
  if (day < 0) return null;
  // The next one coming, never today: someone who means today says "today".
  const ahead = ((day - now.getDay() + 7) % 7) || 7;
  return ymdLocal(addDays(now, ahead));
}

/**
 * Who an @mention means.
 * @param {string} token the word, including the @
 * @param {QuickAddAgent[]} agents
 * @returns {{ assignee: QuickAddAssignee } | { problem: QuickAddProblem }}
 */
export function readMention(token, agents) {
  const raw = token.slice(1);
  const slug = agentSlug(raw);
  if (slug === "me") return { assignee: { kind: "me" } };
  if (slug === "agents" || slug === "my-agents") return { assignee: { kind: "my_agents" } };
  const want = compact(slug);
  const named = agents.map((a) => ({ agent: a, key: compact(agentSlug(a.name)) })).filter((x) => x.key);
  let hits = named.filter((x) => x.key === want);
  if (!hits.length && want.length >= 2) hits = named.filter((x) => x.key.startsWith(want));
  if (!hits.length) {
    return { problem: { kind: "unknown_agent", token, message: `None of your agents is called ${token}, so it stays in the title.` } };
  }
  if (hits.length > 1) {
    return { problem: { kind: "ambiguous_agent", token, message: `More than one of your agents matches ${token}. Type more of the name.` } };
  }
  const agent = hits[0].agent;
  if (agent.access !== undefined && agent.access !== "work") {
    return { problem: { kind: "agent_no_access", token, message: `${agent.name} can't work on this list yet. Give it access in the list's settings.` } };
  }
  return { assignee: { kind: "agent", id: agent.id, name: agent.name } };
}

/**
 * Read a quick-add line.
 * @param {string} text what was typed
 * @param {{ now: Date, agents?: QuickAddAgent[], skipDue?: boolean, skipAssignee?: boolean }} opts
 *   skipDue / skipAssignee: the person dismissed that chip, so keep those words in the title.
 * @returns {QuickAddResult}
 */
export function parseQuickAdd(text, { now, agents = [], skipDue = false, skipAssignee = false }) {
  const words = String(text ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  /** @type {QuickAddResult} */
  const out = { title: "", due: null, dueToken: null, assignee: null, assigneeToken: null, problems: [] };
  let end = words.length;
  while (end > 0) {
    const word = words[end - 1];
    if (word.startsWith("@") && word.length > 1) {
      if (skipAssignee || out.assignee) break;
      const read = readMention(word, agents);
      if ("problem" in read) {
        out.problems.push(read.problem);
        break;
      }
      out.assignee = read.assignee;
      out.assigneeToken = word;
      end -= 1;
      continue;
    }
    if (skipDue || out.due) break;
    const date = readDateWord(word, now);
    if (date === null) break;
    if (typeof date === "object") {
      out.problems.push({ kind: "bad_date", token: word, message: `${word} isn't a real date, so it stays in the title.` });
      break;
    }
    out.due = date;
    out.dueToken = word;
    end -= 1;
    // "pay rent by fri": the "by" belongs with the date, not the title.
    if (end > 1 && CONNECTORS.has(words[end - 1].toLowerCase())) {
      out.dueToken = `${words[end - 1]} ${word}`;
      end -= 1;
    }
  }
  out.title = words.slice(0, end).join(" ");
  return out;
}

/**
 * The assignee as the REST API takes it: "me", "my_agents" or an agent id.
 * @param {QuickAddAssignee | null} a
 * @returns {string | undefined}
 */
export function assigneeParam(a) {
  if (!a) return undefined;
  return a.kind === "agent" ? a.id : a.kind;
}
