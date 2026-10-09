/**
 * @mentions in comments and progress lines, for the web app.
 *
 * Pure module (no React). It mirrors parseMentions in src/lib/lists/rules.mjs,
 * which is what decides who a comment actually reaches, so the composer only
 * suggests mentions that work and an entry only highlights names that did:
 *   - "@alex" (or "@alex@bc") is a person on the list, by handle;
 *   - "@claude-code" is an agent with access to the list, by its name made
 *     URL-safe. When two agents share a name, the writer's own wins, and
 *     "@alex/claude-code" picks Alex's;
 *   - nothing inside an email address, and never the writer themselves.
 *
 * Highlighting builds plain-text spans for React to render. No HTML is ever
 * produced: production CSP enforces Trusted Types.
 *
 * Covered by mentions.test.mjs (node --test).
 */
import { agentSlug, bareHandle, memberName } from "./quick-add.mjs";

/**
 * @typedef {{ handle: string | null, display_name?: string | null, is_you?: boolean, agents?: Array<{ name: string, access?: string }> }} MentionMember
 *   Someone on the list, shaped like the API's MemberView.
 * @typedef {{ kind: "person", handle: string, name: string, is_you: boolean }} DirPerson
 * @typedef {{ kind: "agent", name: string, slug: string, owner: string, ownerName: string, mine: boolean }} DirAgent
 * @typedef {{ people: DirPerson[], agents: DirAgent[] }} MentionDirectory
 * @typedef {{ mention: string, kind: "person" | "agent", label: string, detail: string }} MentionTarget
 * @typedef {{ text: string, kind?: "person" | "agent", you?: boolean, title?: string }} MentionSpan
 */

// The same shape the server reads: "@alex", "@alex@bc", "@claude-code", "@alex/claude-code".
const MENTION = /(^|[^A-Za-z0-9._@\/-])@([A-Za-z0-9][A-Za-z0-9._-]*(?:@bc)?)(?:\/([A-Za-z0-9][A-Za-z0-9._'’-]*))?/g;
const trim = (s) => s.replace(/[._-]+$/, "");
const same = (a, b) => bareHandle(a).toLowerCase() === bareHandle(b).toLowerCase();

/**
 * Everyone a comment on this list can reach: its people, and the agents they
 * gave access to it.
 * @param {MentionMember[]} members
 * @returns {MentionDirectory}
 */
export function mentionDirectory(members) {
  const people = [];
  const agents = [];
  for (const m of members ?? []) {
    if (!m.handle) continue;
    people.push({ kind: "person", handle: m.handle, name: memberName(m), is_you: !!m.is_you });
    for (const a of m.agents ?? []) {
      agents.push({ kind: "agent", name: a.name, slug: agentSlug(a.name), owner: m.handle, ownerName: memberName(m), mine: !!m.is_you });
    }
  }
  return { people, agents };
}

/**
 * Who one "@token" (with an optional "/agent") reaches when `authorHandle` writes it, or null.
 * @param {string} token the name after the @, without the "/agent" part
 * @param {string | null} sub the part after a "/", if any
 * @param {MentionDirectory} dir
 * @param {string | null | undefined} authorHandle
 * @returns {DirPerson | DirAgent | null}
 */
export function resolveMention(token, sub, dir, authorHandle) {
  const t = trim(token);
  const person = dir.people.find((p) => same(p.handle, t)) ?? null;
  if (sub) {
    if (!person) return null;
    const slug = agentSlug(trim(sub));
    const hits = dir.agents.filter((a) => same(a.owner, person.handle) && a.slug === slug);
    return hits.length === 1 ? hits[0] : null;
  }
  if (person) return person;
  const slug = agentSlug(t);
  if (!slug) return null;
  const hits = dir.agents.filter((a) => a.slug === slug);
  const own = authorHandle ? hits.filter((a) => same(a.owner, authorHandle)) : [];
  const chosen = own.length ? own : hits;
  return chosen.length === 1 ? chosen[0] : null;
}

/**
 * What the composer can suggest, with the exact text that reaches each one
 * when you write it: people other than you, then agents. An agent that shares
 * its name with another gets the "@alex/claude-code" form when that's what it
 * takes, and is left out when no form reaches it on its own.
 * @param {MentionMember[]} members
 * @returns {MentionTarget[]}
 */
export function mentionTargets(members) {
  const dir = mentionDirectory(members);
  const me = dir.people.find((p) => p.is_you)?.handle ?? null;
  const out = [];
  for (const p of dir.people) {
    if (p.is_you) continue;
    out.push({ mention: `@${bareHandle(p.handle)}`, kind: "person", label: p.name, detail: `@${bareHandle(p.handle)}` });
  }
  for (const a of dir.agents) {
    if (!a.slug) continue;
    const forms = [`@${a.slug}`, `@${bareHandle(a.owner)}/${a.slug}`];
    const mention = forms.find((f) => {
      const [, token, sub] = /^@([^/]+)(?:\/(.+))?$/.exec(f) ?? [];
      return resolveMention(token, sub ?? null, dir, me) === a;
    });
    if (!mention) continue;
    out.push({ mention, kind: "agent", label: a.name, detail: a.mine ? "your agent" : `${a.ownerName}'s agent` });
  }
  return out;
}

/**
 * The "@…" being typed just before the caret, if any: where it starts and what's typed after the @.
 * @param {string} text @param {number} caret
 * @returns {{ start: number, query: string } | null}
 */
export function mentionQuery(text, caret) {
  const before = String(text ?? "").slice(0, Math.max(0, caret));
  const m = /(^|[^A-Za-z0-9._@\/-])@([A-Za-z0-9._\/'’-]*)$/.exec(before);
  if (!m) return null;
  return { start: m.index + m[1].length, query: m[2] };
}

/**
 * Suggestions for what's typed after the @: mentions and names that start with
 * it first, then names with a word that does. People before agents.
 * @param {MentionTarget[]} targets @param {string} query @param {number} [limit]
 * @returns {MentionTarget[]}
 */
export function suggestMentions(targets, query, limit = 6) {
  const q = String(query ?? "").toLowerCase();
  const scored = [];
  for (const t of targets) {
    const words = [t.mention.slice(1).toLowerCase(), ...t.label.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)];
    const score = !q || words[0].startsWith(q) ? 0 : t.label.toLowerCase().startsWith(q) ? 1 : words.slice(1).some((w) => w.startsWith(q)) ? 2 : -1;
    if (score >= 0) scored.push({ t, score });
  }
  scored.sort((a, b) => a.score - b.score || (a.t.kind === b.t.kind ? 0 : a.t.kind === "person" ? -1 : 1) || a.t.label.localeCompare(b.t.label));
  return scored.slice(0, limit).map((s) => s.t);
}

/**
 * Put a chosen mention in place of the "@…" being typed, with a space after it.
 * @param {string} text @param {number} start where the @ is @param {number} caret @param {string} mention
 * @returns {{ text: string, caret: number }}
 */
export function insertMention(text, start, caret, mention) {
  const before = text.slice(0, start);
  const after = text.slice(caret);
  const space = /^\s/.test(after) ? "" : " ";
  return { text: `${before}${mention}${space}${after}`, caret: start + mention.length + 1 };
}

/**
 * Split an entry into plain-text spans, marking the mentions that reached
 * someone, so they can be highlighted. `author` is who wrote it (the person's
 * handle, and the agent's name when an agent wrote it): when two agents share
 * a name, the writer's own is the one mentioned, and nobody mentions
 * themselves. An agent mentioning its own person does reach them.
 * @param {string} text @param {MentionDirectory} dir
 * @param {{ handle: string | null, agent?: string | null } | null | undefined} author
 * @returns {MentionSpan[]}
 */
export function mentionSpans(text, dir, author) {
  const s = String(text ?? "");
  if (!s.includes("@") || (!dir.people.length && !dir.agents.length)) return [{ text: s }];
  const handle = author?.handle ?? null;
  const out = [];
  let at = 0;
  for (const m of s.matchAll(MENTION)) {
    const start = (m.index ?? 0) + m[1].length;
    const sub = m[3] ? trim(m[3]) : null;
    const hit = resolveMention(m[2], sub, dir, handle);
    if (!hit) continue;
    // Ignore the writer mentioning themselves, as the server does.
    if (handle && hit.kind === "person" && !author?.agent && same(hit.handle, handle)) continue;
    if (handle && hit.kind === "agent" && author?.agent && same(hit.owner, handle) && agentSlug(author.agent) === hit.slug) continue;
    const shown = sub ? `@${m[2]}/${sub}` : `@${trim(m[2])}`;
    if (start > at) out.push({ text: s.slice(at, start) });
    out.push(
      hit.kind === "person"
        ? { text: shown, kind: "person", you: hit.is_you, title: hit.is_you ? "Mentions you" : hit.name }
        : { text: shown, kind: "agent", title: hit.mine ? `Your agent ${hit.name}` : `${hit.ownerName}'s ${hit.name}` },
    );
    at = start + shown.length;
  }
  if (at < s.length) out.push({ text: s.slice(at) });
  return out.length ? out : [{ text: s }];
}
