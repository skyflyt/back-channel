import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import * as RD from "./readiness.mjs";
import { RemoteRuleError } from "./rules.mjs";

const ME = "a0000000-0000-4000-8000-000000000001";
const PEER = "a0000000-0000-4000-8000-000000000002";
const T0 = new Date("2026-10-10T12:00:00.000Z");
const minutes = (m) => new Date(T0.getTime() + m * 60_000);
const report = (over = {}) => ({
  v: 1, agentId: ME, name: "Shop agent", enrolled: true, fingerprint: "AB12-CD34-EF56-7890", workerVersion: "0.1.0",
  appbridge: { pipe: "listening", hostName: "Shop-PC", reason: null, version: "1.1.33.0" },
  runtime: { adapter: "claude", path: null, installed: true, signedIn: true },
  profiles: { remoteApp: { present: true, senders: [{ agentId: PEER, name: null, pinned: true }] } },
  checkedAt: T0.toISOString(),
  ...over,
});
const refused = (fn, code) => assert.throws(fn, (e) => e instanceof RemoteRuleError && e.status === 400 && e.code === code, code);
const parse = (body) => RD.parseReadiness(body, { agentId: ME });

test("fingerprint: uppercase SHA-256 of signingKey + newline + encryptionKey, first 16 hex in groups of 4", () => {
  // Stand-ins for the two public keys: the formula hashes the strings exactly as stored.
  const sk = "signing-public-key\n", ek = "encryption-public-key\n";
  const hex = createHash("sha256").update(`${sk}\n${ek}`).digest("hex").toUpperCase();
  assert.equal(RD.fingerprint(sk, ek), `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`);
  assert.match(RD.fingerprint(sk, ek), RD.FINGERPRINT);
  assert.equal(RD.fingerprint(null, ek), null);
  assert.equal(RD.fingerprint(sk, ""), null);
});

test("report: the contract's shape is accepted and the local-only text is dropped", () => {
  const stored = parse(report({ appbridge: { pipe: "absent", hostName: "  Shop-PC ", reason: "Allow agent control is off on this PC" },
    runtime: { adapter: "claude", path: "C:\\Users\\someone\\.local\\bin\\claude.exe", installed: true, signedIn: null },
    profiles: { remoteApp: { present: true, senders: [{ agentId: PEER.toUpperCase(), name: "Laptop Claude", pinned: true }] } } }));
  assert.deepEqual(stored, report({ appbridge: { pipe: "absent", hostName: "Shop-PC", reason: null },
    runtime: { adapter: "claude", path: null, installed: true, signedIn: null },
    profiles: { remoteApp: { present: true, senders: [{ agentId: PEER, name: null, pinned: true }] } } }));
  assert.deepEqual(parse(report({ agentId: null, enrolled: false, fingerprint: null })).agentId, null, "a worker not enrolled for Dispatch");
});

test("report: strict, every field and no other, values bounded", () => {
  refused(() => parse(report({ extra: 1 })), "unknown_field");
  refused(() => parse({ ...report(), appbridge: { pipe: "listening", hostName: null, reason: null, version: "1.1.33.0", build: "x" } }), "unknown_field");
  // appbridge.version is the one optional field: AppBridge's four-part version, or null; a worker from before it leaves it out.
  for (const version of ["1.1.32", "1.1.33.0.1", "v1.1.33.0", "1.1.33.0; rm -rf", "1.1.33.x", "", 1133, true, {}]) {
    refused(() => parse(report({ appbridge: { pipe: "listening", hostName: null, reason: null, version } })), "invalid_readiness");
  }
  refused(() => parse(report({ appbridge: { pipe: "listening", hostName: null, reason: null, version: "1".repeat(38) + ".1.1.1" } })), "invalid_readiness");
  assert.equal(parse(report({ appbridge: { pipe: "listening", hostName: null, reason: null, version: "1.2.0.4" } })).appbridge.version, "1.2.0.4");
  assert.equal(parse(report({ appbridge: { pipe: "listening", hostName: null, reason: null, version: null } })).appbridge.version, null);
  assert.ok(!("version" in parse(report({ appbridge: { pipe: "listening", hostName: null, reason: null } })).appbridge), "an older worker's report stays without one");
  refused(() => parse({ ...report(), runtime: { adapter: "claude", path: null, installed: true, signedIn: true, email: "x" } }), "unknown_field");
  refused(() => parse({ ...report(), profiles: { remoteApp: { present: true, senders: [] }, lists: {} } }), "unknown_field");
  refused(() => parse({ ...report(), profiles: { remoteApp: { present: true, senders: [{ agentId: PEER, name: null, pinned: true, key: "x" }] } } }), "unknown_field");
  const { checkedAt, ...noDate } = report();
  refused(() => parse(noDate), "invalid_readiness");
  for (const bad of [null, [], "x", 1]) refused(() => parse(bad), "invalid_readiness");
  refused(() => parse(report({ v: 2 })), "unsupported_version");
  refused(() => parse(report({ agentId: PEER })), "agent_mismatch");
  refused(() => parse(report({ agentId: null })), "invalid_readiness");
  for (const name of ["", " ", "x".repeat(81), "Shop\u0007PC", "Shop\u202ePC", 42, null]) refused(() => parse(report({ name })), "invalid_readiness");
  assert.equal(parse(report({ name: "x".repeat(80) })).name.length, 80);
  for (const hostName of ["h".repeat(81), "a\nb", "\u200bx", 7]) refused(() => parse(report({ appbridge: { pipe: "listening", hostName, reason: null } })), "invalid_readiness");
  refused(() => parse(report({ appbridge: { pipe: "open", hostName: null, reason: null } })), "invalid_readiness");
  refused(() => parse(report({ appbridge: { pipe: "listening", hostName: null, reason: "r".repeat(1025) } })), "invalid_readiness");
  for (const fingerprint of ["ab12-cd34-ef56-7890", "AB12CD34EF567890", "AB12-CD34-EF56", 1]) refused(() => parse(report({ fingerprint })), "invalid_fingerprint");
  refused(() => parse(report({ workerVersion: "0.1.0; rm -rf" })), "invalid_readiness");
  refused(() => parse(report({ runtime: { adapter: "codex", path: null, installed: true, signedIn: true } })), "invalid_readiness");
  refused(() => parse(report({ runtime: { adapter: "claude", path: null, installed: "yes", signedIn: true } })), "invalid_readiness");
  refused(() => parse(report({ runtime: { adapter: "claude", path: null, installed: true, signedIn: "yes" } })), "invalid_readiness");
  const many = Array.from({ length: RD.MAX_SENDERS + 1 }, () => ({ agentId: randomUUID(), name: null, pinned: true }));
  refused(() => parse(report({ profiles: { remoteApp: { present: true, senders: many } } })), "invalid_readiness");
  refused(() => parse(report({ profiles: { remoteApp: { present: true, senders: [{ agentId: PEER, name: null, pinned: true }, { agentId: PEER, name: null, pinned: false }] } } })), "invalid_readiness");
  refused(() => parse(report({ profiles: { remoteApp: { present: true, senders: [{ agentId: "not-an-id", name: null, pinned: true }] } } })), "invalid_readiness");
  for (const checkedAt of ["yesterday", "", 1, "2026-10-10T12:00:00.000Z".padEnd(41, "Z")]) refused(() => parse(report({ checkedAt })), "invalid_readiness");
  assert.equal(RD.storedReadiness({ junk: true }, ME), null, "a stored row that no longer fits is ignored, never trusted");
  assert.equal(RD.storedReadiness(null, ME), null);
});

test("matching a report to a registered PC: by name, ignoring case; ambiguous or unknown is no match", () => {
  const pcs = [{ hostDeviceId: "pc1", name: "Shop-PC" }, { hostDeviceId: "pc2", name: "Office PC" }, { hostDeviceId: "pc3", name: "Twin" }, { hostDeviceId: "pc4", name: "twin" }];
  assert.equal(RD.matchPc(" shop-pc ", pcs)?.hostDeviceId, "pc1");
  assert.equal(RD.matchPc("OFFICE PC", pcs)?.hostDeviceId, "pc2");
  assert.equal(RD.matchPc("Twin", pcs), null, "two PCs with that name");
  assert.equal(RD.matchPc("Garage", pcs), null);
  assert.equal(RD.matchPc(null, pcs), null);
  assert.equal(RD.matchPc("", pcs), null);
});

test("matchPc: a computer name the person confirmed for a PC wins over the PC names; two confirmations is no match", () => {
  // Registered as "Desktop"; its workers report the Windows computer name.
  const pcs = [{ hostDeviceId: "pc1", name: "Desktop", agentHostName: "JRR-IT-MZ013M7D" }, { hostDeviceId: "pc2", name: "Office PC", agentHostName: null },
    { hostDeviceId: "pc3", name: "jrr-it-hhcvvg1n" }];
  assert.equal(RD.matchPc(" jrr-it-mz013m7d ", pcs)?.hostDeviceId, "pc1", "by the confirmed computer name, ignoring case and space");
  assert.equal(RD.matchPc("Desktop", pcs)?.hostDeviceId, "pc1", "its own name still matches");
  assert.equal(RD.matchPc("JRR-IT-HHCVVG1N", pcs)?.hostDeviceId, "pc3", "a PC named after its computer, unchanged");
  assert.equal(RD.matchPc("JRR-IT-OTHER", pcs), null);
  // A confirmed computer name beats another PC that happens to be named that.
  const named = [...pcs, { hostDeviceId: "pc4", name: "JRR-IT-MZ013M7D" }];
  assert.equal(RD.matchPc("JRR-IT-MZ013M7D", named)?.hostDeviceId, "pc1");
  // The same computer name confirmed for two PCs: no proof either way.
  const twice = [...pcs, { hostDeviceId: "pc5", name: "Spare", agentHostName: "jrr-it-mz013m7d" }];
  assert.equal(RD.matchPc("JRR-IT-MZ013M7D", twice), null);
  assert.equal(RD.matchedBy("jrr-it-mz013m7d", pcs[0]), "confirmed");
  assert.equal(RD.matchedBy("Desktop", pcs[0]), "name");
  assert.equal(RD.matchedBy("Desktop", null), null);
});

test("parseAgentHostName: a reported computer name (trimmed, printable, 1 to 80 characters) or null", () => {
  assert.equal(RD.parseAgentHostName("  JRR-IT-MZ013M7D "), "JRR-IT-MZ013M7D");
  assert.equal(RD.parseAgentHostName(null), null);
  for (const bad of ["", "   ", "x".repeat(81), "Desk\u0000top", "Desk‮top", 42, undefined, {}]) refused(() => RD.parseAgentHostName(bad), "invalid_request");
});

const states = (c) => Object.fromEntries(c.steps.map((s) => [s.key, s.state]));
const howTo = (c, key) => c.steps.find((s) => s.key === key).howTo;
const pc = { hostDeviceId: "pc1", name: "Shop-PC" };

test("checklist: a fresh, complete report is ready; each step says what's missing and how, on that PC", () => {
  const ok = RD.checklist({ report: parse(report()), readinessAt: minutes(-4), now: T0, pc });
  assert.deepEqual([ok.reporting, ok.ready, ok.missing], [true, true, []]);
  assert.deepEqual(ok.steps.map((s) => [s.step, s.key]), [[1, "appbridge"], [2, "registered"], [3, "agent_control"], [4, "worker"], [5, "senders"], [6, "claude"]]);
  assert.ok(ok.steps.every((s) => s.state === "done" && s.howTo === null && s.title));

  const signedOut = RD.checklist({ report: parse(report({ runtime: { adapter: "claude", path: null, installed: true, signedIn: false } })), readinessAt: T0, now: T0, pc });
  assert.deepEqual([signedOut.ready, signedOut.missing], [false, ["claude"]]);
  assert.equal(howTo(signedOut, "claude"), "On that PC, open AppBridge → Agents → Sign in to Claude.");
  const noClaude = RD.checklist({ report: parse(report({ runtime: { adapter: "claude", path: null, installed: false, signedIn: null } })), readinessAt: T0, now: T0, pc });
  assert.equal(states(noClaude).claude, "needed");
  assert.match(howTo(noClaude, "claude"), /isn't installed/);
  assert.equal(states(RD.checklist({ report: parse(report({ runtime: { adapter: "claude", path: null, installed: true, signedIn: null } })), readinessAt: T0, now: T0, pc })).claude, "unknown");

  const off = RD.checklist({ report: parse(report({ appbridge: { pipe: "absent", hostName: null, reason: null } })), readinessAt: T0, now: T0, pc });
  assert.deepEqual([states(off).appbridge, states(off).agent_control], ["unknown", "needed"]);
  assert.match(howTo(off, "agent_control"), /turn on Allow agent control/);
  const refusedPipe = RD.checklist({ report: parse(report({ appbridge: { pipe: "refused", hostName: null, reason: null, version: "1.1.33.0" } })), readinessAt: T0, now: T0, pc });
  assert.deepEqual([states(refusedPipe).appbridge, states(refusedPipe).agent_control], ["done", "needed"]);
  assert.equal(states(RD.checklist({ report: parse(report({ appbridge: { pipe: "error", hostName: null, reason: null } })), readinessAt: T0, now: T0, pc })).agent_control, "unknown");

  const noSenders = RD.checklist({ report: parse(report({ profiles: { remoteApp: { present: true, senders: [{ agentId: PEER, name: null, pinned: false }] } } })), readinessAt: T0, now: T0, pc });
  assert.deepEqual(noSenders.missing, ["senders"]);
  assert.match(howTo(noSenders, "senders"), /Choose agents…, and check each fingerprint/);
  assert.deepEqual(RD.checklist({ report: parse(report({ profiles: { remoteApp: { present: false, senders: [] } } })), readinessAt: T0, now: T0, pc }).missing, ["senders"]);

  const unpaired = RD.checklist({ report: parse(report({ agentId: null, enrolled: false, fingerprint: null })), readinessAt: T0, now: T0, pc });
  assert.equal(states(unpaired).worker, "needed");
  assert.match(howTo(unpaired, "worker"), /isn't paired for Dispatch/);

  const unmatched = RD.checklist({ report: parse(report()), readinessAt: T0, now: T0, pc: null });
  assert.deepEqual(unmatched.missing, ["registered"]);
  assert.equal(states(unmatched).registered, "unknown", "a name that matches no PC is not proof it isn't registered");
  assert.match(howTo(unmatched, "registered"), /reports as "Shop-PC"/);
});

test("step 1 is AppBridge 1.1.33 or newer, told by the version the worker's hello learned", () => {
  const step1 = (appbridge) => {
    const c = RD.checklist({ report: parse(report({ appbridge: { hostName: "Shop-PC", reason: null, ...appbridge } })), readinessAt: T0, now: T0, pc });
    return [states(c).appbridge, howTo(c, "appbridge")];
  };
  assert.equal(RD.STEPS[0].title, "AppBridge 1.1.33 or newer");
  assert.deepEqual(step1({ pipe: "listening", version: "1.1.33.0" }), ["done", null]);
  assert.deepEqual(step1({ pipe: "listening", version: "1.2.0.0" })[0], "done");
  assert.deepEqual(step1({ pipe: "refused", version: "2.0.0.0" })[0], "done", "agent control off still said its version");
  const old = step1({ pipe: "listening", version: "1.1.32.9" });
  assert.equal(old[0], "needed");
  assert.match(old[1], /It has AppBridge 1\.1\.32\.9; agents need 1\.1\.33 or newer to use the whole PC\. On that PC, open AppBridge → Updates → Install update\./);
  const silent = step1({ pipe: "listening", version: null });
  assert.equal(silent[0], "needed", "an AppBridge that answers without a version is older than 1.1.33");
  assert.match(silent[1], /older than 1\.1\.33/);
  const olderWorker = step1({ pipe: "listening" });
  assert.equal(olderWorker[0], "unknown", "a worker from before version reporting can't tell");
  assert.match(olderWorker[1], /doesn't report AppBridge's version yet/);
  assert.equal(step1({ pipe: "refused", version: null })[0], "unknown");
  assert.equal(step1({ pipe: "absent", version: null })[0], "unknown");
  assert.match(step1({ pipe: "error", version: null })[1], /isn't answering/);
});

test("the AppBridge version compares as four numbers; a PC speaks desktop scope only from its newest report", () => {
  for (const v of ["1.1.33.0", "1.1.33.1", "1.1.34.0", "1.2.0.0", "2.0.0.0", "1.1.100.0"]) assert.equal(RD.appBridgeAtLeast(v), true, v);
  for (const v of ["1.1.32.99", "1.0.99.99", "0.9.0.0", "1.1.3.30", null, undefined, "", "1.1.33", "1.1.33.0 ", 1133]) assert.equal(RD.appBridgeAtLeast(v), false, String(v));
  const at = (version) => parse(report({ appbridge: { pipe: "listening", hostName: "Shop-PC", reason: null, ...(version === undefined ? {} : { version }) } }));
  assert.equal(RD.speaksDesktop([at("1.1.33.0")]), true);
  assert.equal(RD.speaksDesktop([null, at("1.1.33.0")]), true, "a stored report that no longer parses is skipped");
  assert.equal(RD.speaksDesktop([at("1.1.32.0"), at("1.1.33.0")]), false, "the newest report decides: a PC that went back to an older AppBridge");
  assert.equal(RD.speaksDesktop([at(null)]), false);
  assert.equal(RD.speaksDesktop([at(undefined)]), false, "an older worker: no");
  assert.equal(RD.speaksDesktop([]), false, "no report at all: no");
});

test("checklist: a report older than 30 minutes is 'not reporting': the worker isn't running, and nothing else is claimed", () => {
  const edge = RD.checklist({ report: parse(report()), readinessAt: minutes(-30), now: T0, pc });
  assert.equal(edge.reporting, true, "30 minutes is still reporting");
  const stale = RD.checklist({ report: parse(report()), readinessAt: minutes(-31), now: T0, pc });
  assert.deepEqual([stale.reporting, stale.ready], [false, false]);
  assert.deepEqual(states(stale), { appbridge: "unknown", registered: "done", agent_control: "unknown", worker: "needed", senders: "unknown", claude: "unknown" });
  assert.match(howTo(stale, "worker"), /^Not reporting: the worker isn't running on that PC\./);
  assert.equal(howTo(stale, "claude"), "Unknown while the worker isn't reporting.");
  const never = RD.checklist({ report: null, readinessAt: null, now: T0, pc: null });
  assert.deepEqual([never.reporting, states(never).worker, states(never).registered], [false, "needed", "unknown"]);
  assert.match(howTo(never, "worker"), /never reported.*Set up worker/);
});

test("a registered PC with no worker reporting from it: registered, the worker needed, the rest unknown", () => {
  const p = RD.pcWithoutAgent();
  assert.equal(p.note, "No agent set up on this PC yet.");
  assert.deepEqual([p.ready, p.missing], [false, ["appbridge", "agent_control", "worker", "senders", "claude"]]);
  assert.match(p.steps.find((s) => s.key === "worker").howTo, /Agents → Set up worker/);
  assert.equal(RD.HOW_TO.claude, "On that PC, open AppBridge → Agents → Sign in to Claude.");
  assert.deepEqual(Object.keys(RD.HOW_TO), ["appbridge", "registered", "agent_control", "worker", "senders", "claude"]);
});
