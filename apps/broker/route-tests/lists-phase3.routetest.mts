/**
 * Route tests for Lists Phase 3 (web): the live stream (GET /api/lists/stream),
 * templates and "Duplicate list" (/api/lists/templates, POST /api/lists with
 * template or duplicate, bc_list_create {template}), and the opt-in daily
 * digest (/api/lists/preferences and POST /api/lists/digest/run).
 *
 * Runs the real routes, lists.ts, lists-digest.ts, the real rules and the real
 * in-memory lists bus; Prisma, auth, email, the rate limiter and the inbox bus
 * are replaced (lists-harness.mts).
 *
 * Run with:
 *   node --experimental-strip-types --experimental-test-module-mocks \
 *        --import ./route-tests/register-hooks.mjs --test route-tests/*.routetest.mts
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  installMocks, resetStore, state, rest, tool, mcp, ok, refused, rows, taskRow, entriesOf, eventsOf, makeList, addTask, seedRow, sharedList,
  openStream, runDigestRoute, catchUpClock, as, SKYLAR, ALEX, CAROL, A, B, C, A1, A2, B1, MIN, DAY, type Who, type Row, type Res,
} from "./lists-harness.mts";

before(() => installMocks({ mcp: true }));

const open: Array<{ abort: () => void; events: { cancel: () => unknown } | null }> = [];
beforeEach(async () => {
  resetStore();
  (await import("@/lib/lists")).resetListNudges();
  (await import("@/lib/lists/bus.mjs"))._reset({ coalesceMs: 5 });
  delete process.env.LISTS_DIGEST_SECRET;
});
afterEach(async () => {
  for (const s of open.splice(0)) {
    s.abort();
    await s.events?.cancel();
  }
});

/** Open a stream and keep it for cleanup. */
async function listen(who: Who, extra: Record<string, string> = {}) {
  const s = await openStream(who, extra);
  open.push(s);
  return s;
}
/** A stream that has had its `ready` event read. */
async function ready(who: Who) {
  const s = await listen(who);
  assert.equal(s.res.status, 200);
  const first = await s.events!.next();
  assert.equal(first?.event, "ready");
  return s;
}
const changes = async (s: Awaited<ReturnType<typeof listen>>, ms = 80) => (await s.events!.drain(ms)).filter((e) => e.event === "changed");

// ── 1. the live stream ──────────────────────────────────────────────────────

test("stream: cookie only. No cookie is 401; an agent key is 403 people_only, valid or not, with or without a cookie", async () => {
  const none = await listen(null);
  assert.equal(none.res.status, 401);
  assert.equal((await none.res.json()).error, "unauthorized");
  const stranger = await listen({ person: "A" }, { cookie: "bc_session=sess-nobody" });
  assert.equal(stranger.res.status, 401);
  for (const who of [as(A1), { bearer: "keyless" }, { bearer: "junk" }] as Who[]) {
    const r = await listen(who);
    assert.equal(r.res.status, 403);
    assert.equal((await r.res.json()).error, "people_only");
  }
  const both = await listen(SKYLAR, { authorization: `Bearer key-${A1}` });
  assert.equal(both.res.status, 403, "a bearer next to the cookie is still refused");
});

test("stream: only from the app's own pages. Cross-site requests and foreign Origins are refused; GET needs no CSRF", async () => {
  const foreign: Record<string, string>[] = [{ "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { origin: "https://evil.example" }, { origin: "not a url" }];
  for (const extra of foreign) {
    const r = await listen(SKYLAR, extra);
    assert.equal(r.res.status, 403, JSON.stringify(extra));
    assert.equal((await r.res.json()).error, "cross_site");
  }
  const own: Record<string, string>[] = [{ "sec-fetch-site": "same-origin", origin: "https://back-channel.app" }, { "sec-fetch-site": "none" }, {}];
  for (const extra of own) {
    const r = await listen({ person: "A", csrf: "missing" }, extra);
    assert.equal(r.res.status, 200, JSON.stringify(extra));
  }
  state.rateLimited = true;
  const limited = await listen(SKYLAR);
  assert.equal(limited.res.status, 429);
  assert.equal(limited.res.headers.get("retry-after"), "42");
});

test("stream: SSE headers, `ready` first, and every event carries only {at}", async () => {
  const s = await listen(SKYLAR);
  assert.equal(s.res.status, 200);
  assert.equal(s.res.headers.get("content-type"), "text/event-stream");
  assert.equal(s.res.headers.get("cache-control"), "no-cache, no-transform");
  assert.equal(s.res.headers.get("x-accel-buffering"), "no");
  const first = await s.events!.next();
  assert.equal(first?.event, "ready");
  assert.deepEqual(Object.keys(first!.data), ["at"]);
  const id = await makeList("Work", [A1]);
  assert.equal((await changes(s)).length, 1, "a new list");
  ok(await rest("POST", `/${id}/tasks`, as(A1), { tasks: [{ title: "Renew the Mimecast cert", notes: "Expires Oct 28" }, { title: "Patch the switch" }, { title: "Call the plumber" }] }));
  const got = await changes(s);
  assert.equal(got.length, 1, "three tasks in one request are one event");
  assert.deepEqual(Object.keys(got[0].data), ["at"], "metadata only: no list, task or who");
  assert.ok(Number.isFinite(Date.parse(got[0].data.at)));
});

test("stream: a write reaches everyone who can see the list, and nobody else; refused writes and plain reads send nothing", async () => {
  const id = await sharedList("Trip", [A1], [B1]);
  const [skylar, alex, carol] = [await ready(SKYLAR), await ready(ALEX), await ready(CAROL)];
  const t = await addTask(id, as(B1), { title: "Book the Airbnb" });
  assert.equal((await changes(skylar)).length, 1);
  assert.equal((await changes(alex)).length, 1);
  assert.equal((await changes(carol)).length, 0, "Carol isn't on the list");
  // A refusal commits nothing and says nothing.
  refused(await rest("POST", `/tasks/${t.id}/claim`, as(A1), {}), 409, "needs_ok");
  refused(await rest("PATCH", `/${id}`, ALEX, { name: "Mine now" }), 403, "not_allowed");
  ok(await rest("GET", `/${id}`, SKYLAR));
  ok(await rest("GET", "/plate", ALEX));
  assert.equal((await changes(skylar)).length, 0);
  assert.equal((await changes(alex)).length, 0);
  // Each kind of write tells both of them.
  const writes: Array<[string, () => Promise<Res>]> = [
    ["OK", () => rest("POST", `/tasks/${t.id}/ok`, SKYLAR, {})],
    ["claim", () => rest("POST", `/tasks/${t.id}/claim`, as(A1), {})],
    ["progress", () => rest("PATCH", `/tasks/${t.id}`, as(A1), { progress: "Found two places" })],
    ["comment", () => rest("POST", `/tasks/${t.id}/entries`, ALEX, { text: "Near the venue please" })],
    ["react", () => rest("POST", `/tasks/${t.id}/react`, ALEX, { emoji: "\u{1F44D}" })],
    ["done", () => rest("POST", `/tasks/${t.id}/done`, as(A1), { summary: "Booked; confirmation in the notes" })],
    ["rename", () => rest("PATCH", `/${id}`, SKYLAR, { name: "Trip 2026" })],
  ];
  for (const [what, write] of writes) {
    ok(await write(), what);
    assert.equal((await changes(skylar)).length, 1, `Skylar hears: ${what}`);
    assert.equal((await changes(alex)).length, 1, `Alex hears: ${what}`);
  }
  assert.equal((await changes(carol)).length, 0);
});

test("stream: someone taken off a list hears it (their page drops the list); your own settings reach only you", async () => {
  const id = await sharedList("Trip", [A1], [B1]);
  const [skylar, alex] = [await ready(SKYLAR), await ready(ALEX)];
  ok(await rest("PATCH", `/${id}/me`, ALEX, { notify: "mentions_reviews" }));
  assert.equal((await changes(alex)).length, 1);
  assert.equal((await changes(skylar)).length, 0, "Alex's own setting is his alone");
  ok(await rest("DELETE", `/${id}/members/alex`, SKYLAR));
  assert.equal((await changes(alex)).length, 1, "Alex is told even though he's no longer on it");
  assert.equal((await changes(skylar)).length, 1);
  await addTask(id, SKYLAR, { title: "After Alex left" });
  assert.equal((await changes(alex)).length, 0, "and after that, nothing");
});

test("stream: a lapse settled by someone's read tells everyone on the list", async () => {
  const id = await makeList("Work", [A1, A2]);
  const t = await addTask(id, as(A1), { title: "Patch the switch" });
  ok(await rest("POST", `/tasks/${t.id}/claim`, as(A1), {}));
  const s = await ready(SKYLAR);
  taskRow(t.id).claimExpiresAt = new Date(Date.now() - MIN);
  ok(await rest("GET", "/plate", as(A2)));
  assert.equal((await changes(s)).length, 1);
  assert.ok(eventsOf(t.id).includes("lapsed"));
});

test("stream: at most two per account. A third closes the oldest with `replaced`; the other two keep hearing", async () => {
  const first = await ready(SKYLAR);
  const second = await ready(SKYLAR);
  const third = await ready(SKYLAR);
  const told = await first.events!.next();
  assert.deepEqual([told?.event, told?.data], ["replaced", { reason: "too_many_streams" }]);
  assert.equal(await first.events!.next(100), null, "and that stream ends");
  const { listsStreamCount } = await import("@/lib/lists/bus.mjs");
  assert.equal(listsStreamCount(A.id), 2);
  await makeList("Work", []);
  assert.equal((await changes(second)).length, 1);
  assert.equal((await changes(third)).length, 1);
  // A client that goes away gives its slot back.
  third.abort();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(listsStreamCount(A.id), 1);
});

// ── 2. templates ────────────────────────────────────────────────────────────

const BUILTINS = ["builtin:trip-packing", "builtin:new-hire-onboarding", "builtin:move-out", "builtin:weekly-review"];
const tasksOf = (listId: string) => rows("taskItem").filter((t) => t.listId === listId).sort((a, b) => a.position - b.position);

test("templates: everyone gets the four built-ins; a person and their agents see the person's saved ones, nobody else does", async () => {
  const mine = ok(await rest("GET", "/templates", SKYLAR)).templates;
  assert.deepEqual(mine.map((t: Row) => t.id), BUILTINS);
  assert.deepEqual(mine.map((t: Row) => t.kind), ["builtin", "builtin", "builtin", "builtin"]);
  assert.equal(mine[0].name, "Trip packing");
  assert.ok(mine.every((t: Row) => t.count >= 5 && t.preview.length === 5 && !("items" in t)));
  const id = await makeList("Sprint", [A1]);
  await addTask(id, SKYLAR, { title: "Plan", notes: "Monday" });
  const saved = ok(await rest("POST", "/templates", SKYLAR, { list_id: id })).template;
  assert.deepEqual([saved.kind, saved.name, saved.count, saved.preview], ["saved", "Sprint", 1, ["Plan"]]);
  assert.deepEqual(ok(await rest("GET", "/templates", as(A1))).templates.map((t: Row) => t.id), [...BUILTINS, saved.id], "the person's agent sees it");
  assert.deepEqual(ok(await rest("GET", "/templates", ALEX)).templates.map((t: Row) => t.id), BUILTINS, "Alex doesn't");
});

test("templates: a list from a built-in gets its tasks in order, written by whoever started it, and nothing else", async () => {
  const r = ok(await rest("POST", "", SKYLAR, { template: "builtin:trip-packing", agents: [A1] }));
  assert.deepEqual([r.list.name, r.list.emoji, r.tasks_added], ["Trip packing", "\u{1F9F3}", 10]);
  const made = tasksOf(r.list.id);
  assert.equal(made[0].title, "Passport or ID");
  assert.match(made[0].notes, /six months/);
  assert.ok(made.every((t) => t.createdByAccountId === A.id && t.createdByAgentId === null && t.status === "open" && !t.assigneeAccountId));
  assert.ok(made.every((t) => eventsOf(t.id).join() === "created"));
  // Name and emoji can be chosen; the template supplies only what's missing.
  const named = ok(await rest("POST", "", SKYLAR, { template: "builtin:move-out", name: "Leaving Elm St", emoji: "" })).list;
  assert.deepEqual([named.name, named.emoji], ["Leaving Elm St", null]);
  refused(await rest("POST", "", SKYLAR, { template: "builtin:moon-landing" }), 404, "no_such_template");
  refused(await rest("POST", "", SKYLAR, { template: "builtin:move-out", duplicate: r.list.id }), 400, "invalid_create");
  refused(await rest("POST", "", SKYLAR, { template: "builtin:move-out", name: `key ${"bc_" + "Z".repeat(40)}` }), 422, "secret_like");
  refused(await rest("POST", "", SKYLAR, { template: 42 }), 400, "invalid_template");
});

test("templates: bc_list_create {template} from an agent: a built-in or its person's own, by name or id; it gets work access", async () => {
  const tools = (await mcp(as(A1), "tools/list")).json.result.tools as Row[];
  const create = tools.find((t) => t.name === "bc_list_create")!;
  assert.ok(create.inputSchema.properties.template, "the schema takes a template");
  assert.equal(create.inputSchema.required, undefined, "name is optional when a template names the list");
  assert.match(create.description, /builtin:trip-packing/);

  const built = await tool(as(A1), "bc_list_create", { template: "builtin:weekly-review" });
  assert.equal(built.isError, false, JSON.stringify(built.body));
  assert.equal(built.body.list.name, "Weekly review");
  const list = built.body.list.id;
  assert.deepEqual(rows("taskListAgentGrant").filter((g) => g.listId === list).map((g) => [g.agentTokenId, g.access]), [[A1, "work"]]);
  assert.ok(tasksOf(list).every((t) => t.createdByAccountId === A.id && t.createdByAgentId === A1), "written by the agent that started it");

  const byName = await tool(as(A1), "bc_list_create", { template: "move out", name: "Moving" });
  assert.equal(byName.body.list.name, "Moving");
  const src = await makeList("Sprint", []);
  await addTask(src, SKYLAR, { title: "Plan the sprint" });
  const saved = ok(await rest("POST", "/templates", SKYLAR, { list_id: src, name: "Sprint kickoff" })).template;
  for (const ref of [saved.id, "sprint kickoff"]) {
    const r = await tool(as(A2), "bc_list_create", { template: ref });
    assert.equal(r.isError, false, JSON.stringify(r.body));
    assert.deepEqual(tasksOf(r.body.list.id).map((t) => t.title), ["Plan the sprint"]);
  }
  const theirs = await tool(as(B1), "bc_list_create", { template: saved.id });
  assert.deepEqual([theirs.httpStatus, theirs.body.error], [404, "no_such_template"], "someone else's saved template is out of reach");
  const missing = await tool(as(A1), "bc_list_create", { template: "Groceries" });
  assert.equal(missing.httpStatus, 404);
  assert.match(missing.body.message, /"Sprint kickoff"/);
  assert.match(missing.body.message, /builtin:trip-packing/);
  const noName = await tool(as(A1), "bc_list_create", {});
  assert.deepEqual([noName.httpStatus, noName.body.error], [400, "invalid_name"]);
  // An agent still can't copy a list: duplicate isn't in the tool, and REST refuses it.
  assert.equal((await tool(as(A1), "bc_list_create", { duplicate: src })).rpcError?.code, -32602);
  refused(await rest("POST", "", as(A1), { duplicate: src }), 403, "people_only");
});

test("templates: save as template keeps only unfinished tasks you or your agents wrote, in order; people only, with CSRF", async () => {
  const id = await sharedList("Trip", [A1], [B1]);
  await addTask(id, SKYLAR, { title: "Book flights", notes: "Window seats" });
  const alexs = await addTask(id, ALEX, { title: "Alex's idea" });
  await addTask(id, as(A1), { title: "Check passports" });
  const finished = await addTask(id, SKYLAR, { title: "Already done" });
  ok(await rest("POST", `/tasks/${finished.id}/done`, SKYLAR, {}));
  refused(await rest("POST", "/templates", as(A1), { list_id: id }), 403, "people_only");
  refused(await rest("POST", "/templates", { person: "A", csrf: "missing" }, { list_id: id }), 403, "csrf");
  refused(await rest("POST", "/templates", CAROL, { list_id: id }), 404, "not_available");
  const r = ok(await rest("POST", "/templates", SKYLAR, { list_id: id, name: "Trip prep", emoji: "✈" }));
  assert.equal(r.skipped, 1, "Alex's task stays out");
  const row = rows("taskListTemplate").find((t) => t.id === r.template.id)!;
  assert.deepEqual(row.items, [{ title: "Book flights", notes: "Window seats" }, { title: "Check passports", notes: "" }]);
  assert.deepEqual([row.ownerAccountId, row.name, row.emoji], [A.id, "Trip prep", "✈"]);
  assert.ok(!JSON.stringify(row.items).includes(alexs.title));
  // Alex saving the same list gets only his own.
  const his = ok(await rest("POST", "/templates", ALEX, { list_id: id }));
  assert.deepEqual([his.template.count, his.skipped, his.template.name], [1, 2, "Trip"]);
});

test("templates: refusals and limits: empty, too big, 50 per person, secret-shaped text, and delete is the owner's", async () => {
  const trip = await sharedList("Trip", [A1], [B1]);
  await addTask(trip, ALEX, { title: "Only Alex wrote this" });
  assert.match(refused(await rest("POST", "/templates", SKYLAR, { list_id: trip }), 400, "empty_template").message, /someone else/);
  const empty = await makeList("Empty", []);
  refused(await rest("POST", "/templates", SKYLAR, { list_id: empty }), 400, "empty_template");
  const big = await makeList("Big", []);
  for (let i = 0; i < 201; i++) seedRow("taskItem", { listId: big, title: `Task ${i}`, position: i + 1, createdByAccountId: A.id });
  refused(await rest("POST", "/templates", SKYLAR, { list_id: big }), 400, "template_too_big");
  const small = await makeList("Small", []);
  await addTask(small, SKYLAR, { title: "One thing" });
  refused(await rest("POST", "/templates", SKYLAR, { list_id: small, name: `x ${"bc_" + "Y".repeat(40)}` }), 422, "secret_like");
  // A stored template is checked again on the way out: secret-shaped text never becomes a task.
  const planted = seedRow("taskListTemplate", { ownerAccountId: A.id, name: "Planted", items: [{ title: "Rotate", notes: `AKIA${"Q".repeat(16)}` }] });
  refused(await rest("POST", "", SKYLAR, { template: planted.id }), 422, "secret_like");
  for (let i = rows("taskListTemplate").length; i < 50; i++) seedRow("taskListTemplate", { ownerAccountId: A.id, name: `T${i}`, items: [{ title: "x", notes: "" }] });
  refused(await rest("POST", "/templates", SKYLAR, { list_id: small }), 429, "too_many_templates");
  // Delete: the owner only, in the dashboard; anyone else's answer is the same as a missing one.
  refused(await rest("DELETE", `/templates/${planted.id}`, as(A1)), 403, "people_only");
  refused(await rest("DELETE", `/templates/${planted.id}`, ALEX), 404, "not_available");
  refused(await rest("DELETE", "/templates/builtin:trip-packing", SKYLAR), 404, "not_available");
  assert.deepEqual(ok(await rest("DELETE", `/templates/${planted.id}`, SKYLAR)), { deleted: true });
  refused(await rest("DELETE", `/templates/${planted.id}`, SKYLAR), 404, "not_available");
  assert.equal(rows("taskListTemplate").length, 49);
  // The migration's CHECK constraints hold underneath.
  const { prisma } = await import("@/lib/db");
  await assert.rejects(prisma.taskListTemplate.create({ data: { ownerAccountId: A.id, name: "None", items: [] } }), /TaskListTemplate_items_shape/);
  await assert.rejects(prisma.taskListTemplate.create({ data: { ownerAccountId: A.id, name: "", items: [{ title: "x" }] } }), /TaskListTemplate_name_size/);
  await assert.rejects(prisma.listsPreference.create({ data: { accountId: B.id, digest: "weekly" } }), /ListsPreference_digest_check/);
  await assert.rejects(prisma.listsPreference.create({ data: { accountId: B.id, digestHour: 24 } }), /ListsPreference_digestHour_check/);
});

test("duplicate: unfinished tasks' titles, notes and order; not assignees, claims, comments or history; authors kept", async () => {
  const id = await sharedList("Trip", [A1], [B1]);
  const a = await addTask(id, SKYLAR, { title: "Book flights", notes: "Window seats", assignee: "@alex", due: "2026-12-01" });
  const b = await addTask(id, ALEX, { title: "Alex's idea" });
  const c = await addTask(id, as(A1), { title: "Check passports" });
  const done = await addTask(id, SKYLAR, { title: "Already done" });
  ok(await rest("POST", `/tasks/${done.id}/done`, SKYLAR, {}));
  ok(await rest("POST", `/tasks/${c.id}/claim`, as(A1), {}));
  ok(await rest("POST", `/tasks/${a.id}/entries`, ALEX, { text: "On it soon" }));
  refused(await rest("POST", "", as(A1), { duplicate: id }), 403, "people_only");
  refused(await rest("POST", "", CAROL, { duplicate: id }), 404, "not_available");
  refused(await rest("POST", "", { person: "A", csrf: "missing" }, { duplicate: id }), 403, "csrf");

  const r = ok(await rest("POST", "", SKYLAR, { duplicate: id }));
  assert.deepEqual([r.list.name, r.list.shared, r.tasks_added], ["Trip (copy)", false, 3]);
  const copy = tasksOf(r.list.id);
  assert.deepEqual(copy.map((t) => [t.title, t.notes]), [["Book flights", "Window seats"], ["Alex's idea", ""], ["Check passports", ""]]);
  assert.ok(copy.every((t) => t.status === "open" && !t.assigneeAccountId && !t.claimAccountId && t.dueAt === null && t.version === 1));
  assert.deepEqual(copy.map((t) => [t.createdByAccountId, t.createdByAgentId]), [[A.id, null], [B.id, null], [A.id, A1]], "who wrote each is kept");
  for (const t of copy) {
    assert.deepEqual(entriesOf(t.id).map((e) => [e.kind, e.eventType, e.authorAccountId]), [["event", "copied", A.id]], "one line: who copied it");
  }
  assert.deepEqual(rows("taskListMember").filter((m) => m.listId === r.list.id).map((m) => m.accountId), [A.id], "a copy is yours alone");
  // Alex's task is still a request on the copy: Skylar's agents need her OK.
  const view = ok(await rest("GET", `/${r.list.id}`, SKYLAR)).tasks.find((t: Row) => t.title === "Alex's idea");
  assert.equal(view.agent_may_act.ok, false);
  assert.equal(view.created_by.person, "Alex");
  assert.equal(rows("taskItem").find((t) => t.id === b.id)!.listId, id, "the original is untouched");
});

// ── 3. the daily digest ─────────────────────────────────────────────────────

const SECRET = () => "s".repeat(24) + "-digest-" + "t".repeat(24);
const prefOf = (accountId: string) => rows("listsPreference").find((p) => p.accountId === accountId);
const run = async (now = new Date(), limits?: { batch: number; maxScan: number; maxSends: number }) =>
  (await import("@/lib/lists-digest")).runListsDigest(now, limits);
const dailyFor = (accountId: string, extra: Row = {}) => seedRow("listsPreference", { accountId, digest: "daily", digestHour: 0, timezone: "UTC", ...extra });

test("preferences: off by default, people only, validated; turning it on after today's hour waits for tomorrow", async () => {
  assert.deepEqual(ok(await rest("GET", "/preferences", SKYLAR)).preferences, { digest: "off", digest_hour: 8, timezone: null, last_digest_at: null, email_ready: true });
  refused(await rest("GET", "/preferences", as(A1)), 403, "people_only");
  refused(await rest("PATCH", "/preferences", as(A1), { digest: "daily" }), 403, "people_only");
  refused(await rest("PATCH", "/preferences", { person: "A", csrf: "missing" }, { digest: "daily" }), 403, "csrf");
  refused(await rest("PATCH", "/preferences", SKYLAR, { digest: "hourly" }), 400, "invalid_digest");
  refused(await rest("PATCH", "/preferences", SKYLAR, { digest_hour: 25 }), 400, "invalid_digest_hour");
  refused(await rest("PATCH", "/preferences", SKYLAR, { timezone: "Mars/Olympus" }), 400, "invalid_timezone");
  refused(await rest("PATCH", "/preferences", SKYLAR, {}), 400, "nothing_to_change");
  assert.equal(rows("listsPreference").length, 0, "refusals write nothing");

  // Hour 0 in UTC has always passed: today counts as had, so the first comes tomorrow.
  const on = ok(await rest("PATCH", "/preferences", SKYLAR, { digest: "daily", digest_hour: 0, timezone: "UTC" })).preferences;
  assert.deepEqual([on.digest, on.digest_hour, on.timezone], ["daily", 0, "UTC"]);
  assert.equal(prefOf(A.id)!.lastDigestAt.toISOString().slice(0, 10), new Date().toISOString().slice(0, 10));
  assert.equal((await run()).sent, 0, "not right away");
  // Changing the hour while it's on leaves that alone; off and on again re-anchors.
  ok(await rest("PATCH", "/preferences", SKYLAR, { digest_hour: 7 }));
  assert.equal(prefOf(A.id)!.digestHour, 7);
  ok(await rest("PATCH", "/preferences", SKYLAR, { digest: "off" }));
  assert.equal(ok(await rest("GET", "/preferences", SKYLAR)).preferences.digest, "off");
  // Nobody's digest is stored for Alex until he sets one.
  assert.equal(prefOf(B.id), undefined);
  // An unverified email shows in the settings.
  rows("account").find((a) => a.id === B.id)!.emailVerifiedAt = null;
  assert.equal(ok(await rest("GET", "/preferences", ALEX)).preferences.email_ready, false);
});

test("digest route: only the shared secret, in constant time; everything refused while the secret is unset or short", async () => {
  dailyFor(A.id);
  assert.deepEqual(await runDigestRoute(SECRET()), { status: 403, body: { error: "forbidden" } }, "unset");
  process.env.LISTS_DIGEST_SECRET = "short-secret";
  assert.equal((await runDigestRoute("short-secret")).status, 403, "a secret under 32 characters counts as unset");
  process.env.LISTS_DIGEST_SECRET = SECRET();
  for (const wrong of [undefined, "", SECRET().slice(0, -1), SECRET() + "x", SECRET().toUpperCase()]) {
    assert.equal((await runDigestRoute(wrong)).status, 403, `wrong: ${String(wrong).slice(0, 8)}`);
  }
  assert.equal(state.digests.length, 0);
  const r = await runDigestRoute(SECRET());
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ["checked", "due", "empty", "failed", "more", "not_sent", "sent", "skipped"]);
  assert.equal(r.body.checked, 1);
  const { digestSecretValid } = await import("@/lib/lists-digest");
  assert.equal(digestSecretValid(SECRET(), SECRET()), true);
  assert.equal(digestSecretValid(SECRET(), ""), false);
  assert.equal(digestSecretValid(null, SECRET()), false);
});

test("digest: what your agents finished, what needs your look or OK, what's overdue: titles and counts only, with a sign-in link", async () => {
  const work = await makeList("Work", [A1]);
  const t1 = await addTask(work, as(A1), { title: "Renew the Mimecast cert", notes: "PRIVATE-NOTES-1" });
  ok(await rest("POST", `/tasks/${t1.id}/done`, as(A1), { summary: "PRIVATE-SUMMARY renewed" }));
  const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10);
  await addTask(work, SKYLAR, { title: "Pay the invoice", due: yesterday, notes: "PRIVATE-NOTES-2" });
  await addTask(work, SKYLAR, { title: "Not overdue", due: new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10) });
  // A shared list: Alex's agent finishes Skylar's task (waits for her look), and Alex adds one for her agents (needs her OK).
  const trip = await sharedList("Trip", [A1], [B1]);
  const t2 = await addTask(trip, SKYLAR, { title: "Book the hotel" });
  ok(await rest("POST", `/tasks/${t2.id}/ok`, ALEX, {}));
  ok(await rest("POST", `/tasks/${t2.id}/done`, as(B1), { summary: "Booked" }));
  await addTask(trip, ALEX, { title: "Rent a car", assignee: "@skylar's agents" });
  const late = await addTask(trip, ALEX, { title: "Alex's overdue errand", assignee: "@alex", due: yesterday });
  dailyFor(A.id);
  await catchUpClock();

  const r = await run();
  assert.deepEqual([r.checked, r.due, r.sent, r.empty, r.failed], [1, 1, 1, 0, 0]);
  assert.equal(state.digests.length, 1);
  const mail = state.digests[0];
  assert.equal(mail.to, "skylar@example.invalid");
  assert.equal(mail.subject, "Your lists today: 1 finished, 2 for you, 1 overdue");
  assert.deepEqual(mail.sections, [
    { heading: "Your agents finished 1 task", lines: ["Renew the Mimecast cert (Work)"] },
    { heading: "2 tasks need your look or OK", lines: ["Book the hotel (Trip)", "Rent a car (Trip)"] },
    { heading: "1 task is overdue", lines: ["Pay the invoice (Work)"] },
  ]);
  assert.doesNotMatch(JSON.stringify(mail), /PRIVATE-|Alex's overdue errand/, "no notes or summaries, and nobody else's overdue task");
  assert.ok(late.id);
  const url = new URL(mail.url);
  assert.equal(url.pathname, "/account");
  assert.equal(url.searchParams.get("tab"), "lists");
  const vt = url.searchParams.get("vt")!;
  assert.ok(rows("viewToken").some((v) => v.token === `hash:${vt}` && v.accountId === A.id && v.purpose === "account"), "a one-time sign-in, stored hashed");
  assert.ok(prefOf(A.id)!.lastDigestAt instanceof Date);
});

test("digest: once per local day, idempotent across runs and overlapping runs; tomorrow brings the next", async () => {
  const work = await makeList("Work", [A1]);
  const t = await addTask(work, as(A1), { title: "Finished thing" });
  ok(await rest("POST", `/tasks/${t.id}/done`, as(A1), { summary: "Done" }));
  dailyFor(A.id);
  await catchUpClock();
  const now = new Date();
  const [x, y] = await Promise.all([run(now), run(now)]);
  assert.equal(x.sent + y.sent, 1, "two overlapping runs send one");
  assert.equal(state.digests.length, 1);
  assert.deepEqual([(await run(now)).checked, (await run(new Date(now.getTime() + 6 * 60 * MIN))).sent], [0, 0], "later today: nothing");
  const t2 = await addTask(work, as(A1), { title: "Next day's thing" });
  ok(await rest("POST", `/tasks/${t2.id}/done`, as(A1), { summary: "Done too" }));
  const tomorrow = await run(new Date(now.getTime() + DAY));
  assert.equal(tomorrow.sent, 1);
  assert.deepEqual(state.digests[1].sections[0].lines, ["Next day's thing (Work)"], "only what's new since the last one");
});

test("digest: a quiet day sends nothing; off, unverified email and not-yet-the-hour never send; log-only counts as not sent", async () => {
  const base = new Date();
  dailyFor(A.id);
  const quiet = await run(base);
  assert.deepEqual([quiet.due, quiet.empty, quiet.sent], [1, 1, 0]);
  assert.equal(state.digests.length, 0);
  assert.ok(prefOf(A.id)!.lastDigestAt, "today still counts as done");
  // Off, an unverified address, and an hour that hasn't come yet where Carol is.
  const work = await makeList("Work", [A1]);
  const t = await addTask(work, as(A1), { title: "Something" });
  ok(await rest("POST", `/tasks/${t.id}/done`, as(A1), { summary: "Done" }));
  prefOf(A.id)!.digest = "off";
  prefOf(A.id)!.lastDigestAt = null;
  rows("account").find((a) => a.id === B.id)!.emailVerifiedAt = null;
  dailyFor(B.id);
  const hour = base.getUTCHours();
  dailyFor(C.id, hour < 23 ? { timezone: "UTC", digestHour: hour + 1 } : { timezone: "Etc/GMT+1", digestHour: 23 }); // Etc/GMT+1 is UTC-1
  const r = await run(base);
  assert.deepEqual([r.checked, r.due, r.skipped, r.sent], [2, 1, 1, 0], "Skylar is off; Alex can't be emailed; Carol's hour hasn't come");
  // Without RESEND_API_KEY the sender logs and answers false: counted, not retried.
  prefOf(A.id)!.digest = "daily";
  state.digestSendOk = false;
  const logged = await run(base);
  assert.deepEqual([logged.due, logged.sent, logged.not_sent], [1, 0, 1]);
  assert.equal(state.digests.length, 1);
  assert.equal((await run(base)).due, 0, "not retried");
});

test("digest: batched and bounded per run; the rest wait for the next run", async () => {
  for (let i = 0; i < 5; i++) {
    const acct = seedRow("account", { handle: `p${i}`, email: `p${i}@example.invalid`, emailVerifiedAt: new Date() });
    dailyFor(acct.id);
  }
  const first = await run(new Date(), { batch: 2, maxScan: 10, maxSends: 3 });
  assert.deepEqual([first.due, first.empty, first.more], [3, 3, true]);
  const second = await run(new Date(), { batch: 2, maxScan: 10, maxSends: 3 });
  assert.deepEqual([second.checked, second.due, second.more], [2, 2, false], "the ones already done aren't even read");
  const scanBound = await run(new Date(Date.now() + DAY), { batch: 2, maxScan: 2, maxSends: 50 });
  assert.deepEqual([scanBound.checked, scanBound.more], [2, true]);
});

test("digest: a failure before sending puts today's claim back for the next run", async () => {
  dailyFor(A.id);
  state.txFaults.push(new Error("database went away"));
  const r = await run();
  assert.deepEqual([r.due, r.failed, r.sent], [1, 1, 0]);
  assert.equal(prefOf(A.id)!.lastDigestAt, null, "claim put back");
  assert.equal((await run()).due, 1, "the next run tries again");
});
