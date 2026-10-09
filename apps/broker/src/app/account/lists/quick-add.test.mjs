import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuickAdd, readDateWord, readMention, agentSlug, ymdLocal, assigneeParam } from "./quick-add.mjs";

// Friday 9 October 2026, mid-morning local time.
const NOW = new Date(2026, 9, 9, 10, 30);
const AGENTS = [
  { id: "a-cc", name: "Claude Code", access: "work" },
  { id: "a-codex", name: "Codex", access: "work" },
  { id: "a-desk", name: "Claude Desktop", access: "view" },
  { id: "a-gpt", name: "ChatGPT", access: "none" },
];
const parse = (text, opts = {}) => parseQuickAdd(text, { now: NOW, agents: AGENTS, ...opts });

test("plain text is just a title", () => {
  const r = parse("  Call the plumber  ");
  assert.equal(r.title, "Call the plumber");
  assert.equal(r.due, null);
  assert.equal(r.assignee, null);
  assert.deepEqual(r.problems, []);
});

test("today and tomorrow", () => {
  assert.equal(parse("Call mom today").due, "2026-10-09");
  assert.equal(parse("Call mom tomorrow").due, "2026-10-10");
  assert.equal(parse("Call mom Tomorrow").title, "Call mom");
});

test("weekday names and short forms mean the next one coming, never today", () => {
  assert.equal(readDateWord("sat", NOW), "2026-10-10");
  assert.equal(readDateWord("saturday", NOW), "2026-10-10");
  assert.equal(readDateWord("mon", NOW), "2026-10-12");
  assert.equal(readDateWord("tue", NOW), "2026-10-13");
  assert.equal(readDateWord("tues", NOW), "2026-10-13");
  assert.equal(readDateWord("wednesday", NOW), "2026-10-14");
  assert.equal(readDateWord("thu", NOW), "2026-10-15");
  // Today is Friday: "fri" is next week's.
  assert.equal(readDateWord("fri", NOW), "2026-10-16");
  assert.equal(readDateWord("FRIDAY", NOW), "2026-10-16");
  assert.equal(readDateWord("sun", NOW), "2026-10-11");
});

test("weekdays cross month and year ends", () => {
  const nye = new Date(2026, 11, 31, 9); // Thursday 31 Dec 2026
  assert.equal(readDateWord("tomorrow", nye), "2027-01-01");
  assert.equal(readDateWord("mon", nye), "2027-01-04");
  assert.equal(ymdLocal(new Date(2027, 0, 4, 23, 59)), "2027-01-04");
});

test("YYYY-MM-DD is read when it's a real date and kept in the title when it isn't", () => {
  const ok = parse("File taxes 2027-04-15");
  assert.equal(ok.due, "2027-04-15");
  assert.equal(ok.title, "File taxes");
  const bad = parse("File taxes 2027-02-30");
  assert.equal(bad.due, null);
  assert.equal(bad.title, "File taxes 2027-02-30");
  assert.equal(bad.problems[0].kind, "bad_date");
  assert.equal(readDateWord("2026-13-01", NOW).bad, true);
});

test("only trailing words are read: a date word mid-title is left alone", () => {
  const r = parse("Plan monday standup");
  assert.equal(r.title, "Plan monday standup");
  assert.equal(r.due, null);
  assert.equal(parse("Ask @me about it").assignee, null);
});

test("by and due before a date go with the date", () => {
  const r = parse("Pay rent by fri");
  assert.equal(r.title, "Pay rent");
  assert.equal(r.due, "2026-10-16");
  assert.equal(r.dueToken, "by fri");
  assert.equal(parse("Pay rent due tomorrow").title, "Pay rent");
  // A lone connector is the whole title, so it stays.
  assert.equal(parse("by fri").title, "by");
});

test("@me and @agents", () => {
  assert.deepEqual(parse("Book flights @me").assignee, { kind: "me" });
  assert.deepEqual(parse("Book flights @agents").assignee, { kind: "my_agents" });
  assert.deepEqual(parse("Book flights @my-agents").assignee, { kind: "my_agents" });
  assert.equal(parse("Book flights @me").title, "Book flights");
});

test("an agent by its name slug, exact or a unique start", () => {
  assert.equal(agentSlug("Claude Code"), "claude-code");
  assert.equal(agentSlug("Skylar's Codex"), "skylars-codex");
  const r = parse("Renew Mimecast cert fri @claude-code");
  assert.equal(r.title, "Renew Mimecast cert");
  assert.equal(r.due, "2026-10-16");
  assert.deepEqual(r.assignee, { kind: "agent", id: "a-cc", name: "Claude Code" });
  assert.equal(r.assigneeToken, "@claude-code");
  assert.equal(parse("Fix tests @ClaudeCode").assignee?.id, "a-cc");
  assert.equal(parse("Fix tests @codex").assignee?.id, "a-codex");
  assert.equal(parse("Fix tests @cod").assignee?.id, "a-codex");
});

test("the date and the mention can come in either order", () => {
  const r = parse("Renew cert @codex tomorrow");
  assert.equal(r.title, "Renew cert");
  assert.equal(r.due, "2026-10-10");
  assert.equal(r.assignee?.id, "a-codex");
});

test("a mention that matches nothing, or more than one agent, stays in the title with a problem", () => {
  const unknown = parse("Water plants @alex");
  assert.equal(unknown.title, "Water plants @alex");
  assert.equal(unknown.assignee, null);
  assert.equal(unknown.problems[0].kind, "unknown_agent");
  const ambiguous = parse("Write docs @claude");
  assert.equal(ambiguous.assignee, null);
  assert.equal(ambiguous.title, "Write docs @claude");
  assert.equal(ambiguous.problems[0].kind, "ambiguous_agent");
  // Nothing after an unread mention is read either, so the title keeps its order.
  const stop = parse("Water plants fri @alex");
  assert.equal(stop.due, null);
  assert.equal(stop.title, "Water plants fri @alex");
});

test("an agent without work access on this list isn't assigned", () => {
  const r = parse("Summarise notes @claude-desktop");
  assert.equal(r.assignee, null);
  assert.equal(r.problems[0].kind, "agent_no_access");
  assert.match(r.problems[0].message, /Claude Desktop can't work on this list yet/);
  assert.equal(parse("Summarise @chatgpt").problems[0].kind, "agent_no_access");
  // When access isn't known, the match stands.
  const loose = parseQuickAdd("Summarise @chatgpt", { now: NOW, agents: [{ id: "x", name: "ChatGPT" }] });
  assert.equal(loose.assignee?.id, "x");
});

test("dismissed chips keep their words in the title", () => {
  const r = parse("Email Sue about tomorrow", { skipDue: true });
  assert.equal(r.title, "Email Sue about tomorrow");
  assert.equal(r.due, null);
  const s = parse("Thank @codex", { skipAssignee: true });
  assert.equal(s.title, "Thank @codex");
  assert.equal(s.assignee, null);
  // Skipping one still reads the other when it comes last.
  const t = parse("Thank @codex fri", { skipAssignee: true });
  assert.equal(t.due, "2026-10-16");
  assert.equal(t.title, "Thank @codex");
});

test("only one date and one mention are read", () => {
  const r = parse("Ship it today tomorrow");
  assert.equal(r.due, "2026-10-10");
  assert.equal(r.title, "Ship it today");
  const m = parse("Ship it @me @codex");
  assert.equal(m.assignee?.id, "a-codex");
  assert.equal(m.title, "Ship it @me");
});

test("a line that is all chips leaves an empty title for the caller to refuse", () => {
  const r = parse("@me tomorrow");
  assert.equal(r.title, "");
  assert.equal(r.due, "2026-10-10");
  assert.deepEqual(r.assignee, { kind: "me" });
  assert.equal(parse("").title, "");
  assert.equal(parse("@").title, "@");
});

test("assigneeParam speaks the REST API's words", () => {
  assert.equal(assigneeParam(null), undefined);
  assert.equal(assigneeParam({ kind: "me" }), "me");
  assert.equal(assigneeParam({ kind: "my_agents" }), "my_agents");
  assert.equal(assigneeParam({ kind: "agent", id: "a-cc", name: "Claude Code" }), "a-cc");
});

test("readMention on its own", () => {
  assert.deepEqual(readMention("@ME", AGENTS), { assignee: { kind: "me" } });
  assert.equal("problem" in readMention("@zz", []), true);
});
