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
  appbridge: { pipe: "listening", hostName: "Shop-PC", reason: null },
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
  refused(() => parse({ ...report(), appbridge: { pipe: "listening", hostName: null, reason: null, version: "1.1.32" } }), "unknown_field");
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
  const refusedPipe = RD.checklist({ report: parse(report({ appbridge: { pipe: "refused", hostName: null, reason: null } })), readinessAt: T0, now: T0, pc });
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
