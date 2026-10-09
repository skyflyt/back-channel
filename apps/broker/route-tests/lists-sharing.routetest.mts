/**
 * Route tests for Lists Phase 2: sharing lists with friends. Members (friends
 * only, added in the dashboard), membership that fails closed the moment a
 * friendship ends (and the trust route's cleanup), the OK rule across two
 * people (web and "OK'd in chat"), agentsTakeFrom per person, assigning to
 * people, mentions and the doorbell, reactions, and opt-in email nudges.
 *
 * Runs the real lists route, MCP route, trust route, lists.ts and rules; Prisma,
 * auth, email, the rate limiter and the inbox bus are replaced (lists-harness.mts).
 *
 * Run with:
 *   node --experimental-strip-types --experimental-test-module-mocks \
 *        --import ./route-tests/register-hooks.mjs --test route-tests/*.routetest.mts
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import {
  installMocks, resetStore, state, rest, tool, mcp, ok, refused, rows, taskRow, entriesOf, eventsOf, makeList, addTask, setAccess, seedRow,
  befriend, untrust, share, sharedList, headersFor, as, SKYLAR, ALEX, CAROL, A, B, C, A1, A2, B1, B2, C1, type Who, type Row,
} from "./lists-harness.mts";

before(() => installMocks({ mcp: true }));
beforeEach(async () => {
  resetStore();
  (await import("@/lib/lists")).resetListNudges();
});

const NOT_A_FRIEND = { error: "not_a_friend", message: "You can only add friends to a list." };
const THUMBS = "\u{1F44D}";
const PARTY = "\u{1F389}";

const waiting = async (accountId: string) => (await import("@/lib/lists")).tasksWaitingForAgents(accountId);
const claim = (taskId: string, who: Who, body: Row = {}) => rest("POST", `/tasks/${taskId}/claim`, who, body);
const okFor = (taskId: string, who: Who) => rest("POST", `/tasks/${taskId}/ok`, who, {});
const react = (taskId: string, who: Who, emoji: string) => rest("POST", `/tasks/${taskId}/react`, who, { emoji });
const comment = (taskId: string, who: Who, text: string) => rest("POST", `/tasks/${taskId}/entries`, who, { kind: "comment", text });
const me = (listId: string, who: Who, body: Row) => rest("PATCH", `/${listId}/me`, who, body);
const memberRow = (listId: string, accountId: string) => rows("taskListMember").find((m) => m.listId === listId && m.accountId === accountId);
const grantsOf = (listId: string, accountId: string) => rows("taskListAgentGrant").filter((g) => g.listId === listId && g.accountId === accountId);
const listEvents = (listId: string) => rows("taskListEvent").filter((e) => e.listId === listId).map((e) => [e.eventType, e.actorAccountId, e.subjectAccountId]);
const lineOf = (taskId: string, eventType: string) => entriesOf(taskId).find((e) => e.kind === "event" && e.eventType === eventType);
const mentionsOf = (taskId: string) => rows("taskMention").filter((m) => m.taskId === taskId).map((m) => [m.accountId, m.agentId]);

/** DELETE /api/trust/:handle through the real trust route. */
async function revokeTrust(who: Who, handle: string) {
  const { DELETE } = await import("@/app/api/trust/[handle]/route");
  const req = new NextRequest(`https://back-channel.app/api/trust/${encodeURIComponent(handle)}`, { method: "DELETE", headers: headersFor(who) });
  const res = await DELETE(req, { params: Promise.resolve({ handle }) });
  return { status: res.status, body: await res.json() };
}

// ── 1. members ───────────────────────────────────────────────────────────────

test("members: the owner adds a friend; a stranger, a one-sided trust and a handle that doesn't exist all get the same answer", async () => {
  befriend(A, B);
  const id = await makeList("Trip", [A1]);
  const answers = [];
  for (const handle of ["carol", "carol@bc", "@carol", "nobody-by-that-name", "nobody@bc"]) {
    answers.push(refused(await rest("POST", `/${id}/members`, SKYLAR, { handle }), 403, "not_a_friend", handle));
  }
  seedRow("trustedPeer", { accountId: A.id, trustedAccountId: C.id });
  answers.push(refused(await rest("POST", `/${id}/members`, SKYLAR, { handle: "carol" }), 403, "not_a_friend", "Skylar trusts Carol but not the reverse"));
  for (const a of answers) assert.deepEqual(a, NOT_A_FRIEND, "identical, so the answer never says whether a handle exists");
  refused(await rest("POST", `/${id}/members`, SKYLAR, { handle: "" }), 400, "invalid_handle");
  refused(await rest("POST", `/${id}/members`, SKYLAR, {}), 400, "invalid_handle");

  const added = ok(await rest("POST", `/${id}/members`, SKYLAR, { handle: "@Alex" }), "add Alex");
  assert.deepEqual(added.members.map((m: Row) => [m.handle, m.role, m.is_you, m.mention]), [["skylar", "owner", true, "@skylar"], ["alex", "member", false, "@alex"]]);
  assert.equal(memberRow(id, B.id)?.addedByAccountId, A.id);
  assert.equal(memberRow(id, B.id)?.agentsTakeFrom, "me");
  assert.equal(memberRow(id, B.id)?.notify, "off");
  // Idempotent, and adding yourself changes nothing.
  ok(await rest("POST", `/${id}/members`, SKYLAR, { handle: "alex" }), "again");
  ok(await rest("POST", `/${id}/members`, SKYLAR, { handle: "skylar" }), "yourself");
  assert.equal(rows("taskListMember").filter((m) => m.listId === id).length, 2);
  assert.deepEqual(listEvents(id), [["member_added", A.id, B.id]]);

  // Alex sees it now, as a member, with who is on it and what happened.
  const mine = ok(await rest("GET", "", ALEX)).lists;
  assert.deepEqual(mine.map((l: Row) => [l.name, l.your_role, l.shared]), [["Trip", "member", true]]);
  const view = ok(await rest("GET", `/${id}`, ALEX));
  assert.deepEqual(view.list.your_role, "member");
  assert.equal(view.list.shared, true);
  assert.equal(view.list.notify, "off");
  assert.deepEqual(view.members.map((m: Row) => m.handle), ["skylar", "alex"]);
  assert.deepEqual(view.members[0].agents, [{ name: "Claude Code", access: "work", mention: "@claude-code" }], "what an @mention reaches");
  assert.deepEqual(view.activity.map((e: Row) => [e.event, e.text, e.by.person]), [["member_added", "added you", "Skylar"]]);
  assert.deepEqual(view.your_agents.map((a: Row) => [a.name, a.access]), [["Alex's Claude", "none"], ["Claude Code", "none"]], "Alex's own agents start with nothing here");
});

test("members: only the owner adds, only from the dashboard with CSRF, never an agent; 20 people at most", async () => {
  befriend(A, B);
  befriend(B, C);
  const id = await makeList("Trip", [A1]);
  refused(await rest("POST", `/${id}/members`, as(A1), { handle: "alex" }), 403, "people_only", "Skylar's own agent");
  refused(await rest("POST", `/${id}/members`, { person: "A", csrf: "missing" }, { handle: "alex" }), 403, "csrf");
  refused(await rest("POST", `/${id}/members`, CAROL, { handle: "alex" }), 404, "not_available", "not on the list: opaque");
  await share(id);
  refused(await rest("POST", `/${id}/members`, ALEX, { handle: "carol" }), 403, "not_allowed", "a member can't add his own friends");
  refused(await rest("POST", `/${id}/members`, as(B1), { handle: "carol" }), 403, "people_only", "nor can his agent");
  assert.equal(rows("taskListMember").filter((m) => m.listId === id).length, 2);

  // The limit: 20 people including the owner.
  for (let i = 0; i < 18; i++) {
    const p = seedRow("account", { handle: `friend${i}@bc`, displayName: `Friend ${i}` });
    seedRow("taskListMember", { listId: id, accountId: p.id, role: "member", addedByAccountId: A.id });
  }
  const dana = seedRow("account", { handle: "dana@bc", displayName: "Dana" });
  befriend(A, dana);
  refused(await rest("POST", `/${id}/members`, SKYLAR, { handle: "dana" }), 429, "too_many_members");
  // An archived list takes nobody new.
  const other = await makeList("Old", []);
  ok(await rest("PATCH", `/${other}`, SKYLAR, { archived: true }));
  refused(await rest("POST", `/${other}/members`, SKYLAR, { handle: "alex" }), 409, "archived");
});

test("leaving: what Alex and his agents held is released with a line, tasks for him reopen, his work stays his", async () => {
  const id = await sharedList("Trip", [A1], [B1]);
  ok(await me(id, ALEX, { agents_take_from: "anyone" }));
  const snacks = await addTask(id, ALEX, { title: "Pack snacks" });
  ok(await claim(snacks.id, as(B1)), "Alex's agent takes his own task");
  const hotel = await addTask(id, SKYLAR, { title: "Book hotel" });
  ok(await claim(hotel.id, ALEX), "Alex himself takes Skylar's");
  const forAlex = await addTask(id, SKYLAR, { title: "Bring the tent", assignee: "@alex" });
  const forAgents = await addTask(id, SKYLAR, { title: "Find a campsite", assignee: "@alex's agents" });
  ok(await comment(hotel.id, ALEX, "On it, looking near the beach"));

  const left = ok(await rest("DELETE", `/${id}/members/alex`, ALEX), "Alex leaves");
  assert.deepEqual(left, { left: true });
  assert.equal(memberRow(id, B.id), undefined);
  assert.deepEqual(grantsOf(id, B.id), [], "his agents' access ended with him");
  for (const t of [snacks, hotel]) {
    assert.equal(taskRow(t.id).claimAccountId, null);
    assert.equal(taskRow(t.id).status, "open");
  }
  assert.equal(lineOf(snacks.id, "member_left")?.body, "left the list and released \"Pack snacks\"");
  assert.equal(lineOf(hotel.id, "member_left")?.body, "left the list and released \"Book hotel\"");
  assert.equal(lineOf(hotel.id, "member_left")?.authorAccountId, B.id);
  for (const t of [forAlex, forAgents]) {
    assert.equal(taskRow(t.id).assigneeAccountId, null, "for anyone again");
    assert.match(String(lineOf(t.id, "member_left")?.body), /^left the list, so ".+" is for anyone again$/);
  }
  assert.deepEqual(listEvents(id), [["member_added", A.id, B.id], ["member_left", B.id, B.id]]);
  // His past work is still his.
  const seen = ok(await rest("GET", `/tasks/${snacks.id}`, SKYLAR)).task;
  assert.equal(seen.created_by.person, "Alex");
  assert.ok(seen.entries.some((e: Row) => e.kind === "event" && e.event === "claimed" && e.by.agent === "Alex's Claude"));
  assert.ok(entriesOf(hotel.id).some((e) => e.kind === "comment" && e.authorAccountId === B.id));
  const view = ok(await rest("GET", `/${id}`, SKYLAR));
  assert.equal(view.list.shared, false);
  assert.deepEqual(view.activity.map((e: Row) => e.text), ["added Alex", "left the list"]);
  // And he and his agents are out.
  refused(await rest("GET", `/${id}`, ALEX), 404, "not_available");
  refused(await rest("GET", `/tasks/${hotel.id}`, as(B1)), 404, "not_available");
  assert.deepEqual(ok(await rest("GET", "/plate", as(B1))).lists, []);
  refused(await rest("DELETE", `/${id}/members/alex`, ALEX), 404, "not_available", "leaving twice");
});

test("taking someone off: the owner can, a member can't, the owner can't leave her own list; people only", async () => {
  const id = await sharedList("Trip", [A1], [B1]);
  befriend(A, C);
  await share(id, "carol");
  refused(await rest("DELETE", `/${id}/members/carol`, ALEX), 403, "not_allowed", "Alex can't take Carol off");
  refused(await rest("DELETE", `/${id}/members/skylar`, SKYLAR), 409, "owner_cant_leave");
  refused(await rest("DELETE", `/${id}/members/dana`, SKYLAR), 404, "not_a_member");
  refused(await rest("DELETE", `/${id}/members/alex`, as(A1)), 403, "people_only");
  refused(await rest("DELETE", `/${id}/members/alex`, as(B1)), 403, "people_only", "Alex's agent can't leave for him");
  refused(await rest("DELETE", `/${id}/members/alex`, { person: "A", csrf: "missing" }), 403, "csrf");
  const t = await addTask(id, SKYLAR, { title: "Book hotel" });
  ok(await claim(t.id, ALEX));
  const after = ok(await rest("DELETE", `/${id}/members/alex@bc`, SKYLAR), "Skylar takes Alex off");
  assert.deepEqual(after.members.map((m: Row) => m.handle), ["skylar", "carol@bc"]);
  assert.equal(lineOf(t.id, "member_left")?.body, "was taken off the list and released \"Book hotel\"");
  assert.deepEqual(listEvents(id).at(-1), ["member_removed", A.id, B.id]);
  assert.equal(ok(await rest("GET", `/${id}`, CAROL)).activity.at(-1).text, "took Alex off the list");
});

// ── 2. membership follows friendship ─────────────────────────────────────────

test("revoking trust in either direction ends access on the very next request, with no cleanup at all", async () => {
  for (const [from, to] of [[B, A], [A, B]]) {
    resetStore();
    const id = await sharedList("Trip", [A1], [B1]);
    const t = await addTask(id, SKYLAR, { title: "Find a campsite", assignee: "@alex's agents" });
    ok(await rest("GET", `/${id}`, ALEX), "before");
    assert.equal(await waiting(B.id), 1);
    assert.equal(ok(await rest("GET", "/search?q=campsite", as(B1))).tasks.length, 1);

    untrust(from, to); // straight in the store: no route, no cleanup hook
    const who = `${from === A ? "Skylar" : "Alex"} revoked`;
    refused(await rest("GET", `/${id}`, ALEX), 404, "not_available", who);
    refused(await rest("GET", `/tasks/${t.id}`, ALEX), 404, "not_available", who);
    refused(await rest("GET", `/tasks/${t.id}`, as(B1)), 404, "not_available", who);
    refused(await claim(t.id, as(B1)), 404, "not_available", who);
    refused(await comment(t.id, ALEX, "still here?"), 404, "not_available", who);
    assert.deepEqual(ok(await rest("GET", "", ALEX)).lists, [], who);
    assert.deepEqual(ok(await rest("GET", "/plate", as(B1))).lists, [], who);
    assert.deepEqual(ok(await rest("GET", "/search?q=campsite", ALEX)).tasks, [], who);
    assert.equal(await waiting(B.id), 0, `${who}: nothing rings for a list Alex can't open`);
    const owner = ok(await rest("GET", `/${id}`, SKYLAR));
    assert.equal(owner.list.shared, false, who);
    assert.deepEqual(owner.members.map((m: Row) => m.handle), ["skylar"], who);
    refused(await rest("PATCH", `/tasks/${t.id}`, SKYLAR, { assignee: "@alex" }), 400, "invalid_assignee", `${who}: not on the list any more`);
    assert.ok(memberRow(id, B.id), "the row is still there; it just doesn't count");
  }
});

test("the trust route ends sharing at once: membership, agent access and claims, with activity lines either way", async () => {
  // Alex revokes: he leaves Skylar's list.
  let id = await sharedList("Trip", [A1], [B1]);
  ok(await me(id, ALEX, { agents_take_from: "anyone" }));
  const hotel = await addTask(id, SKYLAR, { title: "Book hotel" });
  ok(await claim(hotel.id, as(B1)));
  const r = await revokeTrust(ALEX, "skylar");
  assert.deepEqual([r.status, r.body], [200, { ok: true, handle: "skylar", trusted: false }]);
  assert.equal(memberRow(id, B.id), undefined);
  assert.deepEqual(grantsOf(id, B.id), []);
  assert.equal(taskRow(hotel.id).claimAgentId, null);
  assert.equal(lineOf(hotel.id, "member_left")?.body, "left the list and released \"Book hotel\"");
  assert.deepEqual(listEvents(id).at(-1), ["member_left", B.id, B.id]);
  assert.ok(entriesOf(hotel.id).some((e) => e.eventType === "claimed" && e.authorAgentId === B1), "his agent's work stays attributed");
  assert.ok(rows("accountAudit").some((a) => a.accountId === B.id && a.eventType === "trust.revoked"));

  // Skylar revokes: Alex comes off her list, and she comes off his.
  resetStore();
  id = await sharedList("Trip", [A1], [B1]);
  const alexs = ok(await rest("POST", "", ALEX, { name: "Alex's garage", agents: [B1] })).list.id;
  ok(await rest("POST", `/${alexs}/members`, ALEX, { handle: "skylar" }));
  const drill = await addTask(alexs, ALEX, { title: "Return the drill" });
  ok(await claim(drill.id, SKYLAR));
  const tent = await addTask(id, SKYLAR, { title: "Bring the tent" });
  ok(await claim(tent.id, ALEX));
  assert.equal((await revokeTrust(SKYLAR, "alex")).status, 200);
  assert.deepEqual(listEvents(id).at(-1), ["member_removed", A.id, B.id]);
  assert.deepEqual(listEvents(alexs).at(-1), ["member_left", A.id, A.id]);
  assert.equal(lineOf(tent.id, "member_left")?.body, "was taken off the list and released \"Bring the tent\"");
  assert.equal(lineOf(drill.id, "member_left")?.body, "left the list and released \"Return the drill\"");
  refused(await rest("GET", `/${alexs}`, SKYLAR), 404, "not_available");
  refused(await rest("GET", `/${id}`, ALEX), 404, "not_available");
  // Revoking someone you share nothing with is a no-op for lists.
  const before = rows("taskListEvent").length;
  assert.equal((await revokeTrust(SKYLAR, "carol@bc")).status, 200);
  assert.equal(rows("taskListEvent").length, before);
});

// ── 3. the OK rule ───────────────────────────────────────────────────────────

test("the OK rule: Alex's agent waits for Alex's OK on Skylar's task, from the dashboard or from chat", async () => {
  const id = await sharedList("Trip", [A1], [B1]);
  const airbnb = await addTask(id, SKYLAR, { title: "Book the Airbnb" });
  const seen = ok(await rest("GET", `/tasks/${airbnb.id}`, as(B1))).task;
  assert.deepEqual([seen.agent_may_act.ok, seen.agent_may_act.why], [false, "Skylar wrote this, so your agents need your OK before acting on it."]);
  refused(await claim(airbnb.id, as(B1)), 409, "needs_ok");
  refused(await rest("POST", `/tasks/${airbnb.id}/done`, as(B1), { summary: "booked" }), 409, "needs_ok", "no claim-and-finish around it either");

  // It's on Alex's plate, and his agent's, as an OK request.
  assert.deepEqual(ok(await rest("GET", "/plate", ALEX)).ok_requests.map((t: Row) => t.id), [airbnb.id]);
  const agentPlate = ok(await rest("GET", "/plate", as(B1)));
  assert.deepEqual(agentPlate.ok_requests.map((t: Row) => t.id), [airbnb.id]);
  assert.deepEqual(agentPlate.claimable, []);
  assert.deepEqual(ok(await rest("GET", "/plate", SKYLAR)).ok_requests, [], "Skylar wrote it: nothing to OK");

  // Alex OKs it in the dashboard.
  const oked = ok(await okFor(airbnb.id, ALEX)).task;
  assert.equal(oked.agent_may_act.ok, true);
  assert.deepEqual(rows("taskAgentOk").map((o) => [o.taskId, o.accountId, o.via, o.viaAgentId]), [[airbnb.id, B.id, "web", null]]);
  const line = lineOf(airbnb.id, "ok")!;
  assert.deepEqual([line.body, line.authorAccountId, line.authorAgentId], ["OK'd this for their agents", B.id, null]);
  ok(await okFor(airbnb.id, ALEX), "OKing twice is harmless");
  assert.equal(eventsOf(airbnb.id).filter((e) => e === "ok").length, 1);
  assert.equal(ok(await rest("GET", `/tasks/${airbnb.id}`, as(B1))).task.agent_may_act.why, "you OK'd it for your agents");
  assert.deepEqual(ok(await rest("GET", "/plate", ALEX)).ok_requests, []);
  ok(await claim(airbnb.id, as(B1)), "now it may");

  // The same from chat: the agent records its person's yes, then claims.
  const car = await addTask(id, SKYLAR, { title: "Rent a car" });
  refused(await claim(car.id, as(B1), { ok_from: "yes" }), 400, "invalid_ok_from");
  refused(await claim(car.id, ALEX, { ok_from: "user_in_chat" }), 400, "invalid_ok_from", "people use the OK button");
  const chat = ok(await claim(car.id, as(B1), { ok_from: "user_in_chat" })).task;
  assert.equal(chat.claim.by.agent_id, B1);
  assert.deepEqual(rows("taskAgentOk").filter((o) => o.taskId === car.id).map((o) => [o.accountId, o.via, o.viaAgentId]), [[B.id, "user_in_chat", B1]]);
  const chatLine = lineOf(car.id, "ok")!;
  assert.deepEqual([chatLine.body, chatLine.authorAccountId, chatLine.authorAgentId], ["OK'd this for their agents (via Alex's Claude)", B.id, null]);
  assert.deepEqual(eventsOf(car.id), ["created", "ok", "claimed"]);

  // A chat OK on a task someone else holds is refused as a whole: no OK is left behind.
  const ferry = await addTask(id, SKYLAR, { title: "Ferry tickets" });
  ok(await claim(ferry.id, as(A1)));
  refused(await claim(ferry.id, as(B1), { ok_from: "user_in_chat" }), 409, "already_claimed");
  assert.equal(rows("taskAgentOk").some((o) => o.taskId === ferry.id), false);

  // OK is a person's act in the dashboard, on a live task.
  refused(await okFor(ferry.id, as(B1)), 403, "people_only");
  ok(await rest("POST", `/tasks/${airbnb.id}/done`, as(B1), { summary: "Booked, confirmation 4411" }));
  refused(await okFor(airbnb.id, ALEX), 409, "bad_status");
  refused(await okFor(ferry.id, CAROL), 404, "not_available");
});

test("an OK is per person: Skylar's OK on Carol's task lets Skylar's agents act, never Alex's", async () => {
  const id = await sharedList("Trip", [A1], [B1]);
  befriend(A, C);
  await share(id, "carol");
  const t = await addTask(id, CAROL, { title: "Pick up the keys" });
  ok(await okFor(t.id, SKYLAR));
  assert.equal(ok(await rest("GET", `/tasks/${t.id}`, as(A1))).task.agent_may_act.ok, true);
  const alexView = ok(await rest("GET", `/tasks/${t.id}`, as(B1))).task;
  assert.deepEqual([alexView.agent_may_act.ok, alexView.agent_may_act.why], [false, "Carol wrote this, so your agents need your OK before acting on it."]);
  refused(await claim(t.id, as(B1)), 409, "needs_ok", "Skylar's OK isn't Alex's");
  ok(await claim(t.id, as(A1)), "Skylar's agent may");
});

test("agentsTakeFrom is per person: Alex's 'anyone' lets his agents take Skylar's tasks and never loosens Skylar's", async () => {
  const id = await sharedList("Trip", [A1], [B1]);
  const hers = await addTask(id, SKYLAR, { title: "Book hotel" });
  const his = await addTask(id, ALEX, { title: "Pack snacks" });
  refused(await claim(hers.id, as(B1)), 409, "needs_ok");
  refused(await claim(his.id, as(A1)), 409, "needs_ok");

  refused(await me(id, as(B1), { agents_take_from: "anyone" }), 403, "people_only", "an agent can't loosen its own leash");
  refused(await me(id, ALEX, { agents_take_from: "everyone" }), 400, "invalid_agents_take_from");
  refused(await me(id, ALEX, {}), 400, "nothing_to_change");
  refused(await me(id, CAROL, { agents_take_from: "anyone" }), 404, "not_available");
  assert.deepEqual(ok(await me(id, ALEX, { agents_take_from: "anyone" })), { me: { agents_take_from: "anyone", notify: "off" } });
  assert.equal(memberRow(id, A.id)?.agentsTakeFrom, "me", "Skylar's own setting is untouched");
  assert.equal(ok(await rest("GET", `/${id}`, ALEX)).list.agents_take_from, "anyone");

  ok(await claim(hers.id, as(B1)), "Alex's agent may take Skylar's task now");
  refused(await claim(his.id, as(A1)), 409, "needs_ok", "Skylar's agents still need Skylar");
  assert.deepEqual(rows("taskAgentOk").map((o) => [o.taskId, o.accountId, o.via, o.viaAgentId]), [[hers.id, B.id, "list_setting", B1]]);
  // Alex changes his mind mid-task: the claim it took under the setting stays explained.
  ok(await me(id, ALEX, { agents_take_from: "me" }));
  assert.equal(ok(await rest("GET", `/tasks/${hers.id}`, as(B1))).task.agent_may_act.why, "your agents took it on under your list setting");
  const done = ok(await rest("POST", `/tasks/${hers.id}/done`, as(B1), { summary: "Booked, confirmation 4411" })).task;
  assert.equal(done.status, "needs_review", "an agent finishing a friend's task sends it to that friend");
  assert.equal(done.needs_review_by.person, "Skylar");
  assert.deepEqual(ok(await rest("GET", "/plate", SKYLAR)).waiting_on_you.map((t: Row) => t.id), [hers.id]);
});

// ── 4. assigning to people ───────────────────────────────────────────────────

test("assigning to people: @alex and @alex's agents; Alex's doorbell rings, and nobody picks Alex's agent for him", async () => {
  const id = await sharedList("Trip", [A1], [B1]);
  const forAgents = await addTask(id, SKYLAR, { title: "Find a campsite", assignee: "@alex's agents" });
  assert.deepEqual(forAgents.assignee, { kind: "their_agents", person: "Alex", handle: "alex", agent: null, agent_id: null, is_you: false });
  assert.deepEqual(state.fired, [{ accountId: B.id, kind: "task", committedTasks: 1 }], "Alex's doorbell, not Skylar's");
  assert.equal(await waiting(B.id), 1);
  assert.equal(await waiting(A.id), 0);
  refused(await claim(forAgents.id, as(A1)), 409, "assigned_elsewhere", "Skylar's agents can't take it");
  refused(await claim(forAgents.id, as(B1)), 409, "needs_ok", "Alex's agent waits for Alex");
  const plate = ok(await rest("GET", "/plate", as(B1)));
  assert.deepEqual(plate.up_next.map((t: Row) => t.id), [forAgents.id]);
  assert.deepEqual(plate.ok_requests.map((t: Row) => t.id), [forAgents.id]);
  assert.equal(await waiting(B.id), 0, "seen by the agent it's for");
  assert.deepEqual(ok(await rest("GET", "/plate", ALEX)).ok_requests.map((t: Row) => t.id), [forAgents.id]);

  const forAlex = await addTask(id, as(A1), { title: "Bring the tent", assignee: "@alex" });
  assert.deepEqual([forAlex.assignee.kind, forAlex.assignee.handle], ["person", "alex"]);
  assert.equal(state.fired.length, 1, "a task for the person rings nobody's agents");
  assert.deepEqual(ok(await rest("GET", "/plate", ALEX)).up_next.map((t: Row) => t.id), [forAlex.id]);
  refused(await claim(forAlex.id, SKYLAR), 409, "assigned_elsewhere");
  ok(await claim(forAlex.id, ALEX));

  const r = refused(await rest("POST", `/${id}/tasks`, SKYLAR, { title: "x", assignee: "@alex/alexs-claude" }), 400, "invalid_assignee");
  assert.match(r.message, /@alex's agents/);
  refused(await rest("POST", `/${id}/tasks`, SKYLAR, { title: "x", assignee: B1 }), 400, "invalid_assignee", "Alex's agent by id is not Skylar's to pick");
  const nobody = refused(await rest("POST", `/${id}/tasks`, SKYLAR, { title: "x", assignee: "@carol" }), 400, "invalid_assignee");
  assert.equal(nobody.message, "Nobody called @carol is on this list.");
  // Reassigning to Skylar's own agents rings hers.
  ok(await rest("PATCH", `/tasks/${forAgents.id}`, SKYLAR, { assignee: "@skylar's agents" }));
  assert.equal(taskRow(forAgents.id).assigneeAccountId, A.id);
  assert.equal(taskRow(forAgents.id).assigneeAgents, true);
  assert.deepEqual(state.fired.at(-1), { accountId: A.id, kind: "task", committedTasks: 2 });
});

// ── 5. mentions ──────────────────────────────────────────────────────────────

test("mentions: people and agents on the list; agent mentions ring until that agent sees them; person mentions wait on the plate", async () => {
  const id = await sharedList("Trip", [A1], [B1]);
  ok(await setAccess(id, B2, "view", ALEX), "Alex's Claude Code may look");
  const t = await addTask(id, SKYLAR, { title: "Book hotel" });
  const before = state.fired.length;
  ok(await comment(t.id, SKYLAR, "@alex can you check? @alexs-claude too, and @alex/claude-code. @carol? mail me at skylar@example.com"));
  assert.deepEqual(mentionsOf(t.id).sort(), [[B.id, B1], [B.id, B2], [B.id, null]].sort());
  assert.deepEqual(state.fired.slice(before), [{ accountId: B.id, kind: "task", committedTasks: 1 }], "one ring for Alex's agents");
  assert.equal(await waiting(B.id), 2);
  assert.deepEqual(eventsOf(t.id), ["created"], "no activity line for a mention");

  // The agent's plate shows its own mention and its person's, and seeing it stops the ring for that agent only.
  const plate = ok(await rest("GET", "/plate", as(B1)));
  assert.deepEqual(plate.mentions.map((m: Row) => [m.of.agent_id, m.of.is_you, m.of.is_this_agent]).sort(), [[B1, true, true], [null, true, false]].sort());
  assert.equal(plate.mentions[0].task.id, t.id);
  assert.match(plate.mentions[0].entry.text, /^@alex can you check/);
  assert.equal(plate.mentions[0].entry.by.person, "Skylar");
  assert.equal(await waiting(B.id), 1);
  assert.deepEqual(ok(await rest("GET", "/plate", as(B1))).mentions.map((m: Row) => m.of.agent_id), [null], "its own is seen; its person's waits for him");
  // A view-only agent sees its mention by reading the task.
  ok(await rest("GET", `/tasks/${t.id}`, as(B2)));
  assert.equal(await waiting(B.id), 0);

  // Alex's own: on his plate until he opens the task.
  const alexPlate = ok(await rest("GET", "/plate", ALEX));
  assert.deepEqual(alexPlate.mentions.map((m: Row) => [m.of.person, m.of.agent, m.task.title]), [["Alex", null, "Book hotel"]]);
  assert.equal(ok(await rest("GET", "/plate", ALEX)).mentions.length, 1, "the plate alone doesn't clear it");
  ok(await rest("GET", `/tasks/${t.id}`, ALEX));
  assert.deepEqual(ok(await rest("GET", "/plate", ALEX)).mentions, []);

  // Progress lines mention too; an agent can mention its own person; agents without access can't be mentioned.
  ok(await claim(t.id, as(A1)));
  ok(await setAccess(id, B2, "none", ALEX));
  ok(await rest("PATCH", `/tasks/${t.id}`, as(A1), { progress: "@skylar need your login. @alex/claude-code fyi" }));
  const latest = rows("taskMention").filter((m) => m.taskId === t.id).slice(-1).map((m) => [m.accountId, m.agentId]);
  assert.deepEqual(latest, [[A.id, null]]);
  // Taking an agent's access away clears what was waiting for it there.
  ok(await setAccess(id, B1, "work", ALEX));
  ok(await comment(t.id, SKYLAR, "@alexs-claude one more"));
  assert.equal(await waiting(B.id), 1);
  ok(await setAccess(id, B1, "none", ALEX));
  assert.equal(await waiting(B.id), 0);
});

test("mentions of someone who leaves stop ringing; a send-back comment mentions too", async () => {
  const id = await sharedList("Trip", [A1], [B1]);
  const t = await addTask(id, SKYLAR, { title: "Book hotel" });
  ok(await comment(t.id, SKYLAR, "@alexs-claude and @alex"));
  assert.equal(await waiting(B.id), 1);
  ok(await rest("DELETE", `/${id}/members/alex`, SKYLAR));
  assert.equal(await waiting(B.id), 0);
  assert.ok(rows("taskMention").every((m) => m.seenAt), "cleared, not deleted");

  ok(await claim(t.id, as(A1)));
  ok(await rest("POST", `/tasks/${t.id}/done`, as(A1), { summary: "Booked" }));
  ok(await rest("POST", `/tasks/${t.id}/review`, SKYLAR, { verdict: "send_back", comment: "@claude-code wrong dates" }));
  assert.deepEqual(rows("taskMention").filter((m) => !m.seenAt).map((m) => [m.accountId, m.agentId]), [[A.id, A1]]);
});

// ── 6. reactions ─────────────────────────────────────────────────────────────

test("reactions toggle per person and per agent, show as counts and whether you reacted, and add no activity", async () => {
  const id = await sharedList("Trip", [A1], [B1]);
  ok(await setAccess(id, B2, "view", ALEX));
  const t = await addTask(id, SKYLAR, { title: "Book hotel" });
  assert.deepEqual(ok(await react(t.id, SKYLAR, THUMBS)).task.reactions, [{ emoji: THUMBS, count: 1, you: true }]);
  assert.deepEqual(ok(await react(t.id, SKYLAR, `${THUMBS}️`)).task.reactions, [], "the same again takes it back");
  ok(await react(t.id, ALEX, PARTY));
  ok(await react(t.id, as(B1), PARTY));
  ok(await react(t.id, as(B2), PARTY), "a view-only agent may react");
  const asAlex = ok(await rest("GET", `/tasks/${t.id}`, ALEX)).task;
  assert.deepEqual(asAlex.reactions, [{ emoji: PARTY, count: 3, you: true }]);
  assert.deepEqual(ok(await rest("GET", `/tasks/${t.id}`, SKYLAR)).task.reactions, [{ emoji: PARTY, count: 3, you: false }]);
  assert.deepEqual(ok(await rest("GET", `/${id}`, SKYLAR)).tasks[0].reactions, [{ emoji: PARTY, count: 3, you: false }], "list views carry them too");
  assert.deepEqual(eventsOf(t.id), ["created"]);
  refused(await react(t.id, SKYLAR, "\u{1F525}"), 400, "invalid_emoji");
  refused(await react(t.id, CAROL, PARTY), 404, "not_available");
  refused(await react(t.id, as(C1), PARTY), 404, "not_available");
  ok(await rest("PATCH", `/${id}`, SKYLAR, { archived: true }));
  refused(await react(t.id, ALEX, THUMBS), 409, "archived");
});

// ── 7. email nudges ──────────────────────────────────────────────────────────

test("email nudges: opt-in per list, at most one an hour, never for your own doing, and only who and which task", async () => {
  const lists = await import("@/lib/lists");
  const id = await sharedList("Trip", [A1], [B1]);
  const t = await addTask(id, SKYLAR, { title: "Book hotel", notes: "private-ish notes" });
  ok(await comment(t.id, SKYLAR, "@alex look"));
  assert.equal(state.emails.length, 0, "off by default");

  refused(await me(id, ALEX, { notify: "always" }), 400, "invalid_notify");
  assert.deepEqual(ok(await me(id, ALEX, { notify: "mentions_reviews" })), { me: { agents_take_from: "me", notify: "mentions_reviews" } });
  ok(await comment(t.id, SKYLAR, "@alex look again, this text stays out of email"));
  assert.equal(state.emails.length, 1);
  const mail = state.emails[0];
  assert.deepEqual(Object.keys(mail).sort(), ["by", "handle", "kind", "listName", "taskTitle", "to", "url"]);
  assert.deepEqual([mail.to, mail.handle, mail.kind, mail.by, mail.listName, mail.taskTitle], ["alex@example.invalid", "alex", "mention", "Skylar", "Trip", "Book hotel"]);
  const url = new URL(mail.url);
  assert.equal(url.origin + url.pathname, "https://back-channel.app/account");
  assert.deepEqual([url.searchParams.get("tab"), url.searchParams.get("list"), url.searchParams.get("task")], ["lists", id, t.id]);
  const vt = url.searchParams.get("vt")!;
  assert.match(vt, /^vt_/);
  const token = rows("viewToken").find((v) => v.token === `hash:${vt}`);
  assert.equal(token?.accountId, B.id, "a one-time sign-in for Alex, stored hashed");

  ok(await comment(t.id, SKYLAR, "@alex and again"));
  assert.equal(state.emails.length, 1, "at most one an hour");
  assert.equal(rows("viewToken").length, 1, "no link minted for an email that isn't sent");

  // An hour later (the clock reset): his own agent asking for him counts; his own comment doesn't.
  lists.resetListNudges();
  ok(await comment(t.id, ALEX, "@alex note to self"));
  assert.equal(state.emails.length, 1, "never about your own doing");
  ok(await comment(t.id, as(B1), "@alex I need your passport number, in a sealed message please"));
  assert.deepEqual([state.emails.length, state.emails[1].kind, state.emails[1].by], [2, "mention", "Alex's Alex's Claude"]);

  // A task for his agents that needs his OK.
  lists.resetListNudges();
  await addTask(id, SKYLAR, { title: "Find a campsite", assignee: "@alex's agents" });
  assert.deepEqual([state.emails.length, state.emails[2].kind, state.emails[2].taskTitle], [3, "ok", "Find a campsite"]);
  // Not when his setting already lets his agents act.
  lists.resetListNudges();
  ok(await me(id, ALEX, { agents_take_from: "anyone" }));
  await addTask(id, SKYLAR, { title: "Buy firewood", assignee: "@alex's agents" });
  assert.equal(state.emails.length, 3);

  // A result to check, for Skylar, once she opts in.
  ok(await me(id, SKYLAR, { notify: "mentions_reviews" }));
  ok(await claim(t.id, as(B1)));
  ok(await rest("POST", `/tasks/${t.id}/done`, as(B1), { summary: "Booked" }));
  assert.deepEqual([state.emails.length, state.emails[3].kind, state.emails[3].to, state.emails[3].by], [4, "review", "skylar@example.invalid", "Alex's Alex's Claude"]);

  // The account-wide email switch, and an unverified address, both win.
  lists.resetListNudges();
  rows("account").find((a) => a.id === B.id)!.notifyIdleFrames = false;
  ok(await comment(t.id, SKYLAR, "@alex?"));
  rows("account").find((a) => a.id === B.id)!.notifyIdleFrames = true;
  rows("account").find((a) => a.id === B.id)!.emailVerifiedAt = null;
  ok(await comment(t.id, SKYLAR, "@alex??"));
  assert.equal(state.emails.length, 4);
});

// ── 8. MCP ───────────────────────────────────────────────────────────────────

test("MCP: bc_task_claim takes ok_from only as \"user_in_chat\" and says when; bc_tasks explains ok_requests", async () => {
  const listed = (await mcp(as(B1), "tools/list")).json.result.tools as Row[];
  const claimTool = listed.find((t) => t.name === "bc_task_claim")!;
  assert.deepEqual(claimTool.inputSchema.properties.ok_from.enum, ["user_in_chat"]);
  assert.match(claimTool.inputSchema.properties.ok_from.description, /ONLY when your person said yes to this specific task in this conversation/);
  assert.match(listed.find((t) => t.name === "bc_tasks")!.description, /ok_requests/);
  assert.match(listed.find((t) => t.name === "bc_task_add")!.inputSchema.properties.assignee.description, /"@alex's agents"/);

  const id = await sharedList("Trip", [A1], [B1]);
  const added = await tool(as(A1), "bc_task_add", { list: "Trip", title: "Book the Airbnb", assignee: "@alex's agents" });
  assert.equal(added.isError, false, JSON.stringify(added.body));
  const plate = await tool(as(B1), "bc_tasks");
  assert.deepEqual(plate.body.ok_requests.map((t: Row) => t.title), ["Book the Airbnb"]);
  const t = plate.body.ok_requests[0];
  assert.equal(t.agent_may_act.ok, false);
  const refusedClaim = await tool(as(B1), "bc_task_claim", { task_id: t.id });
  assert.deepEqual([refusedClaim.httpStatus, refusedClaim.body.error], [409, "needs_ok"]);
  const bad = await tool(as(B1), "bc_task_claim", { task_id: t.id, ok_from: "user" });
  assert.equal(bad.isError, true, "the schema's enum is enforced");
  const claimed = await tool(as(B1), "bc_task_claim", { task_id: t.id, ok_from: "user_in_chat" });
  assert.equal(claimed.isError, false, JSON.stringify(claimed.body));
  assert.equal(claimed.body.task.claim.by.agent_id, B1);
  assert.equal(lineOf(t.id, "ok")?.body, "OK'd this for their agents (via Alex's Claude)");
  // Releasing ignores ok_from; it never records an OK.
  const released = await tool(as(B1), "bc_task_claim", { task_id: t.id, action: "release", ok_from: "user_in_chat", reason: "later" });
  assert.equal(released.isError, false);
  assert.equal(rows("taskAgentOk").length, 1);
  void id;
});

test("MCP: a mention of an agent shows in bc_check_inbox until that agent's bc_tasks or bc_task_get shows it", async () => {
  const id = await sharedList("Trip", [A1], [B1]);
  const t = await addTask(id, SKYLAR, { title: "Book hotel" });
  const inbox = async () => (await tool(as(B1), "bc_check_inbox")).body.tasks_waiting_for_your_agents;
  assert.equal(await inbox(), undefined);
  const c = await tool(as(A1), "bc_task_comment", { task_id: t.id, text: "@alexs-claude can you price this?" });
  assert.equal(c.isError, false, JSON.stringify(c.body));
  assert.equal((await inbox()).count, 1);
  assert.match((await inbox()).next, /mentions/);
  const got = await tool(as(B1), "bc_task_get", { task_id: t.id });
  assert.equal(got.isError, false);
  assert.equal(await inbox(), undefined);
});
