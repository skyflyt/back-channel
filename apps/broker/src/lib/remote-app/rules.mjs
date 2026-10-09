/**
 * Remote app sessions: the rules (docs/remote-app-sessions.md).
 *
 * An agent uses an app on one of its person's own PCs (Back Channel Remote, built as AppBridge) to
 * finish a task: one agent, one named PC, an app allow-list, a time limit and usually one Lists task.
 * Pure module, like lists/rules.mjs: no database, no framework, no clock (callers pass `now`), and
 * covered by `node --test`. src/lib/remote-app.ts does the I/O; src/lib/appbridge.ts asks
 * admitsAgentLease() and agentsAdmit() before it issues, redeems or renews an "agent" relay lease.
 *
 * The life of a session:
 *   awaiting_consent -> active    the person approved it in the dashboard (the only way, in v1)
 *   awaiting_consent -> denied    the person said no                                   (terminal)
 *   awaiting_consent -> lapsed    nobody answered within 10 minutes                    (terminal)
 *   awaiting_consent -> ended     the agent withdrew the request                       (terminal)
 *   active  -> blocked            a step failed closed: it stops and asks
 *   blocked -> active             the person said it can go on, in the dashboard
 *   active | blocked -> ended     finished, stopped by anyone, out of time, or revoked (terminal)
 * A stopped session never reopens: going again takes a new request and a new approval.
 */

import { createHash } from "node:crypto";
import { looksSecret } from "../lists/rules.mjs";

export const LIMITS = Object.freeze({
  minMinutes: 1,
  maxMinutes: 60,
  apps: 8,
  appName: 60,
  goal: 500,
  target: 120,
  summary: 2_000,
  evidenceRef: 128,
  actionsPerSession: 1_000,
});

/** How long a request waits for the person's answer. */
export const CONSENT_MS = 10 * 60_000;

export const KINDS = Object.freeze(["agent", "support"]);
export const STATUSES = Object.freeze(["awaiting_consent", "active", "blocked", "ended", "denied", "lapsed"]);
/** Not over yet: at most one of these per account at a time. */
export const LIVE = Object.freeze(["awaiting_consent", "active", "blocked"]);
/** Approved and not over. */
export const RUNNING = Object.freeze(["active", "blocked"]);
export const END_REASONS = Object.freeze(["done", "user_stop", "host_stop", "agent_stop", "lapsed", "fail_closed", "revoked"]);
export const ACTIONS = Object.freeze(["open", "observe", "invoke", "set_value", "toggle", "select", "scroll", "key", "screenshot", "blocked"]);
export const OUTCOMES = Object.freeze(["ok", "credential_field", "not_in_scope", "needs_user", "fail_closed"]);
/** Every outcome but "ok" stops the session and asks. */
export const FAIL_CLOSED = Object.freeze(OUTCOMES.filter((o) => o !== "ok"));
/** The keys a "key" step may name: the bounded set the AppBridge wire carries (no raw key codes). */
export const KEY_NAMES = Object.freeze([
  "Enter", "Tab", "Escape", "Space", "Backspace", "Delete", "Up", "Down", "Left", "Right", "Home", "End", "PageUp", "PageDown",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
]);
const NEEDS_TARGET = new Set(["open", "invoke", "set_value", "toggle", "select", "key"]);
const EVIDENCE_REF = /^[A-Za-z0-9._:-]{1,128}$/;
// App names are plain names ("QuickBooks", "Notepad++"), never paths, patterns or wildcards.
const APP_NAME = /^[\p{L}\p{N}][\p{L}\p{N} .&()'+_-]*$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class RemoteRuleError extends Error {
  /** @param {number} status @param {string} code @param {string} message @param {Record<string, unknown>} [extra] */
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
/** @returns {never} */
function fail(status, code, message, extra) {
  throw new RemoteRuleError(status, code, message, extra);
}

const ms = (d) => (d instanceof Date ? d.getTime() : d ? new Date(d).getTime() : NaN);
const iso = (d) => (d ? new Date(d).toISOString() : null);

// ── Text ────────────────────────────────────────────────────────────────────

export const SECRET_TEXT =
  "That looks like a password or key. Remote sessions record only what an agent did, never secrets: leave it out.";
// Control characters, and the invisible and direction-changing ones that could make an approval card
// say something other than what was stored.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/**
 * Normalise one piece of text. undefined when not supplied; refuses secret-shaped text.
 * @param {unknown} value
 * @param {{ field: string, max: number, required?: boolean, singleLine?: boolean, truncate?: boolean }} opts
 * @returns {string | undefined}
 */
export function cleanText(value, { field, max, required = false, singleLine = true, truncate = false }) {
  if (value === undefined || value === null) {
    if (required) fail(400, `invalid_${field}`, `${field} is required`);
    return undefined;
  }
  if (typeof value !== "string") fail(400, `invalid_${field}`, `${field} must be text`);
  let v = value.replace(/\r\n?/g, "\n").replace(INVISIBLE, "");
  v = singleLine ? v.replace(/\s+/g, " ") : v.replace(/[ \t]+/g, " ");
  v = v.trim();
  if (required && !v) fail(400, `invalid_${field}`, `${field} can't be empty`);
  if ([...v].length > max) {
    if (!truncate) fail(400, `invalid_${field}`, `${field} is longer than ${max} characters`);
    v = [...v].slice(0, max - 1).join("") + "…";
  }
  if (v && looksSecret(v)) fail(422, "secret_like", SECRET_TEXT);
  return v;
}

/** @param {unknown} value @returns {string[]} */
export function parseApps(value) {
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || !list.length || list.length > LIMITS.apps) {
    fail(400, "invalid_apps", `apps must list 1 to ${LIMITS.apps} apps by name, e.g. ["QuickBooks"]`);
  }
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const name = cleanText(item, { field: "apps", max: LIMITS.appName, required: true });
    if (!APP_NAME.test(name)) fail(400, "invalid_apps", `"${name}" isn't an app name. Use the app's plain name, like "QuickBooks": no paths, wildcards or patterns.`);
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** @param {unknown} value @returns {number} */
export function parseMinutes(value) {
  const n = typeof value === "string" && /^\d{1,3}$/.test(value.trim()) ? Number(value) : value;
  if (!Number.isInteger(n) || n < LIMITS.minMinutes || n > LIMITS.maxMinutes) {
    fail(400, "invalid_minutes", `minutes must be a whole number from ${LIMITS.minMinutes} to ${LIMITS.maxMinutes}`);
  }
  return /** @type {number} */ (n);
}

/** @param {unknown} value @returns {string | undefined} */
export function parseEvidenceRef(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !EVIDENCE_REF.test(value)) {
    fail(400, "invalid_evidenceRef", "evidenceRef is a pointer into the PC's own store: 1 to 128 letters, digits, dots, dashes, colons or underscores");
  }
  return value;
}

/** @param {unknown} value @returns {string | undefined} */
export function parseTaskId(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !UUID.test(value.trim())) fail(400, "invalid_task_id", "task_id is a task's id, from bc_tasks");
  return value.trim();
}

/**
 * A request to start a session, validated. host and executor are resolved by the caller.
 * @param {Record<string, unknown>} input
 */
export function parseStart(input) {
  const host = cleanText(input.host, { field: "host", max: 128, required: true });
  return {
    host: /** @type {string} */ (host),
    apps: parseApps(input.apps),
    minutes: parseMinutes(input.minutes),
    goal: /** @type {string} */ (cleanText(input.goal, { field: "goal", max: LIMITS.goal, required: true })),
    taskId: parseTaskId(input.taskId),
    executor: cleanText(input.executor, { field: "executor", max: 128 }) || undefined,
  };
}

/** Is this app on the session's allow-list? Names compare without case. @param {string[]} apps @param {string | null | undefined} name */
export function inAllowList(apps, name) {
  if (!name) return false;
  const want = name.trim().toLowerCase();
  return (apps ?? []).some((a) => a.toLowerCase() === want);
}

// ── Time ────────────────────────────────────────────────────────────────────

/** When an unanswered request lapses. @param {any} session */
export function consentDeadline(session) {
  return new Date(ms(session.createdAt) + CONSENT_MS);
}

/**
 * What a session has become with time alone: an unanswered request lapses after 10 minutes, a running
 * session ends when its time is up. Returns the patch to write, or null when nothing changed.
 * @param {any} session @param {Date} now
 */
export function settle(session, now) {
  const t = now.getTime();
  if (session.status === "awaiting_consent" && !(ms(session.createdAt) + CONSENT_MS > t)) {
    return { status: "lapsed", endedAt: consentDeadline(session) };
  }
  if (RUNNING.includes(session.status) && !(ms(session.expiresAt) > t)) {
    return { status: "ended", endReason: "lapsed", endedAt: session.expiresAt ? new Date(ms(session.expiresAt)) : now };
  }
  return null;
}

/** The session as it really stands now. @param {any} session @param {Date} now */
export function effective(session, now) {
  const patch = settle(session, now);
  return patch ? { ...session, ...patch } : session;
}

// ── Decisions ───────────────────────────────────────────────────────────────

/** One agent session per account at a time, waiting or running. @param {number} liveCount other live sessions on the account */
export function startCheck(liveCount) {
  if (liveCount > 0) {
    fail(409, "session_in_progress",
      "Another agent session on this account is already waiting for approval or running. One at a time: wait for it to end, or ask your person to stop it on the Remote page of the dashboard.");
  }
}

/**
 * The row to create for a new request. Never active: only the person's approval starts it. It is born with an
 * executor secret's hash (agent-control v1.1: newExecutorSecret below; the raw value is discarded), so the PC's
 * agent-control pipe never admits a hello for it before its executor has been handed its own value.
 * @param {{ accountId: string, hostDeviceId: string, agentId: string, executorAgentId: string | null, taskId?: string, goal: string, apps: string[], minutes: number, executorSecretHash: string }} p
 */
export function newSession(p) {
  return {
    accountId: p.accountId,
    kind: "agent",
    hostDeviceId: p.hostDeviceId,
    agentTokenId: p.agentId,
    executorAgentId: p.executorAgentId && p.executorAgentId !== p.agentId ? p.executorAgentId : null,
    listTaskId: p.taskId ?? null,
    goal: p.goal,
    appAllowList: p.apps,
    minutes: p.minutes,
    status: "awaiting_consent",
    executorSecretHash: p.executorSecretHash,
  };
}

/** The agent that drives the app: the named executor, else the agent that asked. @param {any} session */
export function executorOf(session) {
  return session.executorAgentId ?? session.agentTokenId;
}

/** Approve or deny: only a request still waiting, and not lapsed. @param {any} session @param {Date} now */
export function decideCheck(session, now) {
  const s = effective(session, now);
  if (s.status === "lapsed") fail(410, "request_expired", "This request expired before anyone answered. Your agent can ask again if you still want it.");
  if (s.status !== "awaiting_consent") fail(409, "already_decided", `This request is already ${statusLabel(s.status)}.`);
}
/** @param {any} session @param {string} accountId @param {Date} now */
export function approvePatch(session, accountId, now) {
  return { status: "active", consentBy: accountId, consentVia: "web", startedAt: now, expiresAt: new Date(now.getTime() + session.minutes * 60_000) };
}
/** @param {string} accountId @param {Date} now */
export function denyPatch(accountId, now) {
  return { status: "denied", consentBy: accountId, consentVia: "web", endedAt: now };
}

/** Let a paused session go on: the person's call, in the dashboard. @param {any} session @param {Date} now */
export function resumeCheck(session, now) {
  const s = effective(session, now);
  if (s.status !== "blocked") fail(409, "not_paused", s.status === "active" ? "This session isn't paused." : `This session is ${statusLabel(s.status)}.`);
}

/**
 * Stop. Beats everything, and is final. who: "person" (the dashboard), "host" (Stop on the PC) or
 * "agent" (the agent that asked, or the one driving). A person stopping a request that is still
 * waiting has denied it. Returns null when the session is already over: stopping again is a no-op.
 * @param {any} session @param {"person" | "host" | "agent"} who @param {Date} now @param {string} [accountId]
 */
export function stopPatch(session, who, now, accountId) {
  const s = effective(session, now);
  if (!LIVE.includes(s.status)) return null;
  if (s.status === "awaiting_consent" && who === "person") return denyPatch(accountId ?? s.accountId, now);
  return { status: "ended", endReason: who === "person" ? "user_stop" : who === "host" ? "host_stop" : "agent_stop", endedAt: now };
}

/**
 * The agent ends its session with a summary. finished: the goal is done. Ending a request that never
 * started withdraws it. Ending while paused (it stopped to ask) without finishing is fail_closed.
 * @param {any} session @param {{ finished: boolean }} opts @param {Date} now
 */
export function endPatch(session, { finished }, now) {
  const s = effective(session, now);
  if (s.status === "awaiting_consent") {
    if (finished) fail(409, "not_approved", "This session never started: your person hasn't approved it. To withdraw the request, end it with finished: false.");
    return { status: "ended", endReason: "agent_stop", endedAt: now };
  }
  if (!RUNNING.includes(s.status)) fail(409, "session_over", `This session is already over (${s.status === "ended" ? endLabel(s.endReason) : statusLabel(s.status)}).`);
  return { status: "ended", endReason: finished ? "done" : s.status === "blocked" ? "fail_closed" : "agent_stop", endedAt: now };
}

/**
 * One step reported by the agent driving the app, validated. Only fixed kinds, a bounded control or app
 * name and an outcome: there is deliberately no field for a value, typed text or screen content.
 * @param {Record<string, unknown>} body
 */
export function parseReport(body) {
  const names = Object.keys(body ?? {});
  const allowed = ["action", "target", "outcome", "evidenceRef"];
  const extra = names.find((n) => !allowed.includes(n));
  if (extra) fail(400, "unknown_field", `Unknown field "${extra}". A step is { action, target?, outcome, evidenceRef? }: never a value, typed text or screen content.`);
  const action = body.action;
  if (typeof action !== "string" || !ACTIONS.includes(action)) fail(400, "invalid_action", `action must be one of: ${ACTIONS.join(", ")}`);
  const outcome = body.outcome;
  if (typeof outcome !== "string" || !OUTCOMES.includes(outcome)) fail(400, "invalid_outcome", `outcome must be one of: ${OUTCOMES.join(", ")}`);
  const target = cleanText(body.target, { field: "target", max: LIMITS.target, truncate: true }) || null;
  if (NEEDS_TARGET.has(action) && !target) fail(400, "target_required", `A ${action} step names its target: the control's name, or the app's for open.`);
  if (action === "key" && !KEY_NAMES.includes(/** @type {string} */ (target))) fail(400, "invalid_target", `A key step names one key: ${KEY_NAMES.join(", ")}`);
  if (action === "blocked" && outcome === "ok") fail(400, "invalid_outcome", "A blocked step says why: credential_field, not_in_scope, needs_user or fail_closed.");
  const evidenceRef = parseEvidenceRef(body.evidenceRef) ?? null;
  if (action === "screenshot" && !evidenceRef) fail(400, "evidence_required", "A screenshot step names where the PC kept it (evidenceRef). The picture itself never comes here.");
  return { action, target, outcome, evidenceRef };
}

/**
 * What recording a step does to the session. Only a running, unpaused session takes steps. Anything but
 * "ok" pauses it (fail closed: it stops and asks). An app opened outside the allow-list is recorded as
 * not_in_scope and pauses it too, whatever the report said: the broker double-checks the PC's scope.
 * @param {any} session @param {{ action: string, target: string | null, outcome: string, evidenceRef: string | null }} report
 * @param {Date} now @param {number} recorded steps already recorded for this session
 */
export function reportDecision(session, report, now, recorded) {
  const s = effective(session, now);
  if (s.status === "blocked") fail(409, "paused", "This session is paused: it stopped to ask. Wait until your person says it can go on, or end it.");
  if (s.status === "awaiting_consent") fail(409, "not_approved", "Your person hasn't approved this session yet. Nothing may happen on the PC until they do.");
  if (s.status !== "active") fail(409, "session_over", `This session is over (${s.status === "ended" ? endLabel(s.endReason) : statusLabel(s.status)}). Stop working on the PC.`);
  if (recorded >= LIMITS.actionsPerSession) fail(429, "too_many_steps", `This session has recorded ${LIMITS.actionsPerSession} steps, the most one session may. End it and start another if there is more to do.`);
  let outcome = report.outcome;
  let refused = null;
  if (report.action === "open" && outcome === "ok" && !inAllowList(s.appAllowList, report.target)) {
    outcome = "not_in_scope";
    refused = "not_in_scope";
  }
  const row = { action: report.action, target: report.target, outcome, evidenceRef: report.evidenceRef };
  return { row, pause: outcome !== "ok", refused };
}

// ── Relay admission (src/lib/appbridge.ts) ──────────────────────────────────

/**
 * May the PC hold an "agent" relay lease for this session right now? Only while it is approved, running,
 * not paused and not out of time, for that PC, in that account.
 * @param {any} session @param {{ accountId: string, hostDeviceId: string }} binding @param {Date} now
 */
export function admitsAgentLease(session, { accountId, hostDeviceId }, now) {
  return !!session && session.kind === "agent" && session.accountId === accountId && session.hostDeviceId === hostDeviceId &&
    session.status === "active" && ms(session.expiresAt) > now.getTime();
}

/**
 * The session's agents (the one that asked and the one driving) must still be live, full-scope agents
 * of the same account: revoking either one, or downgrading its key, ends the PC's lease.
 * @param {any} session @param {Array<{ id: string, accountId: string, revokedAt?: Date | null, scope?: string | null }>} agents
 */
export function agentsAdmit(session, agents) {
  const wanted = new Set([session.agentTokenId, executorOf(session)]);
  for (const id of wanted) {
    const a = agents.find((x) => x.id === id);
    if (!a || a.accountId !== session.accountId || a.revokedAt || a.scope !== "full") return false;
  }
  return true;
}

/** An agent lease never outlives its session. @param {any} session @param {Date} now @param {number} ttlMs */
export function agentLeaseExpiry(session, now, ttlMs) {
  return new Date(Math.min(now.getTime() + ttlMs, ms(session.expiresAt)));
}

// ── The executor secret (agent-control v1.1; the support relay path contract, §2.3 and §5) ──
//
// Per session, both kinds. The local pipe that carries agent-control (the PC's AgentControl pipe in Phase A, the issuer
// connector's SupportConnector pipe in Phase B) admits a hello only with this session's secret, so a rogue process of
// the same user can't drive it. The broker stores only its sha256. A secret is generated when the session is created,
// and its raw value is never kept, so nobody holds it until it is HANDED OUT: once, to its one reader (Phase A: the
// executor; Phase B: the agent that asked, which seals it into the Dispatch hand-off), in a fresh value whose hash
// replaces the first. After that no read shows it again; a lost reply is recovered by an explicit rotation, which
// hands out a new value and stops the old one. A session with no hash is a v1 session (created before secrets
// existed): it never gets one, and its PC asks for none.

export const EXECUTOR_SECRET_PREFIX = "abx_";
export const EXECUTOR_SECRET = /^abx_[A-Za-z0-9_-]{43}$/;

/**
 * A fresh executor secret and the hash to store. `bytes` is 32 random bytes: the caller passes node:crypto
 * randomBytes(32) (like newCode's `pick`), so this stays pure.
 * @param {Uint8Array} bytes
 */
export function newExecutorSecret(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new TypeError("an executor secret needs 32 random bytes");
  const secret = EXECUTOR_SECRET_PREFIX + Buffer.from(bytes).toString("base64url");
  return { secret, hash: createHash("sha256").update(secret, "utf8").digest("hex") };
}

/** Running, as far as the secret is concerned: an agent session approved and not over; a support session allowed and not over. */
const secretRunning = (/** @type {any} */ s) => (s.kind === "support" ? s.status === "active" : RUNNING.includes(s.status));

/**
 * Is the session's secret due to its reader in this response? Exactly once: while the session runs, while it has not
 * been handed out yet, and never for a v1 session (no hash).
 * @param {any} session @param {Date} now
 */
export function executorSecretDue(session, now) {
  const s = effective(session, now);
  return !!s.executorSecretHash && !s.executorSecretIssuedAt && secretRunning(s);
}

/**
 * May its reader rotate the secret (a lost reply)? Only while the session runs, and never for a v1 session.
 * @param {any} session @param {Date} now
 */
export function executorSecretRotateCheck(session, now) {
  const s = effective(session, now);
  const support = s.kind === "support";
  if (!s.executorSecretHash) {
    fail(409, "no_executor_secret", "This session started before executor secrets existed, so nothing asks for one: connect as before.");
  }
  if (s.status === "awaiting_consent") {
    fail(409, support ? "not_allowed_yet" : "not_approved", support
      ? "Nothing is running yet. The executor secret is handed out once, on your first bc_support_status after they press Allow."
      : "Your person hasn't approved this session yet. The executor secret is handed out once, with the session, after they do.");
  }
  if (!secretRunning(s)) fail(409, "session_over", "This session is over, so it has no use for an executor secret.");
}

/** What handing out a secret (the first time, or by rotation) writes: the new value's hash, and when. @param {string} hash @param {Date} now */
export const executorSecretPatch = (hash, now) => ({ executorSecretHash: hash, executorSecretIssuedAt: now });

// ── Words ───────────────────────────────────────────────────────────────────

/** @param {string} status */
export function statusLabel(status) {
  return (
    {
      awaiting_consent: "waiting for approval",
      active: "running",
      blocked: "paused: it stopped to ask",
      ended: "over",
      denied: "denied",
      lapsed: "expired with no answer",
    }[status] ?? status
  );
}

/** @param {string | null | undefined} reason */
export function endLabel(reason) {
  return (
    {
      done: "finished",
      user_stop: "stopped by you",
      host_stop: "stopped on the PC",
      agent_stop: "stopped by the agent",
      lapsed: "ran out of time",
      fail_closed: "ended after it stopped to ask",
      revoked: "ended because the PC or an agent was removed",
    }[reason ?? ""] ?? "over"
  );
}

export const OUTCOME_PHRASES = Object.freeze({
  credential_field: "that's a password field, and agents never type passwords",
  not_in_scope: "that's outside the apps you approved",
  needs_user: "it needs you at the PC",
  fail_closed: "something unexpected came up",
});

const VERBS = Object.freeze({
  open: ["Opened", "open"],
  observe: ["Looked at", "look at"],
  invoke: ["Clicked", "click"],
  set_value: ["Filled in", "fill in"],
  toggle: ["Switched", "switch"],
  select: ["Chose an item in", "choose an item in"],
  scroll: ["Scrolled", "scroll"],
  key: ["Pressed", "press"],
  screenshot: ["Saved a screenshot", "save a screenshot"],
});

/**
 * The fixed phrase for one step, e.g. "Clicked 'Save' on Shop-PC." Built only from the step's kind, its
 * bounded target and outcome: never anything else from the screen.
 * @param {{ action: string, target?: string | null, outcome: string }} row @param {{ pc?: string }} [opts]
 */
export function actionPhrase(row, { pc } = {}) {
  const on = pc ? ` on ${pc}` : "";
  if (row.action === "blocked") return `Stopped and asked${on}: ${OUTCOME_PHRASES[row.outcome] ?? "something unexpected came up"}.`;
  const [done, todo] = VERBS[row.action] ?? ["Did", "do"];
  const what = !row.target ? (row.action === "observe" ? " the screen" : "")
    : row.action === "open" || row.action === "key" ? ` ${row.target}`
    : row.action === "screenshot" ? ""
    : ` '${row.target}'`;
  if (row.outcome === "ok") return row.action === "screenshot" ? `Saved a screenshot${on} (kept on the PC).` : `${done}${what}${on}.`;
  return `Tried to ${todo}${what}${on}, and stopped: ${OUTCOME_PHRASES[row.outcome] ?? "something unexpected came up"}.`;
}

// ── Views ───────────────────────────────────────────────────────────────────

/**
 * One session as an agent or the dashboard sees it.
 * @param {any} session
 * @param {{ now: Date, pc: string, startedBy: string, drivenBy: string, task?: { id: string, title: string } | null, pausedBecause?: string | null }} ctx
 */
export function sessionView(session, { now, pc, startedBy, drivenBy, task = null, pausedBecause = null }) {
  const s = effective(session, now);
  const view = {
    id: s.id,
    kind: s.kind ?? "agent",
    status: s.status,
    statusText: s.status === "ended" ? endLabel(s.endReason) : statusLabel(s.status),
    pc: { hostDeviceId: s.hostDeviceId, label: pc },
    apps: s.appAllowList ?? [],
    goal: s.goal,
    minutes: s.minutes,
    startedBy: { agentId: s.agentTokenId, name: startedBy },
    drivenBy: { agentId: executorOf(s), name: drivenBy },
    task: s.listTaskId ? { id: s.listTaskId, title: task?.title ?? null } : null,
    requestedAt: iso(s.createdAt),
    approvalExpiresAt: s.status === "awaiting_consent" ? iso(consentDeadline(s)) : null,
    startedAt: iso(s.startedAt),
    expiresAt: iso(s.expiresAt),
    endedAt: iso(s.endedAt),
    endReason: s.endReason ?? null,
  };
  if (s.status === "blocked") view.pausedBecause = pausedBecause ?? OUTCOME_PHRASES.fail_closed;
  if (s.summary) view.summary = s.summary;
  if (s.evidenceRef) view.evidenceRef = s.evidenceRef;
  return view;
}

/** @param {any} row @param {{ pc?: string }} [opts] */
export function actionView(row, opts) {
  return { at: iso(row.at), action: row.action, target: row.target ?? null, outcome: row.outcome, text: actionPhrase(row, opts), ...(row.evidenceRef ? { evidenceRef: row.evidenceRef } : {}) };
}

/**
 * What the calling agent should do next, in plain words. role: "starter" (asked for it), "driver" (drives
 * the app; the starter too when it named no other agent).
 * @param {ReturnType<typeof sessionView>} view @param {{ role: "starter" | "driver", sameAgent: boolean }} who
 */
export function nextStep(view, { role, sameAgent }) {
  switch (view.status) {
    case "awaiting_consent":
      return role === "starter"
        ? "Nothing happens on the PC until your person approves. Give them approvalUrl: it signs them in to their Back Channel dashboard and opens this request on the Remote page (don't open it yourself). " +
          `If nobody answers by ${view.approvalExpiresAt}, the request lapses. Check back with bc_remote_session_status about every 30 seconds.`
        : "Your person hasn't approved this session yet. Do nothing on the PC until they do.";
    case "active":
      if (role === "starter" && !sameAgent) {
        return `Approved until ${view.expiresAt}. ${view.drivenBy.name} drives ${view.apps.join(", ")} on ${view.pc.label}, not you. ` +
          `Hand it the session with Dispatch now: submit a task to targetAgentId ${view.drivenBy.agentId}, expiring no later than ${view.expiresAt}, whose sealed request has profile "remote-app", ` +
          `the goal as its objective and remoteAppSessionId "${view.id}" (docs/remote-app-sessions.md). It records each step and ends the session itself. ` +
          "Watch with bc_remote_session_status; stop it with bc_remote_session_end (finished: false) if you need to.";
      }
      return `Approved until ${view.expiresAt}. Work only in ${view.apps.join(", ")} on ${view.pc.label}, only toward the goal, and stop and ask if anything is unexpected. ` +
        "bc_remote_app_open, bc_remote_observe and bc_remote_act answer not_available_yet until the Back Channel Remote agent component is installed on that PC. " +
        "Finish with bc_remote_session_end and a summary of what you did." +
        (view.executorSecret
          ? " session.executorSecret is shown this once: send it in the hello on the PC's agent-control pipe (v1.1) and keep it nowhere else. " +
            `If it gets lost, POST /api/remote-app/sessions/${view.id}/executor-secret for a new one; the old one stops working.`
          : "");
    case "blocked":
      return `Paused: ${view.pausedBecause}. Your person decides on the Remote page whether it goes on. Don't work around it; wait, or end the session.`;
    default:
      return `This session is over (${view.statusText}). If your person still wants this done, start a new one with bc_remote_session_start: it needs a new approval.`;
  }
}
