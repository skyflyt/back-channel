import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LIMITS, AGENT_CLAIM_MS, SEND_BACK_MS, STALE_PERSON_CLAIM_MS, ListRuleError, SECRET_MESSAGE,
  looksSecret, cleanText, parseDue, parseAssignee,
  canView, canWork, canComment, canManage, agentMayAct,
  hasLiveClaim, claimLapsed, effectiveStatus, claimCheck, claimPatch, releasePatch, renewPatch,
  finishCheck, donePatch, reviewCheck, reviewPatch, statusChange, nextPosition,
  who, whoLabel, taskView, entryView, plateSections,
} from "./rules.mjs";

const NOW = new Date("2026-10-09T18:00:00.000Z");
const later = (msFromNow) => new Date(NOW.getTime() + msFromNow);
const ME = "acct-skylar";
const ALEX = "acct-alex";
const AGENT = "agent-claude-code";
const OTHER_AGENT = "agent-codex";

const person = (over = {}) => ({ accountId: ME, agentId: null, role: "owner", agentAccess: null, ...over });
const agent = (over = {}) => ({ accountId: ME, agentId: AGENT, role: "owner", agentAccess: "work", ...over });
const task = (over = {}) => ({
  id: "t1", listId: "l1", title: "Renew the Mimecast cert", notes: "", version: 1, status: "open", position: 1024,
  dueAt: null, createdByAccountId: ME, createdByAgentId: null, assigneeAccountId: null, assigneeAgents: false,
  assigneeAgentId: null, claimAccountId: null, claimAgentId: null, claimedAt: null, claimExpiresAt: null,
  reviewerAccountId: null, completedAt: null, completedByAccountId: null, completedByAgentId: null, summary: null,
  createdAt: later(-60_000), updatedAt: later(-60_000), ...over,
});
const OK = { ok: true, why: "written by you or one of your agents" };
const throwsRule = (fn, code) => assert.throws(fn, (e) => e instanceof ListRuleError && e.code === code);

// ── text ──

test("looksSecret: catches keys and codes, leaves ordinary task text alone", () => {
  for (const s of [
    "-----BEGIN OPENSSH PRIVATE KEY-----\nabc",
    "key AKIAIOSFODNN7EXAMPLE here",
    "sk_live_51HcXyzABCDEFGHIJKLMNOP",
    "bc_" + "A".repeat(43),
    "bco_" + "x9_-".repeat(10),
    "code BCX-7Q2M-XK4P",
  ]) assert.equal(looksSecret(s), true, s);
  for (const s of [
    "Renew the cert before it expires",
    "Call bc_task_claim then bc_task_done",
    "Ticket SD 204376, change 2412",
    "AKIA is the AWS prefix",
    "sk_live_ keys go in the vault",
  ]) assert.equal(looksSecret(s), false, s);
});

test("cleanText: trims, strips control characters, enforces length in characters, refuses secrets with the plain-language message", () => {
  assert.equal(cleanText("  hello\u0007 world \r\n ", { field: "title", max: 200 }), "hello world");
  assert.equal(cleanText("a\nb", { field: "title", max: 200, singleLine: true }), "a b");
  assert.equal(cleanText("line 1\r\nline 2", { field: "notes", max: 200 }), "line 1\nline 2");
  assert.equal(cleanText(undefined, { field: "notes", max: 10 }), undefined);
  assert.equal(cleanText(null, { field: "notes", max: 10 }), undefined);
  assert.equal(cleanText("🎉".repeat(10), { field: "title", max: 10 }), "🎉".repeat(10), "counts characters, not UTF-16 units");
  throwsRule(() => cleanText("x".repeat(11), { field: "title", max: 10 }), "invalid_title");
  throwsRule(() => cleanText("   ", { field: "title", max: 10, required: true }), "invalid_title");
  throwsRule(() => cleanText(undefined, { field: "title", max: 10, required: true }), "invalid_title");
  throwsRule(() => cleanText(42, { field: "title", max: 10 }), "invalid_title");
  try {
    cleanText("my key is bc_" + "A".repeat(43), { field: "notes", max: 1000 });
    assert.fail("should refuse");
  } catch (e) {
    assert.equal(e.status, 422);
    assert.equal(e.message, SECRET_MESSAGE);
  }
});

test("parseDue: a plain date lands at noon UTC so it's the same day everywhere; null clears; nonsense and far-off dates are refused", () => {
  assert.equal(parseDue("2026-10-31", NOW).toISOString(), "2026-10-31T12:00:00.000Z");
  assert.equal(parseDue("2026-10-31T09:30:00-07:00", NOW).toISOString(), "2026-10-31T16:30:00.000Z");
  assert.equal(parseDue(null, NOW), null);
  assert.equal(parseDue("", NOW), null);
  assert.equal(parseDue(undefined, NOW), undefined);
  throwsRule(() => parseDue("next friday", NOW), "invalid_due");
  throwsRule(() => parseDue("2099-01-01", NOW), "invalid_due");
  throwsRule(() => parseDue(5, NOW), "invalid_due");
});

test("parseAssignee: the Phase 1 vocabulary", () => {
  assert.deepEqual(parseAssignee(null), { kind: "nobody" });
  assert.deepEqual(parseAssignee("nobody"), { kind: "nobody" });
  assert.deepEqual(parseAssignee(""), { kind: "nobody" });
  assert.deepEqual(parseAssignee("me"), { kind: "me" });
  assert.deepEqual(parseAssignee("My Agents"), { kind: "my_agents" });
  assert.deepEqual(parseAssignee("this_agent"), { kind: "this_agent" });
  assert.deepEqual(parseAssignee("33ed05fc-9afd-49b5-9a16-5be3ce1bc214"), { kind: "agent", agentId: "33ed05fc-9afd-49b5-9a16-5be3ce1bc214" });
  assert.equal(parseAssignee(undefined), undefined);
  throwsRule(() => parseAssignee("@alex"), "invalid_assignee");
  throwsRule(() => parseAssignee(7), "invalid_assignee");
});

// ── permissions and the OK rule ──

test("permissions: agents act with their person's role, capped by the access granted on this list", () => {
  assert.equal(canView(person()), true);
  assert.equal(canWork(person({ role: "member" })), true);
  assert.equal(canManage(person()), true);
  assert.equal(canManage(person({ role: "member" })), false);
  assert.equal(canView(agent({ agentAccess: "view" })), true);
  assert.equal(canComment(agent({ agentAccess: "view" })), true);
  assert.equal(canWork(agent({ agentAccess: "view" })), false);
  assert.equal(canView(agent({ agentAccess: null })), false, "an agent with no grant sees nothing");
  assert.equal(canManage(agent()), false, "agents never manage a list, even their owner's");
  assert.equal(canView(person({ role: null })), false, "not a member, not visible");
  assert.equal(canView(agent({ role: null })), false, "a grant without membership is worthless");
});

test("agentMayAct: your own and your agents' tasks yes; someone else's only after an OK or a list setting", () => {
  assert.equal(agentMayAct(task(), ME).ok, true);
  assert.equal(agentMayAct(task({ createdByAgentId: OTHER_AGENT }), ME).ok, true);
  const alexs = task({ createdByAccountId: ALEX });
  const no = agentMayAct(alexs, ME, { authorName: "Alex" });
  assert.equal(no.ok, false);
  assert.match(no.why, /^Alex wrote this/);
  assert.equal(agentMayAct(alexs, ME, { okAccountIds: [ME] }).ok, true);
  assert.equal(agentMayAct(alexs, ME, { okAccountIds: [ALEX] }).ok, false, "Alex's OK is for Alex's agents, not mine");
  assert.equal(agentMayAct(alexs, ME, { agentsTakeFrom: "anyone" }).ok, true);
});

// ── claims ──

test("claims: atomic semantics in the rules: one holder, the holder may re-claim, everyone else hears who has it", () => {
  const held = task({ status: "in_progress", ...claimPatch(task(), agent(), NOW) });
  assert.equal(held.claimExpiresAt.getTime(), NOW.getTime() + AGENT_CLAIM_MS);
  assert.deepEqual(claimCheck(held, agent(), NOW, OK), { ok: true, already: true });
  const other = claimCheck(held, agent({ agentId: OTHER_AGENT }), NOW, OK, () => "Skylar's Claude Code");
  assert.equal(other.code, "already_claimed");
  assert.equal(other.why, "Skylar's Claude Code is already on this.");
  assert.equal(claimCheck(held, person(), NOW, OK).code, "already_claimed", "the person too: claims are exclusive");
});

test("claims: a person's claim never lapses; an agent's lapses after an hour of silence and the task reads as open again", () => {
  const personHeld = task({ status: "in_progress", ...claimPatch(task(), person(), NOW) });
  assert.equal(personHeld.claimExpiresAt, null);
  assert.equal(hasLiveClaim(personHeld, later(30 * 24 * 60 * 60_000)), true);

  const agentHeld = task({ status: "in_progress", ...claimPatch(task(), agent(), NOW) });
  const afterLapse = later(AGENT_CLAIM_MS + 1);
  assert.equal(hasLiveClaim(agentHeld, later(AGENT_CLAIM_MS - 1)), true);
  assert.equal(hasLiveClaim(agentHeld, afterLapse), false);
  assert.equal(claimLapsed(agentHeld, afterLapse), true);
  assert.equal(effectiveStatus(agentHeld, afterLapse), "open");
  assert.equal(claimCheck(agentHeld, agent({ agentId: OTHER_AGENT }), afterLapse, OK).ok, true, "anyone may pick up a lapsed task");

  const blockedHeld = task({ ...agentHeld, status: "blocked" });
  assert.equal(effectiveStatus(blockedHeld, afterLapse), "blocked", "a lapse doesn't hide that it was blocked");
  assert.deepEqual(releasePatch(blockedHeld).status, "blocked");
  assert.deepEqual(releasePatch(agentHeld).status, "open");
});

test("claims: any write by the claiming agent renews; nobody else's does", () => {
  const held = task({ status: "in_progress", ...claimPatch(task(), agent(), NOW) });
  const t = later(50 * 60_000);
  assert.equal(renewPatch(held, agent(), t).claimExpiresAt.getTime(), t.getTime() + AGENT_CLAIM_MS);
  assert.equal(renewPatch(held, agent({ agentId: OTHER_AGENT }), t), null);
  assert.equal(renewPatch(held, person(), t), null, "people's claims have nothing to renew");
  assert.equal(renewPatch(held, agent(), later(AGENT_CLAIM_MS + 1)), null, "a lapsed claim isn't revived by a late write");
});

test("claims follow the assignment, and an agent needs the OK rule to pass", () => {
  const forAgent = task({ assigneeAccountId: ME, assigneeAgentId: AGENT });
  assert.equal(claimCheck(forAgent, agent(), NOW, OK).ok, true);
  assert.equal(claimCheck(forAgent, agent({ agentId: OTHER_AGENT }), NOW, OK).code, "assigned_elsewhere");
  assert.equal(claimCheck(forAgent, person(), NOW, OK).ok, true, "the person can take back work they gave an agent");
  const forAlex = task({ assigneeAccountId: ALEX });
  assert.equal(claimCheck(forAlex, person(), NOW, OK).code, "assigned_elsewhere");
  const needsOk = claimCheck(task({ createdByAccountId: ALEX }), agent(), NOW, { ok: false, why: "Alex wrote this" });
  assert.equal(needsOk.code, "needs_ok");
  assert.equal(claimCheck(task(), agent({ agentAccess: "view" }), NOW, OK).code, "not_allowed");
  assert.equal(claimCheck(task({ status: "done" }), agent(), NOW, OK).code, "not_claimable");
});

// ── finishing and review ──

test("finishing: agents must say what they did; people needn't", () => {
  throwsRule(() => donePatch(task(), agent(), NOW, undefined), "summary_required");
  throwsRule(() => donePatch(task(), agent(), NOW, ""), "summary_required");
  const byAgent = donePatch(task({ status: "in_progress", ...claimPatch(task(), agent(), NOW) }), agent(), NOW, "Renewed; new expiry 2027-10-28");
  assert.equal(byAgent.status, "done", "your own agent finishing your own task is final");
  assert.equal(byAgent.completedByAgentId, AGENT);
  assert.equal(byAgent.claimAgentId, null, "the claim is cleared, the record of who did it is kept");
  assert.equal(donePatch(task(), person(), NOW, undefined).status, "done");
});

test("finishing someone else's request sends it to them for a look", () => {
  const p = donePatch(task({ createdByAccountId: ALEX }), agent(), NOW, "Booked it");
  assert.equal(p.status, "needs_review");
  assert.equal(p.reviewerAccountId, ALEX);
});

test("finishCheck: claimant, or anyone who could claim it now, or the list owner over someone else's claim", () => {
  const held = task({ status: "in_progress", ...claimPatch(task(), agent(), NOW) });
  assert.equal(finishCheck(held, agent(), NOW, OK, false).ok, true);
  assert.equal(finishCheck(held, agent({ agentId: OTHER_AGENT }), NOW, OK, false).code, "already_claimed");
  assert.equal(finishCheck(held, person(), NOW, OK, true).ok, true, "the owner can close out anything on their list");
  assert.equal(finishCheck(task(), agent(), NOW, OK, false).ok, true, "claim-and-finish in one step");
  assert.equal(finishCheck(task({ status: "done" }), person(), NOW, OK, true).code, "not_finishable");
});

test("review: people only; Looks good closes it; Send back returns it to whoever did it with a fresh claim", () => {
  const review = task({ createdByAccountId: ALEX, status: "needs_review", reviewerAccountId: ALEX, completedAt: NOW, completedByAccountId: ME, completedByAgentId: AGENT, summary: "Booked" });
  const alex = person({ accountId: ALEX, role: "member" });
  assert.equal(reviewCheck(review, agent(), NOW, "accept", false).code, "people_only");
  assert.equal(reviewCheck(review, person({ role: "member" }), NOW, "accept", false).code, "not_reviewer");
  assert.equal(reviewCheck(review, alex, NOW, "accept", false).ok, true);
  assert.deepEqual(reviewPatch(review, "accept", NOW), { status: "done", reviewerAccountId: null });
  const back = reviewPatch(review, "send_back", NOW);
  assert.equal(back.status, "in_progress");
  assert.equal(back.claimAgentId, AGENT);
  assert.equal(back.claimExpiresAt.getTime(), NOW.getTime() + AGENT_CLAIM_MS);
  assert.equal(back.completedAt, null);
});

test("send back: an agent's finished work, for seven days, by the person who asked", () => {
  const done = task({ status: "done", completedAt: NOW, completedByAccountId: ME, completedByAgentId: AGENT, summary: "x" });
  assert.equal(reviewCheck(done, person(), later(SEND_BACK_MS - 1), "send_back", true).ok, true);
  assert.equal(reviewCheck(done, person(), later(SEND_BACK_MS + 1), "send_back", true).code, "too_late");
  assert.equal(reviewCheck(task({ ...done, completedByAgentId: null }), person(), NOW, "send_back", true).code, "not_reviewable");
  assert.equal(reviewCheck(done, person(), NOW, "accept", true).code, "not_reviewable", "done is already accepted");
});

test("statusChange: block and unblock by whoever is on it; drop, restore and reopen are a person's call", () => {
  const held = task({ status: "in_progress", ...claimPatch(task(), agent(), NOW) });
  const blocked = statusChange(held, agent(), NOW, "blocked", false);
  assert.deepEqual(blocked, { ok: true, patch: { status: "blocked" } });
  assert.equal(statusChange(held, agent({ agentId: OTHER_AGENT }), NOW, "blocked", false).code, "already_claimed");
  const unblocked = statusChange({ ...held, status: "blocked" }, agent(), NOW, "unblocked", false);
  assert.equal(unblocked.patch.status, "in_progress");
  assert.equal(statusChange(task({ status: "blocked" }), person(), NOW, "unblocked", true).patch.status, "open");
  assert.equal(statusChange(held, agent(), NOW, "dropped", false).code, "people_only");
  assert.equal(statusChange(held, person(), NOW, "dropped", true).patch.status, "dropped");
  assert.equal(statusChange(task({ status: "dropped" }), person(), NOW, "restored", true).patch.status, "open");
  assert.equal(statusChange(task({ status: "done", completedAt: NOW }), person(), NOW, "reopened", true).patch.status, "open");
  assert.equal(statusChange(task(), person(), NOW, "reopened", true).code, "bad_status");
});

test("nextPosition appends after the last task", () => {
  assert.equal(nextPosition(null), 1024);
  assert.equal(nextPosition(2048), 3072);
});

// ── views ──

const names = {
  accounts: new Map([[ME, { handle: "skyflyt86@bc", displayName: "Skylar" }], [ALEX, { handle: "alex@bc", displayName: null }]]),
  agents: new Map([[AGENT, { name: "Claude Code", accountId: ME }], [OTHER_AGENT, { name: "Codex", accountId: ME }]]),
};

test("who/whoLabel: agents are always shown with their person; gone people and agents still read sensibly", () => {
  assert.equal(whoLabel(who(names, ME, AGENT, person())), "Skylar's Claude Code");
  assert.equal(whoLabel(who(names, ALEX, null, person())), "alex@bc");
  assert.equal(who(names, "gone", null, person()).person, "a former member");
  assert.equal(who(names, ME, "revoked-agent", person()).agent, "a removed agent");
  assert.equal(who(names, ME, AGENT, agent()).is_this_agent, true);
  assert.equal(who(names, ME, OTHER_AGENT, agent()).is_this_agent, false);
  assert.equal("is_this_agent" in who(names, ME, AGENT, person()), false, "only agents get the is_this_agent hint");
  assert.equal(who(names, null, null, person()), null);
});

test("taskView: carries provenance, the live claim, the OK rule, and hides a lapsed claim", () => {
  const list = { id: "l1", name: "Work", shared: false };
  const held = task({ status: "in_progress", ...claimPatch(task(), agent(), NOW), dueAt: new Date("2026-10-31T12:00:00Z") });
  const v = taskView(held, { actor: agent({ agentId: OTHER_AGENT }), names, list, mayAct: OK, now: NOW });
  assert.equal(v.status, "in_progress");
  assert.equal(v.claim.by.agent, "Claude Code");
  assert.equal(v.claim.lapses_at, new Date(NOW.getTime() + AGENT_CLAIM_MS).toISOString());
  assert.equal(v.due, "2026-10-31T12:00:00.000Z");
  assert.deepEqual(v.agent_may_act, OK);
  assert.equal(v.created_by.is_you, true);
  const lapsed = taskView(held, { actor: person(), names, list, mayAct: OK, now: later(AGENT_CLAIM_MS + 1) });
  assert.equal(lapsed.status, "open");
  assert.equal(lapsed.claim, null);
});

test("taskView: stale person claims, review and send-back windows", () => {
  const list = { id: "l1", name: "Work", shared: false };
  const old = later(-(STALE_PERSON_CLAIM_MS + 60_000));
  const stale = task({ status: "in_progress", claimAccountId: ME, claimedAt: old, updatedAt: old });
  assert.equal(taskView(stale, { actor: person(), names, list, mayAct: OK, now: NOW }).claim.stale, true);
  const done = task({ status: "done", completedAt: NOW, completedByAccountId: ME, completedByAgentId: AGENT, summary: "Renewed" });
  const dv = taskView(done, { actor: person(), names, list, mayAct: OK, now: NOW });
  assert.equal(dv.summary, "Renewed");
  assert.equal(dv.completed_by.agent, "Claude Code");
  assert.equal(dv.send_back_until, new Date(NOW.getTime() + SEND_BACK_MS).toISOString());
  const review = task({ status: "needs_review", reviewerAccountId: ALEX, completedAt: NOW, completedByAccountId: ME, completedByAgentId: AGENT });
  assert.equal(taskView(review, { actor: person(), names, list, mayAct: OK, now: NOW }).needs_review_by.handle, "alex@bc");
});

test("taskView with lines: the latest progress and what a blocked task is waiting on, no extra requests", () => {
  const list = { id: "l1", name: "Work", shared: false };
  const held = task({ status: "blocked", ...claimPatch(task(), agent(), NOW), status: "blocked" });
  const lines = {
    progress: { body: "Renewed in portal", authorAccountId: ME, authorAgentId: AGENT, createdAt: NOW },
    blocked: { body: "marked this blocked: waiting on DNS", eventType: "blocked" },
  };
  const v = taskView(held, { actor: person(), names, list, mayAct: OK, now: NOW, lines });
  assert.equal(v.last_progress.text, "Renewed in portal");
  assert.equal(v.last_progress.by.agent, "Claude Code");
  assert.equal(v.blocked_reason, "waiting on DNS");
  const quiet = taskView(task({ status: "in_progress", claimAccountId: ME, claimedAt: NOW }), { actor: person(), names, list, mayAct: OK, now: NOW, lines: {} });
  assert.equal(quiet.last_progress, null);
  assert.equal("blocked_reason" in quiet, false, "only blocked tasks carry a reason");
  assert.equal("last_progress" in taskView(task(), { actor: person(), names, list, mayAct: OK, now: NOW }), false, "absent unless asked for");
});

test("entryView: who said it and when", () => {
  const e = entryView({ id: "e1", kind: "progress", authorAccountId: ME, authorAgentId: AGENT, body: "Checked expiry", eventType: null, createdAt: NOW }, { actor: person(), names });
  assert.deepEqual(e, { id: "e1", kind: "progress", by: who(names, ME, AGENT, person()), text: "Checked expiry", at: NOW.toISOString() });
});

// ── my plate ──

test("plateSections for an agent: what it's doing, what's for it, what it could take, what its person must check", () => {
  const rows = [
    task({ id: "doing", status: "in_progress", ...claimPatch(task(), agent(), NOW) }),
    task({ id: "for-this-agent", assigneeAccountId: ME, assigneeAgentId: AGENT }),
    task({ id: "for-my-agents", assigneeAccountId: ME, assigneeAgents: true, dueAt: later(60_000) }),
    task({ id: "for-the-person", assigneeAccountId: ME }),
    task({ id: "for-codex", assigneeAccountId: ME, assigneeAgentId: OTHER_AGENT }),
    task({ id: "unassigned-late", position: 5000 }),
    task({ id: "unassigned-due", position: 9000, dueAt: later(3600_000) }),
    task({ id: "not-allowed" }),
    task({ id: "held-by-codex", status: "in_progress", ...claimPatch(task(), agent({ agentId: OTHER_AGENT }), NOW) }),
    task({ id: "review", status: "needs_review", reviewerAccountId: ME, completedAt: NOW }),
    task({ id: "done", status: "done", completedAt: NOW, completedByAccountId: ME, completedByAgentId: AGENT }),
  ];
  const p = plateSections(rows, agent(), NOW, (t) => t.id !== "not-allowed");
  assert.deepEqual(p.doing.map((t) => t.id), ["doing"]);
  assert.deepEqual(p.up_next.map((t) => t.id), ["for-my-agents", "for-this-agent"], "due date first");
  assert.deepEqual(p.claimable.map((t) => t.id), ["unassigned-due", "unassigned-late"]);
  assert.deepEqual(p.waiting_on_you.map((t) => t.id), ["review"]);
  assert.deepEqual(p.done_recently, [], "celebrating is for people");
});

test("plateSections for a person: their own claims and assignments, reviews, and what their agents just finished", () => {
  const rows = [
    task({ id: "mine", status: "in_progress", claimAccountId: ME, claimedAt: NOW }),
    task({ id: "agent-doing", status: "in_progress", ...claimPatch(task(), agent(), NOW) }),
    task({ id: "for-me", assigneeAccountId: ME }),
    task({ id: "for-agents", assigneeAccountId: ME, assigneeAgents: true }),
    task({ id: "done-by-agent", status: "done", completedAt: later(-60_000), completedByAccountId: ME, completedByAgentId: AGENT }),
    task({ id: "done-long-ago", status: "done", completedAt: later(-48 * 3600_000), completedByAccountId: ME, completedByAgentId: AGENT }),
  ];
  const p = plateSections(rows, person(), NOW, () => true);
  assert.deepEqual(p.doing.map((t) => t.id), ["mine", "agent-doing"], "a person sees their agents' work as theirs too");
  assert.deepEqual(p.up_next.map((t) => t.id), ["for-me"]);
  assert.deepEqual(p.done_recently.map((t) => t.id), ["done-by-agent"]);
});

test("limits are the design's numbers", () => {
  assert.deepEqual([LIMITS.title, LIMITS.notes, LIMITS.entry, LIMITS.batchAdd, LIMITS.listsPerAccount], [200, 20_000, 8_000, 20, 50]);
  assert.equal(AGENT_CLAIM_MS, 3_600_000);
});
