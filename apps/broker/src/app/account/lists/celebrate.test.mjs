import { test } from "node:test";
import assert from "node:assert/strict";
import { celebration, tally, unfinishedCount, joinNames } from "./celebrate.mjs";

const you = { person: "Skylar", handle: "skylar", agent: null, is_you: true };
const yourAgent = { person: "Skylar", handle: "skylar", agent: "Claude Code", is_you: true };
const yourOtherAgent = { person: "Skylar", handle: "skylar", agent: "Codex", is_you: true };
const alex = { person: "Alex", handle: "alex@bc", agent: null, is_you: false };
const alexAgent = { person: "Alex", handle: "alex@bc", agent: "Codex", is_you: false };
const done = (by) => ({ status: "done", completed_by: by });

test("unfinishedCount counts open, in progress, blocked and waiting-for-a-check", () => {
  assert.equal(unfinishedCount([{ status: "open" }, { status: "in_progress" }, { status: "blocked" }, { status: "needs_review" }, { status: "done" }, { status: "dropped" }]), 4);
});

test("tally: people before agents, you first, then by how many", () => {
  assert.equal(tally([done(alex), done(alex), done(alex), done(alex), ...Array.from({ length: 6 }, () => done(yourAgent))]), "Alex finished 4 and your agents finished 6");
  assert.equal(tally([done(yourAgent), done(yourOtherAgent), done(you), done(alexAgent)]), "You finished 1, your agents finished 2 and Alex's agents finished 1");
  assert.equal(tally([done(null)]), "Someone finished 1");
  assert.equal(joinNames(["A", "B", "C"]), "A, B and C");
});

test("celebration: only when the same list goes from some unfinished tasks to none", () => {
  const list = (unfinished, finished = [done(alex), done(yourAgent)]) => ({ listId: "L", unfinished, done: finished });
  assert.equal(celebration({ listId: "L", unfinished: 1 }, list(0)), "All done. Alex finished 1 and your agents finished 1.");
  assert.equal(celebration(null, list(0)), null, "not on first load");
  assert.equal(celebration({ listId: "OTHER", unfinished: 3 }, list(0)), null, "not when switching lists");
  assert.equal(celebration({ listId: "L", unfinished: 0 }, list(0)), null, "already empty");
  assert.equal(celebration({ listId: "L", unfinished: 2 }, list(1)), null, "still something left");
  assert.equal(celebration({ listId: "L", unfinished: 1 }, list(0, [])), null, "emptied by dropping, nothing finished");
});
