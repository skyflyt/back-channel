import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuickAdd, readDateWord, readMention, agentSlug, ymdLocal, assigneeParam, assigneeChip, bareHandle, memberName } from "./quick-add.mjs";

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

/* ------------------------- shared lists (Phase 2) ------------------------- */

// People on a shared list, shaped like the API's MemberView. Alex also has an agent called Codex.
const MEMBERS = [
  { handle: "skylar@bc", display_name: "Skylar", is_you: true, agents: [{ name: "Claude Code", access: "work" }, { name: "Codex", access: "work" }] },
  { handle: "alex@bc", display_name: "Alex Rivera", is_you: false, agents: [{ name: "Codex", access: "work" }, { name: "Alex’s ChatGPT", access: "view" }] },
  { handle: "carol@bc", display_name: null, is_you: false, agents: [] },
];
const shared = (text, opts = {}) => parse(text, { members: MEMBERS, ...opts });

test("@alex is a person on the list, by handle or a unique start of their name", () => {
  const r = shared("Book the Airbnb @alex");
  assert.equal(r.title, "Book the Airbnb");
  assert.deepEqual(r.assignee, { kind: "person", handle: "alex", name: "Alex Rivera" });
  assert.equal(r.assigneeToken, "@alex");
  assert.equal(assigneeParam(r.assignee), "@alex");
  assert.equal(assigneeChip(r.assignee), "For Alex Rivera");
  assert.equal(shared("Pack @alex@bc").assignee?.handle, "alex", "the @bc form");
  assert.equal(shared("Pack @AlexRivera").assignee?.handle, "alex", "the display name");
  assert.deepEqual(shared("Pack @car").assignee, { kind: "person", handle: "carol", name: "carol" }, "a unique start; no display name falls back to the handle");
});

test("@alex's agents is two words, read together, with either apostrophe", () => {
  const r = shared("Book the Airbnb @alex's agents");
  assert.equal(r.title, "Book the Airbnb");
  assert.deepEqual(r.assignee, { kind: "person_agents", handle: "alex", name: "Alex Rivera" });
  assert.equal(r.assigneeToken, "@alex's agents");
  assert.equal(assigneeParam(r.assignee), "@alex's agents");
  assert.equal(assigneeChip(r.assignee), "For Alex Rivera's agents");
  assert.equal(shared("Book it @Alex’s Agents").assignee?.kind, "person_agents");
  // With a date on either side.
  const before = shared("Book hotel fri @alex's agents");
  assert.equal(before.due, "2026-10-16");
  assert.equal(before.assignee?.kind, "person_agents");
  assert.equal(before.title, "Book hotel");
  const after = shared("Book hotel @alex's agents by fri");
  assert.equal(after.due, "2026-10-16");
  assert.equal(after.assignee?.kind, "person_agents");
  assert.equal(after.title, "Book hotel");
});

test("your own handle means you, and your own agents", () => {
  assert.deepEqual(shared("Call the bank @skylar").assignee, { kind: "me" });
  assert.deepEqual(shared("Call the bank @skylar's agents").assignee, { kind: "my_agents" });
  assert.deepEqual(shared("Call the bank @me's agents").assignee, { kind: "my_agents" });
});

test("your own agent wins a name you and a friend's agent share", () => {
  assert.deepEqual(shared("Fix tests @codex").assignee, { kind: "agent", id: "a-codex", name: "Codex" });
});

test("someone else's specific agent is never an assignee: the problem says to ask their person", () => {
  const slash = shared("Review PR @alex/codex");
  assert.equal(slash.assignee, null);
  assert.equal(slash.title, "Review PR @alex/codex");
  assert.equal(slash.problems[0].kind, "other_agent");
  assert.match(slash.problems[0].message, /Only Alex Rivera picks which of their agents works on something, so try @alex's agents\./);
  // A name only a friend's agent answers to.
  const theirs = shared("Summarise @alexs-chatgpt");
  assert.equal(theirs.assignee, null);
  assert.equal(theirs.problems[0].kind, "other_agent");
  assert.match(theirs.problems[0].message, /^Alex’s ChatGPT is Alex Rivera's agent\./);
  // Your own agent by the qualified form is still yours.
  assert.equal(shared("Fix tests @skylar/claude-code").assignee?.id, "a-cc");
});

test("names nobody on the list answers to stay in the title", () => {
  const r = shared("Water plants @dave");
  assert.equal(r.assignee, null);
  assert.equal(r.title, "Water plants @dave");
  assert.equal(r.problems[0].kind, "unknown_name");
  assert.match(r.problems[0].message, /Nobody on this list, and none of your agents, is called @dave/);
  const theirs = shared("Water plants @dave's agents");
  assert.equal(theirs.title, "Water plants @dave's agents");
  assert.equal(theirs.problems[0].kind, "unknown_person");
  assert.match(theirs.problems[0].message, /Nobody on this list is called @dave/);
  // A plain "agents" at the end is just a word.
  assert.equal(shared("Thank the agents").title, "Thank the agents");
  assert.equal(shared("Thank the agents").problems.length, 0);
});

test("a person and an agent that both match a start are ambiguous", () => {
  const members = [...MEMBERS, { handle: "cody@bc", display_name: null, is_you: false, agents: [] }];
  const r = parse("Ship it @cod", { members });
  assert.equal(r.assignee, null);
  assert.equal(r.problems[0].kind, "ambiguous_agent");
  assert.match(r.problems[0].message, /More than one person or agent matches @cod/);
});

test("a dismissed @alex's agents chip keeps both words in the title", () => {
  const r = shared("Book it @alex's agents", { skipAssignee: true });
  assert.equal(r.title, "Book it @alex's agents");
  assert.equal(r.assignee, null);
});

test("helpers: bare handles, member names, the assignee chip", () => {
  assert.equal(bareHandle("@Alex@bc"), "Alex");
  assert.equal(bareHandle(null), "");
  assert.equal(memberName({ handle: "carol@bc", display_name: "  " }), "carol");
  assert.equal(memberName({ handle: "alex@bc", display_name: "Alex" }), "Alex");
  assert.equal(assigneeChip(null), null);
  assert.equal(assigneeChip({ kind: "me" }), "For you");
  assert.equal(assigneeChip({ kind: "my_agents" }), "For your agents");
  assert.equal(assigneeChip({ kind: "agent", id: "a-cc", name: "Claude Code" }), "For Claude Code");
});
