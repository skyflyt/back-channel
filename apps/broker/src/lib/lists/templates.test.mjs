import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_TEMPLATES, TEMPLATE_LIMITS, builtinTemplate, parseTemplateRef, matchTemplateName, cleanTemplateItems, itemsFromTasks, tasksToDuplicate,
  copyName, templateView,
} from "./templates.mjs";
import { ListRuleError, LIMITS, looksSecret } from "./rules.mjs";

const refusal = (fn, status, code) => {
  assert.throws(fn, (e) => e instanceof ListRuleError && e.status === status && e.code === code);
};
// Built at runtime so no secret-shaped literal sits in the source.
const fakeKey = () => "bc_" + "Q".repeat(40);

test("the four built-ins: plain names, an emoji each, items that pass the same checks as anyone's", () => {
  assert.deepEqual(BUILTIN_TEMPLATES.map((t) => t.name), ["Trip packing", "New hire onboarding", "Move out", "Weekly review"]);
  assert.deepEqual(BUILTIN_TEMPLATES.map((t) => t.slug), ["trip-packing", "new-hire-onboarding", "move-out", "weekly-review"]);
  for (const t of BUILTIN_TEMPLATES) {
    assert.ok(t.emoji && [...t.emoji].length <= LIMITS.emoji, t.slug);
    assert.ok(t.items.length >= 5 && t.items.length <= TEMPLATE_LIMITS.items, t.slug);
    assert.deepEqual(cleanTemplateItems(t.items), t.items.map((i) => ({ ...i })), `${t.slug} is already clean`);
    for (const i of t.items) {
      assert.ok(!looksSecret(i.title + i.notes));
      assert.doesNotMatch(i.title + i.notes, /!|amazing|awesome|effortless|seamless/i, "plain, no hype");
    }
  }
  assert.equal(Object.isFrozen(BUILTIN_TEMPLATES[0].items[0]), true);
  assert.equal(builtinTemplate("move-out").name, "Move out");
  assert.equal(builtinTemplate("nope"), null);
});

test("parseTemplateRef: builtin:<slug>, a saved id, or a name; unknown built-ins and non-text refused", () => {
  assert.deepEqual(parseTemplateRef("builtin:trip-packing"), { kind: "builtin", slug: "trip-packing" });
  assert.deepEqual(parseTemplateRef(" BUILTIN:Weekly-Review "), { kind: "builtin", slug: "weekly-review" });
  const id = "0f3c2a1e-1111-4222-8333-444455556666";
  assert.deepEqual(parseTemplateRef(id), { kind: "saved", id });
  assert.deepEqual(parseTemplateRef("Trip packing"), { kind: "name", name: "Trip packing" });
  refusal(() => parseTemplateRef("builtin:moon-landing"), 404, "no_such_template");
  refusal(() => parseTemplateRef(""), 400, "invalid_template");
  refusal(() => parseTemplateRef(7), 400, "invalid_template");
});

test("matchTemplateName: the person's own template first, then a built-in; two of theirs with one name is ambiguous", () => {
  const saved = [{ id: "s1", name: "Trip packing" }, { id: "s2", name: "Sprint" }, { id: "s3", name: "Sprint" }];
  assert.deepEqual(matchTemplateName("trip packing", saved), { kind: "saved", id: "s1" });
  assert.deepEqual(matchTemplateName("Move out", saved), { kind: "builtin", slug: "move-out" });
  assert.deepEqual(matchTemplateName("weekly review template", []), { kind: "builtin", slug: "weekly-review" });
  assert.deepEqual(matchTemplateName("move-out", []), { kind: "builtin", slug: "move-out" });
  assert.equal(matchTemplateName("sprint", saved), "ambiguous");
  assert.equal(matchTemplateName("Groceries", saved), null);
});

test("cleanTemplateItems: titles one line, notes kept, secrets refused, 1 to 200 items, total size capped", () => {
  assert.deepEqual(cleanTemplateItems([{ title: "  Book\nhotel ", notes: "Near the venue\r\nwith parking" }, { title: "Pack" }]), [
    { title: "Book hotel", notes: "Near the venue\nwith parking" },
    { title: "Pack", notes: "" },
  ]);
  refusal(() => cleanTemplateItems([]), 400, "empty_template");
  refusal(() => cleanTemplateItems("nope"), 400, "invalid_template");
  refusal(() => cleanTemplateItems([{ title: "" }]), 400, "invalid_title");
  refusal(() => cleanTemplateItems([{ title: "x".repeat(201) }]), 400, "invalid_title");
  refusal(() => cleanTemplateItems([{ title: "Rotate", notes: `key ${fakeKey()}` }]), 422, "secret_like");
  refusal(() => cleanTemplateItems(Array.from({ length: 201 }, (_, i) => ({ title: `T${i}` }))), 400, "template_too_big");
  assert.equal(cleanTemplateItems(Array.from({ length: 200 }, (_, i) => ({ title: `T${i}` }))).length, 200);
  refusal(() => cleanTemplateItems(Array.from({ length: 6 }, () => ({ title: "Long", notes: "n".repeat(20_000) }))), 400, "template_too_big");
});

test("itemsFromTasks keeps only unfinished tasks the person or their agents wrote, in list order", () => {
  const tasks = [
    { status: "open", position: 3072, title: "Third", notes: "", createdByAccountId: "me" },
    { status: "done", position: 1024, title: "Finished", notes: "", createdByAccountId: "me" },
    { status: "in_progress", position: 2048, title: "Second", notes: "n", createdByAccountId: "me", createdByAgentId: "agent-1" },
    { status: "open", position: 512, title: "Alex's", notes: "", createdByAccountId: "alex" },
    { status: "needs_review", position: 256, title: "First", notes: "", createdByAccountId: "me" },
    { status: "dropped", position: 100, title: "Dropped", notes: "", createdByAccountId: "me" },
  ];
  assert.deepEqual(itemsFromTasks(tasks, "me"), {
    items: [{ title: "First", notes: "" }, { title: "Second", notes: "n" }, { title: "Third", notes: "" }],
    skipped: 1,
  });
});

test("tasksToDuplicate copies unfinished titles, notes and order, and who wrote each", () => {
  const tasks = [
    { status: "open", position: 2, title: "B", notes: "nb", createdByAccountId: "alex", createdByAgentId: "x", assigneeAccountId: "alex", claimAccountId: "alex" },
    { status: "done", position: 0, title: "Done", notes: "", createdByAccountId: "me" },
    { status: "blocked", position: 1, title: "A", notes: "", createdByAccountId: "me", createdByAgentId: null },
  ];
  assert.deepEqual(tasksToDuplicate(tasks), [
    { title: "A", notes: "", createdByAccountId: "me", createdByAgentId: null },
    { title: "B", notes: "nb", createdByAccountId: "alex", createdByAgentId: "x" },
  ]);
});

test("copyName adds (copy) within the 80-character limit", () => {
  assert.equal(copyName("Trip"), "Trip (copy)");
  const long = "L".repeat(80);
  assert.equal([...copyName(long)].length, 80);
  assert.ok(copyName(long).endsWith(" (copy)"));
});

test("templateView: built-ins have builtin:<slug> ids; saved ones their own; a short preview of titles", () => {
  const b = templateView(BUILTIN_TEMPLATES[0]);
  assert.equal(b.id, "builtin:trip-packing");
  assert.equal(b.kind, "builtin");
  assert.equal(b.count, BUILTIN_TEMPLATES[0].items.length);
  assert.equal(b.preview.length, 5);
  const s = templateView({ id: "s1", name: "Mine", emoji: null, items: [{ title: "One", notes: "secret-free notes" }], createdAt: new Date("2026-10-09T10:00:00Z") });
  assert.deepEqual(s, { id: "s1", kind: "saved", name: "Mine", emoji: null, count: 1, preview: ["One"], created_at: "2026-10-09T10:00:00.000Z" });
  assert.ok(!("items" in s), "notes never travel in the list view");
});
