/**
 * PC readiness for agents: the rules (vault design pc-agent-readiness.md; docs/remote-app-sessions.md, "Setting up a
 * PC"). Can one of the person's agents drive an app on one of their PCs? Six steps must all be true:
 *
 *   1 appbridge      AppBridge 1.1.33 or newer (agent-control v1.2: the hello's host.version, reported as appbridge.version)
 *   2 registered     the PC is registered with Back Channel Remote (a host device, not revoked)
 *   3 agent_control  "Allow agent control" is on and listening
 *   4 worker         the Back Channel worker is installed, paired for Dispatch and running (it reports)
 *   5 senders        the worker's remote-app profile names at least one pinned agent that may hand it sessions
 *   6 claude         the claude CLI is signed in
 *
 * The worker on the PC reports what it sees (PUT /api/agents/self/readiness, src/lib/agent-readiness.ts) at start and
 * every 10 minutes. This module checks that report's shape, and turns the last report into the dashboard's checklist
 * and the readiness bc_remote_machines gives agents. It never claims what it can't know: a step it can't tell is
 * "unknown", and a report older than 30 minutes means the worker isn't running.
 *
 * Pure, like rules.mjs: no database, no clock (callers pass `now`), covered by `node --test`.
 */

import { createHash } from "node:crypto";
import { RemoteRuleError } from "./rules.mjs";

/** The largest report Back Channel takes, in bytes of JSON. */
export const MAX_REPORT_BYTES = 8192;
/** A report older than this: "not reporting", the worker isn't running on that PC. */
export const STALE_MS = 30 * 60_000;
export const MAX_SENDERS = 32;
export const FINGERPRINT = /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/;
export const PIPE_STATES = Object.freeze(["listening", "absent", "refused", "error"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/;
/** AppBridge's own version, as its agent-control hello says it (v1.2, `host.version`): four numbers, "1.1.33.0". */
export const APPBRIDGE_VERSION = /^\d+\.\d+\.\d+\.\d+$/;
/**
 * The first AppBridge whose agent-control speaks contract v1.2: desktop scope, `windows`, `open` by installed name, and a
 * sessions list whose entries carry `scope` (and may have no apps). Older hosts refuse those members as malformed.
 */
export const DESKTOP_APPBRIDGE = Object.freeze([1, 1, 33, 0]);
export const DESKTOP_APPBRIDGE_TEXT = "1.1.33";

/**
 * Is this AppBridge version (as reported, "1.1.33.0") at least `min`? false for anything that isn't four numbers.
 * @param {unknown} version @param {readonly number[]} [min]
 */
export function appBridgeAtLeast(version, min = DESKTOP_APPBRIDGE) {
  if (typeof version !== "string" || version.length > 40 || !APPBRIDGE_VERSION.test(version)) return false;
  const parts = version.split(".").map(Number);
  for (let i = 0; i < 4; i++) {
    if (parts[i] !== min[i]) return parts[i] > min[i];
  }
  return true;
}
// Control characters (C0 and C1), and the invisible and direction-changing ones that could make a name read as
// something other than what was stored.
const UNPRINTABLE = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/;

/**
 * THE fingerprint, the same formula the worker uses (packages/worker/src/readiness.mjs): uppercase hex SHA-256 of
 * `signingKey + "\n" + encryptionKey`, the agent's public Dispatch keys exactly as enrolled (the SPKI PEM strings
 * stored on AgentToken), first 16 hex characters in groups of 4: "AB12-CD34-EF56-7890". null without both keys.
 * @param {unknown} signingKey @param {unknown} encryptionKey
 * @returns {string | null}
 */
export function fingerprint(signingKey, encryptionKey) {
  if (typeof signingKey !== "string" || !signingKey || typeof encryptionKey !== "string" || !encryptionKey) return null;
  const hex = createHash("sha256").update(`${signingKey}\n${encryptionKey}`, "utf8").digest("hex").toUpperCase();
  return /** @type {string[]} */ (hex.slice(0, 16).match(/.{4}/g)).join("-");
}

// ── The report ───────────────────────────────────────────────────────────────

/** @returns {never} */
function refuse(code, message) {
  throw new RemoteRuleError(400, code, message);
}
const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
/** @param {unknown} value @param {string[]} keys @param {string} where */
function exactly(value, keys, where, optional = /** @type {string[]} */ ([])) {
  if (!isObject(value)) refuse("invalid_readiness", `${where} must be an object.`);
  const obj = /** @type {Record<string, unknown>} */ (value);
  const extra = Object.keys(obj).find((k) => !keys.includes(k) && !optional.includes(k));
  if (extra) refuse("unknown_field", `Unknown field "${where === "The report" ? extra : `${where}.${extra}`}". A readiness report has exactly the contract's fields.`);
  const missing = keys.find((k) => !(k in obj));
  if (missing) refuse("invalid_readiness", `${where} needs "${missing}".`);
  return obj;
}
/** @param {unknown} v @param {string} field @returns {boolean} */
function bool(v, field) {
  if (typeof v !== "boolean") refuse("invalid_readiness", `${field} must be true or false.`);
  return /** @type {boolean} */ (v);
}
/** Printable text, 1 to max characters, or null when allowed. @param {unknown} v @param {string} field @param {number} max @param {boolean} [nullable] */
function printable(v, field, max, nullable = false) {
  if (v === null && nullable) return null;
  if (typeof v !== "string") refuse("invalid_readiness", `${field} must be text${nullable ? " or null" : ""}.`);
  const t = /** @type {string} */ (v).trim();
  if (!t || [...t].length > max || UNPRINTABLE.test(t)) refuse("invalid_readiness", `${field} must be printable text, 1 to ${max} characters.`);
  return t;
}
/**
 * Local-only text the worker may print on the PC (the claude path, the pipe's reason, a sender's name): accepted as
 * null or bounded text, and never stored. Back Channel keeps no free text from the PC beyond its name and the worker's.
 * @param {unknown} v @param {string} field
 */
function localOnly(v, field) {
  if (v !== null && (typeof v !== "string" || v.length > 1024)) refuse("invalid_readiness", `${field} must be null or short text.`);
  return null;
}

/**
 * @typedef {{ agentId: string, name: null, pinned: boolean }} Sender
 * @typedef {{
 *   v: 1, agentId: string | null, name: string, enrolled: boolean, fingerprint: string | null, workerVersion: string,
 *   appbridge: { pipe: "listening" | "absent" | "refused" | "error", hostName: string | null, reason: null, version?: string | null },
 *   runtime: { adapter: "claude", path: null, installed: boolean, signedIn: boolean | null },
 *   profiles: { remoteApp: { present: boolean, senders: Sender[] } },
 *   checkedAt: string,
 * }} Readiness
 */

/**
 * Check a readiness report against the contract's shape, strictly: every field present, no other field, and every
 * value bounded. Returns what is stored (the local-only text dropped). `agentId` is the reporting agent's own id: a
 * report may only be about itself. The one optional field is `appbridge.version` (agent-control v1.2, AppBridge
 * 1.1.33): the AppBridge version the pipe's hello reported, or null when it gave none. A worker from before it leaves
 * it out, and the stored report then has no `version` at all, so the checklist can tell "an older worker" (unknown)
 * from "an older AppBridge" (needs the update).
 * @param {unknown} body @param {{ agentId: string }} caller
 * @returns {Readiness}
 */
export function parseReadiness(body, { agentId }) {
  const r = exactly(body, ["v", "agentId", "name", "enrolled", "fingerprint", "workerVersion", "appbridge", "runtime", "profiles", "checkedAt"], "The report");
  if (r.v !== 1) refuse("unsupported_version", "This is readiness report version 1 only.");
  if (r.agentId !== null && typeof r.agentId !== "string") refuse("invalid_readiness", "agentId must be this agent's id or null.");
  if (r.agentId !== null && r.agentId !== agentId) refuse("agent_mismatch", "A worker reports only about itself: agentId must be its own.");
  const name = printable(r.name, "name", 80);
  const enrolled = bool(r.enrolled, "enrolled");
  if (enrolled && r.agentId === null) refuse("invalid_readiness", "An enrolled worker names its agentId.");
  if (r.fingerprint !== null && (typeof r.fingerprint !== "string" || !FINGERPRINT.test(r.fingerprint))) refuse("invalid_fingerprint", "fingerprint must look like AB12-CD34-EF56-7890, or be null.");
  if (typeof r.workerVersion !== "string" || !VERSION.test(r.workerVersion)) refuse("invalid_readiness", "workerVersion must be a short version string.");

  const a = exactly(r.appbridge, ["pipe", "hostName", "reason"], "appbridge", ["version"]);
  if (typeof a.pipe !== "string" || !PIPE_STATES.includes(a.pipe)) refuse("invalid_readiness", `appbridge.pipe must be one of: ${PIPE_STATES.join(", ")}.`);
  const hostName = printable(a.hostName, "appbridge.hostName", 80, true);
  localOnly(a.reason, "appbridge.reason");
  if ("version" in a && a.version !== null && (typeof a.version !== "string" || a.version.length > 40 || !APPBRIDGE_VERSION.test(a.version))) {
    refuse("invalid_readiness", 'appbridge.version must be AppBridge\'s four-part version, like "1.1.33.0", or null.');
  }

  const rt = exactly(r.runtime, ["adapter", "path", "installed", "signedIn"], "runtime");
  if (rt.adapter !== "claude") refuse("invalid_readiness", 'runtime.adapter must be "claude".');
  localOnly(rt.path, "runtime.path");
  const installed = bool(rt.installed, "runtime.installed");
  if (rt.signedIn !== null && typeof rt.signedIn !== "boolean") refuse("invalid_readiness", "runtime.signedIn must be true, false or null.");

  const p = exactly(r.profiles, ["remoteApp"], "profiles");
  const ra = exactly(p.remoteApp, ["present", "senders"], "profiles.remoteApp");
  const present = bool(ra.present, "profiles.remoteApp.present");
  if (!Array.isArray(ra.senders) || ra.senders.length > MAX_SENDERS) refuse("invalid_readiness", `profiles.remoteApp.senders must be a list of at most ${MAX_SENDERS}.`);
  /** @type {Sender[]} */
  const senders = [];
  for (const s of /** @type {unknown[]} */ (ra.senders)) {
    const x = exactly(s, ["agentId", "name", "pinned"], "profiles.remoteApp.senders[]");
    if (typeof x.agentId !== "string" || !UUID.test(x.agentId)) refuse("invalid_readiness", "Each sender's agentId must be an agent id.");
    if (senders.some((y) => y.agentId.toLowerCase() === /** @type {string} */ (x.agentId).toLowerCase())) refuse("invalid_readiness", "A sender is listed twice.");
    localOnly(x.name, "profiles.remoteApp.senders[].name");
    senders.push({ agentId: /** @type {string} */ (x.agentId).toLowerCase(), name: null, pinned: bool(x.pinned, "profiles.remoteApp.senders[].pinned") });
  }

  if (typeof r.checkedAt !== "string" || r.checkedAt.length > 40 || !Number.isFinite(Date.parse(r.checkedAt))) refuse("invalid_readiness", "checkedAt must be a date and time.");

  return {
    v: 1, agentId: /** @type {string | null} */ (r.agentId), name: /** @type {string} */ (name), enrolled,
    fingerprint: /** @type {string | null} */ (r.fingerprint), workerVersion: r.workerVersion,
    appbridge: { pipe: /** @type {Readiness["appbridge"]["pipe"]} */ (a.pipe), hostName, reason: null,
      ...("version" in a ? { version: /** @type {string | null} */ (a.version) } : {}) },
    runtime: { adapter: "claude", path: null, installed, signedIn: /** @type {boolean | null} */ (rt.signedIn) },
    profiles: { remoteApp: { present, senders } },
    checkedAt: new Date(r.checkedAt).toISOString(),
  };
}

/**
 * A stored report read back from the database: parsed again, null if it no longer fits (never trusted blindly).
 * @param {unknown} stored @param {string} agentId @returns {Readiness | null}
 */
export function storedReadiness(stored, agentId) {
  if (!stored) return null;
  try { return parseReadiness(stored, { agentId }); } catch { return null; }
}

// ── Matching a report to a registered PC ────────────────────────────────────

/**
 * The registered PC a worker reports from, best effort. A report names the computer (`hostName`, the Windows computer
 * name AppBridge's hello gives), which is often not what the person called the PC when they registered it ("Desktop").
 * So, ignoring case and surrounding space:
 *   1. the one PC whose confirmed computer name (`agentHostName`, set by the person on the Remote page) equals it;
 *   2. otherwise the one PC whose name equals it.
 * Two PCs either way is no match, and so is none. A name match, not a proof.
 * @template {{ hostDeviceId: string, name: string, agentHostName?: string | null }} P
 * @param {string | null | undefined} hostName @param {P[]} pcs
 * @returns {P | null}
 */
export function matchPc(hostName, pcs) {
  const want = norm(hostName);
  if (!want) return null;
  const confirmed = pcs.filter((p) => norm(p.agentHostName) === want);
  if (confirmed.length) return confirmed.length === 1 ? confirmed[0] : null;
  const named = pcs.filter((p) => norm(p.name) === want);
  return named.length === 1 ? named[0] : null;
}
/** @param {unknown} v */
const norm = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");

/**
 * How a worker's report was matched to its PC, for the card: "confirmed" by the person (the PC's agentHostName), by
 * "name" (the PC's label), or null for no match.
 * @param {string | null | undefined} hostName @param {{ agentHostName?: string | null } | null} pc
 * @returns {"confirmed" | "name" | null}
 */
export function matchedBy(hostName, pc) {
  if (!pc) return null;
  return norm(pc.agentHostName) && norm(pc.agentHostName) === norm(hostName) ? "confirmed" : "name";
}

/**
 * The computer name the person confirms for a PC (POST /api/remote-app/readiness/pc): the hostName exactly as one of
 * the account's workers reported it, or null to forget it. Printable, 1 to 80 characters, like the report's own field.
 * @param {unknown} v @returns {string | null}
 */
export function parseAgentHostName(v) {
  if (v === null) return null;
  const t = typeof v === "string" ? v.trim() : "";
  if (!t || [...t].length > 80 || UNPRINTABLE.test(t)) {
    throw new RemoteRuleError(400, "invalid_request", "hostName must be the computer name one of your workers reported (printable, 1 to 80 characters), or null to forget it.");
  }
  return t;
}

// ── The checklist ────────────────────────────────────────────────────────────

/** @typedef {"appbridge" | "registered" | "agent_control" | "worker" | "senders" | "claude"} StepKey */
/** @typedef {{ step: number, key: StepKey, title: string, state: "done" | "needed" | "unknown", howTo: string | null }} Step */

const ON_PC = "On that PC, open AppBridge";
/** Each step's title and the one line that says how to do it, in the order a person does them. */
export const STEPS = Object.freeze(/** @type {const} */ ([
  { key: "appbridge", title: `AppBridge ${DESKTOP_APPBRIDGE_TEXT} or newer`, howTo: `${ON_PC} → Updates → Install update.` },
  { key: "registered", title: "PC registered with Back Channel", howTo: `${ON_PC} → Internet access → Register this PC, with a code from "Add a device" on the Remote page.` },
  { key: "agent_control", title: "Allow agent control is on", howTo: `${ON_PC} → Agents and turn on Allow agent control.` },
  { key: "worker", title: "Back Channel worker set up and running", howTo: `${ON_PC} → Agents → Set up worker (Get a code gives it a connect code), then Start.` },
  { key: "senders", title: "Agents allowed to hand it sessions", howTo: `${ON_PC} → Agents → Choose agents…, and check each fingerprint matches the one Back Channel shows for that agent.` },
  { key: "claude", title: "Claude signed in", howTo: `${ON_PC} → Agents → Sign in to Claude.` },
]));
/** The how-to line for each step, for agents (bc_remote_machines): what to tell the person. */
export const HOW_TO = Object.freeze(Object.fromEntries(STEPS.map((s) => [s.key, s.howTo])));

const CANT_TELL = "Back Channel can't tell from here. Check on that PC in AppBridge → Agents.";
const WHILE_SILENT = "Unknown while the worker isn't reporting.";
const AFTER_WORKER = "Back Channel learns this once the worker on that PC reports.";

/**
 * The six steps for one worker, from its last report.
 * @param {{ report: Readiness | null, readinessAt: Date | string | null, now: Date, pc: { name: string } | null }} input
 * @returns {{ reporting: boolean, steps: Step[], ready: boolean, missing: StepKey[] }}
 */
export function checklist({ report, readinessAt, now, pc }) {
  const at = readinessAt ? new Date(readinessAt).getTime() : NaN;
  const reporting = !!report && Number.isFinite(at) && now.getTime() - at <= STALE_MS;
  /** @type {Record<StepKey, [Step["state"], string | null]>} */
  const s = { appbridge: ["unknown", WHILE_SILENT], registered: ["unknown", WHILE_SILENT], agent_control: ["unknown", WHILE_SILENT],
    worker: ["needed", ""], senders: ["unknown", WHILE_SILENT], claude: ["unknown", WHILE_SILENT] };
  if (pc) s.registered = ["done", null];
  if (!reporting) {
    s.worker = ["needed", report ? `Not reporting: the worker isn't running on that PC. ${ON_PC} → Agents → Start.` : `It has never reported. ${STEPS[3].howTo}`];
  } else {
    const r = /** @type {Readiness} */ (report);
    const pipe = r.appbridge.pipe;
    s.appbridge = appBridgeStep(r.appbridge);
    if (!pc) {
      s.registered = ["unknown", r.appbridge.hostName
        ? `It reports as "${r.appbridge.hostName}", which matches no single PC registered here. If it's one of your registered PCs, say which on the Remote page (Agents on your PCs → Which PC is this?). If it isn't registered: ${STEPS[1].howTo}`
        : `${CANT_TELL} If it isn't registered: ${STEPS[1].howTo}`];
    }
    s.agent_control = pipe === "listening" ? ["done", null]
      : pipe === "absent" ? ["needed", `AppBridge isn't running there, or Allow agent control is off. ${STEPS[2].howTo}`]
      : pipe === "refused" ? ["needed", STEPS[2].howTo]
      : ["unknown", `Agent control didn't answer properly. ${STEPS[2].howTo}`];
    s.worker = r.enrolled ? ["done", null] : ["needed", `The worker runs but isn't paired for Dispatch. ${STEPS[3].howTo}`];
    const pinned = r.profiles.remoteApp.present && r.profiles.remoteApp.senders.some((x) => x.pinned);
    s.senders = pinned ? ["done", null] : ["needed", STEPS[4].howTo];
    s.claude = !r.runtime.installed ? ["needed", "Claude Code isn't installed there. Install it, then open AppBridge → Agents → Sign in to Claude."]
      : r.runtime.signedIn === true ? ["done", null]
      : r.runtime.signedIn === false ? ["needed", STEPS[5].howTo]
      : ["unknown", `Couldn't tell whether Claude is signed in. ${STEPS[5].howTo}`];
  }
  const steps = STEPS.map((def, i) => ({ step: i + 1, key: def.key, title: def.title, state: s[def.key][0], howTo: s[def.key][0] === "done" ? null : s[def.key][1] || def.howTo }));
  const missing = steps.filter((x) => x.state !== "done").map((x) => x.key);
  return { reporting, steps, ready: missing.length === 0, missing };
}

/**
 * Step 1, from what the worker's hello learned. An AppBridge from 1.1.33 says its version (`host.version`); one that
 * answers without it is older. A worker from before version reporting sends no `version` at all, so then nothing is
 * known (and updating AppBridge updates the worker that ships inside it).
 * @param {Readiness["appbridge"]} a @returns {[Step["state"], string | null]}
 */
function appBridgeStep(a) {
  const update = STEPS[0].howTo;
  if (typeof a.version === "string") {
    return appBridgeAtLeast(a.version) ? ["done", null]
      : ["needed", `It has AppBridge ${a.version}; agents need ${DESKTOP_APPBRIDGE_TEXT} or newer to use the whole PC. ${update}`];
  }
  if (a.version === null && a.pipe === "listening") {
    return ["needed", `Its AppBridge is older than ${DESKTOP_APPBRIDGE_TEXT}, so agents can't use the whole PC there yet. ${update}`];
  }
  if (a.version === undefined && (a.pipe === "listening" || a.pipe === "refused")) {
    return ["unknown", `This worker doesn't report AppBridge's version yet. ${update} (it updates the worker too).`];
  }
  return ["unknown", `Back Channel can't tell the version while agent control ${a.pipe === "refused" ? "is off" : "isn't answering"}. ${update}`];
}

/**
 * Does this PC's AppBridge speak agent-control v1.2 (desktop scope)? From the newest readiness report of a worker that
 * reports from it (`reports`, newest first, each already matched to this PC): its `appbridge.version` is 1.1.33 or
 * newer. No report, an older worker or an older AppBridge: false, and the PC gets the v1.1 sessions list.
 * @param {Array<Readiness | null>} reports
 */
export function speaksDesktop(reports) {
  const latest = reports.find((r) => !!r);
  return !!latest && appBridgeAtLeast(latest.appbridge.version);
}

/**
 * A registered PC that no worker reports from: registered, and nothing else known yet.
 * @returns {{ steps: Step[], ready: false, missing: StepKey[], note: string }}
 */
export function pcWithoutAgent() {
  const steps = STEPS.map((def, i) => {
    /** @type {Step["state"]} */
    const state = def.key === "registered" ? "done" : def.key === "worker" ? "needed" : "unknown";
    return { step: i + 1, key: def.key, title: def.title, state, howTo: state === "done" ? null : state === "needed" ? def.howTo : AFTER_WORKER };
  });
  return { steps, ready: false, missing: steps.filter((x) => x.state !== "done").map((x) => x.key), note: "No agent set up on this PC yet." };
}
