/**
 * Route tests for Lists Phase 1 over REST (/api/lists/[[...path]] → src/lib/lists.ts).
 * The MCP side is in lists-mcp.routetest.mts; the in-memory Prisma, the mocks and
 * the request helpers are in lists-harness.mts.
 *
 * Runs the real route handler, the real lists.ts and the real rules; only
 * Prisma, auth, the rate limiter and the inbox bus are replaced.
 *
 * Run with:
 *   node --experimental-strip-types --experimental-test-module-mocks \
 *        --import ./route-tests/register-hooks.mjs --test route-tests/*.routetest.mts
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  installMocks, resetStore, state, holdUntil, serializationFailure, rest, ok, refused, rows, taskRow, listRow, entriesOf, eventsOf,
  makeList, addTask, setAccess, catchUpClock, seedRow, as, SKYLAR, ALEX, A, B, A1, A2, A3, AR, B1, MIN, DAY, type Who, type Row,
} from "./lists-harness.mts";

before(() => installMocks());
beforeEach(() => resetStore());

const waiting = async () => (await import("@/lib/lists")).tasksWaitingForAgents(A.id);
const claim = (taskId: string, who: Who) => rest("POST", `/tasks/${taskId}/claim`, who, {});
const grantsOn = (listId: string) =>
  rows("taskListAgentGrant").filter((g) => g.listId === listId).map((g) => ({ agent: g.agentTokenId, access: g.access, by: g.accountId })).sort((x, y) => x.agent.localeCompare(y.agent));
const inAnHour = (d: Date | null) => !!d && d.getTime() > Date.now() + 55 * MIN && d.getTime() <= Date.now() + 61 * MIN;

// ── 1. auth ──────────────────────────────────────────────────────────────────

test("auth: no credentials or an unknown key → 401; a bearer context with no agent identity → 401 agent_key_required", async () => {
  refused(await rest("GET", "", null), 401, "unauthorized");
  refused(await rest("POST", "", null, { name: "Work" }), 401, "unauthorized");
  refused(await rest("GET", "/plate", { bearer: "bc_not_a_key" }), 401, "unauthorized");
  refused(await rest("GET", "/plate", as(AR)), 401, "unauthorized", "a revoked agent");
  for (const [method, path, body] of [["GET", "", undefined], ["GET", "/plate", undefined], ["POST", "", { name: "Work" }]] as const) {
    const r = refused(await rest(method, path, { bearer: "keyless" }, body), 401, "agent_key_required", `${method} ${path}`);
    assert.match(r.message, /per-agent key/);
  }
  // Fails closed for the people-only powers too: a keyless bearer is never treated as the person.
  const id = await makeList("Work", []);
  refused(await rest("PUT", `/${id}/agents`, { bearer: "keyless" }, { agent_id: A2, access: "work" }), 401, "agent_key_required");
  assert.deepEqual(grantsOn(id), []);
  assert.equal(rows("taskList").length, 1);
});

test("auth: the dashboard cookie reads without CSRF, and writes only with a matching CSRF token", async () => {
  const r = await rest("GET", "", { person: "A", csrf: "missing" });
  assert.deepEqual(ok(r).lists, []);
  assert.equal(r.headers.get("cache-control"), "no-store");
  for (const csrf of ["missing", "mismatched"] as const) {
    const res = refused(await rest("POST", "", { person: "A", csrf }, { name: "Work" }), 403, "csrf", csrf);
    assert.equal(res.message, "Refresh the page and try again.");
  }
  assert.equal(rows("taskList").length, 0, "a refused write wrote nothing");
  const id = await makeList("Work", []);
  refused(await rest("PATCH", `/${id}`, { person: "A", csrf: "mismatched" }, { name: "Renamed" }), 403, "csrf");
  refused(await setAccess(id, A1, "work", { person: "A", csrf: "missing" }), 403, "csrf");
  assert.equal(listRow(id).name, "Work");
  assert.deepEqual(grantsOn(id), []);
  ok(await rest("GET", `/${id}`, { person: "A", csrf: "missing" }), "GET needs no CSRF");
  ok(await rest("GET", "/plate", { person: "A", csrf: "mismatched" }), "GET needs no CSRF");
});

test("auth: a connector-scope agent key (claude.ai / ChatGPT over OAuth) works lists end to end", async () => {
  const created = ok(await rest("POST", "", as(A3), { name: "Packing" }));
  assert.deepEqual(grantsOn(created.list.id), [{ agent: A3, access: "work", by: A.id }]);
  const t = await addTask(created.list.id, as(A3), { title: "Sunscreen" });
  assert.equal(ok(await claim(t.id, as(A3))).task.claim.by.agent, "claude.ai");
  assert.deepEqual(ok(await rest("GET", "/plate", as(A3))).doing.map((x: Row) => x.id), [t.id]);
  // The dashboard shows it as hosted.
  const view = ok(await rest("GET", `/${created.list.id}`, SKYLAR));
  assert.deepEqual(view.your_agents.find((a: Row) => a.id === A3), { id: A3, name: "claude.ai", runtime_type: "other", last_used_at: null, hosted: true, access: "work" });
});

test("auth: rate limited → 429 with Retry-After", async () => {
  state.rateLimited = true;
  const r = refused(await rest("POST", "", SKYLAR, { name: "Work" }), 429, "rate_limited");
  assert.ok(r.message);
  assert.equal((await rest("GET", "", SKYLAR)).headers.get("retry-after"), "42");
  assert.equal(rows("taskList").length, 0);
});

// ── 2. creating lists ───────────────────────────────────────────────────────

test("create list as a person: work access for exactly the agents she picked, all of them hers", async () => {
  const r = ok(await rest("POST", "", SKYLAR, { name: "  Work  ", emoji: "💼", agents: [A1, A2, A1] }));
  assert.deepEqual(r.list, { id: r.list.id, name: "Work", emoji: "💼", archived: false, shared: false, your_role: "owner" });
  assert.deepEqual(grantsOn(r.list.id), [{ agent: A1, access: "work", by: A.id }, { agent: A2, access: "work", by: A.id }]);
  const members = rows("taskListMember").filter((m) => m.listId === r.list.id);
  assert.deepEqual(members.map((m) => ({ accountId: m.accountId, role: m.role, addedBy: m.addedByAccountId, takeFrom: m.agentsTakeFrom })), [
    { accountId: A.id, role: "owner", addedBy: A.id, takeFrom: "me" },
  ]);
  const solo = ok(await rest("POST", "", SKYLAR, { name: "Personal" }));
  assert.deepEqual(grantsOn(solo.list.id), [], "no agents picked: none get access");

  // Someone else's agent, a revoked one, or junk: refused, and nothing is written.
  for (const agents of [[A1, B1], [AR], ["not-an-agent"], "A1", [42]]) {
    refused(await rest("POST", "", SKYLAR, { name: "Nope", agents }), 400, "invalid_agents", JSON.stringify(agents));
  }
  assert.equal(rows("taskList").length, 2);
  assert.equal(rows("taskListMember").length, 2);
  assert.equal(rows("taskListAgentGrant").length, 2);
});

test("create list as an agent: it gets work access itself and nothing more, and can't pick agents", async () => {
  const r = ok(await rest("POST", "", as(A1), { name: "Vegas" }));
  assert.equal(r.list.your_role, "owner");
  assert.deepEqual(grantsOn(r.list.id), [{ agent: A1, access: "work", by: A.id }]);
  assert.equal(listRow(r.list.id).ownerAccountId, A.id, "the person owns it; agents are never members");
  for (const agents of [[A2], [], [A1]]) refused(await rest("POST", "", as(A1), { name: "Sneaky", agents }), 403, "people_only");
  assert.equal(rows("taskList").length, 1);
  refused(await rest("GET", `/${r.list.id}`, as(A2)), 404, "not_available", "the person's other agents get nothing by default");
  const view = ok(await rest("GET", `/${r.list.id}`, SKYLAR));
  assert.deepEqual(view.your_agents.map((a: Row) => [a.name, a.access]), [["Claude Code", "work"], ["Codex", "none"], ["claude.ai", "none"]]);
});

test("the 50-list limit counts live lists; archiving one makes room; other people are unaffected", async () => {
  for (let i = 0; i < 50; i++) ok(await rest("POST", "", SKYLAR, { name: `List ${i}` }));
  const r = refused(await rest("POST", "", SKYLAR, { name: "One too many" }), 429, "too_many_lists");
  assert.match(r.message, /50 lists/);
  refused(await rest("POST", "", as(A1), { name: "From an agent" }), 429, "too_many_lists", "an agent's lists are its person's");
  assert.equal(rows("taskList").length, 50);
  ok(await rest("PATCH", `/${rows("taskList")[0].id}`, SKYLAR, { archived: true }));
  ok(await rest("POST", "", SKYLAR, { name: "Fits now" }));
  ok(await rest("POST", "", ALEX, { name: "Alex's" }));
});

// ── 3. visibility ───────────────────────────────────────────────────────────

test("another account gets 404 not_available for the list and its tasks, never 403, identical to a list that doesn't exist", async () => {
  const id = await makeList("Work", [A1]);
  const t = await addTask(id, SKYLAR, { title: "Renew cert" });
  const ghostList = randomUUID();
  const ghostTask = randomUUID();
  const probes: Array<[string, string, unknown?]> = [
    ["GET", `/${id}`], ["GET", `/${id}/tasks`], ["PATCH", `/${id}`, { name: "Mine now" }], ["POST", `/${id}/tasks`, { title: "Planted" }],
    ["GET", `/tasks/${t.id}`], ["PATCH", `/tasks/${t.id}`, { progress: "hi" }], ["GET", `/tasks/${t.id}/entries`],
    ["POST", `/tasks/${t.id}/entries`, { text: "hi" }], ["POST", `/tasks/${t.id}/claim`, {}], ["POST", `/tasks/${t.id}/release`, {}],
    ["POST", `/tasks/${t.id}/done`, { summary: "did it" }], ["POST", `/tasks/${t.id}/review`, { verdict: "accept" }],
  ];
  for (const who of [ALEX, as(B1)]) {
    const probesFor = who === ALEX ? [...probes, ["PUT", `/${id}/agents`, { agent_id: B1, access: "work" }] as [string, string, unknown]] : probes;
    for (const [method, path, body] of probesFor) {
      const real = await rest(method as "GET", path, who, body);
      const ghost = await rest(method as "GET", path.replace(id, ghostList).replace(t.id, ghostTask), who, body);
      refused(real, 404, "not_available", `${JSON.stringify(who)} ${method} ${path}`);
      assert.deepEqual(real.body, ghost.body, `${method} ${path}: no difference between hidden and missing`);
    }
    assert.deepEqual(ok(await rest("GET", "", who)).lists, []);
    assert.deepEqual(ok(await rest("GET", "/search?q=cert", who)).tasks, []);
    const plate = ok(await rest("GET", "/plate", who));
    assert.deepEqual([plate.doing, plate.up_next, plate.claimable], [[], [], []]);
  }
  assert.equal(listRow(id).name, "Work");
  assert.equal(rows("taskItem").length, 1);
  assert.deepEqual(eventsOf(t.id), ["created"]);
  assert.equal(entriesOf(t.id).length, 1);
  assert.deepEqual(grantsOn(id), [{ agent: A1, access: "work", by: A.id }]);
});

test("an agent with no grant can't see the list at all", async () => {
  const id = await makeList("Work", [A1]);
  const t = await addTask(id, SKYLAR, { title: "Renew cert" });
  refused(await rest("GET", `/${id}`, as(A2)), 404, "not_available");
  refused(await rest("GET", `/${id}/tasks`, as(A2)), 404, "not_available");
  refused(await rest("GET", `/tasks/${t.id}`, as(A2)), 404, "not_available");
  refused(await claim(t.id, as(A2)), 404, "not_available");
  refused(await rest("POST", `/tasks/${t.id}/entries`, as(A2), { text: "hi" }), 404, "not_available");
  assert.deepEqual(ok(await rest("GET", "", as(A2))).lists, []);
  assert.deepEqual(ok(await rest("GET", "/search", as(A2))).tasks, []);
  const plate = ok(await rest("GET", "/plate", as(A2)));
  assert.deepEqual(plate.lists, []);
  assert.match(plate.hint, /No lists are shared with this agent/);
  // The agent that has the grant does see it.
  assert.deepEqual(ok(await rest("GET", "", as(A1))).lists.map((l: Row) => l.name), ["Work"]);
  assert.deepEqual(ok(await rest("GET", "/plate", as(A1))).claimable.map((x: Row) => x.id), [t.id]);
});

test("a view agent can read and comment, but can't claim, add, add progress, edit or finish", async () => {
  const id = await makeList("Work", [A1]);
  ok(await setAccess(id, A2, "view"));
  const t = await addTask(id, SKYLAR, { title: "Renew cert" });
  ok(await rest("GET", `/${id}`, as(A2)));
  ok(await rest("GET", `/tasks/${t.id}`, as(A2)));
  const commented = ok(await rest("POST", `/tasks/${t.id}/entries`, as(A2), { text: "Expiry is Oct 28" }));
  assert.equal(commented.task.id, t.id);
  refused(await claim(t.id, as(A2)), 403, "not_allowed", "claim");
  refused(await rest("POST", `/${id}/tasks`, as(A2), { title: "More work" }), 403, "not_allowed", "add");
  refused(await rest("POST", `/tasks/${t.id}/entries`, as(A2), { kind: "progress", text: "step" }), 403, "not_allowed", "progress entry");
  refused(await rest("PATCH", `/tasks/${t.id}`, as(A2), { progress: "step" }), 403, "not_allowed", "progress");
  refused(await rest("PATCH", `/tasks/${t.id}`, as(A2), { title: "Renamed", version: 1 }), 403, "not_allowed", "edit");
  refused(await rest("POST", `/tasks/${t.id}/done`, as(A2), { summary: "did it" }), 403, "not_allowed", "done");
  assert.equal(taskRow(t.id).status, "open");
  assert.equal(taskRow(t.id).claimAccountId, null);
  assert.equal(rows("taskItem").length, 1);
  assert.deepEqual(entriesOf(t.id).map((e) => [e.kind, e.authorAgentId, e.body]), [
    ["event", null, "added this task"],
    ["comment", A2, "Expiry is Oct 28"],
  ]);
  // Nothing a view agent can't do is offered to it as claimable.
  assert.deepEqual(ok(await rest("GET", "/plate", as(A2))).claimable, []);
});

// ── 4. adding tasks ─────────────────────────────────────────────────────────

test("add a task by list id: attributed to the agent and its person, appended, with a created line", async () => {
  const id = await makeList("Work", [A1]);
  const r = ok(await rest("POST", `/${id}/tasks`, as(A1), { title: "Renew the Mimecast cert", notes: "Expires **Oct 28**", due: "2026-10-28", assignee: "me" }));
  const v = r.tasks[0];
  assert.deepEqual(v.list, { id, name: "Work", shared: false });
  assert.equal(v.title, "Renew the Mimecast cert");
  assert.equal(v.notes, "Expires **Oct 28**");
  assert.equal(v.status, "open");
  assert.equal(v.version, 1);
  assert.equal(v.due, "2026-10-28T12:00:00.000Z");
  assert.deepEqual(v.created_by, { person: "Skylar", handle: "skylar", agent: "Claude Code", agent_id: A1, is_you: true, is_this_agent: true });
  assert.deepEqual(v.assignee, { kind: "person", person: "Skylar", handle: "skylar", agent: null, agent_id: null, is_you: true, is_this_agent: false });
  assert.equal(v.claim, null);
  assert.equal(v.agent_may_act.ok, true);
  const row = taskRow(v.id);
  assert.equal(row.createdByAccountId, A.id);
  assert.equal(row.createdByAgentId, A1);
  assert.equal(row.position, 1024);
  assert.deepEqual(entriesOf(v.id).map((e) => [e.kind, e.eventType, e.authorAccountId, e.authorAgentId]), [["event", "created", A.id, A1]]);
  const second = await addTask(id, SKYLAR, { title: "Second" });
  assert.equal(taskRow(second.id).position, 2048);
  assert.equal(taskRow(second.id).createdByAgentId, null);
  assert.deepEqual(state.fired, [], "a task for the person doesn't ring the agents' doorbell");
});

test("batch add: 20 at once, in order; 21 or none is refused; one bad item rolls the whole batch back", async () => {
  const id = await makeList("Work", [A1]);
  const twenty = Array.from({ length: 20 }, (_, i) => ({ title: `Item ${i + 1}` }));
  const r = ok(await rest("POST", `/${id}/tasks`, as(A1), { tasks: twenty }));
  assert.deepEqual(r.tasks.map((x: Row) => x.title), twenty.map((x) => x.title));
  const positions = r.tasks.map((x: Row) => taskRow(x.id).position);
  assert.deepEqual(positions, twenty.map((_, i) => 1024 * (i + 1)));
  refused(await rest("POST", `/${id}/tasks`, as(A1), { tasks: [...twenty, { title: "Item 21" }] }), 400, "invalid_tasks");
  refused(await rest("POST", `/${id}/tasks`, as(A1), { tasks: [] }), 400, "invalid_tasks");
  refused(await rest("POST", `/${id}/tasks`, as(A1), { tasks: [{ title: "fine" }, { title: "   " }] }), 400, "invalid_title");
  refused(await rest("POST", `/${id}/tasks`, as(A1), { tasks: [{ title: "fine" }, "junk"] }), 400, "invalid_tasks");
  refused(await rest("POST", `/${id}/tasks`, as(A1), { tasks: [{ title: "fine" }, { title: "x".repeat(201) }] }), 400, "invalid_title");
  refused(await rest("POST", `/${id}/tasks`, as(A1), { tasks: [{ title: "fine" }, { title: "late", due: "someday" }] }), 400, "invalid_due");
  assert.equal(rows("taskItem").length, 20);
  assert.equal(rows("taskEntry").length, 20);
});

test("secret-shaped text is refused with 422 secret_like wherever it appears, and nothing is stored or echoed", async () => {
  const key = `bc_${"Zq9-x_7Lm2".repeat(4)}abc`; // bc_ + 43 characters
  assert.equal(key.length, 46);
  const id = await makeList("Work", [A1]);
  const t = await addTask(id, as(A1), { title: "Rotate the key" });
  const attempts: Array<[string, string, Who, unknown]> = [
    ["POST", `/${id}/tasks`, as(A1), { title: `Use ${key}` }],
    ["POST", `/${id}/tasks`, SKYLAR, { title: "Rotate", notes: `the old one was ${key}` }],
    ["POST", `/${id}/tasks`, as(A1), { tasks: [{ title: "fine" }, { title: "also fine", notes: key }] }],
    ["POST", `/${id}/tasks`, SKYLAR, { title: "AWS AKIAABCDEFGHIJKLMNOP" }],
    ["PATCH", `/tasks/${t.id}`, as(A1), { progress: `new key ${key}` }],
    ["PATCH", `/tasks/${t.id}`, as(A1), { notes: key, version: 1 }],
    ["POST", `/tasks/${t.id}/entries`, as(A1), { text: `here: ${key}` }],
    ["POST", `/tasks/${t.id}/done`, SKYLAR, { summary: `rotated to ${key}` }],
  ];
  for (const [method, path, who, body] of attempts) {
    const r = refused(await rest(method as "POST", path, who, body), 422, "secret_like", `${method} ${path}`);
    assert.match(r.message, /looks like a password or key/);
    assert.ok(!JSON.stringify(r).includes(key), "the refusal never echoes the secret");
  }
  assert.equal(rows("taskItem").length, 1);
  assert.deepEqual(entriesOf(t.id).map((e) => e.eventType), ["created"]);
  assert.equal(taskRow(t.id).status, "open");
  assert.equal(taskRow(t.id).notes, "");
  assert.ok(!JSON.stringify(state.db).includes(key));
});

test("a task for my_agents or one agent rings the doorbell once, after commit; a task for the person, or nobody, doesn't", async () => {
  const id = await makeList("Work", [A1]);
  ok(await rest("POST", `/${id}/tasks`, SKYLAR, { tasks: [{ title: "a", assignee: "my_agents" }, { title: "b", assignee: "my agents" }, { title: "c", assignee: A1 }] }));
  assert.deepEqual(state.fired, [{ accountId: A.id, kind: "task", committedTasks: 3 }], "one ring for the batch, after the tasks were committed");
  state.fired = [];
  await addTask(id, SKYLAR, { title: "for me", assignee: "me" });
  await addTask(id, SKYLAR, { title: "anyone", assignee: "nobody" });
  await addTask(id, SKYLAR, { title: "unassigned" });
  assert.deepEqual(state.fired, []);
  // An agent without work access here, someone else's agent, a revoked one: refused, nothing written, no ring.
  for (const assignee of [A2, B1, AR]) refused(await rest("POST", `/${id}/tasks`, SKYLAR, { title: "x", assignee }), 400, "invalid_assignee", assignee);
  ok(await setAccess(id, A2, "view"));
  const r = refused(await rest("POST", `/${id}/tasks`, SKYLAR, { title: "x", assignee: A2 }), 400, "invalid_assignee", "view isn't work");
  assert.match(r.message, /Codex can't work on this list yet/);
  refused(await rest("POST", `/${id}/tasks`, SKYLAR, { title: "x", assignee: "this_agent" }), 400, "invalid_assignee", "a person isn't an agent");
  refused(await rest("POST", `/${id}/tasks`, SKYLAR, { title: "x", assignee: "the intern" }), 400, "invalid_assignee");
  assert.equal(rows("taskItem").length, 6);
  assert.deepEqual(state.fired, []);
  // An attempt that aborts at commit and is re-run rings once, for the attempt that committed.
  state.txFaults = [serializationFailure()];
  state.txCalls = 0;
  await addTask(id, as(A1), { title: "retried", assignee: "this_agent" });
  assert.equal(state.txCalls, 2);
  assert.equal(rows("taskItem").filter((x) => x.title === "retried").length, 1);
  assert.deepEqual(state.fired, [{ accountId: A.id, kind: "task", committedTasks: 7 }]);
  // Reassigning to the agents rings too.
  state.fired = [];
  const t = await addTask(id, SKYLAR, { title: "later" });
  ok(await rest("PATCH", `/tasks/${t.id}`, SKYLAR, { assignee: "my_agents" }));
  assert.deepEqual(state.fired.map((f) => f.kind), ["task"]);
  assert.deepEqual(eventsOf(t.id), ["created", "assigned"]);
});

// ── 5. claims ───────────────────────────────────────────────────────────────

test("two agents race to claim: exactly one wins and the loser hears who has it (serializable abort, then retry)", async () => {
  const id = await makeList("Work", [A1, A2]);
  const t = await addTask(id, SKYLAR, { title: "Renew cert" });
  state.txCalls = 0;
  holdUntil(2); // both transactions take their snapshot before either commits
  const [r1, r2] = await Promise.all([claim(t.id, as(A1)), claim(t.id, as(A2))]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  const [win, lose, winner] = r1.status === 200 ? [r1, r2, A1] : [r2, r1, A2];
  refused(lose, 409, "already_claimed");
  assert.equal(lose.body.claim.by.agent_id, winner);
  assert.equal(lose.body.claim.by.person, "Skylar");
  assert.equal(lose.body.claim.by.is_this_agent, false);
  assert.equal(lose.body.claim.since, taskRow(t.id).claimedAt.toISOString());
  assert.match(lose.body.message, new RegExp(`^Skylar's ${winner === A1 ? "Claude Code" : "Codex"} is already on this`));
  assert.equal(win.body.task.claim.by.agent_id, winner);
  assert.equal(state.txCalls, 3, "the loser's first attempt aborted at commit and was re-run");
  assert.equal(taskRow(t.id).claimAgentId, winner);
  assert.deepEqual(eventsOf(t.id), ["created", "claimed"]);
});

test("without serializable isolation, the conditional claim write alone still lets exactly one agent win", async () => {
  const id = await makeList("Work", [A1, A2]);
  const t = await addTask(id, SKYLAR, { title: "Renew cert" });
  state.txMode = "live";
  state.txCalls = 0;
  holdUntil(2);
  const [r1, r2] = await Promise.all([claim(t.id, as(A1)), claim(t.id, as(A2))]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  const [lose, winner] = r1.status === 200 ? [r2, A1] : [r1, A2];
  refused(lose, 409, "already_claimed");
  assert.match(lose.body.message, /just picked this up/, "the loser passed the rules on a stale read and lost at the conditional write");
  assert.equal(state.txCalls, 2);
  assert.equal(taskRow(t.id).claimAgentId, winner);
  assert.deepEqual(eventsOf(t.id), ["created", "claimed"], "the loser's event was rolled back");
});

test("the claimant re-claiming is idempotent and renews; a person's claim never lapses", async () => {
  const id = await makeList("Work", [A1, A2]);
  const t = await addTask(id, SKYLAR, { title: "Renew cert" });
  const first = ok(await claim(t.id, as(A1)));
  assert.equal(first.task.status, "in_progress");
  assert.equal(first.task.claim.by.is_this_agent, true);
  assert.ok(inAnHour(taskRow(t.id).claimExpiresAt));
  assert.equal(first.task.claim.lapses_at, taskRow(t.id).claimExpiresAt.toISOString());
  const claimedAt = taskRow(t.id).claimedAt.getTime();
  taskRow(t.id).claimExpiresAt = new Date(Date.now() + 5 * MIN);
  const again = ok(await claim(t.id, as(A1)));
  assert.equal(again.task.claim.by.agent_id, A1);
  assert.equal(taskRow(t.id).claimedAt.getTime(), claimedAt, "same claim, not a new one");
  assert.ok(inAnHour(taskRow(t.id).claimExpiresAt), "re-claiming renews");
  assert.deepEqual(eventsOf(t.id), ["created", "claimed"], "no second claimed line");

  const p = await addTask(id, SKYLAR, { title: "Book flights" });
  const mine = ok(await claim(p.id, SKYLAR));
  assert.equal(mine.task.claim.lapses_at, null);
  assert.equal(taskRow(p.id).claimExpiresAt, null);
  assert.equal(taskRow(p.id).claimAgentId, null);
  // Weeks later it's still hers: no lapse, just a "still on it?" hint.
  taskRow(p.id).claimedAt = new Date(Date.now() - 30 * DAY);
  taskRow(p.id).updatedAt = new Date(Date.now() - 30 * DAY);
  const later = ok(await rest("GET", `/tasks/${p.id}`, SKYLAR));
  assert.equal(later.task.status, "in_progress");
  assert.equal(later.task.claim.stale, true);
  const taken = refused(await claim(p.id, as(A1)), 409, "already_claimed");
  assert.deepEqual([taken.claim.by.person, taken.claim.by.agent], ["Skylar", null]);
  assert.equal(taskRow(p.id).claimAccountId, A.id);
});

test("an agent's claim that ran out is released on the next read, with an activity line quoting its last progress", async () => {
  const id = await makeList("Work", [A1, A2]);
  const t = await addTask(id, SKYLAR, { title: "Renew cert" });
  ok(await claim(t.id, as(A1)));
  ok(await rest("PATCH", `/tasks/${t.id}`, as(A1), { progress: "Checked expiry: Oct 28" }));
  ok(await rest("PATCH", `/tasks/${t.id}`, as(A1), { progress: "Renewed in portal, waiting on DNS" }));
  ok(await rest("POST", `/tasks/${t.id}/entries`, as(A2), { kind: "progress", text: "Codex: DNS looks fine from here" }));
  taskRow(t.id).claimExpiresAt = new Date(Date.now() - 1_000);

  const read = ok(await rest("GET", `/tasks/${t.id}`, SKYLAR));
  assert.equal(read.task.status, "open");
  assert.equal(read.task.claim, null);
  const row = taskRow(t.id);
  assert.deepEqual([row.status, row.claimAccountId, row.claimAgentId, row.claimedAt, row.claimExpiresAt], ["open", null, null, null, null]);
  const lapsed = entriesOf(t.id).filter((e) => e.eventType === "lapsed");
  assert.equal(lapsed.length, 1);
  assert.deepEqual([lapsed[0].authorAccountId, lapsed[0].authorAgentId], [A.id, A1], "attributed to the agent that went quiet");
  assert.equal(lapsed[0].body, 'stopped working on this (no word for an hour): last progress was "Renewed in portal, waiting on DNS"');
  const shown = read.task.entries.at(-1);
  assert.equal(shown.event, "lapsed");
  assert.equal(shown.by.agent, "Claude Code");
  // Announced once, not on every read; and the task can be picked up again.
  ok(await rest("GET", `/tasks/${t.id}`, SKYLAR));
  ok(await rest("GET", `/${id}`, SKYLAR));
  assert.equal(entriesOf(t.id).filter((e) => e.eventType === "lapsed").length, 1);
  assert.equal(ok(await claim(t.id, as(A2))).task.claim.by.agent_id, A2);
});

test("a lapse is settled by any read (list, plate, search), keeps a blocked task blocked, and reads plainly with no progress", async () => {
  const id = await makeList("Work", [A1]);
  const quiet = await addTask(id, SKYLAR, { title: "Quiet" });
  const stuck = await addTask(id, SKYLAR, { title: "Stuck" });
  const found = await addTask(id, SKYLAR, { title: "Findable cert" });
  for (const t of [quiet, stuck, found]) ok(await claim(t.id, as(A1)));
  ok(await rest("PATCH", `/tasks/${stuck.id}`, as(A1), { status: "blocked", reason: "needs a login" }));
  for (const t of [quiet, stuck, found]) taskRow(t.id).claimExpiresAt = new Date(Date.now() - 1);
  const list = ok(await rest("GET", `/${id}`, SKYLAR));
  assert.deepEqual(list.tasks.map((x: Row) => [x.title, x.status, x.claim]), [["Quiet", "open", null], ["Stuck", "blocked", null], ["Findable cert", "open", null]]);
  assert.equal(taskRow(stuck.id).status, "blocked");
  assert.equal(entriesOf(quiet.id).find((e) => e.eventType === "lapsed")!.body, "stopped working on this (no word for an hour)");

  const again = await addTask(id, SKYLAR, { title: "Via plate" });
  ok(await claim(again.id, as(A1)));
  taskRow(again.id).claimExpiresAt = new Date(Date.now() - 1);
  const plate = ok(await rest("GET", "/plate", as(A1)));
  assert.deepEqual(plate.doing, []);
  assert.ok(plate.claimable.some((x: Row) => x.id === again.id));
  assert.deepEqual(eventsOf(again.id), ["created", "claimed", "lapsed"]);

  const viaSearch = await addTask(id, SKYLAR, { title: "Via search" });
  ok(await claim(viaSearch.id, as(A1)));
  taskRow(viaSearch.id).claimExpiresAt = new Date(Date.now() - 1);
  const s = ok(await rest("GET", "/search?q=via%20SEARCH", SKYLAR));
  assert.deepEqual(s.tasks.map((x: Row) => [x.title, x.status]), [["Via search", "open"]]);
  assert.deepEqual(eventsOf(viaSearch.id), ["created", "claimed", "lapsed"]);
});

test("any write by the claiming agent pushes its claim out an hour; nobody else's write does", async () => {
  const id = await makeList("Work", [A1, A2]);
  const t = await addTask(id, SKYLAR, { title: "Renew cert" });
  ok(await claim(t.id, as(A1)));
  const mine: Array<[string, () => ReturnType<typeof rest>]> = [
    ["progress via PATCH", () => rest("PATCH", `/tasks/${t.id}`, as(A1), { progress: "step" })],
    ["progress entry", () => rest("POST", `/tasks/${t.id}/entries`, as(A1), { kind: "progress", text: "step" })],
    ["comment", () => rest("POST", `/tasks/${t.id}/entries`, as(A1), { text: "a note" })],
    ["notes edit", () => rest("PATCH", `/tasks/${t.id}`, as(A1), { notes: `edit ${Date.now()}`, version: taskRow(t.id).version })],
    ["due date", () => rest("PATCH", `/tasks/${t.id}`, as(A1), { due: "2026-11-01" })],
  ];
  for (const [label, write] of mine) {
    taskRow(t.id).claimExpiresAt = new Date(Date.now() + 5 * MIN);
    ok(await write(), label);
    assert.ok(inAnHour(taskRow(t.id).claimExpiresAt), `${label} renews`);
  }
  const others: Array<[string, () => ReturnType<typeof rest>]> = [
    ["another agent's progress", () => rest("PATCH", `/tasks/${t.id}`, as(A2), { progress: "Codex was here" })],
    ["another agent's progress entry", () => rest("POST", `/tasks/${t.id}/entries`, as(A2), { kind: "progress", text: "Codex again" })],
    ["another agent's comment", () => rest("POST", `/tasks/${t.id}/entries`, as(A2), { text: "hi" })],
    ["another agent re-claiming", () => claim(t.id, as(A2))],
    ["the person's comment", () => rest("POST", `/tasks/${t.id}/entries`, SKYLAR, { text: "how's it going?" })],
    ["the person's progress", () => rest("PATCH", `/tasks/${t.id}`, SKYLAR, { progress: "nudged" })],
  ];
  for (const [label, write] of others) {
    const soon = new Date(Date.now() + 5 * MIN);
    taskRow(t.id).claimExpiresAt = soon;
    await write();
    assert.equal(taskRow(t.id).claimExpiresAt.getTime(), soon.getTime(), `${label} doesn't renew A1's claim`);
    assert.equal(taskRow(t.id).claimAgentId, A1);
  }
});

test("release: the claimant (with a reason) or the list owner; anyone else is refused", async () => {
  const id = await makeList("Work", [A1, A2]);
  const t = await addTask(id, SKYLAR, { title: "Renew cert" });
  refused(await rest("POST", `/tasks/${t.id}/release`, as(A1), {}), 409, "not_claimed");
  ok(await claim(t.id, as(A1)));
  refused(await rest("POST", `/tasks/${t.id}/release`, as(A2), {}), 403, "not_claimant");
  const r = ok(await rest("POST", `/tasks/${t.id}/release`, as(A1), { reason: "needs Skylar's login" }));
  assert.equal(r.task.status, "open");
  assert.equal(entriesOf(t.id).at(-1)!.body, "let go of this: needs Skylar's login");
  ok(await claim(t.id, as(A2)));
  ok(await rest("POST", `/tasks/${t.id}/release`, SKYLAR, {}), "the owner may force a release");
  assert.equal(taskRow(t.id).claimAgentId, null);
});

// ── 6. finishing and review ─────────────────────────────────────────────────

test("finishing: an agent must say what it did; done records who finished, keeps the summary and clears the claim", async () => {
  const id = await makeList("Work", [A1, A2]);
  const t = await addTask(id, SKYLAR, { title: "Renew cert" });
  ok(await claim(t.id, as(A1)));
  refused(await rest("POST", `/tasks/${t.id}/done`, as(A1), {}), 400, "summary_required");
  refused(await rest("POST", `/tasks/${t.id}/done`, as(A1), { summary: "   " }), 400, "summary_required");
  assert.equal(taskRow(t.id).status, "in_progress");
  assert.equal(taskRow(t.id).claimAgentId, A1);
  const d = ok(await rest("POST", `/tasks/${t.id}/done`, as(A1), { summary: "Renewed; new expiry 2027-10-28", evidence: "checked in the portal" }));
  assert.equal(d.task.status, "done");
  assert.equal(d.task.summary, "Renewed; new expiry 2027-10-28\n\nEvidence: checked in the portal");
  assert.equal(d.task.claim, null);
  assert.equal(d.task.completed_by.agent_id, A1);
  assert.ok(d.task.send_back_until);
  const row = taskRow(t.id);
  assert.deepEqual(
    [row.status, row.completedByAccountId, row.completedByAgentId, row.reviewerAccountId, row.claimAccountId, row.claimAgentId, row.claimExpiresAt],
    ["done", A.id, A1, null, null, null, null],
  );
  assert.ok(row.completedAt instanceof Date);
  assert.deepEqual(eventsOf(t.id), ["created", "claimed", "done"]);
  refused(await rest("POST", `/tasks/${t.id}/done`, as(A1), { summary: "again" }), 409, "not_finishable");
});

test("finishing a task someone else holds is refused; the list owner may finish over an agent's claim", async () => {
  const id = await makeList("Work", [A1, A2]);
  const t = await addTask(id, SKYLAR, { title: "Renew cert" });
  ok(await claim(t.id, as(A1)));
  const r = refused(await rest("POST", `/tasks/${t.id}/done`, as(A2), { summary: "I did it" }), 409, "already_claimed");
  assert.match(r.message, /Skylar's Claude Code is already on this/);
  assert.equal(taskRow(t.id).status, "in_progress");
  const d = ok(await rest("POST", `/tasks/${t.id}/done`, SKYLAR, {}), "a person needs no summary");
  assert.equal(d.task.status, "done");
  const row = taskRow(t.id);
  assert.deepEqual([row.completedByAccountId, row.completedByAgentId, row.claimAgentId, row.summary], [A.id, null, null, null]);
  // An agent may claim-and-finish an unheld task in one go.
  const t2 = await addTask(id, SKYLAR, { title: "Order toner" });
  ok(await rest("POST", `/tasks/${t2.id}/done`, as(A2), { summary: "Ordered, arrives Tuesday" }));
  assert.equal(taskRow(t2.id).completedByAgentId, A2);
});

test("send back: within 7 days the person returns an agent's finished work to the same agent with a comment; agents can't review", async () => {
  const id = await makeList("Work", [A1]);
  const t = await addTask(id, SKYLAR, { title: "Renew cert" });
  ok(await claim(t.id, as(A1)));
  ok(await rest("POST", `/tasks/${t.id}/done`, as(A1), { summary: "Renewed" }));
  refused(await rest("POST", `/tasks/${t.id}/review`, as(A1), { verdict: "send_back", comment: "redo" }), 403, "people_only");
  refused(await rest("POST", `/tasks/${t.id}/review`, SKYLAR, { verdict: "send_back" }), 400, "invalid_comment");
  refused(await rest("POST", `/tasks/${t.id}/review`, SKYLAR, { verdict: "maybe" }), 400, "invalid_verdict");
  assert.equal(taskRow(t.id).status, "done");

  const r = ok(await rest("POST", `/tasks/${t.id}/review`, SKYLAR, { verdict: "send_back", comment: "The expiry still shows 2026" }));
  assert.equal(r.task.status, "in_progress");
  assert.equal(r.task.claim.by.agent_id, A1);
  const row = taskRow(t.id);
  assert.deepEqual([row.claimAccountId, row.claimAgentId, row.completedAt, row.completedByAgentId, row.summary], [A.id, A1, null, null, null]);
  assert.ok(inAnHour(row.claimExpiresAt), "a fresh agent claim, which lapses as usual");
  const comment = entriesOf(t.id).find((e) => e.kind === "comment")!;
  assert.deepEqual([comment.authorAccountId, comment.authorAgentId, comment.body], [A.id, null, "The expiry still shows 2026"]);
  assert.deepEqual(eventsOf(t.id), ["created", "claimed", "done", "sent_back"]);
  // The agent picks it straight back up.
  assert.equal(ok(await rest("GET", "/plate", as(A1))).doing[0].id, t.id);
  ok(await rest("PATCH", `/tasks/${t.id}`, as(A1), { progress: "Fixed the expiry" }));
  ok(await rest("POST", `/tasks/${t.id}/done`, as(A1), { summary: "Renewed for real" }));

  taskRow(t.id).completedAt = new Date(Date.now() - 8 * DAY);
  refused(await rest("POST", `/tasks/${t.id}/review`, SKYLAR, { verdict: "send_back", comment: "late" }), 409, "too_late");
  const mine = await addTask(id, SKYLAR, { title: "My own" });
  ok(await rest("POST", `/tasks/${mine.id}/done`, SKYLAR, {}));
  refused(await rest("POST", `/tasks/${mine.id}/review`, SKYLAR, { verdict: "send_back", comment: "hmm" }), 409, "not_reviewable");
});

test("a friend's task on a shared list: their agent needs the OK, its finished work waits for the asker's look", async () => {
  // Phase 2 sharing has no API yet; the rows are what it will write.
  const id = await makeList("Trip", [A1]);
  state.db.taskListMember.push({ listId: id, accountId: B.id, role: "member", agentsTakeFrom: "me", addedByAccountId: A.id, joinedAt: new Date() });
  refused(await setAccess(id, B1, "work"), 400, "invalid_agent", "Skylar can't grant Alex's agent");
  ok(await setAccess(id, B1, "work", ALEX), "Alex grants his own");
  const t = await addTask(id, SKYLAR, { title: "Book the Airbnb" });
  const seen = ok(await rest("GET", `/tasks/${t.id}`, as(B1)));
  assert.equal(seen.task.list.shared, true);
  assert.equal(seen.task.agent_may_act.ok, false);
  assert.match(seen.task.agent_may_act.why, /^Skylar wrote this/);
  refused(await claim(t.id, as(B1)), 409, "needs_ok");
  assert.deepEqual(ok(await rest("GET", "/plate", as(B1))).claimable, []);
  rows("taskListMember").find((m) => m.accountId === B.id)!.agentsTakeFrom = "anyone";
  ok(await claim(t.id, as(B1)));
  const done = ok(await rest("POST", `/tasks/${t.id}/done`, as(B1), { summary: "Booked, confirmation 4411" }));
  assert.equal(done.task.status, "needs_review");
  assert.equal(taskRow(t.id).reviewerAccountId, A.id);
  assert.deepEqual(ok(await rest("GET", "/plate", SKYLAR)).waiting_on_you.map((x: Row) => x.id), [t.id]);
  refused(await rest("POST", `/tasks/${t.id}/review`, ALEX, { verdict: "accept" }), 403, "not_reviewer");
  ok(await rest("POST", `/tasks/${t.id}/review`, SKYLAR, { verdict: "accept" }));
  assert.equal(taskRow(t.id).status, "done");
  assert.deepEqual(eventsOf(t.id), ["created", "claimed", "needs_review", "accepted"]);
});

// ── 7. edits ────────────────────────────────────────────────────────────────

test("title and notes edits need the version that was read; a stale one gets edit_conflict with the current text", async () => {
  const id = await makeList("Work", [A1]);
  const t = await addTask(id, SKYLAR, { title: "Renew cert", notes: "v1" });
  refused(await rest("PATCH", `/tasks/${t.id}`, as(A1), { notes: "v2" }), 400, "version_required");
  refused(await rest("PATCH", `/tasks/${t.id}`, as(A1), { notes: "v2", version: "1" }), 400, "version_required");
  const r = ok(await rest("PATCH", `/tasks/${t.id}`, as(A1), { notes: "v2", version: 1 }));
  assert.equal(r.task.version, 2);
  assert.equal(r.task.notes, "v2");
  assert.deepEqual(eventsOf(t.id), ["created", "edited"]);
  const c = refused(await rest("PATCH", `/tasks/${t.id}`, SKYLAR, { title: "Renew the Mimecast cert", version: 1 }), 409, "edit_conflict");
  assert.deepEqual(c.current, { title: "Renew cert", notes: "v2", version: 2 });
  assert.equal(taskRow(t.id).title, "Renew cert");
  assert.equal(ok(await rest("PATCH", `/tasks/${t.id}`, SKYLAR, { title: "Renew the Mimecast cert", version: 2 })).task.version, 3);
  refused(await rest("PATCH", `/tasks/${t.id}`, SKYLAR, { title: "", version: 3 }), 400, "invalid_title");
  // Due dates and progress need no version and don't bump it.
  ok(await rest("PATCH", `/tasks/${t.id}`, SKYLAR, { due: "2026-11-01", progress: "pushed a week" }));
  assert.equal(taskRow(t.id).version, 3);
  assert.equal(taskRow(t.id).dueAt.toISOString(), "2026-11-01T12:00:00.000Z");
  ok(await rest("PATCH", `/tasks/${t.id}`, SKYLAR, { due: "" }));
  assert.equal(taskRow(t.id).dueAt, null);
  refused(await rest("PATCH", `/tasks/${t.id}`, SKYLAR, {}), 400, "nothing_to_change");
  assert.deepEqual(eventsOf(t.id), ["created", "edited", "edited"]);
});

// ── 8. status ───────────────────────────────────────────────────────────────

test("status: blocking needs a reason; unblocking returns to in_progress while someone holds it, open otherwise", async () => {
  const id = await makeList("Work", [A1, A2]);
  const t = await addTask(id, SKYLAR, { title: "Renew cert" });
  ok(await claim(t.id, as(A1)));
  refused(await rest("PATCH", `/tasks/${t.id}`, as(A1), { status: "blocked" }), 400, "invalid_reason");
  refused(await rest("PATCH", `/tasks/${t.id}`, as(A1), { status: "blocked", reason: "  " }), 400, "invalid_reason");
  const b = ok(await rest("PATCH", `/tasks/${t.id}`, as(A1), { status: "blocked", reason: "Needs Skylar's login" }));
  assert.equal(b.task.status, "blocked");
  assert.equal(b.task.claim.by.agent_id, A1, "blocked keeps the claim");
  assert.equal(entriesOf(t.id).at(-1)!.body, "marked this blocked: Needs Skylar's login");
  refused(await rest("PATCH", `/tasks/${t.id}`, as(A2), { status: "unblocked" }), 409, "already_claimed");
  assert.equal(ok(await rest("PATCH", `/tasks/${t.id}`, as(A1), { status: "unblocked" })).task.status, "in_progress");

  const t2 = await addTask(id, SKYLAR, { title: "Waiting on vendor" });
  assert.equal(ok(await rest("PATCH", `/tasks/${t2.id}`, SKYLAR, { status: "blocked", reason: "vendor" })).task.status, "blocked");
  assert.equal(ok(await rest("PATCH", `/tasks/${t2.id}`, SKYLAR, { status: "unblocked" })).task.status, "open");
  refused(await rest("PATCH", `/tasks/${t2.id}`, SKYLAR, { status: "unblocked" }), 409, "bad_status");
  refused(await rest("PATCH", `/tasks/${t2.id}`, SKYLAR, { status: "done" }), 400, "invalid_status");
  refused(await rest("PATCH", `/tasks/${t2.id}`, SKYLAR, { status: "in_progress" }), 400, "invalid_status");
});

test("status: agents can't drop, restore or reopen; a person can", async () => {
  const id = await makeList("Work", [A1]);
  const t = await addTask(id, SKYLAR, { title: "Renew cert" });
  ok(await claim(t.id, as(A1)));
  for (const status of ["dropped", "restored", "reopened"]) refused(await rest("PATCH", `/tasks/${t.id}`, as(A1), { status }), 403, "people_only", status);
  const dropped = ok(await rest("PATCH", `/tasks/${t.id}`, SKYLAR, { status: "dropped", reason: "not needed" }));
  assert.equal(dropped.task.status, "dropped");
  assert.equal(taskRow(t.id).claimAgentId, null, "dropping clears the claim");
  refused(await rest("PATCH", `/tasks/${t.id}`, as(A1), { status: "restored" }), 403, "people_only");
  assert.equal(ok(await rest("PATCH", `/tasks/${t.id}`, SKYLAR, { status: "restored" })).task.status, "open");
  ok(await rest("POST", `/tasks/${t.id}/done`, as(A1), { summary: "done after all" }));
  refused(await rest("PATCH", `/tasks/${t.id}`, as(A1), { status: "reopened" }), 403, "people_only");
  const reopened = ok(await rest("PATCH", `/tasks/${t.id}`, SKYLAR, { status: "reopened" }));
  assert.equal(reopened.task.status, "open");
  assert.deepEqual([taskRow(t.id).completedAt, taskRow(t.id).completedByAgentId, taskRow(t.id).summary], [null, null, null]);
  assert.deepEqual(eventsOf(t.id), ["created", "claimed", "dropped", "restored", "done", "reopened"]);
});

// ── 9. agent access ─────────────────────────────────────────────────────────

test("which agents work a list is a person's call, in the dashboard, for her own agents only", async () => {
  const id = await makeList("Work", [A1]);
  for (const [agent, access] of [[A2, "work"], [A1, "none"], [A1, "work"]] as const) {
    const r = refused(await setAccess(id, agent, access, as(A1)), 403, "people_only");
    assert.match(r.message, /Only a person/);
  }
  refused(await setAccess(id, A2, "work", as(B1)), 403, "people_only");
  refused(await setAccess(id, A2, "work", { person: "A", csrf: "missing" }), 403, "csrf");
  assert.deepEqual(grantsOn(id), [{ agent: A1, access: "work", by: A.id }]);

  assert.deepEqual(ok(await setAccess(id, A2, "view")), { agent_id: A2, access: "view" });
  assert.deepEqual(grantsOn(id), [{ agent: A1, access: "work", by: A.id }, { agent: A2, access: "view", by: A.id }]);
  ok(await setAccess(id, A2, "work"));
  assert.deepEqual(grantsOn(id), [{ agent: A1, access: "work", by: A.id }, { agent: A2, access: "work", by: A.id }], "replaced, not duplicated");
  ok(await rest("GET", `/${id}`, as(A2)));
  ok(await setAccess(id, A2, "none"));
  ok(await setAccess(id, A2, "none"));
  assert.deepEqual(grantsOn(id), [{ agent: A1, access: "work", by: A.id }]);
  refused(await rest("GET", `/${id}`, as(A2)), 404, "not_available", "removing access takes effect at once");

  refused(await setAccess(id, B1, "work"), 400, "invalid_agent", "someone else's agent");
  refused(await setAccess(id, AR, "work"), 400, "invalid_agent", "a revoked agent");
  refused(await setAccess(id, A2, "admin" as "work"), 400, "invalid_access");
  refused(await rest("PUT", `/${id}/agents`, SKYLAR, { access: "work" }), 400, "invalid_access");
  refused(await setAccess(id, B1, "work", ALEX), 404, "not_available", "only on lists you're on");
  assert.deepEqual(grantsOn(id), [{ agent: A1, access: "work", by: A.id }]);
});

// ── 10. the plate ───────────────────────────────────────────────────────────

test("an agent's plate: doing, up next and claimable, each by due date then position; reading up next marks it seen", async () => {
  const { tasksWaitingForAgents } = await import("@/lib/lists");
  const id = await makeList("Work", [A1, A2]);
  const day = (n: number) => new Date(Date.now() + n * DAY).toISOString();
  const add = (title: string, extra: Row = {}) => addTask(id, SKYLAR, { title, ...extra });
  const cNoDue = await add("claimable, no due");
  const cIn3 = await add("claimable, due in 3 days", { due: day(3) });
  const cIn1 = await add("claimable, due tomorrow", { due: day(1) });
  const uA1 = await add("for Claude Code", { assignee: A1 });
  const uAgents = await add("for any agent, due in 2 days", { assignee: "my_agents", due: day(2) });
  const uA2 = await add("for Codex", { assignee: A2 });
  const forSkylar = await add("for Skylar", { assignee: "me" });
  const dLater = await add("doing, due in 5 days", { due: day(5) });
  const dSooner = await add("doing, due tomorrow", { due: day(1) });
  const codexDoing = await add("Codex is on it");
  ok(await claim(dLater.id, as(A1)));
  ok(await claim(dSooner.id, as(A1)));
  ok(await claim(codexDoing.id, as(A2)));

  assert.equal(await tasksWaitingForAgents(A.id), 3);
  const plate = ok(await rest("GET", "/plate", as(A1)));
  assert.deepEqual(Object.keys(plate), ["lists", "doing", "up_next", "claimable", "waiting_on_you", "done_recently"]);
  const ids = (xs: Row[]) => xs.map((x) => x.id);
  assert.deepEqual(ids(plate.doing), [dSooner.id, dLater.id]);
  assert.deepEqual(ids(plate.up_next), [uAgents.id, uA1.id]);
  assert.deepEqual(ids(plate.claimable), [cIn1.id, cIn3.id, cNoDue.id]);
  assert.deepEqual([plate.waiting_on_you, plate.done_recently], [[], []]);
  assert.deepEqual(plate.lists, [{ id, name: "Work", emoji: null, shared: false }]);
  for (const x of [...plate.doing, ...plate.up_next, ...plate.claimable]) assert.equal(x.agent_may_act.ok, true);
  assert.ok(![uA2.id, forSkylar.id, codexDoing.id].some((x) => JSON.stringify(plate).includes(x)));

  assert.ok(taskRow(uA1.id).agentSeenAt instanceof Date);
  assert.ok(taskRow(uAgents.id).agentSeenAt instanceof Date);
  assert.equal(taskRow(uA2.id).agentSeenAt, null);
  assert.equal(await tasksWaitingForAgents(A.id), 1, "Codex's task still waits");
  const seenAt = taskRow(uAgents.id).agentSeenAt.getTime();
  const codex = ok(await rest("GET", "/plate", as(A2)));
  assert.deepEqual(ids(codex.up_next), [uAgents.id, uA2.id]);
  assert.deepEqual(ids(codex.doing), [codexDoing.id]);
  assert.equal(await tasksWaitingForAgents(A.id), 0);
  assert.equal(taskRow(uAgents.id).agentSeenAt.getTime(), seenAt, "first sight is kept");
});

test("a person's plate: her claims and her agents', what's for her, and what her agents finished in the last day", async () => {
  const id = await makeList("Work", [A1, A2]);
  const forMe = await addTask(id, SKYLAR, { title: "for me", assignee: "me" });
  const agentsDoing = await addTask(id, SKYLAR, { title: "Claude Code's on it" });
  const finished = await addTask(id, SKYLAR, { title: "finished by Codex" });
  const old = await addTask(id, SKYLAR, { title: "finished two days ago" });
  const hers = await addTask(id, SKYLAR, { title: "finished by Skylar" });
  const open = await addTask(id, SKYLAR, { title: "anyone's" });
  ok(await claim(agentsDoing.id, as(A1)));
  ok(await rest("POST", `/tasks/${finished.id}/done`, as(A2), { summary: "Done" }));
  ok(await rest("POST", `/tasks/${old.id}/done`, as(A2), { summary: "Done earlier" }));
  taskRow(old.id).completedAt = new Date(Date.now() - 2 * DAY);
  ok(await rest("POST", `/tasks/${hers.id}/done`, SKYLAR, {}));
  const plate = ok(await rest("GET", "/plate", SKYLAR));
  const ids = (xs: Row[]) => xs.map((x) => x.id);
  assert.deepEqual(ids(plate.doing), [agentsDoing.id]);
  assert.deepEqual(ids(plate.up_next), [forMe.id]);
  assert.deepEqual(ids(plate.claimable), [open.id]);
  assert.deepEqual(ids(plate.done_recently), [finished.id]);
  assert.equal(plate.done_recently[0].completed_by.agent, "Codex");
  assert.ok(plate.done_recently[0].send_back_until);
  assert.deepEqual(ok(await rest("GET", "/plate", as(A2))).done_recently, [], "agents don't get done_recently");
});

test("a view-only agent's plate doesn't offer, or mark as seen, work it can't do", async () => {
  const { tasksWaitingForAgents } = await import("@/lib/lists");
  const id = await makeList("Work", [A1]);
  ok(await setAccess(id, A2, "view"));
  const t = await addTask(id, SKYLAR, { title: "Renew cert", assignee: "my_agents" });
  assert.equal(await tasksWaitingForAgents(A.id), 1);
  const viewer = ok(await rest("GET", "/plate", as(A2)));
  assert.deepEqual(viewer.up_next, [], "Codex can only look here, so the task isn't up next for it");
  assert.equal(taskRow(t.id).agentSeenAt, null);
  assert.equal(await tasksWaitingForAgents(A.id), 1, "the doorbell keeps ringing for an agent that can do it");
  refused(await claim(t.id, as(A2)), 403, "not_allowed");
  assert.deepEqual(ok(await rest("GET", "/plate", as(A1))).up_next.map((x: Row) => x.id), [t.id]);
  assert.equal(await tasksWaitingForAgents(A.id), 0);
});

// ── 11. archived lists ──────────────────────────────────────────────────────

test("an archived list refuses every write with 409 archived; reads still work; unarchiving restores it", async () => {
  const id = await makeList("Work", [A1]);
  const t = await addTask(id, SKYLAR, { title: "Renew cert", assignee: "my_agents" });
  const held = await addTask(id, SKYLAR, { title: "Held" });
  ok(await claim(held.id, as(A1)));
  const { tasksWaitingForAgents } = await import("@/lib/lists");
  assert.equal(await tasksWaitingForAgents(A.id), 1);
  refused(await rest("PATCH", `/${id}`, as(A1), { archived: true }), 403, "not_allowed", "only the owner, in person");
  refused(await rest("PATCH", `/${id}`, SKYLAR, { archived: "yes" }), 400, "invalid_archived");
  const archived = ok(await rest("PATCH", `/${id}`, SKYLAR, { archived: true }));
  assert.equal(archived.list.archived, true);
  assert.ok(listRow(id).archivedAt instanceof Date);
  assert.equal(await tasksWaitingForAgents(A.id), 0, "an archived list doesn't ring");

  const writes: Array<[string, string, Who, unknown]> = [
    ["POST", `/${id}/tasks`, SKYLAR, { title: "More" }],
    ["POST", `/${id}/tasks`, as(A1), { title: "More" }],
    ["PATCH", `/tasks/${t.id}`, SKYLAR, { progress: "x" }],
    ["PATCH", `/tasks/${t.id}`, SKYLAR, { title: "Renamed", version: 1 }],
    ["POST", `/tasks/${t.id}/claim`, as(A1), {}],
    ["POST", `/tasks/${held.id}/release`, as(A1), {}],
    ["POST", `/tasks/${held.id}/done`, as(A1), { summary: "x" }],
    ["POST", `/tasks/${t.id}/done`, SKYLAR, {}],
    ["POST", `/tasks/${t.id}/review`, SKYLAR, { verdict: "accept" }],
    ["POST", `/tasks/${t.id}/entries`, SKYLAR, { text: "hello?" }],
    ["POST", `/tasks/${t.id}/entries`, as(A1), { kind: "progress", text: "x" }],
  ];
  const before = JSON.stringify(state.db.taskItem);
  for (const [method, path, who, body] of writes) {
    const r = refused(await rest(method as "POST", path, who, body), 409, "archived", `${method} ${path}`);
    assert.match(r.message, /Unarchive it/);
  }
  assert.equal(JSON.stringify(state.db.taskItem), before, "nothing changed");

  // Reads.
  const list = ok(await rest("GET", `/${id}`, SKYLAR));
  assert.equal(list.list.archived, true);
  assert.equal(list.tasks.length, 2);
  assert.equal(ok(await rest("GET", `/tasks/${t.id}`, SKYLAR)).task.title, "Renew cert");
  assert.ok(ok(await rest("GET", `/tasks/${t.id}/entries`, SKYLAR)).entries.length >= 1);
  assert.deepEqual(ok(await rest("GET", `/${id}/tasks`, SKYLAR)).tasks.map((x: Row) => x.id).sort(), [t.id, held.id].sort(), "the list's tasks");
  assert.deepEqual(ok(await rest("GET", "", SKYLAR)).lists.map((l: Row) => [l.name, l.archived]), [["Work", true]], "a person still sees it, marked archived");
  ok(await rest("GET", `/tasks/${t.id}`, as(A1)));
  assert.deepEqual(ok(await rest("GET", "", as(A1))).lists, [], "agents stop seeing it");
  assert.deepEqual(ok(await rest("GET", "/plate", as(A1))).doing, []);

  ok(await rest("PATCH", `/${id}`, SKYLAR, { archived: false }));
  ok(await rest("PATCH", `/tasks/${held.id}`, as(A1), { progress: "back at it" }));
  assert.equal((await addTask(id, SKYLAR, { title: "More" })).status, "open");
});

// ── overview, edits racing, entries, limits, failures ───────────────────────

test("the lists overview: counts by status and the person's agent grants; agents see their lists only; only the owner renames", async () => {
  const work = await makeList("Work", [A1]);
  const house = await makeList("House", [A2]);
  const made: Row[] = [];
  for (const title of ["open", "doing", "stuck", "finished", "dropped"]) made.push(await addTask(work, SKYLAR, { title }));
  const [open, doing, stuck, finished, dropped] = made;
  ok(await claim(doing.id, as(A1)));
  ok(await rest("PATCH", `/tasks/${stuck.id}`, SKYLAR, { status: "blocked", reason: "vendor" }));
  ok(await rest("POST", `/tasks/${finished.id}/done`, SKYLAR, {}));
  ok(await rest("PATCH", `/tasks/${dropped.id}`, SKYLAR, { status: "dropped" }));
  assert.ok(open.id);
  const mine = ok(await rest("GET", "", SKYLAR)).lists;
  assert.deepEqual(mine, [
    { id: work, name: "Work", emoji: null, archived: false, shared: false, your_role: "owner", counts: { open: 1, in_progress: 1, blocked: 1, needs_review: 0, done: 1 }, agents: [{ agent_id: A1, access: "work" }] },
    { id: house, name: "House", emoji: null, archived: false, shared: false, your_role: "owner", counts: { open: 0, in_progress: 0, blocked: 0, needs_review: 0, done: 0 }, agents: [{ agent_id: A2, access: "work" }] },
  ]);
  const agents = ok(await rest("GET", "", as(A1))).lists;
  assert.deepEqual(agents.map((l: Row) => l.id), [work]);
  assert.equal("agents" in agents[0], false, "an agent isn't shown its person's grants");

  refused(await rest("PATCH", `/${work}`, as(A1), { name: "Mine" }), 403, "not_allowed");
  refused(await rest("PATCH", `/${work}`, SKYLAR, { name: "  " }), 400, "invalid_name");
  refused(await rest("PATCH", `/${work}`, SKYLAR, {}), 400, "nothing_to_change");
  refused(await rest("POST", "", SKYLAR, { name: "" }), 400, "invalid_name");
  refused(await rest("POST", "", SKYLAR, { name: "x".repeat(81) }), 400, "invalid_name");
  assert.deepEqual(ok(await rest("PATCH", `/${work}`, SKYLAR, { name: "Day job", emoji: "💼" })).list, { id: work, name: "Day job", emoji: "💼", archived: false });
  assert.equal(ok(await rest("PATCH", `/${work}`, SKYLAR, { emoji: null })).list.emoji, null);
  assert.equal(listRow(work).name, "Day job");
});

test("two edits made against the same version: one lands, the other gets edit_conflict with the winner's text", async () => {
  const id = await makeList("Work", [A1]);
  const t = await addTask(id, SKYLAR, { title: "Renew cert", notes: "v1" });
  holdUntil(2);
  const [r1, r2] = await Promise.all([
    rest("PATCH", `/tasks/${t.id}`, as(A1), { notes: "from Claude Code", version: 1 }),
    rest("PATCH", `/tasks/${t.id}`, SKYLAR, { notes: "from Skylar", version: 1 }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  const [win, lose] = r1.status === 200 ? [r1, r2] : [r2, r1];
  refused(lose, 409, "edit_conflict");
  assert.deepEqual(lose.body.current, { title: "Renew cert", notes: win.body.task.notes, version: 2 });
  assert.deepEqual([taskRow(t.id).notes, taskRow(t.id).version], [win.body.task.notes, 2]);
  assert.deepEqual(eventsOf(t.id), ["created", "edited"]);
});

test("entries page newest-first 50 at a time, shown oldest-first, with before= for older ones", async () => {
  const id = await makeList("Work", [A1]);
  const t = await addTask(id, SKYLAR, { title: "Long thread" });
  for (let i = 1; i <= 60; i++) seedRow("taskEntry", { taskId: t.id, kind: "comment", authorAccountId: A.id, body: `comment ${i}` });
  const first = ok(await rest("GET", `/tasks/${t.id}/entries`, as(A1)));
  assert.equal(first.more, true);
  assert.deepEqual(first.entries.map((e: Row) => e.text), Array.from({ length: 50 }, (_, i) => `comment ${i + 11}`));
  const older = ok(await rest("GET", `/tasks/${t.id}/entries?before=${first.entries[0].id}`, as(A1)));
  assert.equal(older.more, undefined);
  assert.deepEqual(older.entries.map((e: Row) => e.text), ["added this task", ...Array.from({ length: 10 }, (_, i) => `comment ${i + 1}`)]);
  // bc_task_get / GET task carries the latest 50 too.
  const got = ok(await rest("GET", `/tasks/${t.id}`, as(A1)));
  assert.equal(got.task.entries.length, 50);
  assert.equal(got.task.entries.at(-1).text, "comment 60");
});

test("limits: 500 comments and progress lines per task; 2,000 open tasks per list (finished ones don't count)", async () => {
  const id = await makeList("Work", [A1]);
  const t = await addTask(id, SKYLAR, { title: "Chatty" });
  for (let i = 0; i < 499; i++) seedRow("taskEntry", { taskId: t.id, kind: i % 2 ? "comment" : "progress", authorAccountId: A.id, body: `line ${i}` });
  ok(await rest("POST", `/tasks/${t.id}/entries`, as(A1), { text: "the 500th" }));
  refused(await rest("POST", `/tasks/${t.id}/entries`, as(A1), { text: "the 501st" }), 429, "too_many_entries");
  refused(await rest("PATCH", `/tasks/${t.id}`, as(A1), { progress: "one more" }), 429, "too_many_entries");
  ok(await claim(t.id, as(A1)), "activity lines aren't capped");

  const busy = await makeList("Busy", [A1]);
  for (let i = 0; i < 1_999; i++) seedRow("taskItem", { listId: busy, title: `t${i}`, position: 1024 * (i + 1), createdByAccountId: A.id });
  refused(await rest("POST", `/${busy}/tasks`, as(A1), { tasks: [{ title: "a" }, { title: "b" }] }), 429, "too_many_tasks");
  const last = await addTask(busy, as(A1), { title: "the 2000th" });
  assert.equal(taskRow(last.id).position, 1024 * 2_000, "appended after the last position");
  refused(await rest("POST", `/${busy}/tasks`, as(A1), { title: "2001" }), 429, "too_many_tasks");
  rows("taskItem").find((x) => x.listId === busy && x.title === "t0")!.status = "done";
  await addTask(busy, as(A1), { title: "room again" });
});

test("failures: exhausted serialization retries → 503 busy (retryable); anything else → 503 unavailable, not retried, content never logged", async (t) => {
  const id = await makeList("Work", [A1]);
  state.txFaults = Array.from({ length: 5 }, serializationFailure);
  state.txCalls = 0;
  const busy = await rest("POST", `/${id}/tasks`, as(A1), { title: "Renew the Mimecast cert" });
  refused(busy, 503, "busy");
  assert.equal(busy.body.retryable, true);
  assert.equal(busy.headers.get("retry-after"), "1");
  assert.equal(state.txCalls, 5, "bounded: five attempts");
  assert.equal(rows("taskItem").length, 0);
  assert.deepEqual(state.fired, []);

  const logged: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
  state.txFaults = [new Error('insert into "TaskItem" failed for "Renew the Mimecast cert" (Bearer key-secret)')];
  state.txCalls = 0;
  const down = await rest("POST", `/${id}/tasks`, as(A1), { title: "Renew the Mimecast cert" });
  refused(down, 503, "unavailable");
  assert.equal(state.txCalls, 1, "not a conflict, so not retried");
  assert.equal(rows("taskItem").length, 0);
  assert.deepEqual(logged, ["[lists] addTasks failed: Error"]);
});

// ── search and changes ──────────────────────────────────────────────────────

test("search and changes: case-insensitive words in title or notes across visible lists; changes tracks writes", async () => {
  const work = await makeList("Work", [A1]);
  const house = await makeList("House", []);
  const cert = await addTask(work, SKYLAR, { title: "Renew Mimecast CERT" });
  const notes = await addTask(work, SKYLAR, { title: "Vendor call", notes: "ask about the cert price" });
  await addTask(work, SKYLAR, { title: "Unrelated" });
  const houseCert = await addTask(house, SKYLAR, { title: "Certify the boiler" });
  const ids = (r: Row) => r.tasks.map((x: Row) => x.id);
  assert.deepEqual(ids(ok(await rest("GET", "/search?q=cert", SKYLAR))).sort(), [cert.id, notes.id, houseCert.id].sort());
  assert.deepEqual(ids(ok(await rest("GET", "/search?q=cert", as(A1)))), [cert.id, notes.id], "the agent only searches lists it's on");
  assert.deepEqual(ids(ok(await rest("GET", `/${house}/tasks?q=CERT`, SKYLAR))), [houseCert.id]);
  ok(await rest("POST", `/tasks/${cert.id}/done`, SKYLAR, {}));
  assert.deepEqual(ids(ok(await rest("GET", `/${work}/tasks?status=done`, SKYLAR))), [cert.id]);
  assert.ok(!ids(ok(await rest("GET", `/${work}/tasks`, SKYLAR))).includes(cert.id), "finished tasks are left out by default");
  refused(await rest("GET", "/search?status=finished", SKYLAR), 400, "invalid_status");

  assert.equal(ok(await rest("GET", "/changes", SKYLAR)).changed, true, "no since: changed");
  await catchUpClock();
  const { at } = ok(await rest("GET", "/changes", SKYLAR));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(ok(await rest("GET", `/changes?since=${encodeURIComponent(at)}`, SKYLAR)).changed, false);
  ok(await rest("PATCH", `/tasks/${notes.id}`, SKYLAR, { progress: "called them" }));
  assert.equal(ok(await rest("GET", `/changes?since=${encodeURIComponent(at)}`, SKYLAR)).changed, true);
  assert.equal(ok(await rest("GET", `/changes?since=${encodeURIComponent(at)}`, ALEX)).changed, false, "nobody else's changes leak");
});

// ── 13. the REST map ────────────────────────────────────────────────────────

test("REST map: unknown paths and wrong methods are 404 not_found, before auth", async () => {
  const id = await makeList("Work", [A1]);
  const t = await addTask(id, SKYLAR, { title: "Renew cert" });
  const unknown: Array<[string, string]> = [
    ["GET", "/tasks"], ["POST", "/tasks"], ["POST", "/plate"], ["POST", "/search"], ["POST", "/changes"], ["PUT", ""], ["PATCH", ""],
    ["GET", `/${id}/agents`], ["POST", `/${id}/agents`], ["PATCH", `/${id}/agents`], ["GET", `/${id}/members`], ["PUT", `/${id}`], ["PUT", `/${id}/tasks`],
    ["PUT", `/tasks/${t.id}`], ["POST", `/tasks/${t.id}`], ["GET", `/tasks/${t.id}/claim`], ["PATCH", `/tasks/${t.id}/done`], ["POST", `/tasks/${t.id}/ok`],
    ["PUT", `/tasks/${t.id}/entries`], ["GET", "/plate/today"],
    // Extra trailing segments must not silently alias a shorter route.
    ["GET", `/${id}/tasks/${t.id}`], ["PATCH", `/${id}/tasks/${t.id}`], ["POST", `/${id}/tasks/bulk`], ["PUT", `/${id}/agents/${A2}`],
    ["POST", `/tasks/${t.id}/claim/now`], ["GET", `/tasks/${t.id}/entries/older`], ["GET", `/${id}/x/y/z`],
  ];
  for (const who of [SKYLAR, null]) {
    for (const [method, path] of unknown) {
      const r = refused(await rest(method as "GET", path, who, method === "GET" ? undefined : { title: "x", agent_id: A2, access: "work" }), 404, "not_found", `${method} ${path}`);
      assert.equal(r.message, "No such lists endpoint.");
    }
  }
  assert.equal(rows("taskItem").length, 1, "nothing was written by an unmapped path");
  assert.deepEqual(eventsOf(t.id), ["created"]);
  assert.deepEqual(grantsOn(id), [{ agent: A1, access: "work", by: A.id }]);
  // A non-id where an id goes reads as a list that isn't there.
  refused(await rest("GET", "/not-a-uuid", SKYLAR), 404, "not_available");
  refused(await rest("GET", "/tasks/not-a-uuid", SKYLAR), 404, "not_available");
  // Bodies must be JSON objects.
  refused(await rest("POST", "", SKYLAR, "{not json"), 400, "invalid_json");
  refused(await rest("POST", "", SKYLAR, "[1,2]"), 400, "invalid_json");
  refused(await rest("POST", `/${id}/tasks`, SKYLAR, "null"), 400, "invalid_json");
});

// ── follow-ups from review ──────────────────────────────────────────────────

test("auth comes before the body: an unauthenticated caller with a malformed body hears 401, not 400", async () => {
  refused(await rest("POST", "", null, "{not json"), 401, "unauthorized");
  const id = await makeList("Work", [A1]);
  refused(await rest("POST", `/${id}/tasks`, null, "{not json"), 401, "unauthorized");
  refused(await rest("POST", `/${id}/tasks`, as(A1), "{not json"), 400, "invalid_json", "an authenticated caller still hears what's wrong");
});

test("taking an agent's work access away releases what it holds on that list, with a line saying why", async () => {
  const id = await makeList("Work", [A1]);
  const t = await addTask(id, as(A1), { title: "Renew the cert" });
  ok(await claim(t.id, as(A1)), "claim");
  ok(await setAccess(id, A1, "view"), "downgrade to view");
  assert.equal(taskRow(t.id).claimAgentId, null);
  assert.equal(taskRow(t.id).status, "open");
  const released = entriesOf(t.id).find((e) => e.kind === "event" && e.eventType === "released");
  assert.match(String(released?.body), /work access on this list was removed/);
  refused(await claim(t.id, as(A1)), 403, "not_allowed", "a view-only agent can't claim it back");
});
test("list and plate views carry each worked task's latest progress and blocked reason in one go", async () => {
  const id = await makeList("Work", [A1]);
  const t = await addTask(id, as(A1), { title: "Renew the cert" });
  ok(await claim(t.id, as(A1)), "claim");
  ok(await rest("PATCH", `/tasks/${t.id}`, as(A1), { progress: "Checked expiry: Oct 28" }), "progress 1");
  ok(await rest("PATCH", `/tasks/${t.id}`, as(A1), { progress: "Renewed in portal" }), "progress 2");
  let view = ok(await rest("GET", `/${id}`, SKYLAR)).tasks.find((x: Row) => x.id === t.id);
  assert.equal(view.last_progress.text, "Renewed in portal");
  assert.equal(view.last_progress.by.agent_id, A1);
  ok(await rest("PATCH", `/tasks/${t.id}`, as(A1), { status: "blocked", reason: "waiting on DNS" }), "block");
  view = ok(await rest("GET", `/${id}`, SKYLAR)).tasks.find((x: Row) => x.id === t.id);
  assert.equal(view.blocked_reason, "waiting on DNS");
  const plate = ok(await rest("GET", "/plate", as(A1)));
  assert.equal(plate.doing.find((x: Row) => x.id === t.id)?.last_progress?.text, "Renewed in portal");
});