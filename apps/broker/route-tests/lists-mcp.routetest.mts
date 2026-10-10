/**
 * Route tests for Lists Phase 1 over MCP: POST /api/mcp tools/list and
 * tools/call for the bc_task* tools and bc_list_create, plus the
 * bc_check_inbox note about tasks waiting for this account's agents.
 *
 * Runs the real MCP route, the real tool catalog and validator, the real
 * lists.ts and rules; Prisma, auth, the rate limiter, the inbox bus and the
 * MCP route's other wrapped routes are replaced (see lists-harness.mts).
 *
 * Run with:
 *   node --experimental-strip-types --experimental-test-module-mocks \
 *        --import ./route-tests/register-hooks.mjs --test route-tests/*.routetest.mts
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  installMocks, resetStore, state, mcp, tool, rest, ok, rows, taskRow, entriesOf, eventsOf, makeList, addTask,
  as, SKYLAR, A, A1, A2, A3, type Row,
} from "./lists-harness.mts";

before(() => installMocks({ mcp: true }));
beforeEach(() => resetStore());

const LIST_TOOLS = ["bc_tasks", "bc_task_get", "bc_task_add", "bc_task_claim", "bc_task_update", "bc_task_done", "bc_task_comment", "bc_list_create"];
const toolNames = async (who: Parameters<typeof mcp>[0]) => {
  const r = await mcp(who, "tools/list");
  assert.equal(r.status, 200);
  return (r.json.result.tools as Row[]).map((t) => t.name as string);
};

test("tools/list offers the 8 list tools to any agent key, full or connector, and none to a context with no agent identity", async () => {
  const full = await toolNames(as(A1));
  assert.deepEqual(full.filter((n) => LIST_TOOLS.includes(n)), LIST_TOOLS);
  assert.ok(full.includes("bc_dashboard_link"));
  const connector = await toolNames(as(A3));
  assert.deepEqual(connector.filter((n) => LIST_TOOLS.includes(n)), LIST_TOOLS, "lists work from claude.ai and ChatGPT too");
  assert.ok(!connector.includes("bc_dashboard_link"));
  const keyless = await toolNames({ bearer: "keyless" });
  assert.deepEqual(keyless.filter((n) => LIST_TOOLS.includes(n)), []);
  assert.ok(keyless.includes("bc_check_inbox"), "the rest of the catalog is unchanged");
  // Calling one anyway is refused by Lists itself, never run as the person.
  const r = await tool({ bearer: "keyless" }, "bc_task_add", { list: "Work", title: "Planted" });
  assert.equal(r.httpStatus, 401);
  assert.equal(r.body.error, "agent_key_required");
  const create = await tool({ bearer: "keyless" }, "bc_list_create", { name: "Planted" });
  assert.equal(create.httpStatus, 401);
  assert.equal(rows("taskList").length, 0);
  assert.equal((await mcp({ bearer: "nope" }, "tools/list")).status, 401);
});

test("round trip: bc_task_add → bc_tasks → bc_task_claim → bc_task_update → bc_task_done", async () => {
  const work = await makeList("Work", [A1]);
  await makeList("House", [A1]);
  const add = await tool(as(A1), "bc_task_add", { list: "work list", title: "Renew the Mimecast cert", notes: "Expires Oct 28", due: "2026-10-28" });
  assert.equal(add.isError, false, JSON.stringify(add.body));
  const t = add.body.tasks[0];
  assert.deepEqual(t.list, { id: work, name: "Work", shared: false }, "\"work list\" means the Work list");
  assert.deepEqual([t.created_by.agent, t.created_by.is_this_agent, t.agent_may_act.ok], ["Claude Code", true, true]);

  const plate = await tool(as(A1), "bc_tasks");
  assert.deepEqual(plate.body.claimable.map((x: Row) => x.id), [t.id]);
  assert.deepEqual(plate.body.doing, []);

  const claimed = await tool(as(A1), "bc_task_claim", { task_id: t.id });
  assert.equal(claimed.body.task.status, "in_progress");
  assert.equal(claimed.body.task.claim.by.is_this_agent, true);
  assert.ok(claimed.body.task.claim.lapses_at);

  const progress = await tool(as(A1), "bc_task_update", { task_id: t.id, progress: "Renewed in the portal; waiting on DNS" });
  assert.equal(progress.isError, false, JSON.stringify(progress.body));
  assert.deepEqual((await tool(as(A1), "bc_tasks")).body.doing.map((x: Row) => x.id), [t.id]);

  const done = await tool(as(A1), "bc_task_done", { task_id: t.id, summary: "Renewed; new expiry 2027-10-28", evidence: "checked in the portal" });
  assert.equal(done.body.task.status, "done");
  assert.equal(done.body.task.completed_by.agent_id, A1);
  assert.equal(done.body.task.summary, "Renewed; new expiry 2027-10-28\n\nEvidence: checked in the portal");

  const got = await tool(as(A1), "bc_task_get", { task_id: t.id });
  assert.deepEqual(got.body.task.entries.map((e: Row) => e.event ?? e.kind), ["created", "claimed", "progress", "done"]);
  assert.equal(got.body.task.entries[2].text, "Renewed in the portal; waiting on DNS");
  assert.equal(got.body.task.entries[2].by.is_this_agent, true);
  const after = (await tool(as(A1), "bc_tasks")).body;
  assert.deepEqual([after.doing, after.claimable], [[], []]);
  assert.deepEqual(state.fired, []);
});

test("bc_task_add resolves a list by name or id; an unknown name says which lists this agent can use", async () => {
  const work = await makeList("Work", [A1]);
  await makeList("House", [A1]);
  const hidden = await makeList("Secret", [A2]);
  for (const list of ["Work", "work", "WORK list", "  work list  "]) {
    const r = await tool(as(A1), "bc_task_add", { list, title: `via "${list}"` });
    assert.equal(r.body.tasks[0].list.id, work, list);
  }
  assert.equal((await tool(as(A1), "bc_task_add", { list: work, title: "by id" })).body.tasks[0].list.id, work);
  const miss = await tool(as(A1), "bc_task_add", { list: "Garage", title: "Fix the door" });
  assert.equal(miss.httpStatus, 404);
  assert.equal(miss.body.error, "no_such_list");
  assert.equal(miss.body.message, 'No list called "Garage". Lists you can use: Work, House.');
  assert.ok(!miss.body.message.includes("Secret"), "never names a list the agent can't see");
  const byHiddenName = await tool(as(A1), "bc_task_add", { list: "Secret", title: "x" });
  assert.equal(byHiddenName.body.error, "no_such_list");
  const byHiddenId = await tool(as(A1), "bc_task_add", { list: hidden, title: "x" });
  assert.deepEqual([byHiddenId.httpStatus, byHiddenId.body.error], [404, "not_available"]);
  assert.equal(rows("taskItem").length, 5);
  // An agent with no lists at all hears "none yet".
  const lonely = await tool(as(A3), "bc_task_add", { list: "Work", title: "x" });
  assert.equal(lonely.body.message, 'No list called "Work". Lists you can use: none yet.');
});

test("bc_task_add: up to 20 at once with tasks; 21 is refused; secrets are refused; tasks for the agents ring once", async () => {
  await makeList("Work", [A1]);
  const twenty = Array.from({ length: 20 }, (_, i) => ({ title: `Item ${i + 1}` }));
  const batch = await tool(as(A1), "bc_task_add", { list: "Work", tasks: twenty });
  assert.equal(batch.body.tasks.length, 20);
  const tooMany = await tool(as(A1), "bc_task_add", { list: "Work", tasks: [...twenty, { title: "Item 21" }] });
  assert.deepEqual([tooMany.httpStatus, tooMany.body.error], [400, "invalid_tasks"]);
  const secret = await tool(as(A1), "bc_task_add", { list: "Work", title: "Rotate", notes: `old key bc_${"k".repeat(43)}` });
  assert.deepEqual([secret.httpStatus, secret.body.error], [422, "secret_like"]);
  assert.equal(rows("taskItem").length, 20);
  assert.deepEqual(state.fired, []);
  await tool(as(A1), "bc_task_add", { list: "Work", tasks: [{ title: "for us", assignee: "my_agents" }, { title: "for me", assignee: "this_agent" }] });
  assert.deepEqual(state.fired, [{ accountId: A.id, kind: "task", committedTasks: 22 }]);
});

test("bc_tasks browses one list by name or id, filters by status and words, and names the lists when it can't find one", async () => {
  const work = await makeList("Work", [A1]);
  const house = await makeList("House", [A1]);
  const cert = await addTask(work, SKYLAR, { title: "Renew cert" });
  await addTask(work, SKYLAR, { title: "Order toner" });
  const milk = await addTask(house, SKYLAR, { title: "Milk" });
  assert.deepEqual((await tool(as(A1), "bc_tasks", { list: "house" })).body.tasks.map((x: Row) => x.id), [milk.id]);
  assert.deepEqual((await tool(as(A1), "bc_tasks", { list: work, q: "CERT" })).body.tasks.map((x: Row) => x.id), [cert.id]);
  ok(await rest("POST", `/tasks/${cert.id}/done`, SKYLAR, {}));
  assert.deepEqual((await tool(as(A1), "bc_tasks", { list: "Work", status: "done" })).body.tasks.map((x: Row) => x.id), [cert.id]);
  assert.deepEqual((await tool(as(A1), "bc_tasks", { q: "milk" })).body.tasks.map((x: Row) => x.id), [milk.id]);
  const miss = await tool(as(A1), "bc_tasks", { list: "Garage" });
  assert.deepEqual([miss.httpStatus, miss.body.error], [404, "no_such_list"]);
  assert.match(miss.body.message, /Lists you can use: Work, House\./);
  const badStatus = await tool(as(A1), "bc_tasks", { status: "finished" });
  assert.equal(badStatus.rpcError?.code, -32602, "the schema's enum catches it before Lists does");
});

test("bc_list_create from an agent gives it work access alone; release with a reason; comments; schema limits", async () => {
  const c = await tool(as(A1), "bc_list_create", { name: "Packing for Vegas", emoji: "🧳" });
  assert.deepEqual([c.body.list.name, c.body.list.emoji, c.body.list.your_role], ["Packing for Vegas", "🧳", "owner"]);
  assert.deepEqual(rows("taskListAgentGrant").map((g) => [g.agentTokenId, g.access]), [[A1, "work"]]);
  const t = (await tool(as(A1), "bc_task_add", { list: "packing for vegas", title: "Sunscreen" })).body.tasks[0];
  assert.equal((await tool(as(A2), "bc_task_get", { task_id: t.id })).body.error, "not_available", "the person's other agents don't see it");

  await tool(as(A1), "bc_task_claim", { task_id: t.id });
  const released = await tool(as(A1), "bc_task_claim", { task_id: t.id, action: "release", reason: "needs Skylar's card" });
  assert.equal(released.body.task.status, "open");
  assert.equal(entriesOf(t.id).at(-1)!.body, "let go of this: needs Skylar's card");
  const commented = await tool(as(A1), "bc_task_comment", { task_id: t.id, text: "SPF 50 is in the hall closet" });
  assert.equal(commented.isError, false);
  assert.deepEqual(entriesOf(t.id).filter((e) => e.kind === "comment").map((e) => [e.authorAgentId, e.body]), [[A1, "SPF 50 is in the hall closet"]]);

  // Summary is required by the schema, and an empty one by the rules.
  assert.equal((await tool(as(A1), "bc_task_done", { task_id: t.id })).rpcError?.code, -32602);
  const empty = await tool(as(A1), "bc_task_done", { task_id: t.id, summary: "  " });
  assert.deepEqual([empty.httpStatus, empty.body.error], [400, "summary_required"]);
  // Agents can block and unblock over MCP, but the schema doesn't offer dropping.
  assert.equal((await tool(as(A1), "bc_task_update", { task_id: t.id, status: "dropped" })).rpcError?.code, -32602);
  assert.equal(taskRow(t.id).status, "open");
  // No tool lets an agent widen access: there's no agents argument to bc_list_create.
  assert.equal((await tool(as(A1), "bc_list_create", { name: "Sneaky", agents: [A2] })).rpcError?.code, -32602);
});

test("bc_task_claim race over MCP: one agent gets it, the other hears who has it", async () => {
  const work = await makeList("Work", [A1, A2]);
  const t = await addTask(work, SKYLAR, { title: "Renew cert" });
  const [r1, r2] = await Promise.all([tool(as(A1), "bc_task_claim", { task_id: t.id }), tool(as(A2), "bc_task_claim", { task_id: t.id })]);
  const loser = r1.isError ? r1 : r2;
  assert.equal([r1, r2].filter((r) => r.isError).length, 1);
  assert.equal(loser.httpStatus, 409);
  assert.equal(loser.body.error, "already_claimed");
  assert.equal(loser.body.claim.by.agent_id, taskRow(t.id).claimAgentId);
  assert.deepEqual(eventsOf(t.id), ["created", "claimed"]);
});

test("bc_check_inbox notes tasks waiting for this account's agents until one of them has seen them", async () => {
  const work = await makeList("Work", [A1]);
  const inbox = async () => {
    const r = await tool(as(A1), "bc_check_inbox");
    assert.equal(r.isError, false, JSON.stringify(r.body));
    return r.body;
  };
  assert.equal((await inbox()).tasks_waiting_for_your_agents, undefined);
  await addTask(work, SKYLAR, { title: "for Skylar", assignee: "me" });
  assert.equal((await inbox()).tasks_waiting_for_your_agents, undefined, "a task for the person doesn't count");
  await addTask(work, SKYLAR, { title: "Renew cert", assignee: "my_agents" });
  await addTask(work, SKYLAR, { title: "Order toner", assignee: A1 });
  const body = await inbox();
  assert.deepEqual(body.tasks_waiting_for_your_agents, {
    count: 2,
    next: "Call bc_tasks to see them: tasks for your agents are in up_next, and comments that mention one of your agents are in mentions.",
  });
  assert.deepEqual(body.sessions, [], "the rest of the inbox is unchanged");
  // Archived lists don't count.
  const old = await makeList("Old", [A1]);
  await addTask(old, SKYLAR, { title: "stale", assignee: "my_agents" });
  ok(await rest("PATCH", `/${old}`, SKYLAR, { archived: true }));
  assert.equal((await inbox()).tasks_waiting_for_your_agents.count, 2);
  // The agent looks at its plate: they're seen, and the note goes away.
  const plate = await tool(as(A1), "bc_tasks");
  assert.equal(plate.body.up_next.length, 2);
  assert.equal((await inbox()).tasks_waiting_for_your_agents, undefined);
});
