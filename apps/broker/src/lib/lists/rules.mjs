/**
 * Lists: the rules, with no database or framework in sight (docs/lists.md).
 *
 * Pure module so `node --test` can cover every decision; src/lib/lists.ts does
 * the I/O and calls these. Nothing here reads the clock: callers pass `now`.
 *
 * An "actor" is whoever is calling:
 *   { accountId, agentId: string | null, role: "owner" | "member" | null,
 *     agentAccess: "view" | "work" | null }
 * A person in the browser has agentId null. An agent acts with its person's
 * role on the list, capped by the access its person granted it there. Agents
 * are never members in their own right.
 */

export const LIMITS = Object.freeze({
  listName: 80,
  emoji: 16,
  title: 200,
  notes: 20_000,
  entry: 8_000,
  summary: 8_000,
  listsPerAccount: 50,
  openTasksPerList: 2_000,
  entriesPerTask: 500,
  batchAdd: 20,
  pageSize: 50,
});

export const STATUSES = Object.freeze(["open", "in_progress", "blocked", "needs_review", "done", "dropped"]);
/** Statuses that still need something from someone. */
export const ACTIVE = Object.freeze(["open", "in_progress", "blocked", "needs_review"]);

/** An agent's claim lapses after this long without a write from it. A person's never does. */
export const AGENT_CLAIM_MS = 60 * 60_000;
/** How long the person who asked can still send an agent's finished work back. */
export const SEND_BACK_MS = 7 * 24 * 60 * 60_000;
/** A person's claim with no activity for this long gets a gentle "still on it?" hint. */
export const STALE_PERSON_CLAIM_MS = 3 * 24 * 60 * 60_000;

export class ListRuleError extends Error {
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
  throw new ListRuleError(status, code, message, extra);
}

// ── Text ────────────────────────────────────────────────────────────────────

// Secret-shaped strings are refused outright: list content is stored readable
// and seen by everyone on the list. Same hard-stop set as the vault's commit
// gate, plus Back Channel's own agent keys and connect codes.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}/,
  /\bbco?_[A-Za-z0-9_-]{32,}/,
  /\bBCX-[A-Z0-9]{4}-[A-Z0-9]{4}\b/i,
];
export const SECRET_MESSAGE =
  "That looks like a password or key. Lists are stored by Back Channel and seen by everyone on the list, " +
  "so keep secrets out of tasks and send them as a message instead.";

/** @param {string} text */
export function looksSecret(text) {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

// Control characters other than newline and tab.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Normalise one piece of user text. Returns undefined when the value was not
 * supplied (so a PATCH can tell "leave it" from "clear it"), "" when it was
 * supplied empty and empty is allowed.
 * @param {unknown} value
 * @param {{ field: string, max: number, required?: boolean, singleLine?: boolean }} opts
 * @returns {string | undefined}
 */
export function cleanText(value, { field, max, required = false, singleLine = false }) {
  if (value === undefined || value === null) {
    if (required) fail(400, `invalid_${field}`, `${field} is required`);
    return undefined;
  }
  if (typeof value !== "string") fail(400, `invalid_${field}`, `${field} must be text`);
  let v = value.replace(/\r\n?/g, "\n").replace(CONTROL, "");
  if (singleLine) v = v.replace(/\s*\n\s*/g, " ");
  v = v.trim();
  if (required && !v) fail(400, `invalid_${field}`, `${field} can't be empty`);
  if ([...v].length > max) fail(400, `invalid_${field}`, `${field} is longer than ${max} characters`);
  if (looksSecret(v)) fail(422, "secret_like", SECRET_MESSAGE);
  return v;
}

/**
 * A due date: "YYYY-MM-DD" (stored at 12:00 UTC so it shows as the same day in
 * every timezone a person is likely to be in) or a full ISO timestamp. null or
 * "" clears it; undefined leaves it alone.
 * @param {unknown} value @param {Date} now
 * @returns {Date | null | undefined}
 */
export function parseDue(value, now) {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") fail(400, "invalid_due", "due must be a date like 2026-10-31");
  const v = value.trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00.000Z`) : new Date(v);
  if (!Number.isFinite(d.getTime())) fail(400, "invalid_due", "due must be a date like 2026-10-31");
  const tenYears = 10 * 366 * 24 * 60 * 60_000;
  if (Math.abs(d.getTime() - now.getTime()) > tenYears) fail(400, "invalid_due", "due is too far away");
  return d;
}

/**
 * Who a task is for. Phase 1 accepts nobody, the person ("me": for an agent,
 * that's its person), the person's agents, the calling agent, or one agent by id.
 * @param {unknown} value
 * @returns {undefined | { kind: "nobody" } | { kind: "me" } | { kind: "my_agents" } | { kind: "this_agent" } | { kind: "agent", agentId: string }}
 */
export function parseAssignee(value) {
  if (value === undefined) return undefined;
  if (value === null) return { kind: "nobody" };
  if (typeof value !== "string") fail(400, "invalid_assignee", "assignee must be nobody, me, my_agents, this_agent or an agent id");
  const v = value.trim();
  const lower = v.toLowerCase();
  if (lower === "" || lower === "nobody" || lower === "none" || lower === "anyone") return { kind: "nobody" };
  if (lower === "me") return { kind: "me" };
  if (lower === "my_agents" || lower === "my agents") return { kind: "my_agents" };
  if (lower === "this_agent" || lower === "this agent") return { kind: "this_agent" };
  if (/^[0-9a-f-]{8,64}$/i.test(v)) return { kind: "agent", agentId: v };
  return fail(400, "invalid_assignee", "assignee must be nobody, me, my_agents, this_agent or an agent id");
}

// ── Permissions ─────────────────────────────────────────────────────────────

/** @param {any} actor */
export function canView(actor) {
  return !!actor?.role && (!actor.agentId || actor.agentAccess === "view" || actor.agentAccess === "work");
}
/** Add, edit, claim, finish, add progress. @param {any} actor */
export function canWork(actor) {
  return !!actor?.role && (!actor.agentId || actor.agentAccess === "work");
}
/** Comment: anyone who can see the list, agents with view access included. @param {any} actor */
export function canComment(actor) {
  return canView(actor);
}
/** Rename, archive, decide which agents may work here: people only, and only the owner for the list itself. @param {any} actor */
export function canManage(actor) {
  return actor?.role === "owner" && !actor.agentId;
}

/**
 * The OK rule: may this account's agents act on this task without asking?
 * A task someone else wrote is a request, not an instruction.
 * @param {{ createdByAccountId: string, createdByAgentId?: string | null }} task
 * @param {string} accountId the agents' person
 * @param {{ agentsTakeFrom?: string, okAccountIds?: string[], authorName?: string }} [opts]
 */
export function agentMayAct(task, accountId, { agentsTakeFrom = "me", okAccountIds = [], authorName = "Someone else" } = {}) {
  if (task.createdByAccountId === accountId) return { ok: true, why: "written by you or one of your agents" };
  if (okAccountIds.includes(accountId)) return { ok: true, why: "you OK'd it for your agents" };
  if (agentsTakeFrom === "anyone") return { ok: true, why: "your setting on this list lets your agents take anyone's tasks" };
  return { ok: false, why: `${authorName} wrote this, so your agents need your OK before acting on it.` };
}

// ── Claims and status ───────────────────────────────────────────────────────

const ms = (d) => (d instanceof Date ? d.getTime() : d ? new Date(d).getTime() : NaN);

/** @param {any} task @param {Date} now */
export function hasLiveClaim(task, now) {
  if (!task.claimAccountId) return false;
  if (!task.claimAgentId) return true;
  return ms(task.claimExpiresAt) > now.getTime();
}
/** An agent claim that ran out on a task still marked as being worked. @param {any} task @param {Date} now */
export function claimLapsed(task, now) {
  return !!task.claimAgentId && (task.status === "in_progress" || task.status === "blocked") && !(ms(task.claimExpiresAt) > now.getTime());
}
/** @param {any} task @param {any} actor */
export function isClaimant(task, actor) {
  return !!task.claimAccountId && task.claimAccountId === actor.accountId && (task.claimAgentId ?? null) === (actor.agentId ?? null);
}
/** What the status really is once a lapsed agent claim is taken into account. @param {any} task @param {Date} now */
export function effectiveStatus(task, now) {
  return claimLapsed(task, now) && task.status === "in_progress" ? "open" : task.status;
}

/**
 * Could this actor claim this task right now? Returns a reason when not, in
 * words a person can act on.
 * @param {any} task @param {any} actor @param {Date} now
 * @param {{ ok: boolean, why: string }} mayAct the OK rule for the actor's account
 * @param {(t: any) => string} [holderLabel]
 */
export function claimCheck(task, actor, now, mayAct, holderLabel = () => "someone else") {
  if (!canWork(actor)) {
    return actor?.agentId
      ? { ok: false, code: "not_allowed", why: "Your person hasn't given this agent work access to this list." }
      : { ok: false, code: "not_allowed", why: "You can't work on this list." };
  }
  if (hasLiveClaim(task, now)) {
    if (isClaimant(task, actor)) return { ok: true, already: true };
    return { ok: false, code: "already_claimed", why: `${holderLabel(task)} is already on this.` };
  }
  const status = effectiveStatus(task, now);
  if (status !== "open" && status !== "blocked") {
    return { ok: false, code: "not_claimable", why: `This task is ${statusLabel(status)}.` };
  }
  if (task.assigneeAgentId && actor.agentId && actor.agentId !== task.assigneeAgentId) {
    return { ok: false, code: "assigned_elsewhere", why: "This task is for a different agent." };
  }
  if (task.assigneeAccountId && task.assigneeAccountId !== actor.accountId) {
    return { ok: false, code: "assigned_elsewhere", why: "This task is for someone else." };
  }
  if (actor.agentId && !mayAct.ok) return { ok: false, code: "needs_ok", why: mayAct.why };
  return { ok: true };
}

/** @param {any} task @param {any} actor @param {Date} now */
export function claimPatch(task, actor, now) {
  return {
    status: "in_progress",
    claimAccountId: actor.accountId,
    claimAgentId: actor.agentId ?? null,
    claimedAt: now,
    claimExpiresAt: actor.agentId ? new Date(now.getTime() + AGENT_CLAIM_MS) : null,
  };
}
const NO_CLAIM = Object.freeze({ claimAccountId: null, claimAgentId: null, claimedAt: null, claimExpiresAt: null });
/** Let go (or lapse): a blocked task stays blocked, anything else goes back to open. @param {any} task */
export function releasePatch(task) {
  return { ...NO_CLAIM, status: task.status === "blocked" ? "blocked" : "open" };
}
/** Any write by the agent holding the claim keeps it alive. null when nothing to renew. @param {any} task @param {any} actor @param {Date} now */
export function renewPatch(task, actor, now) {
  if (!actor.agentId || !isClaimant(task, actor) || !hasLiveClaim(task, now)) return null;
  return { claimExpiresAt: new Date(now.getTime() + AGENT_CLAIM_MS) };
}

/**
 * Can this actor mark the task finished? The claimant can; so can anyone who
 * could claim it right now (claim-and-finish in one go), and the list owner.
 * @param {any} task @param {any} actor @param {Date} now @param {{ ok: boolean, why: string }} mayAct @param {boolean} isListOwner
 * @param {(t: any) => string} [holderLabel]
 */
export function finishCheck(task, actor, now, mayAct, isListOwner, holderLabel) {
  if (!canWork(actor)) return claimCheck(task, actor, now, mayAct, holderLabel);
  const status = effectiveStatus(task, now);
  if (status === "needs_review" || status === "done" || status === "dropped") {
    return { ok: false, code: "not_finishable", why: `This task is already ${statusLabel(status)}.` };
  }
  if (hasLiveClaim(task, now) && !isClaimant(task, actor)) {
    if (isListOwner && !actor.agentId) return { ok: true };
    return { ok: false, code: "already_claimed", why: `${(holderLabel ?? (() => "someone else"))(task)} is already on this.` };
  }
  if (hasLiveClaim(task, now)) return { ok: true };
  return claimCheck(task, actor, now, mayAct, holderLabel);
}

/**
 * Finishing. Agents must say what they did. If an agent finishes a task that
 * someone other than its own person wrote, the person who asked checks it.
 * @param {any} task @param {any} actor @param {Date} now @param {string | undefined} summary
 */
export function donePatch(task, actor, now, summary) {
  if (actor.agentId && !summary) {
    fail(400, "summary_required", "Say what you did, and how you checked it, in summary. Agents always do, so the person can see it at a glance.");
  }
  const needsReview = !!actor.agentId && task.createdByAccountId !== actor.accountId;
  return {
    ...NO_CLAIM,
    status: needsReview ? "needs_review" : "done",
    reviewerAccountId: needsReview ? task.createdByAccountId : null,
    completedAt: now,
    completedByAccountId: actor.accountId,
    completedByAgentId: actor.agentId ?? null,
    summary: summary || null,
  };
}

/**
 * "Looks good" or "Send back". People only. needs_review: the reviewer or the
 * list owner. done: an agent's finished work can be sent back by the person
 * who asked (or the list owner) for SEND_BACK_MS.
 * @param {any} task @param {any} actor @param {Date} now @param {"accept" | "send_back"} verdict @param {boolean} isListOwner
 */
export function reviewCheck(task, actor, now, verdict, isListOwner) {
  if (actor.agentId) return { ok: false, code: "people_only", why: "Only a person can check finished work." };
  if (task.status === "needs_review") {
    if (actor.accountId !== task.reviewerAccountId && !isListOwner) return { ok: false, code: "not_reviewer", why: "Someone else is checking this one." };
    return { ok: true };
  }
  if (task.status === "done" && verdict === "send_back") {
    if (!task.completedByAgentId) return { ok: false, code: "not_reviewable", why: "Only an agent's finished work can be sent back. Reopen it instead." };
    if (!(ms(task.completedAt) + SEND_BACK_MS > now.getTime())) return { ok: false, code: "too_late", why: "It's been more than 7 days. Reopen it instead." };
    if (actor.accountId !== task.createdByAccountId && !isListOwner) return { ok: false, code: "not_reviewer", why: "Only the person who asked can send this back." };
    return { ok: true };
  }
  return { ok: false, code: "not_reviewable", why: `This task is ${statusLabel(task.status)}.` };
}
/** @param {any} task @param {"accept" | "send_back"} verdict @param {Date} now */
export function reviewPatch(task, verdict, now) {
  if (verdict === "accept") return { status: "done", reviewerAccountId: null };
  return {
    status: "in_progress",
    reviewerAccountId: null,
    claimAccountId: task.completedByAccountId,
    claimAgentId: task.completedByAgentId ?? null,
    claimedAt: now,
    claimExpiresAt: task.completedByAgentId ? new Date(now.getTime() + AGENT_CLAIM_MS) : null,
    completedAt: null,
    completedByAccountId: null,
    completedByAgentId: null,
    summary: null,
  };
}

/**
 * Status changes other than claim/finish/review.
 * @param {any} task @param {any} actor @param {Date} now
 * @param {"blocked" | "unblocked" | "dropped" | "restored" | "reopened"} change
 * @param {boolean} isListOwner
 * @returns {{ ok: true, patch: Record<string, unknown> } | { ok: false, code: string, why: string }}
 */
export function statusChange(task, actor, now, change, isListOwner) {
  if (!canWork(actor)) return { ok: false, code: "not_allowed", why: "You can't change tasks on this list." };
  const status = effectiveStatus(task, now);
  const holderOk = !hasLiveClaim(task, now) || isClaimant(task, actor) || (isListOwner && !actor.agentId);
  switch (change) {
    case "blocked":
      if (status !== "in_progress" && status !== "open") return { ok: false, code: "bad_status", why: `This task is ${statusLabel(status)}.` };
      if (!holderOk) return { ok: false, code: "already_claimed", why: "Only whoever is on it can mark it blocked." };
      return { ok: true, patch: { status: "blocked" } };
    case "unblocked":
      if (status !== "blocked") return { ok: false, code: "bad_status", why: "This task isn't blocked." };
      if (!holderOk) return { ok: false, code: "already_claimed", why: "Only whoever is on it can unblock it." };
      return { ok: true, patch: { status: hasLiveClaim(task, now) ? "in_progress" : "open" } };
    case "dropped":
    case "restored":
    case "reopened":
      // Taking a task off the list, or putting one back, is a person's call.
      if (actor.agentId) return { ok: false, code: "people_only", why: "Only a person can drop, restore or reopen a task." };
      if (change === "dropped") {
        if (!ACTIVE.includes(status)) return { ok: false, code: "bad_status", why: `This task is ${statusLabel(status)}.` };
        return { ok: true, patch: { ...NO_CLAIM, status: "dropped", reviewerAccountId: null } };
      }
      if (change === "restored") {
        if (status !== "dropped") return { ok: false, code: "bad_status", why: "This task isn't dropped." };
        return { ok: true, patch: { status: "open" } };
      }
      if (status !== "done") return { ok: false, code: "bad_status", why: "This task isn't done." };
      return { ok: true, patch: { ...NO_CLAIM, status: "open", completedAt: null, completedByAccountId: null, completedByAgentId: null, summary: null } };
    default:
      return { ok: false, code: "bad_change", why: "Unknown status change." };
  }
}

/** @param {string} status */
export function statusLabel(status) {
  return (
    {
      open: "open",
      in_progress: "being worked on",
      blocked: "blocked",
      needs_review: "waiting for a check",
      done: "done",
      dropped: "dropped",
    }[status] ?? status
  );
}

/** Where a new task goes: after everything else. @param {number | null | undefined} maxPosition */
export function nextPosition(maxPosition) {
  return (typeof maxPosition === "number" && Number.isFinite(maxPosition) ? maxPosition : 0) + 1024;
}

// ── Activity phrases ────────────────────────────────────────────────────────
// Fixed wording for automatic activity lines. Shown as "<who> <phrase>".
export const EVENT_PHRASES = Object.freeze({
  created: "added this task",
  claimed: "picked this up",
  released: "let go of this",
  lapsed: "stopped working on this (no word for an hour)",
  blocked: "marked this blocked",
  unblocked: "unblocked this",
  done: "finished this",
  needs_review: "finished this and it's ready for a look",
  accepted: "checked it: looks good",
  sent_back: "sent this back",
  reopened: "reopened this",
  dropped: "dropped this",
  restored: "restored this",
  assigned: "changed who this is for",
  edited: "edited this",
});

// ── Views ───────────────────────────────────────────────────────────────────

/**
 * @typedef {{ accounts: Map<string, { handle: string, displayName?: string | null }>, agents: Map<string, { name: string, accountId: string, runtimeType?: string | null }> }} Names
 */

/**
 * A person, or an agent and its person, as the caller should see them.
 * @param {Names} names @param {string | null | undefined} accountId @param {string | null | undefined} agentId @param {any} actor
 */
export function who(names, accountId, agentId, actor) {
  if (!accountId) return null;
  const acct = names.accounts.get(accountId);
  const agent = agentId ? names.agents.get(agentId) : null;
  const ref = {
    person: acct?.displayName || acct?.handle || "a former member",
    handle: acct?.handle ?? null,
    agent: agentId ? agent?.name ?? "a removed agent" : null,
    agent_id: agentId ?? null,
    is_you: !!actor && actor.accountId === accountId,
  };
  if (actor?.agentId) ref.is_this_agent = !!agentId && agentId === actor.agentId;
  return ref;
}
/** "Skylar's Claude Code", or just "Skylar". @param {ReturnType<typeof who>} ref */
export function whoLabel(ref) {
  if (!ref) return "Nobody";
  return ref.agent ? `${ref.person}'s ${ref.agent}` : ref.person;
}

const iso = (d) => (d ? new Date(d).toISOString() : null);

/**
 * One task as an agent or the web app receives it. Every field an agent needs
 * to act safely is here: who wrote it, who it's for, who holds it, and whether
 * this agent may act on it.
 * @param {any} task
 * `lines`, when given, is the task's latest progress entry and latest "blocked" event, so a list
 * can show what an agent is doing without one request per task.
 * @param {{ actor: any, names: Names, list: { id: string, name: string, shared: boolean }, mayAct: { ok: boolean, why: string }, now: Date, lines?: { progress?: any, blocked?: any } }} ctx
 */
export function taskView(task, { actor, names, list, mayAct, now, lines }) {
  const status = effectiveStatus(task, now);
  const live = hasLiveClaim(task, now);
  const assignee = task.assigneeAgentId
    ? { kind: "agent", ...who(names, task.assigneeAccountId, task.assigneeAgentId, actor) }
    : task.assigneeAccountId
      ? { kind: task.assigneeAgents ? "their_agents" : "person", ...who(names, task.assigneeAccountId, null, actor) }
      : null;
  const view = {
    id: task.id,
    list,
    title: task.title,
    notes: task.notes ?? "",
    version: task.version,
    status,
    due: iso(task.dueAt),
    created_by: who(names, task.createdByAccountId, task.createdByAgentId, actor),
    assignee,
    claim: live
      ? { by: who(names, task.claimAccountId, task.claimAgentId, actor), since: iso(task.claimedAt), lapses_at: iso(task.claimExpiresAt) }
      : null,
    agent_may_act: mayAct,
    created_at: iso(task.createdAt),
    updated_at: iso(task.updatedAt),
  };
  if (live && !task.claimAgentId && ms(task.claimedAt) + STALE_PERSON_CLAIM_MS < now.getTime() && ms(task.updatedAt) + STALE_PERSON_CLAIM_MS < now.getTime()) {
    view.claim.stale = true;
  }
  if (task.completedAt) {
    view.completed_at = iso(task.completedAt);
    view.completed_by = who(names, task.completedByAccountId, task.completedByAgentId, actor);
    if (task.summary) view.summary = task.summary;
  }
  if (lines) {
    const p = lines.progress;
    view.last_progress = p ? { text: p.body, by: who(names, p.authorAccountId, p.authorAgentId, actor), at: iso(p.createdAt) } : null;
    if (status === "blocked") view.blocked_reason = lines.blocked ? blockedReason(lines.blocked.body) : null;
  }
  if (status === "needs_review") view.needs_review_by = who(names, task.reviewerAccountId, null, actor);
  if (status === "done" && task.completedByAgentId && task.completedAt) {
    const until = ms(task.completedAt) + SEND_BACK_MS;
    if (until > now.getTime()) view.send_back_until = new Date(until).toISOString();
  }
  return view;
}

/** The reason out of a "blocked" activity line ("marked this blocked: waiting on DNS" → "waiting on DNS"). @param {string} body */
export function blockedReason(body) {
  const prefix = `${EVENT_PHRASES.blocked}: `;
  return typeof body === "string" && body.startsWith(prefix) ? body.slice(prefix.length) : null;
}

/** @param {any} entry @param {{ actor: any, names: Names }} ctx */
export function entryView(entry, { actor, names }) {
  return {
    id: entry.id,
    kind: entry.kind,
    by: who(names, entry.authorAccountId, entry.authorAgentId, actor),
    ...(entry.eventType ? { event: entry.eventType } : {}),
    text: entry.body,
    at: iso(entry.createdAt),
  };
}

// ── My plate ────────────────────────────────────────────────────────────────

const dueOrder = (a, b) => {
  const da = a.dueAt ? ms(a.dueAt) : Infinity;
  const db = b.dueAt ? ms(b.dueAt) : Infinity;
  return da - db || (a.position ?? 0) - (b.position ?? 0) || ms(a.createdAt) - ms(b.createdAt);
};

/**
 * Sort the caller's visible tasks into what needs them. `canClaimFn` answers
 * claimCheck for the actor on a given task (the caller knows each list's
 * access and the OK rule).
 * @param {any[]} tasks raw rows the actor can see
 * @param {any} actor
 * @param {Date} now
 * @param {(t: any) => boolean} canClaimFn
 */
export function plateSections(tasks, actor, now, canClaimFn) {
  const doing = [];
  const upNext = [];
  const claimable = [];
  const waitingOnYou = [];
  const doneRecently = [];
  for (const t of tasks) {
    const status = effectiveStatus(t, now);
    const live = hasLiveClaim(t, now);
    if (status === "needs_review" && t.reviewerAccountId === actor.accountId) {
      waitingOnYou.push(t);
      continue;
    }
    if (live && t.claimAccountId === actor.accountId && (actor.agentId ? t.claimAgentId === actor.agentId : true)) {
      doing.push(t);
      continue;
    }
    if (status === "done" && !actor.agentId && t.completedByAgentId && t.completedByAccountId === actor.accountId && ms(t.completedAt) > now.getTime() - 24 * 60 * 60_000) {
      doneRecently.push(t);
      continue;
    }
    if (status !== "open" && status !== "blocked") continue;
    if (live) continue;
    const forMe = actor.agentId
      ? t.assigneeAgentId === actor.agentId || (t.assigneeAgents && !t.assigneeAgentId && t.assigneeAccountId === actor.accountId)
      : t.assigneeAccountId === actor.accountId && !t.assigneeAgents && !t.assigneeAgentId;
    if (forMe) {
      upNext.push(t);
      continue;
    }
    if (!t.assigneeAccountId && !t.assigneeAgentId && canClaimFn(t)) claimable.push(t);
  }
  doing.sort(dueOrder);
  upNext.sort(dueOrder);
  claimable.sort(dueOrder);
  waitingOnYou.sort((a, b) => ms(a.completedAt) - ms(b.completedAt));
  doneRecently.sort((a, b) => ms(b.completedAt) - ms(a.completedAt));
  return { doing, up_next: upNext, claimable: claimable.slice(0, 20), waiting_on_you: waitingOnYou, done_recently: doneRecently.slice(0, 20) };
}
