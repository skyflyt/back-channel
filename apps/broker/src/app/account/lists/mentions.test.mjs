import { test } from "node:test";
import assert from "node:assert/strict";
import { mentionDirectory, resolveMention, mentionTargets, mentionQuery, suggestMentions, insertMention, mentionSpans } from "./mentions.mjs";

// Skylar (you) and Alex both have an agent called Claude Code; Carol has two agents with one name.
const MEMBERS = [
  { handle: "skylar@bc", display_name: "Skylar", is_you: true, agents: [{ name: "Claude Code", access: "work" }, { name: "Codex", access: "view" }] },
  { handle: "alex@bc", display_name: "Alex Rivera", is_you: false, agents: [{ name: "Claude Code", access: "work" }, { name: "Alex’s ChatGPT", access: "work" }] },
  { handle: "carol@bc", display_name: null, is_you: false, agents: [{ name: "Helper", access: "work" }, { name: "Helper", access: "view" }] },
];
const dir = mentionDirectory(MEMBERS);
const me = { handle: "skylar@bc" };

test("the directory holds the people and the agents they gave access", () => {
  assert.deepEqual(dir.people.map((p) => p.handle), ["skylar@bc", "alex@bc", "carol@bc"]);
  assert.equal(dir.people[2].name, "carol");
  assert.deepEqual(dir.agents.map((a) => `${a.ownerName}:${a.slug}:${a.mine}`), [
    "Skylar:claude-code:true", "Skylar:codex:true", "Alex Rivera:claude-code:false", "Alex Rivera:alexs-chatgpt:false", "carol:helper:false", "carol:helper:false",
  ]);
  assert.deepEqual(mentionDirectory(null), { people: [], agents: [] });
});

test("resolveMention matches the server: people by handle, the writer's own agent first, @person/agent for the other", () => {
  assert.equal(resolveMention("alex", null, dir, me.handle)?.handle, "alex@bc");
  assert.equal(resolveMention("Alex@bc", null, dir, me.handle)?.handle, "alex@bc");
  assert.equal(resolveMention("claude-code", null, dir, me.handle)?.owner, "skylar@bc");
  assert.equal(resolveMention("claude-code", null, dir, "alex@bc")?.owner, "alex@bc");
  assert.equal(resolveMention("claude-code", null, dir, "carol@bc"), null, "neither of Carol's: ambiguous, so nobody");
  assert.equal(resolveMention("alex", "claude-code", dir, me.handle)?.owner, "alex@bc");
  assert.equal(resolveMention("helper", null, dir, me.handle), null);
  assert.equal(resolveMention("carol", "helper", dir, me.handle), null, "two with one name, even qualified");
  assert.equal(resolveMention("dave", null, dir, me.handle), null);
  assert.equal(resolveMention("dave", "codex", dir, me.handle), null);
});

test("mentionTargets suggests the text that reaches each one, never yourself", () => {
  const t = mentionTargets(MEMBERS);
  assert.deepEqual(t.map((x) => x.mention), ["@alex", "@carol", "@claude-code", "@codex", "@alex/claude-code", "@alexs-chatgpt"]);
  assert.deepEqual(t[0], { mention: "@alex", kind: "person", label: "Alex Rivera", detail: "@alex" });
  assert.equal(t.find((x) => x.mention === "@claude-code")?.detail, "your agent");
  assert.equal(t.find((x) => x.mention === "@alex/claude-code")?.detail, "Alex Rivera's agent");
  // A personal list: just your own agents.
  assert.deepEqual(mentionTargets([MEMBERS[0]]).map((x) => x.mention), ["@claude-code", "@codex"]);
});

test("mentionQuery finds the @ being typed, not one inside an email address", () => {
  assert.deepEqual(mentionQuery("hey @al", 7), { start: 4, query: "al" });
  assert.deepEqual(mentionQuery("@", 1), { start: 0, query: "" });
  assert.deepEqual(mentionQuery("ask @alex/cl", 12), { start: 4, query: "alex/cl" });
  assert.equal(mentionQuery("mail me@alex.com", 16), null);
  assert.equal(mentionQuery("@alex done", 10), null, "a space ends it");
  assert.deepEqual(mentionQuery("(@car", 5), { start: 1, query: "car" });
  assert.equal(mentionQuery("@al", 0), null);
});

test("suggestMentions: starts first, then word starts, people before agents", () => {
  const t = mentionTargets(MEMBERS);
  assert.deepEqual(suggestMentions(t, "").map((x) => x.mention).slice(0, 2), ["@alex", "@carol"]);
  assert.deepEqual(suggestMentions(t, "al").map((x) => x.mention), ["@alex", "@alexs-chatgpt", "@alex/claude-code"], "then by name");
  assert.deepEqual(suggestMentions(t, "riv").map((x) => x.mention), ["@alex"], "a word of the name");
  assert.deepEqual(suggestMentions(t, "chat").map((x) => x.mention), ["@alexs-chatgpt"]);
  assert.deepEqual(suggestMentions(t, "zz"), []);
  assert.equal(suggestMentions(t, "", 2).length, 2);
});

test("insertMention replaces what was typed and adds one space", () => {
  assert.deepEqual(insertMention("hey @al", 4, 7, "@alex"), { text: "hey @alex ", caret: 10 });
  assert.deepEqual(insertMention("hey @al thanks", 4, 7, "@alex"), { text: "hey @alex thanks", caret: 10 });
});

test("mentionSpans highlights only mentions that reached someone, as plain text", () => {
  const spans = mentionSpans("@alex can you and @claude-code check? cc @dave, mail me@alex.com", dir, me);
  assert.deepEqual(spans, [
    { text: "@alex", kind: "person", you: false, title: "Alex Rivera" },
    { text: " can you and " },
    { text: "@claude-code", kind: "agent", title: "Your agent Claude Code" },
    { text: " check? cc @dave, mail me@alex.com" },
  ]);
  assert.equal(spans.map((s) => s.text).join(""), "@alex can you and @claude-code check? cc @dave, mail me@alex.com");
  // A trailing full stop isn't part of the name; the @bc form and the qualified form are.
  assert.deepEqual(mentionSpans("thanks @Alex@bc.", dir, me), [{ text: "thanks " }, { text: "@Alex@bc", kind: "person", you: false, title: "Alex Rivera" }, { text: "." }]);
  assert.deepEqual(mentionSpans("@alex/claude-code go", dir, me)[0], { text: "@alex/claude-code", kind: "agent", title: "Alex Rivera's Claude Code" });
  // A mention of you is marked as one.
  assert.deepEqual(mentionSpans("@skylar look", dir, { handle: "alex@bc" })[0], { text: "@skylar", kind: "person", you: true, title: "Mentions you" });
});

test("mentionSpans: nobody mentions themselves, but an agent reaches its own person", () => {
  assert.deepEqual(mentionSpans("@skylar note to self", dir, me), [{ text: "@skylar note to self" }]);
  assert.equal(mentionSpans("@skylar I need your login", dir, { handle: "skylar@bc", agent: "Claude Code" })[0].kind, "person");
  assert.deepEqual(mentionSpans("@claude-code that's me", dir, { handle: "skylar@bc", agent: "Claude Code" }), [{ text: "@claude-code that's me" }]);
  // The writer's own agent wins a shared name.
  assert.equal(mentionSpans("@claude-code go", dir, { handle: "alex@bc" })[0].title, "Alex Rivera's Claude Code");
  assert.deepEqual(mentionSpans("no mentions", dir, me), [{ text: "no mentions" }]);
  assert.deepEqual(mentionSpans("@alex", mentionDirectory([]), me), [{ text: "@alex" }]);
});
