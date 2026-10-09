import { test } from "node:test";
import assert from "node:assert/strict";
import * as S from "./rules.mjs";
import { RemoteRuleError } from "../remote-app/rules.mjs";

const T0 = new Date("2026-10-10T14:00:00.000Z");
const at = (minutes) => new Date(T0.getTime() + minutes * 60_000);
const invite = (over = {}) => ({
  id: "22222222-2222-4222-8222-222222222222", accountId: "acct", agentTokenId: "agent-a", forName: "Mom", task: "Get the printer working again",
  minutes: 30, listTaskId: null, status: "requested", codeHash: null, mintedAt: null, codeExpiresAt: null, redeemedAt: null, sessionId: null, closedAt: null,
  createdAt: T0, ...over,
});
const minted = (over = {}) => invite({ status: "minted", codeHash: "a".repeat(64), mintedAt: T0, codeExpiresAt: at(15), ...over });
const session = (over = {}) => ({
  id: "33333333-3333-4333-8333-333333333333", accountId: "acct", kind: "support", hostDeviceId: "support_" + "A".repeat(22), agentTokenId: "agent-a",
  executorAgentId: null, listTaskId: null, goal: "Get the printer working again", appAllowList: [], minutes: 30, status: "awaiting_consent",
  createdAt: T0, startedAt: null, expiresAt: null, endedAt: null, endReason: null, helperLabel: "Mom", supportKeySha256: "AB".repeat(32),
  removal: null, removalAt: null, ...over,
});
const running = (over = {}) => session({ status: "active", consentVia: "helper", startedAt: at(1), expiresAt: at(31), ...over });
const refused = (fn, code, status) => assert.throws(fn, (e) => e instanceof RemoteRuleError && e.code === code && (status === undefined || e.status === status), code);

test("codes: BCS-XXXX-XXXX from an unambiguous alphabet, normalised from how people type them", () => {
  let i = 0;
  const code = S.newCode((n) => (i++ * 7) % n);
  assert.match(code, S.CODE);
  for (let k = 0; k < 200; k++) assert.match(S.newCode((n) => Math.floor(Math.random() * n)), S.CODE);
  assert.ok(!/[01ILO]/.test(S.CODE_ALPHABET), "no 0/O, 1/I/L");
  assert.equal(S.normalizeCode("bcs-abcd-efgh"), "BCS-ABCD-EFGH");
  assert.equal(S.normalizeCode(" BCS ABCD EFGH "), "BCS-ABCD-EFGH");
  assert.equal(S.normalizeCode("BCSABCDEFGH"), "BCS-ABCD-EFGH");
  assert.equal(S.normalizeCode("abcd-efgh"), "BCS-ABCD-EFGH", "the eight letters alone");
  for (const bad of ["BCS-ABCD-EFG", "BCS-ABCD-EFGH1", "BCX-ABCD-EFGH", "BCS-ABC0-EFGH", "BCS-ABCI-EFGH", "", null, 42, "x".repeat(65)]) {
    assert.equal(S.normalizeCode(bad), null, String(bad));
  }
});

test("a request: who it's for, the exact task, 1 to 45 minutes; no codes, secrets, links or phone numbers in what the helped person reads", () => {
  assert.deepEqual(S.parseInvite({ for: " Mom ", task: "Get the\nprinter working again", minutes: 30 }),
    { forName: "Mom", task: "Get the printer working again", minutes: 30, taskId: undefined });
  assert.equal(S.parseInvite({ for: "Mom", task: "t", minutes: "45" }).minutes, 45);
  for (const minutes of [0, 46, 60, 1.5, "lots", null, undefined]) refused(() => S.parseMinutes(minutes), "invalid_minutes", 400);
  refused(() => S.parseInvite({ for: "Mom", minutes: 5 }), "invalid_task", 400);
  refused(() => S.parseInvite({ task: "t", minutes: 5 }), "invalid_for", 400);
  refused(() => S.parseInvite({ for: "Mom", task: "x".repeat(301), minutes: 5 }), "invalid_task", 400);
  refused(() => S.parseInvite({ for: "M".repeat(61), task: "t", minutes: 5 }), "invalid_for", 400);
  refused(() => S.parseInvite({ for: "Mom", task: "Use code BCS-ABCD-EFGH", minutes: 5 }), "secret_like", 422);
  refused(() => S.parseInvite({ for: "Mom", task: "key " + ["sk", "live", "abcdefghijklmnopqrstuvwx"].join("_"), minutes: 5 }), "secret_like", 422);
  for (const task of ["Call 1-800-555-0199 about your PC", "Go to https://example.com/fix", "Visit www.example.com", "Email help@example.com", "Ring +44 20 7946 0958"]) {
    refused(() => S.parseInvite({ for: "Mom", task, minutes: 5 }), "no_contact_details", 422);
  }
  assert.equal(S.parseInvite({ for: "Mom", task: "Point the printer at 192.168.1.20 again", minutes: 5 }).task, "Point the printer at 192.168.1.20 again", "an IP address is not a phone number");
  assert.equal(S.parseInvite({ for: "Dad‮", task: "Fix​ the scanner", minutes: 5 }).task, "Fix the scanner", "invisible characters never reach the consent screen");
});

test("the issuer as the broker asserts it: account name and handle, cleaned; never per-invite text", () => {
  assert.deepEqual(S.issuerIdentity({ handle: "skylar@bc", displayName: "Skylar" }), { name: "Skylar", handle: "skylar@bc" });
  assert.deepEqual(S.issuerIdentity({ handle: "skylar@bc", displayName: "  " }), { name: "skylar@bc", handle: "skylar@bc" });
  assert.equal(S.issuerIdentity({ handle: "h@bc", displayName: "Sky‮lar​" }).name, "Skylar");
  assert.equal([...S.issuerIdentity({ handle: "h@bc", displayName: "x".repeat(80) }).name].length, 60);
  assert.equal(S.issuerLine({ name: "Skylar", handle: "skylar@bc" }), "Skylar (skylar@bc)");
  assert.equal(S.issuerLine({ name: "skylar@bc", handle: "skylar@bc" }), "skylar@bc");
});

test("time: a request lapses after 60 minutes, a minted code expires after 15", () => {
  assert.equal(S.settleInvite(invite(), at(59)), null);
  assert.deepEqual(S.settleInvite(invite(), at(60)), { status: "lapsed", closedAt: at(60) });
  assert.equal(S.settleInvite(minted(), at(14.9)), null);
  assert.deepEqual(S.settleInvite(minted(), at(15)), { status: "expired", closedAt: at(15) });
  assert.equal(S.settleInvite(minted({ status: "redeemed" }), at(500)), null, "a used code doesn't expire: its session has its own clock");
  assert.equal(S.redeemable(minted(), at(14)), true);
  assert.equal(S.redeemable(minted(), at(15)), false);
  assert.equal(S.redeemable(invite(), T0), false);
  assert.deepEqual(S.mintPatch(T0, "h"), { status: "minted", codeHash: "h", mintedAt: T0, codeExpiresAt: at(15) });
  assert.equal(S.credentialExpiry(T0, 30).getTime(), at(10 + 30 + 60).getTime(), "Allow window + the session + the receipt grace, never renewed");
});

test("approving, denying and cancelling", () => {
  assert.doesNotThrow(() => S.decideCheck(invite(), at(10)));
  refused(() => S.decideCheck(invite(), at(61)), "request_expired", 410);
  refused(() => S.decideCheck(minted(), at(1)), "already_decided", 409);
  refused(() => S.decideCheck(invite({ status: "denied" }), at(1)), "already_decided", 409);
  assert.doesNotThrow(() => S.voidCheck(minted(), at(1)));
  refused(() => S.voidCheck(minted(), at(16)), "not_voidable", 409);
  refused(() => S.voidCheck(invite(), at(1)), "not_voidable", 409);
  assert.doesNotThrow(() => S.outstandingCheck(2));
  refused(() => S.outstandingCheck(3), "too_many_outstanding", 409);
  assert.doesNotThrow(() => S.mintsCheck(4));
  refused(() => S.mintsCheck(5), "daily_limit", 429);
});

test("redemption creates a session pinned to the key, waiting for Allow, with no app list and no executor", () => {
  const s = S.newSupportSession({ invite: minted({ listTaskId: "task-1" }), relayHostId: "support_" + "B".repeat(22), keySha256: "CD".repeat(32), keySpki: "spki", credentialHash: "c".repeat(64), now: at(2) });
  assert.deepEqual(
    { kind: s.kind, status: s.status, goal: s.goal, apps: s.appAllowList, executor: s.executorAgentId, minutes: s.minutes, helper: s.helperLabel, task: s.listTaskId, created: s.createdAt },
    { kind: "support", status: "awaiting_consent", goal: "Get the printer working again", apps: [], executor: null, minutes: 30, helper: "Mom", task: "task-1", created: at(2) });
  assert.match(s.hostDeviceId, S.RELAY_HOST);
  assert.equal(s.supportCredentialExpiresAt.getTime(), S.credentialExpiry(at(2), 30).getTime());
});

test("Allow: only within 10 minutes of redemption, once; it starts the 45-minute-at-most clock", () => {
  assert.equal(S.allowCheck(session(), at(9)), "allow");
  assert.equal(S.allowCheck(running(), at(2)), "already");
  refused(() => S.allowCheck(session(), at(10)), "too_late", 410);
  refused(() => S.allowCheck(running({ status: "ended", endReason: "host_stop", endedAt: at(3) }), at(4)), "session_over", 409);
  refused(() => S.allowCheck(session({ status: "denied" }), at(1)), "session_over", 409);
  assert.deepEqual(S.allowPatch(session({ minutes: 45 }), at(3)), { status: "active", consentVia: "helper", startedAt: at(3), expiresAt: at(48) });
});

test("stop: from either side, the agent, or a report; final; before Allow the helped side's Stop is a no", () => {
  assert.deepEqual(S.stopPatch(session(), "helped", at(1)), { status: "denied", consentVia: "helper", endedAt: at(1) });
  assert.deepEqual(S.stopPatch(running(), "helped", at(5)), { status: "ended", endReason: "host_stop", endedAt: at(5) });
  assert.deepEqual(S.stopPatch(running(), "issuer", at(5)), { status: "ended", endReason: "user_stop", endedAt: at(5) });
  assert.deepEqual(S.stopPatch(session(), "issuer", at(1)), { status: "ended", endReason: "user_stop", endedAt: at(1) });
  assert.deepEqual(S.stopPatch(running(), "report", at(5)), { status: "ended", endReason: "reported", endedAt: at(5) });
  assert.deepEqual(S.stopPatch(session(), "report", at(1)), { status: "ended", endReason: "reported", endedAt: at(1) });
  assert.deepEqual(S.stopPatch(running(), "agent", at(5), { finished: true }), { status: "ended", endReason: "done", endedAt: at(5) });
  assert.deepEqual(S.stopPatch(session(), "agent", at(1), { finished: true }), { status: "ended", endReason: "agent_stop", endedAt: at(1) }, "never 'done' before it ran");
  assert.equal(S.stopPatch(running({ status: "ended", endReason: "done" }), "issuer", at(9)), null, "already over: a no-op");
  assert.equal(S.stopPatch(running(), "issuer", at(31)), null, "the cap ran out first");
});

test("steps are view-first: every control action reported as done says the helped person confirmed it; nothing carries content", () => {
  assert.deepEqual(S.parseStep({ action: "observe", outcome: "ok" }), { action: "observe", target: null, outcome: "ok" });
  assert.deepEqual(S.parseStep({ action: "invoke", target: "Print test page", outcome: "ok", confirmed: true }), { action: "invoke", target: "Print test page", outcome: "ok" });
  assert.deepEqual(S.parseStep({ action: "invoke", target: "Delete", outcome: "declined", confirmed: false }), { action: "invoke", target: "Delete", outcome: "declined" });
  for (const action of S.CONTROL_ACTIONS) {
    const target = action === "key" ? "Enter" : action === "scroll" ? undefined : "Thing";
    refused(() => S.parseStep({ action, target, outcome: "ok" }), "confirm_required", 400);
    refused(() => S.parseStep({ action, target, outcome: "ok", confirmed: false }), "confirm_required", 400);
  }
  refused(() => S.parseStep({ action: "set_value", target: "Name", outcome: "ok", confirmed: true, value: "secret" }), "unknown_field", 400);
  refused(() => S.parseStep({ action: "screenshot", outcome: "ok" }), "invalid_action", 400);
  refused(() => S.parseStep({ action: "invoke", outcome: "ok", confirmed: true }), "target_required", 400);
  refused(() => S.parseStep({ action: "key", target: "VK_LWIN", outcome: "ok", confirmed: true }), "invalid_target", 400);
  refused(() => S.parseStep({ action: "blocked", outcome: "declined" }), "invalid_outcome", 400);
  refused(() => S.parseStep({ action: "invoke", target: "x", outcome: "maybe" }), "invalid_outcome", 400);
  refused(() => S.parseStep({ action: "invoke", target: "x", outcome: "ok", confirmed: "yes" }), "invalid_confirmed", 400);
  assert.equal([...S.parseStep({ action: "invoke", target: "y".repeat(300), outcome: "ok", confirmed: true }).target].length, 120);
  assert.doesNotThrow(() => S.stepCheck(running(), at(2), 0));
  refused(() => S.stepCheck(session(), at(2), 0), "not_allowed_yet", 409);
  refused(() => S.stepCheck(running(), at(31), 0), "session_over", 409);
  refused(() => S.stepCheck(running(), at(2), S.LIMITS.stepsPerSession), "too_many_steps", 429);
});

test("fixed phrases, for the issuer and for the helped person", () => {
  const row = (action, target, outcome) => ({ action, target, outcome });
  assert.equal(S.stepPhrase(row("invoke", "Print test page", "ok"), "issuer"), "Clicked 'Print test page' (they allowed it).");
  assert.equal(S.stepPhrase(row("invoke", "Print test page", "ok"), "helped"), "Clicked 'Print test page' (you allowed it).");
  assert.equal(S.stepPhrase(row("invoke", "Delete printer", "declined"), "helped"), "Asked to click 'Delete printer', and you said no.");
  assert.equal(S.stepPhrase(row("observe", null, "ok"), "helped"), "Looked at the screen.");
  assert.equal(S.stepPhrase(row("open", "Printers & scanners", "ok"), "issuer"), "Opened Printers & scanners (they allowed it).");
  assert.equal(S.stepPhrase(row("set_value", "Password", "credential_field"), "issuer"), "Tried to fill in 'Password', and stopped: that's a password field, and the helper never types passwords.");
  assert.equal(S.stepPhrase(row("blocked", null, "needs_user"), "helped"), "Stopped and asked: it needed the person at the computer (for example a Windows permission prompt).");
});

test("the transcript is metadata only, and says honestly whether the helper removed itself", () => {
  const steps = [{ action: "open", target: "Printers & scanners", outcome: "ok" }, { action: "invoke", target: "Remove device", outcome: "declined" }];
  const ended = running({ status: "ended", endReason: "done", endedAt: at(20) });
  const issuerView = S.transcript(ended, steps, { audience: "issuer", issuer: "Skylar (skylar@bc)", helped: "Mom", now: at(21) });
  assert.deepEqual(issuerView.lines, [
    "Support for Mom, through Back Channel.",
    "Task: Get the printer working again.",
    "Connected on 2026-10-10, 14:01 to 14:20 UTC (19 minutes).",
    "Opened Printers & scanners (they allowed it).",
    "Asked to click 'Remove device', and they said no.",
    "Finished.",
    "Couldn't confirm the helper removed itself.",
  ]);
  assert.equal(issuerView.text, issuerView.lines.join("\n"));
  const helped = S.transcript({ ...ended, removal: "removed", removalAt: at(21) }, steps, { audience: "helped", issuer: "Skylar (skylar@bc)", helped: "Mom", now: at(22) });
  assert.equal(helped.lines[0], "Help from Skylar (skylar@bc), through Back Channel.");
  assert.ok(!helped.text.includes("Mom"), "the helped person never sees what the agent called them");
  assert.equal(helped.lines.at(-1), "The helper removed itself.");
  const live = S.transcript(running(), [], { audience: "issuer", issuer: "x", helped: "Mom", now: at(5) });
  assert.deepEqual(live.lines.slice(2), ["Connected since 14:01 UTC on 2026-10-10.", "No actions were recorded."], "no ending and no removal line while it runs");
  const never = S.transcript(session({ status: "denied", endedAt: at(1) }), [], { audience: "helped", issuer: "x", helped: "Mom", now: at(2) });
  assert.deepEqual(never.lines.slice(2), ["You didn't allow it, so nothing happened.", "Couldn't confirm the helper removed itself. If you still have the file you downloaded, you can delete it."]);
  assert.equal(S.removalText({ ...ended, removal: "in_memory" }, "issuer"), "The helper ran in memory only, so there was nothing to remove.");
  assert.equal(S.removalText({ ...ended, removal: "unconfirmed" }, "issuer"), "The helper couldn't confirm it removed itself.");
  const capped = S.transcript(running({ status: "active" }), [], { audience: "issuer", issuer: "x", helped: "Mom", now: at(40) });
  assert.ok(capped.lines.includes("The 30-minute limit ran out, so it ended."), "time is applied even before it is written");
});

test("the removal receipt: one per session; the same one again is a no-op", () => {
  assert.equal(S.receiptCheck(running(), "removed"), "record");
  assert.equal(S.receiptCheck(running({ removal: "removed" }), "removed"), "already");
  refused(() => S.receiptCheck(running({ removal: "removed" }), "in_memory"), "receipt_recorded", 409);
  refused(() => S.receiptCheck(running(), "deleted"), "invalid_removal", 400);
});

test("the helper's relay lease: only once allowed, running and in time, for that relay identity and account", () => {
  const b = { accountId: "acct", relayHostId: "support_" + "A".repeat(22) };
  assert.equal(S.admitsSupportLease(running(), b, at(2)), true);
  assert.equal(S.admitsSupportLease(session(), b, at(2)), false, "not before Allow");
  assert.equal(S.admitsSupportLease(running(), b, at(31)), false, "not after the cap");
  assert.equal(S.admitsSupportLease(running({ status: "ended", endReason: "host_stop" }), b, at(2)), false);
  assert.equal(S.admitsSupportLease(running({ kind: "agent" }), b, at(2)), false, "an agent session is never a support lease");
  assert.equal(S.admitsSupportLease(running(), { ...b, accountId: "other" }, at(2)), false);
  assert.equal(S.admitsSupportLease(running(), { ...b, relayHostId: "support_" + "Z".repeat(22) }, at(2)), false);
  assert.equal(S.admitsSupportLease(running({ hostDeviceId: "pcShop000000000000000A" }), { ...b, relayHostId: "pcShop000000000000000A" }, at(2)), false, "never a device id");
});

test("views: an agent never sees a code; the helped person never sees who it's 'for' or the agent", () => {
  const v = S.inviteView(minted({ codeHash: "f".repeat(64) }), { now: at(1), requestedBy: "Claude Code" });
  assert.equal(v.status, "minted"); assert.equal(v.codeExpiresAt, at(15).toISOString());
  assert.ok(!JSON.stringify(v).includes("f".repeat(64)), "not even the hash");
  assert.match(S.nextStep(v), /you never see it/);
  const requested = S.inviteView(invite(), { now: at(1), requestedBy: "Claude Code" });
  assert.equal(requested.approvalExpiresAt, at(60).toISOString());
  assert.match(S.nextStep(requested), /approvalUrl/); assert.match(S.nextStep(requested), /don't open it yourself/);
  const withSession = S.inviteView(minted({ status: "redeemed", redeemedAt: at(2) }), { now: at(3), requestedBy: "Claude Code", session: session({ createdAt: at(2) }) });
  assert.equal(withSession.session.status, "awaiting_consent"); assert.equal(withSession.session.allowBy, at(12).toISOString());
  assert.match(S.nextStep(withSession), /press Allow/);
  const h = S.helpedView(running(), { now: at(5), issuer: { name: "Skylar", handle: "skylar@bc" } });
  assert.deepEqual(Object.keys(h).sort(), ["allowBy", "endReason", "endedAt", "expiresAt", "id", "issuer", "minutes", "peer", "removal", "startedAt", "status", "statusText", "task"]);
  assert.ok(!JSON.stringify(h).includes("Mom") && !JSON.stringify(h).includes("agent-a"));
});

test("peer: the helper learns the issuer connector's pinned key from the broker, never on first use; null until a device is pinned", () => {
  const issuer = { name: "Skylar", handle: "skylar@bc" };
  assert.equal(S.helpedView(running(), { now: at(5), issuer }).peer, null);
  const pinned = running({ supportClientDeviceId: "dev".padEnd(22, "x"), supportClientKeySha256: "EF".repeat(32) });
  assert.deepEqual(S.helpedView(pinned, { now: at(5), issuer }).peer, { connectorSpkiSha256: "EF".repeat(32) });
  assert.ok(!JSON.stringify(S.helpedView(pinned, { now: at(5), issuer })).includes("dev".padEnd(22, "x")), "the device id never reaches the helper");
});

test("the executor secret: born with the session (hash only), shown to the agent that asked in its view only when handed out", () => {
  const s = S.newSupportSession({ invite: minted(), relayHostId: "support_" + "B".repeat(22), keySha256: "CD".repeat(32), keySpki: "spki", credentialHash: "c".repeat(64),
    executorSecretHash: "e".repeat(64), now: at(2) });
  assert.equal(s.executorSecretHash, "e".repeat(64));
  assert.ok(!("executorSecretIssuedAt" in s) || s.executorSecretIssuedAt == null, "born, never handed out yet");
  const live = running({ executorSecretHash: "e".repeat(64) });
  const redeemed = minted({ status: "redeemed", redeemedAt: at(1), sessionId: live.id });
  const plain = S.inviteView(redeemed, { now: at(5), requestedBy: "Claude Code", session: live });
  assert.ok(!("executorSecret" in plain.session), "not in an ordinary view");
  assert.ok(!JSON.stringify(plain).includes("e".repeat(64)), "and never the hash");
  assert.doesNotMatch(S.nextStep(plain), /shown this once/);
  assert.match(S.nextStep(plain), new RegExp(`POST /api/support/invites/${plain.id}/executor-secret`), "how to recover a lost one");
  const value = "abx_" + "Q".repeat(43);
  const handed = S.inviteView(redeemed, { now: at(5), requestedBy: "Claude Code", session: live, executorSecret: value });
  assert.equal(handed.session.executorSecret, value);
  assert.match(S.nextStep(handed), /shown this once/); assert.match(S.nextStep(handed), /profile "remote-support"/);
  assert.match(S.nextStep(handed), new RegExp(`remoteAppSessionId "${live.id}"`));
});
