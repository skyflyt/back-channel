/**
 * Quick add for Lists: "Renew Mimecast cert fri @claude-code".
 *
 * Pure module (no React, no clock): the caller passes `now`, the person's
 * agents and, on a shared list, the people on it. It reads words off the END
 * of what was typed, so a word in the middle of a title is never touched:
 *   - a due date: today, tomorrow, a weekday (monday or mon), or YYYY-MM-DD,
 *     optionally after "by" or "due";
 *   - who it's for: @me, @agents, @<agent-name-slug> for one of your own
 *     agents ("Claude Code" is @claude-code; a unique start like @claude works
 *     too), @alex for someone on the list, or @alex's agents for theirs.
 * The web app shows what was read as chips before saving, so nothing is
 * guessed silently, and either chip can be dismissed to keep the words in the
 * title. Anything that looks like a mention but doesn't match comes back as a
 * problem and stays in the title.
 *
 * Someone else's specific agent is never an assignee: only that person picks
 * which of their agents works on something (the API refuses "@alex/codex" and
 * another person's agent id), so "@alex's agents" is the way to ask.
 *
 * Covered by quick-add.test.mjs (node --test).
 */

/**
 * @typedef {{ id: string, name: string, access?: string }} QuickAddAgent
 * @typedef {{ handle: string | null, display_name?: string | null, is_you?: boolean, agents?: Array<{ name: string, access?: string }> }} QuickAddMember
 *   Someone on the list, shaped like the API's MemberView.
 * @typedef {{ kind: "me" } | { kind: "my_agents" } | { kind: "agent", id: string, name: string }
 *   | { kind: "person", handle: string, name: string } | { kind: "person_agents", handle: string, name: string }} QuickAddAssignee
 * @typedef {{ kind: "unknown_agent" | "unknown_name" | "unknown_person" | "ambiguous_agent" | "agent_no_access" | "other_agent" | "bad_date", token: string, message: string }} QuickAddProblem
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

/** A handle as people type it: "alex" for "alex@bc". @param {string | null | undefined} handle */
export const bareHandle = (handle) => String(handle ?? "").trim().replace(/^@/, "").replace(/@bc$/i, "");

/** What to call someone on the list: their display name, or their handle. @param {QuickAddMember} m */
export const memberName = (m) => (m.display_name && m.display_name.trim()) || bareHandle(m.handle) || "someone";

/** The keys a person answers to in quick add: their handle, and their display name as a slug. @param {QuickAddMember} m */
const personKeys = (m) => [...new Set([compact(agentSlug(bareHandle(m.handle))), compact(agentSlug(m.display_name ?? ""))].filter(Boolean))];

/**
 * A person on the list (or their agents) as an assignee. Your own handle means you.
 * @param {QuickAddMember} m @param {boolean} theirAgents @returns {QuickAddAssignee}
 */
const personAssignee = (m, theirAgents) => {
  if (m.is_you) return theirAgents ? { kind: "my_agents" } : { kind: "me" };
  return { kind: theirAgents ? "person_agents" : "person", handle: bareHandle(m.handle), name: memberName(m) };
};

/**
 * Who an @mention means.
 * @param {string} token the word (or "@alex's agents"), including the @
 * @param {QuickAddAgent[]} agents the person's own agents
 * @param {QuickAddMember[]} [members] the people on the list, when it's shared
 * @returns {{ assignee: QuickAddAssignee } | { problem: QuickAddProblem }}
 */
export function readMention(token, agents, members = []) {
  const raw = token.slice(1);
  const people = members.filter((m) => m.handle);
  const shared = people.some((m) => !m.is_you);

  // "@alex's agents": that person's agents, and only Alex picks which one.
  const theirs = /^(.+?)['’]s\s+agents$/i.exec(raw);
  if (theirs) {
    const want = compact(agentSlug(bareHandle(theirs[1])));
    const hits = people.filter((m) => personKeys(m).includes(want));
    if (hits.length === 1) return { assignee: personAssignee(hits[0], true) };
    if (agentSlug(theirs[1]) === "me" || agentSlug(theirs[1]) === "my") return { assignee: { kind: "my_agents" } };
    return { problem: { kind: "unknown_person", token, message: `Nobody on this list is called @${theirs[1]}, so it stays in the title.` } };
  }

  const slug = agentSlug(raw);
  if (slug === "me") return { assignee: { kind: "me" } };
  if (slug === "agents" || slug === "my-agents") return { assignee: { kind: "my_agents" } };

  // "@alex/codex": one of someone else's agents. Not ours to pick.
  const slash = /^([^/]+)\/(.+)$/.exec(raw);
  if (slash) {
    const owner = people.find((m) => personKeys(m).includes(compact(agentSlug(slash[1]))));
    if (owner && !owner.is_you) return { problem: otherAgent(token, owner) };
    if (owner?.is_you) return readMention(`@${slash[2]}`, agents);
  }

  // "@alex@bc" is how handles look in full; the @bc part says nothing about who.
  const want = compact(agentSlug(raw.replace(/@bc$/i, "")));
  const mine = agents.map((a) => ({ kind: "agent", agent: a, keys: [compact(agentSlug(a.name))] })).filter((x) => x.keys[0]);
  const folks = people.map((m) => ({ kind: "person", member: m, keys: personKeys(m) }));
  const all = [...folks, ...mine];
  let hits = all.filter((x) => x.keys.includes(want));
  // A name only someone else's agent answers to: say whose it is, and how to ask.
  if (!hits.length) {
    const owner = people.find((m) => !m.is_you && (m.agents ?? []).some((a) => compact(agentSlug(a.name)) === want));
    if (owner) return { problem: otherAgent(token, owner, (owner.agents ?? []).find((a) => compact(agentSlug(a.name)) === want)?.name) };
  }
  if (!hits.length && want.length >= 2) hits = all.filter((x) => x.keys.some((k) => k.startsWith(want)));
  if (!hits.length) {
    return shared
      ? { problem: { kind: "unknown_name", token, message: `Nobody on this list, and none of your agents, is called ${token}, so it stays in the title.` } }
      : { problem: { kind: "unknown_agent", token, message: `None of your agents is called ${token}, so it stays in the title.` } };
  }
  if (hits.length > 1) {
    return shared
      ? { problem: { kind: "ambiguous_agent", token, message: `More than one person or agent matches ${token}. Type more of the name.` } }
      : { problem: { kind: "ambiguous_agent", token, message: `More than one of your agents matches ${token}. Type more of the name.` } };
  }
  const hit = hits[0];
  if (hit.kind === "person") return { assignee: personAssignee(hit.member, false) };
  const agent = hit.agent;
  if (agent.access !== undefined && agent.access !== "work") {
    return { problem: { kind: "agent_no_access", token, message: `${agent.name} can't work on this list yet. Give it access in the list's settings.` } };
  }
  return { assignee: { kind: "agent", id: agent.id, name: agent.name } };
}

/** @param {string} token @param {QuickAddMember} owner @param {string} [agentName] @returns {QuickAddProblem} */
function otherAgent(token, owner, agentName) {
  const name = memberName(owner);
  const lead = agentName ? `${agentName} is ${name}'s agent. ` : "";
  return {
    kind: "other_agent",
    token,
    message: `${lead}Only ${name} picks which of their agents works on something, so try @${bareHandle(owner.handle)}'s agents.`,
  };
}

/**
 * Read a quick-add line.
 * @param {string} text what was typed
 * @param {{ now: Date, agents?: QuickAddAgent[], members?: QuickAddMember[], skipDue?: boolean, skipAssignee?: boolean }} opts
 *   members: the people on a shared list, so "@alex" and "@alex's agents" resolve.
 *   skipDue / skipAssignee: the person dismissed that chip, so keep those words in the title.
 * @returns {QuickAddResult}
 */
export function parseQuickAdd(text, { now, agents = [], members = [], skipDue = false, skipAssignee = false }) {
  const words = String(text ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  /** @type {QuickAddResult} */
  const out = { title: "", due: null, dueToken: null, assignee: null, assigneeToken: null, problems: [] };
  let end = words.length;
  while (end > 0) {
    const word = words[end - 1];
    // "@alex's agents" is two words: read them together.
    const theirs = end >= 2 && /^agents$/i.test(word) && /^@.+['’]s$/i.test(words[end - 2]);
    if ((word.startsWith("@") && word.length > 1) || theirs) {
      if (skipAssignee || out.assignee) break;
      const token = theirs ? `${words[end - 2]} ${word}` : word;
      const read = readMention(token, agents, members);
      if ("problem" in read) {
        out.problems.push(read.problem);
        break;
      }
      out.assignee = read.assignee;
      out.assigneeToken = token;
      end -= theirs ? 2 : 1;
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
 * The assignee as the REST API takes it: "me", "my_agents", one of your own
 * agents' ids, "@alex" or "@alex's agents". Never another person's agent id.
 * @param {QuickAddAssignee | null} a
 * @returns {string | undefined}
 */
export function assigneeParam(a) {
  if (!a) return undefined;
  if (a.kind === "agent") return a.id;
  if (a.kind === "person") return `@${a.handle}`;
  if (a.kind === "person_agents") return `@${a.handle}'s agents`;
  return a.kind;
}

/**
 * The chip for who a quick-added task is for: "For you", "For Alex's agents".
 * @param {QuickAddAssignee | null} a
 * @returns {string | null}
 */
export function assigneeChip(a) {
  if (!a) return null;
  if (a.kind === "me") return "For you";
  if (a.kind === "my_agents") return "For your agents";
  if (a.kind === "person_agents") return `For ${a.name}'s agents`;
  return `For ${a.name}`;
}
