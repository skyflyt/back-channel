import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as R from "./rules.mjs";

const T0 = new Date("2026-10-09T18:00:00.000Z");
const at = (minutes) => new Date(T0.getTime() + minutes * 60_000);
const session = (over = {}) => ({
  id: "11111111-1111-4111-8111-111111111111", accountId: "acct", kind: "agent", hostDeviceId: "pc-1", agentTokenId: "agent-a",
  executorAgentId: null, listTaskId: null, goal: "Enter this week's invoices", appAllowList: ["QuickBooks"], minutes: 30,
  status: "awaiting_consent", createdAt: T0, startedAt: null, expiresAt: null, endedAt: null, endReason: null, ...over,
});
const running = (over = {}) => session({ status: "active", startedAt: T0, expiresAt: at(30), ...over });
const refused = (fn, code, status) => assert.throws(fn, (e) => e instanceof R.RemoteRuleError && e.code === code && (status === undefined || e.status === status), code);

test("start: apps, minutes, goal and task are validated; the cap is 60 minutes", () => {
  const ok = R.parseStart({ host: " Shop-PC ", apps: ["QuickBooks", "quickbooks", "Notepad++"], minutes: 30, goal: "Enter\nthe invoices", taskId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" });
  assert.deepEqual(ok, { host: "Shop-PC", apps: ["QuickBooks", "Notepad++"], minutes: 30, goal: "Enter the invoices", taskId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", executor: undefined });
  assert.deepEqual(R.parseStart({ host: "pc", apps: "Excel", minutes: "5", goal: "g" }).apps, ["Excel"], "one app as a string, minutes as digits");
  for (const minutes of [0, 61, 1.5, -3, "sixty", null, undefined, 600]) refused(() => R.parseMinutes(minutes), "invalid_minutes", 400);
  assert.equal(R.parseMinutes(60), 60);
  assert.equal(R.parseMinutes(1), 1);
  for (const apps of [[], undefined, Array.from({ length: 9 }, (_, i) => `App${i}`), [""], [42]]) refused(() => R.parseApps(apps), "invalid_apps");
  for (const bad of ["*", "C:\\Windows\\notepad.exe", "../x", "Quick*", "a/b", "?"]) refused(() => R.parseApps([bad]), "invalid_apps", 400);
  refused(() => R.parseApps(["x".repeat(61)]), "invalid_apps", 400);
  refused(() => R.parseStart({ host: "pc", apps: ["Excel"], minutes: 5 }), "invalid_goal", 400);
  refused(() => R.parseStart({ host: "pc", apps: ["Excel"], minutes: 5, goal: "g".repeat(501) }), "invalid_goal", 400);
  refused(() => R.parseStart({ host: "pc", apps: ["Excel"], minutes: 5, goal: "use key " + ["sk", "live", "abcdefghijklmnopqrstuvwx"].join("_") }), "secret_like", 422);
  refused(() => R.parseStart({ host: "pc", apps: ["Excel"], minutes: 5, goal: "g", taskId: "not-a-task" }), "invalid_task_id", 400);
});

test("text: invisible and direction-changing characters never reach an approval card", () => {
  assert.equal(R.cleanText("Pay\u202Eredli\u202C Bob\u200B", { field: "goal", max: 50 }), "Payredli Bob");
  assert.equal(R.cleanText("  a \n\t b  ", { field: "goal", max: 50 }), "a b");
  assert.equal(R.cleanText("line one\nline two", { field: "summary", max: 50, singleLine: false }), "line one\nline two");
  assert.equal(R.cleanText(undefined, { field: "x", max: 5 }), undefined);
  assert.equal([...R.cleanText("y".repeat(200), { field: "target", max: 120, truncate: true })].length, 120, "a long control name is cut to 120, not refused");
});

test("one session per account at a time", () => {
  assert.doesNotThrow(() => R.startCheck(0));
  refused(() => R.startCheck(1), "session_in_progress", 409);
  const row = R.newSession({ accountId: "acct", hostDeviceId: "pc-1", agentId: "agent-a", executorAgentId: "agent-a", goal: "g", apps: ["Excel"], minutes: 5 });
  assert.equal(row.status, "awaiting_consent", "a new session is never active: only the person's approval starts it");
  assert.equal(row.executorAgentId, null, "the agent that asked drives it unless another is named");
  assert.equal(R.executorOf(row), "agent-a");
  assert.equal(R.executorOf({ ...row, executorAgentId: "agent-b" }), "agent-b");
  assert.equal(row.kind, "agent");
});

test("consent: approve or deny only a waiting request; it lapses after 10 minutes and that is final", () => {
  const s = session();
  assert.doesNotThrow(() => R.decideCheck(s, at(9.9)));
  refused(() => R.decideCheck(s, at(10)), "request_expired", 410);
  assert.deepEqual(R.settle(s, at(10)), { status: "lapsed", endedAt: at(10) });
  assert.equal(R.effective(s, at(11)).status, "lapsed");
  const approved = R.approvePatch(s, "acct", at(2));
  assert.deepEqual(approved, { status: "active", consentBy: "acct", consentVia: "web", startedAt: at(2), expiresAt: at(32) });
  refused(() => R.decideCheck({ ...s, ...approved }, at(3)), "already_decided", 409);
  assert.deepEqual(R.denyPatch("acct", at(1)), { status: "denied", consentBy: "acct", consentVia: "web", endedAt: at(1) });
  refused(() => R.decideCheck({ ...s, status: "denied" }, at(1)), "already_decided", 409);
  assert.equal(R.consentDeadline(s).getTime(), at(10).getTime());
});

test("time: a running session ends when its minutes are up, paused or not", () => {
  assert.equal(R.settle(running(), at(29.9)), null);
  assert.deepEqual(R.settle(running(), at(30)), { status: "ended", endReason: "lapsed", endedAt: at(30) });
  assert.deepEqual(R.settle(running({ status: "blocked" }), at(45)), { status: "ended", endReason: "lapsed", endedAt: at(30) });
  assert.equal(R.settle(session({ status: "ended", endReason: "done" }), at(99)), null, "terminal stays terminal");
});

test("stop: beats everything, is final, and says who stopped it", () => {
  assert.deepEqual(R.stopPatch(running(), "person", at(5)), { status: "ended", endReason: "user_stop", endedAt: at(5) });
  assert.deepEqual(R.stopPatch(running({ status: "blocked" }), "host", at(5)), { status: "ended", endReason: "host_stop", endedAt: at(5) });
  assert.deepEqual(R.stopPatch(running(), "agent", at(5)), { status: "ended", endReason: "agent_stop", endedAt: at(5) });
  assert.equal(R.stopPatch(running({ status: "ended", endReason: "done" }), "person", at(5)), null, "stopping again is a no-op");
  assert.equal(R.stopPatch(running(), "person", at(31)), null, "out of time is already over");
  assert.deepEqual(R.stopPatch(session(), "person", at(1), "acct"), { status: "denied", consentBy: "acct", consentVia: "web", endedAt: at(1) }, "a person stopping a waiting request denies it");
  assert.deepEqual(R.stopPatch(session(), "agent", at(1)), { status: "ended", endReason: "agent_stop", endedAt: at(1) });
});

test("pause and go on: only a paused session can be resumed", () => {
  assert.doesNotThrow(() => R.resumeCheck(running({ status: "blocked" }), at(1)));
  refused(() => R.resumeCheck(running(), at(1)), "not_paused", 409);
  refused(() => R.resumeCheck(running({ status: "blocked" }), at(31)), "not_paused", 409);
});

test("end: done, withdrawn, or fail_closed when it gave up while paused", () => {
  assert.deepEqual(R.endPatch(running(), { finished: true }, at(5)), { status: "ended", endReason: "done", endedAt: at(5) });
  assert.deepEqual(R.endPatch(running(), { finished: false }, at(5)), { status: "ended", endReason: "agent_stop", endedAt: at(5) });
  assert.deepEqual(R.endPatch(running({ status: "blocked" }), { finished: false }, at(5)), { status: "ended", endReason: "fail_closed", endedAt: at(5) });
  assert.deepEqual(R.endPatch(running({ status: "blocked" }), { finished: true }, at(5)).endReason, "done");
  assert.deepEqual(R.endPatch(session(), { finished: false }, at(1)), { status: "ended", endReason: "agent_stop", endedAt: at(1) }, "withdraw a waiting request");
  refused(() => R.endPatch(session(), { finished: true }, at(1)), "not_approved", 409);
  refused(() => R.endPatch(running({ status: "ended", endReason: "user_stop" }), { finished: true }, at(1)), "session_over", 409);
  refused(() => R.endPatch(running(), { finished: true }, at(30)), "session_over", 409);
});

test("steps: fixed kinds, a bounded target, an outcome, and no field for content", () => {
  assert.deepEqual(R.parseReport({ action: "invoke", target: " Save ", outcome: "ok" }), { action: "invoke", target: "Save", outcome: "ok", evidenceRef: null });
  refused(() => R.parseReport({ action: "set_value", target: "Amount", outcome: "ok", value: "1200.00" }), "unknown_field", 400);
  refused(() => R.parseReport({ action: "type", target: "x", outcome: "ok" }), "invalid_action", 400);
  refused(() => R.parseReport({ action: "invoke", target: "x", outcome: "maybe" }), "invalid_outcome", 400);
  refused(() => R.parseReport({ action: "invoke", outcome: "ok" }), "target_required", 400);
  refused(() => R.parseReport({ action: "key", target: "VK_0x41", outcome: "ok" }), "invalid_target", 400);
  assert.equal(R.parseReport({ action: "key", target: "Enter", outcome: "ok" }).target, "Enter");
  refused(() => R.parseReport({ action: "blocked", outcome: "ok" }), "invalid_outcome", 400);
  refused(() => R.parseReport({ action: "screenshot", outcome: "ok" }), "evidence_required", 400);
  refused(() => R.parseReport({ action: "screenshot", outcome: "ok", evidenceRef: "../../etc/passwd" }), "invalid_evidenceRef", 400);
  assert.equal(R.parseReport({ action: "screenshot", outcome: "ok", evidenceRef: "audit:2026-10-09:0007" }).evidenceRef, "audit:2026-10-09:0007");
  assert.equal(R.parseReport({ action: "observe", outcome: "ok" }).target, null);
  assert.equal([...R.parseReport({ action: "invoke", target: "z".repeat(500), outcome: "ok" }).target].length, 120);
  refused(() => R.parseReport({ action: "invoke", target: "AKIAABCDEFGHIJKLMNOP", outcome: "ok" }), "secret_like", 422);
});

test("steps: only a running, unpaused session records; anything but ok pauses it; an app off the list is not_in_scope", () => {
  const step = (over) => ({ action: "invoke", target: "Save", outcome: "ok", evidenceRef: null, ...over });
  assert.deepEqual(R.reportDecision(running(), step(), at(1), 0), { row: step(), pause: false, refused: null });
  for (const outcome of R.FAIL_CLOSED) assert.equal(R.reportDecision(running(), step({ outcome }), at(1), 0).pause, true, outcome);
  assert.deepEqual(R.reportDecision(running(), step({ action: "open", target: "quickbooks" }), at(1), 0).pause, false, "allow-list compares without case");
  assert.deepEqual(R.reportDecision(running(), step({ action: "open", target: "Outlook" }), at(1), 0),
    { row: step({ action: "open", target: "Outlook", outcome: "not_in_scope" }), pause: true, refused: "not_in_scope" });
  refused(() => R.reportDecision(running({ status: "blocked" }), step(), at(1), 0), "paused", 409);
  refused(() => R.reportDecision(session(), step(), at(1), 0), "not_approved", 409);
  refused(() => R.reportDecision(running(), step(), at(30), 0), "session_over", 409);
  refused(() => R.reportDecision(running({ status: "ended", endReason: "user_stop" }), step(), at(1), 0), "session_over", 409);
  refused(() => R.reportDecision(running(), step(), at(1), R.LIMITS.actionsPerSession), "too_many_steps", 429);
});

test("relay admission: only an approved, running, unpaused, unexpired session, for that PC and account", () => {
  const b = { accountId: "acct", hostDeviceId: "pc-1" };
  assert.equal(R.admitsAgentLease(running(), b, at(1)), true);
  assert.equal(R.admitsAgentLease(running(), b, at(30)), false, "expired");
  for (const status of ["awaiting_consent", "blocked", "ended", "denied", "lapsed"]) assert.equal(R.admitsAgentLease(running({ status }), b, at(1)), false, status);
  assert.equal(R.admitsAgentLease(running(), { ...b, hostDeviceId: "pc-2" }, at(1)), false, "another PC");
  assert.equal(R.admitsAgentLease(running(), { ...b, accountId: "other" }, at(1)), false, "another account");
  assert.equal(R.admitsAgentLease(running({ kind: "support" }), b, at(1)), false, "Phase B sessions never ride this path");
  assert.equal(R.admitsAgentLease(null, b, at(1)), false);
  assert.equal(R.agentLeaseExpiry(running(), at(29.5), 120_000).getTime(), at(30).getTime(), "a lease never outlives its session");
  assert.equal(R.agentLeaseExpiry(running(), at(1), 120_000).getTime(), at(3).getTime());
  const live = (id, over = {}) => ({ id, accountId: "acct", revokedAt: null, scope: "full", ...over });
  assert.equal(R.agentsAdmit(running(), [live("agent-a")]), true);
  assert.equal(R.agentsAdmit(running({ executorAgentId: "agent-b" }), [live("agent-a")]), false, "the driver must be live too");
  assert.equal(R.agentsAdmit(running({ executorAgentId: "agent-b" }), [live("agent-a"), live("agent-b")]), true);
  assert.equal(R.agentsAdmit(running(), [live("agent-a", { revokedAt: new Date() })]), false, "revoked");
  assert.equal(R.agentsAdmit(running(), [live("agent-a", { scope: "connector" })]), false, "a connector key never drives a PC");
  assert.equal(R.agentsAdmit(running(), [live("agent-a", { accountId: "other" })]), false);
});

test("phrases are fixed: kind, bounded target and outcome only", () => {
  assert.equal(R.actionPhrase({ action: "open", target: "QuickBooks", outcome: "ok" }, { pc: "Shop-PC" }), "Opened QuickBooks on Shop-PC.");
  assert.equal(R.actionPhrase({ action: "invoke", target: "Save", outcome: "ok" }), "Clicked 'Save'.");
  assert.equal(R.actionPhrase({ action: "set_value", target: "Amount", outcome: "ok" }), "Filled in 'Amount'.");
  assert.equal(R.actionPhrase({ action: "set_value", target: "Password", outcome: "credential_field" }, { pc: "Shop-PC" }),
    "Tried to fill in 'Password' on Shop-PC, and stopped: that's a password field, and agents never type passwords.");
  assert.equal(R.actionPhrase({ action: "open", target: "Outlook", outcome: "not_in_scope" }), "Tried to open Outlook, and stopped: that's outside the apps you approved.");
  assert.equal(R.actionPhrase({ action: "blocked", target: null, outcome: "needs_user" }), "Stopped and asked: it needs you at the PC.");
  assert.equal(R.actionPhrase({ action: "screenshot", target: null, outcome: "ok" }, { pc: "Shop-PC" }), "Saved a screenshot on Shop-PC (kept on the PC).");
  assert.equal(R.actionPhrase({ action: "observe", target: null, outcome: "ok" }), "Looked at the screen.");
  assert.equal(R.actionPhrase({ action: "key", target: "Enter", outcome: "ok" }), "Pressed Enter.");
  for (const a of R.ACTIONS) for (const o of R.OUTCOMES) {
    if (a === "blocked" && o === "ok") continue;
    const text = R.actionPhrase({ action: a, target: a === "key" ? "Tab" : "Field", outcome: o }, { pc: "PC" });
    assert.ok(text.length > 5 && !/\u2014|undefined|null/.test(text), `${a}/${o}: ${text}`);
  }
});

test("views and next steps say what to do, honestly", () => {
  const names = { pc: "Shop-PC", startedBy: "Claude Code", drivenBy: "Shop agent" };
  const waiting = R.sessionView(session(), { now: at(1), ...names });
  assert.equal(waiting.status, "awaiting_consent");
  assert.equal(waiting.approvalExpiresAt, at(10).toISOString());
  assert.match(R.nextStep(waiting, { role: "starter", sameAgent: true }), /approvalUrl.*don't open it yourself/);
  const handOff = R.sessionView(running({ executorAgentId: "agent-b" }), { now: at(1), ...names });
  const next = R.nextStep(handOff, { role: "starter", sameAgent: false });
  assert.match(next, /Dispatch/); assert.match(next, /targetAgentId agent-b/); assert.match(next, new RegExp(`remoteAppSessionId "${handOff.id}"`));
  assert.match(R.nextStep(R.sessionView(running(), { now: at(1), ...names }), { role: "driver", sameAgent: true }), /not_available_yet/);
  const paused = R.sessionView(running({ status: "blocked" }), { now: at(1), ...names, pausedBecause: R.OUTCOME_PHRASES.needs_user });
  assert.equal(paused.pausedBecause, "it needs you at the PC");
  assert.match(R.nextStep(paused, { role: "driver", sameAgent: true }), /Don't work around it/);
  const over = R.sessionView(running(), { now: at(31), ...names });
  assert.equal(over.status, "ended"); assert.equal(over.statusText, "ran out of time");
  assert.match(R.nextStep(over, { role: "starter", sameAgent: true }), /new approval/);
  const row = { at: at(2), action: "invoke", target: "Save", outcome: "ok", evidenceRef: "ev:1", id: 7n };
  assert.deepEqual(R.actionView(row), { at: at(2).toISOString(), action: "invoke", target: "Save", outcome: "ok", text: "Clicked 'Save'.", evidenceRef: "ev:1" });
  assert.doesNotThrow(() => JSON.stringify(R.actionView(row)), "no BigInt id leaks into a view");
});

test("the executor secret: abx_ and 43 base64url characters, stored as its sha256 only", () => {
  const bytes = new Uint8Array(32).fill(7);
  const { secret, hash } = R.newExecutorSecret(bytes);
  assert.match(secret, R.EXECUTOR_SECRET);
  assert.equal(secret, "abx_" + Buffer.from(bytes).toString("base64url"));
  assert.equal(hash, createHash("sha256").update(secret).digest("hex"));
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(R.newExecutorSecret(new Uint8Array(32).fill(8)).secret, secret);
  for (const bad of [new Uint8Array(31), new Uint8Array(33), "x".repeat(32), null]) assert.throws(() => R.newExecutorSecret(bad), TypeError);
  assert.deepEqual(R.executorSecretPatch(hash, at(3)), { executorSecretHash: hash, executorSecretIssuedAt: at(3) });
});

test("the executor secret is due once, while the session runs, and never for a v1 session", () => {
  const h = "e".repeat(64);
  assert.equal(R.executorSecretDue(running({ executorSecretHash: h }), at(1)), true, "approved and running");
  assert.equal(R.executorSecretDue(running({ executorSecretHash: h, status: "blocked" }), at(1)), true, "paused is still running");
  assert.equal(R.executorSecretDue(running({ executorSecretHash: h, executorSecretIssuedAt: at(1) }), at(2)), false, "handed out already: never again");
  assert.equal(R.executorSecretDue(session({ executorSecretHash: h }), at(1)), false, "not before approval");
  assert.equal(R.executorSecretDue(running({ executorSecretHash: h }), at(31)), false, "not once time is up");
  assert.equal(R.executorSecretDue(running({ executorSecretHash: h, status: "ended", endReason: "done" }), at(2)), false);
  assert.equal(R.executorSecretDue(running({ executorSecretHash: null }), at(1)), false, "a v1 session (no hash) never gets one");
  assert.equal(R.executorSecretDue(running({ executorSecretHash: undefined }), at(1)), false);
  // Support: only once the helped person has allowed it (support sessions never pause).
  const support = (over = {}) => running({ kind: "support", executorSecretHash: h, ...over });
  assert.equal(R.executorSecretDue(support(), at(1)), true);
  assert.equal(R.executorSecretDue(support({ status: "awaiting_consent", startedAt: null, expiresAt: null }), at(1)), false);
});

test("rotating the executor secret: only its reader's, while running, never for a v1 session", () => {
  const h = "e".repeat(64);
  assert.doesNotThrow(() => R.executorSecretRotateCheck(running({ executorSecretHash: h, executorSecretIssuedAt: at(1) }), at(2)));
  assert.doesNotThrow(() => R.executorSecretRotateCheck(running({ executorSecretHash: h }), at(2)), "before the first hand-out it hands the first one out");
  refused(() => R.executorSecretRotateCheck(running({ executorSecretHash: null }), at(2)), "no_executor_secret", 409);
  refused(() => R.executorSecretRotateCheck(session({ executorSecretHash: h }), at(2)), "not_approved", 409);
  refused(() => R.executorSecretRotateCheck(session({ kind: "support", executorSecretHash: h }), at(2)), "not_allowed_yet", 409);
  refused(() => R.executorSecretRotateCheck(running({ executorSecretHash: h }), at(31)), "session_over", 409);
  refused(() => R.executorSecretRotateCheck(running({ executorSecretHash: h, status: "ended", endReason: "user_stop" }), at(2)), "session_over", 409);
});

test("v1.1: a new session is born with its executor secret's hash; the executor is told it is shown once, and how to recover it", () => {
  const s = R.newSession({ accountId: "acct", hostDeviceId: "pc-1", agentId: "agent-a", executorAgentId: "agent-b", goal: "g", apps: ["Excel"], minutes: 5, executorSecretHash: "e".repeat(64) });
  assert.equal(s.executorSecretHash, "e".repeat(64)); assert.equal(s.status, "awaiting_consent");
  assert.ok(!("executorSecretIssuedAt" in s), "born, never handed out yet");
  const names = { pc: "Shop-PC", startedBy: "Claude Code", drivenBy: "Shop agent" };
  const plain = R.sessionView(running({ executorAgentId: "agent-b" }), { now: at(1), ...names });
  assert.doesNotMatch(R.nextStep(plain, { role: "driver", sameAgent: false }), /executor-secret|shown this once/);
  const handed = { ...plain, executorSecret: "abx_" + "Q".repeat(43) };
  const next = R.nextStep(handed, { role: "driver", sameAgent: false });
  assert.match(next, /shown this once/); assert.match(next, /hello on the PC's agent-control pipe/);
  assert.match(next, new RegExp(`POST /api/remote-app/sessions/${plain.id}/executor-secret`));
});

test("desktop scope: every new session may use the whole PC; apps are optional, only what it expects to use", () => {
  assert.deepEqual(R.parseStart({ host: "pc", minutes: 5, goal: "g" }).apps, [], "apps left out");
  assert.deepEqual(R.parseStart({ host: "pc", apps: [], minutes: 5, goal: "g" }).apps, [], "or empty");
  assert.deepEqual(R.parseStart({ host: "pc", apps: null, minutes: 5, goal: "g" }).apps, []);
  assert.deepEqual(R.parseStart({ host: "pc", apps: ["Notepad", "notepad"], minutes: 5, goal: "g" }).apps, ["Notepad"]);
  refused(() => R.parseStart({ host: "pc", apps: Array.from({ length: 9 }, (_, i) => `App${i}`), minutes: 5, goal: "g" }), "invalid_apps", 400);
  for (const bad of ["*", "C:\Windows\notepad.exe", "a/b"]) refused(() => R.parseStart({ host: "pc", apps: [bad], minutes: 5, goal: "g" }), "invalid_apps", 400);
  refused(() => R.parseStart({ host: "pc", apps: "", minutes: 5, goal: "g" }), "invalid_apps", 400);
  refused(() => R.parseStart({ host: "pc", apps: { a: 1 }, minutes: 5, goal: "g" }), "invalid_apps", 400);
  assert.deepEqual(R.parseApps(undefined, { optional: true }), []);
  refused(() => R.parseApps([]), "invalid_apps", 400);
  const s = R.newSession({ accountId: "acct", hostDeviceId: "pc-1", agentId: "agent-a", executorAgentId: null, goal: "g", apps: [], minutes: 5, executorSecretHash: "e".repeat(64) });
  assert.equal(s.scope, "desktop");
  assert.deepEqual(s.appAllowList, []);
  assert.equal(R.scopeOf(s), "desktop");
  assert.equal(R.scopeOf(session()), "apps", "a session from before scope existed is apps scope");
  assert.equal(R.scopeOf({ scope: "anything else" }), "apps");
  assert.deepEqual(R.SCOPES, ["apps", "desktop"]);
});

test("desktop scope: reportDecision has no allow-list; every other rule still holds", () => {
  const desk = (over = {}) => running({ scope: "desktop", appAllowList: [], ...over });
  const step = (over) => ({ action: "open", target: "Outlook", outcome: "ok", evidenceRef: null, ...over });
  assert.deepEqual(R.reportDecision(desk(), step(), at(1), 0), { row: step(), pause: false, refused: null }, "any app may open");
  assert.deepEqual(R.reportDecision(desk({ appAllowList: ["Notepad"] }), step(), at(1), 0).pause, false, "the apps it expected don't limit it");
  for (const outcome of R.FAIL_CLOSED) {
    const d = R.reportDecision(desk(), step({ outcome }), at(1), 0);
    assert.deepEqual([d.pause, d.refused, d.row.outcome], [true, null, outcome], outcome);
  }
  refused(() => R.reportDecision(desk({ status: "blocked" }), step(), at(1), 0), "paused", 409);
  refused(() => R.reportDecision(desk(), step(), at(30), 0), "session_over", 409);
  refused(() => R.reportDecision(desk(), step(), at(1), R.LIMITS.actionsPerSession), "too_many_steps", 429);
  // Apps scope is unchanged.
  assert.equal(R.reportDecision(running(), step(), at(1), 0).refused, "not_in_scope");
});

test("desktop scope: views, phrases and next steps describe the whole PC and the rails", () => {
  const names = { pc: "Shop-PC", startedBy: "Claude Code", drivenBy: "Shop agent" };
  const desk = (over = {}) => running({ scope: "desktop", appAllowList: ["Notepad"], ...over });
  assert.equal(R.sessionView(desk(), { now: at(1), ...names }).scope, "desktop");
  assert.equal(R.sessionView(running(), { now: at(1), ...names }).scope, "apps");
  const driver = R.nextStep(R.sessionView(desk(), { now: at(1), ...names }), { role: "driver", sameAgent: true });
  assert.match(driver, /You may use the whole PC \(Shop-PC\), only toward the goal/);
  assert.match(driver, /except passwords, administrator \(UAC\) prompts, sign-in prompts and the lock screen/);
  assert.match(driver, /Every step is recorded, and Stop is final\./);
  assert.doesNotMatch(driver, /Work only in/);
  const handOff = R.nextStep(R.sessionView(desk({ executorAgentId: "agent-b" }), { now: at(1), ...names }), { role: "starter", sameAgent: false });
  assert.match(handOff, /Shop agent drives the whole PC \(Shop-PC\), not you\./);
  assert.match(R.nextStep(R.sessionView(running(), { now: at(1), ...names }), { role: "driver", sameAgent: true }), /Work only in QuickBooks on Shop-PC/, "apps scope as before");
  assert.equal(R.actionPhrase({ action: "open", target: "Registry Editor", outcome: "not_in_scope" }, { pc: "Shop-PC", scope: "desktop" }),
    "Tried to open Registry Editor on Shop-PC, and stopped: that's off limits to agents.");
  assert.equal(R.actionPhrase({ action: "blocked", outcome: "not_in_scope" }, { scope: "desktop" }), "Stopped and asked: that's off limits to agents.");
  assert.equal(R.actionPhrase({ action: "open", target: "Outlook", outcome: "not_in_scope" }), "Tried to open Outlook, and stopped: that's outside the apps you approved.");
  assert.equal(R.outcomePhrase("needs_user", "desktop"), "it needs you at the PC");
  assert.equal(R.outcomePhrase("nonsense", "desktop"), "something unexpected came up");
  assert.equal(R.actionView({ at: at(2), action: "open", target: "Paint", outcome: "not_in_scope" }, { scope: "desktop" }).text, "Tried to open Paint, and stopped: that's off limits to agents.");
  assert.equal(R.reachPhrase(desk(), "Shop-PC"), "the whole PC (Shop-PC)");
  assert.equal(R.reachPhrase(running({ appAllowList: ["QuickBooks", "Excel", "Word"] }), "Shop-PC"), "QuickBooks, Excel and Word on Shop-PC");
  assert.equal(R.appList(["A", "B"]), "A and B");
});
