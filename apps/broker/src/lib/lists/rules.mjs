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
  membersPerList: 20,
  mentionsPerEntry: 10,
  /** Each of the plate's ok_requests and mentions, and a list's recent member activity. */
  plateExtras: 20,
});

/** Whose tasks a person's agents may take without an OK, per list. */
export const AGENTS_TAKE_FROM = Object.freeze(["me", "anyone"]);
/** Email nudges, per person per list: off, or mentions, reviews and OK requests. */
export const NOTIFY = Object.freeze(["off", "mentions_reviews"]);
/** How an OK was given: in the dashboard, by the person saying yes in chat, or by their list setting. */
export const OK_VIA = Object.freeze(["web", "user_in_chat", "list_setting"]);
/** The only reactions there are. */
export const REACTIONS = Object.freeze(["👍", "🎉", "🙏", "✅"]);
/** At most one email nudge per person per hour, across all their lists. */
export const NUDGE_EVERY_MS = 60 * 60_000;

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

const ASSIGNEE_HELP = "assignee must be nobody, me, my_agents, this_agent, one of your agents' ids, \"@handle\" or \"@handle's agents\"";
const HANDLE = /^@?([a-z0-9][a-z0-9._-]*(?:@bc)?)$/i;

/**
 * Who a task is for:
 *   "nobody"              anyone allowed may pick it up
 *   "me"                  the person (for an agent, that's its person)
 *   "my_agents"           any of the person's agents with work access
 *   "this_agent"          the calling agent
 *   an agent id           one of the caller's own agents
 *   "@alex"               a person on the list (Alex, or any of Alex's agents once Alex OKs it)
 *   "@alex's agents"      that person's agents; only Alex picks which one
 * "@alex/claude-code" (someone's specific agent) is refused: each person picks their own agents.
 * @param {unknown} value
 * @returns {undefined | { kind: "nobody" } | { kind: "me" } | { kind: "my_agents" } | { kind: "this_agent" } | { kind: "agent", agentId: string }
 *   | { kind: "person", handle: string } | { kind: "person_agents", handle: string }}
 */
export function parseAssignee(value) {
  if (value === undefined) return undefined;
  if (value === null) return { kind: "nobody" };
  if (typeof value !== "string") fail(400, "invalid_assignee", ASSIGNEE_HELP);
  const v = value.trim();
  const lower = v.toLowerCase();
  if (lower === "" || lower === "nobody" || lower === "none" || lower === "anyone") return { kind: "nobody" };
  if (lower === "me") return { kind: "me" };
  if (lower === "my_agents" || lower === "my agents") return { kind: "my_agents" };
  if (lower === "this_agent" || lower === "this agent") return { kind: "this_agent" };
  if (/^[0-9a-f-]{8,64}$/i.test(v)) return { kind: "agent", agentId: v };
  if (v.startsWith("@")) {
    const agents = /^(.+?)['’]s\s+agents$/i.exec(v);
    if (agents) {
      const h = HANDLE.exec(agents[1].trim());
      if (h) return { kind: "person_agents", handle: h[1] };
    }
    const slash = /^@([^/\s]+)\/\S+$/.exec(v);
    if (slash) {
      return fail(400, "invalid_assignee", `Give it to "@${slash[1]}" or "@${slash[1]}'s agents". Each person picks which of their own agents works on something; for one of yours, use its id.`);
    }
    const h = HANDLE.exec(v);
    if (h) return { kind: "person", handle: h[1] };
  }
  return fail(400, "invalid_assignee", ASSIGNEE_HELP);
}

/**
 * The handles an account might be stored under for what someone typed: "@Alex",
 * "alex" and "alex@bc" all find alex@bc. Empty when it can't be a handle.
 * @param {unknown} typed
 * @returns {string[]}
 */
export function handleCandidates(typed) {
  if (typeof typed !== "string") return [];
  const m = HANDLE.exec(typed.trim());
  if (!m) return [];
  const h = m[1];
  const lower = h.toLowerCase();
  const out = [h, lower];
  if (!/@bc$/i.test(h)) out.push(`${h}@bc`, `${lower}@bc`);
  return [...new Set(out)];
}

/**
 * Does this stored handle answer to what was typed? "alex", "@Alex" and "alex@bc" all match
 * alex@bc (and an older handle stored without "@bc").
 * @param {string} handle @param {string} typed
 */
export function handleMatches(handle, typed) {
  if (!handle || !handleCandidates(typed).length) return false;
  const bare = (h) => String(h).trim().toLowerCase().replace(/^@/, "").replace(/@bc$/, "");
  return bare(handle) === bare(typed);
}

/**
 * How an agent is mentioned: "Claude Code" is @claude-code, "Alex's Codex" is @alexs-codex.
 * Kept in step with agentSlug in src/app/account/lists/quick-add.mjs.
 * @param {string} name
 */
export function agentSlug(name) {
  return String(name)
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

// ── Sharing: membership follows friendship ───────────────────────────────────

/**
 * Friends are mutual trust: both directed TrustedPeer rows exist. `edges` holds
 * them as "from>to". Revoking is one-sided, so one missing row ends it.
 * @param {Set<string>} edges @param {string} a @param {string} b
 */
export function mutualFriends(edges, a, b) {
  return a !== b && edges.has(`${a}>${b}`) && edges.has(`${b}>${a}`);
}

/**
 * Does this membership row still count? The owner always does. Anyone else only
 * while they and the owner are still friends: fail closed, so a revoked friend and
 * their agents lose the list on their very next request, cleanup or not.
 * @param {{ accountId: string, role: string }} member @param {string} ownerAccountId @param {Set<string>} edges
 */
export function memberCounts(member, ownerAccountId, edges) {
  if (!member) return false;
  if (member.role === "owner") return member.accountId === ownerAccountId;
  return mutualFriends(edges, member.accountId, ownerAccountId);
}

/**
 * Taking someone off a list, or leaving it. Cookie-only checks happen in the caller.
 * @param {any} actor the person asking @param {string} targetAccountId @param {string | null} targetRole
 * @returns {{ ok: true, how: "left" | "removed" } | { ok: false, status: number, code: string, why: string }}
 */
export function removalCheck(actor, targetAccountId, targetRole) {
  if (actor.agentId) return { ok: false, status: 403, code: "people_only", why: "Only a person, in the Back Channel dashboard, can change who is on a list." };
  if (targetAccountId === actor.accountId) {
    if (actor.role === "owner") return { ok: false, status: 409, code: "owner_cant_leave", why: "You own this list, so you can't leave it. Archive it instead." };
    return { ok: true, how: "left" };
  }
  if (!canManage(actor)) return { ok: false, status: 403, code: "not_allowed", why: "Only the list's owner can take people off it." };
  if (!targetRole) return { ok: false, status: 404, code: "not_a_member", why: "Nobody by that handle is on this list." };
  return { ok: true, how: "removed" };
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

/**
 * Can this person OK a task for their own agents now, and is there anything to record?
 * An OK is per person: it only ever lets the OK-giver's own agents act.
 * @param {any} task @param {any} actor @param {Date} now @param {boolean} alreadyOk this person already OK'd it
 * @returns {{ ok: true, needed: boolean } | { ok: false, code: string, why: string }}
 */
export function okCheck(task, actor, now, alreadyOk) {
  if (!canView(actor)) return { ok: false, code: "not_allowed", why: "You can't see this task." };
  const status = effectiveStatus(task, now);
  if (status !== "open" && status !== "in_progress" && status !== "blocked") {
    return { ok: false, code: "bad_status", why: `This task is ${statusLabel(status)}, so there's nothing to OK.` };
  }
  return { ok: true, needed: task.createdByAccountId !== actor.accountId && !alreadyOk };
}

/** The activity line for an OK. @param {"web" | "user_in_chat" | "list_setting"} via @param {string | null} [agentName] */
export function okLine(via, agentName) {
  return via === "user_in_chat" ? `${EVENT_PHRASES.ok} (via ${agentName || "an agent"})` : EVENT_PHRASES.ok;
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
  ok: "OK'd this for their agents",
  member_left: "left the list",
});

/**
 * The line on a task when the person holding it, or the person it was for, is no longer on the list.
 * Their past work stays attributed to them; only what was in flight is let go.
 * @param {string} title @param {"left" | "removed"} how @param {boolean} released they (or their agent) held it
 */
export function memberLeftLine(title, how, released) {
  const t = `"${String(title).slice(0, 200)}"`;
  const who = how === "left" ? "left the list" : "was taken off the list";
  return released ? `${who} and released ${t}` : `${who}, so ${t} is for anyone again`;
}

/** List-level activity: who joined, left or was taken off. Shown as "<text>". */
export const LIST_EVENTS = Object.freeze(["member_added", "member_left", "member_removed"]);

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
 * `reactions` are the task's reaction rows; the view carries counts and whether the caller reacted.
 * @param {{ actor: any, names: Names, list: { id: string, name: string, shared: boolean }, mayAct: { ok: boolean, why: string }, now: Date, lines?: { progress?: any, blocked?: any }, reactions?: any[] }} ctx
 */
export function taskView(task, { actor, names, list, mayAct, now, lines, reactions }) {
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
    reactions: reactionSummary(reactions ?? [], actor),
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

// ── Reactions ───────────────────────────────────────────────────────────────

/**
 * One of the four reactions, or a 400. A trailing variation selector (what many
 * keyboards add) is ignored.
 * @param {unknown} value
 */
export function cleanEmoji(value) {
  const v = typeof value === "string" ? value.trim().replace(/️/g, "") : "";
  if (!REACTIONS.includes(v)) fail(400, "invalid_emoji", `emoji must be one of ${REACTIONS.join(" ")}`);
  return v;
}

/**
 * Counts per reaction, in the fixed order, and whether the caller (this person,
 * or this agent) reacted. Reactions nobody gave are left out.
 * @param {Array<{ accountId: string, agentId?: string | null, emoji: string }>} rows @param {any} actor
 */
export function reactionSummary(rows, actor) {
  return REACTIONS.map((emoji) => {
    const mine = rows.filter((r) => r.emoji === emoji);
    return {
      emoji,
      count: mine.length,
      you: !!actor && mine.some((r) => r.accountId === actor.accountId && (r.agentId ?? null) === (actor.agentId ?? null)),
    };
  }).filter((r) => r.count > 0);
}

// ── Mentions ────────────────────────────────────────────────────────────────

// "@alex", "@alex@bc", "@claude-code", "@alex/claude-code". Not inside an email address or a path.
const MENTION = /(^|[^A-Za-z0-9._@\/-])@([A-Za-z0-9][A-Za-z0-9._-]*(?:@bc)?)(?:\/([A-Za-z0-9][A-Za-z0-9._'’-]*))?/g;

/**
 * Who a comment or progress line mentions. People are the list's members, by
 * handle (@alex). Agents are members' agents with access to this list, by name
 * (@claude-code for "Claude Code"), or qualified by their person
 * (@alex/claude-code) when more than one agent answers to that name. An
 * unqualified agent name prefers the writer's own agent; one that still matches
 * several agents mentions none of them. Unknown names are ordinary text. Nobody
 * is mentioned by their own words.
 * @param {string} text
 * @param {{ people: Array<{ accountId: string, handle: string }>, agents: Array<{ id: string, accountId: string, name: string }>, author: { accountId: string, agentId: string | null } }} ctx
 * @returns {Array<{ accountId: string, agentId: string | null }>}
 */
export function parseMentions(text, { people, agents, author }) {
  const found = new Map();
  if (typeof text !== "string" || !text.includes("@")) return [];
  const add = (accountId, agentId) => {
    if (accountId === author.accountId && (agentId ?? null) === (author.agentId ?? null)) return;
    const key = `${accountId}|${agentId ?? ""}`;
    if (!found.has(key) && found.size < LIMITS.mentionsPerEntry) found.set(key, { accountId, agentId: agentId ?? null });
  };
  const trim = (s) => s.replace(/[._-]+$/, "");
  for (const m of text.matchAll(MENTION)) {
    const token = trim(m[2]);
    const sub = m[3] ? trim(m[3]) : null;
    const person = people.find((p) => handleMatches(p.handle, token));
    if (sub) {
      if (!person) continue;
      const slug = agentSlug(sub);
      const hits = agents.filter((a) => a.accountId === person.accountId && agentSlug(a.name) === slug);
      if (hits.length === 1) add(person.accountId, hits[0].id);
      continue;
    }
    if (person) {
      add(person.accountId, null);
      continue;
    }
    const slug = agentSlug(token);
    if (!slug) continue;
    const hits = agents.filter((a) => agentSlug(a.name) === slug);
    const own = hits.filter((a) => a.accountId === author.accountId);
    const chosen = own.length ? own : hits;
    if (chosen.length === 1) add(chosen[0].accountId, chosen[0].id);
  }
  return [...found.values()];
}

// ── Members and list activity ───────────────────────────────────────────────

/**
 * One person on a list, as everyone on it sees them. `agents` are that person's
 * agents with access to this list, with the mention that reaches each.
 * @param {{ accountId: string, role: string, joinedAt: Date }} member @param {Names} names @param {any} actor
 * @param {Array<{ id: string, name: string, access: string }>} [agents]
 */
export function memberView(member, names, actor, agents = []) {
  const acct = names.accounts.get(member.accountId);
  const handle = acct?.handle ?? null;
  return {
    handle,
    display_name: acct?.displayName ?? null,
    role: member.role,
    joined_at: iso(member.joinedAt),
    is_you: !!actor && actor.accountId === member.accountId,
    mention: handle ? `@${handle.replace(/@bc$/, "")}` : null,
    agents: agents.map((a) => ({ name: a.name, access: a.access, mention: `@${agentSlug(a.name)}` })),
  };
}

/**
 * A list-level activity line ("Skylar added Alex", "Alex left the list").
 * @param {{ id: string, eventType: string, actorAccountId: string, subjectAccountId: string, createdAt: Date }} event
 * @param {{ actor: any, names: Names }} ctx
 */
export function listEventView(event, { actor, names }) {
  const by = who(names, event.actorAccountId, null, actor);
  const subject = who(names, event.subjectAccountId, null, actor);
  const name = (ref) => (ref?.is_you ? "you" : ref?.person ?? "someone");
  const text =
    event.eventType === "member_added" ? `added ${name(subject)}`
      : event.eventType === "member_left" ? "left the list"
        : `took ${name(subject)} off the list`;
  return { id: event.id, event: event.eventType, by, subject, text, at: iso(event.createdAt) };
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

/**
 * "OK for my agents?": tasks someone else wrote that this person's agents could
 * take but can't act on yet. That is a task for the person or their agents, or an
 * unassigned one on a list where their agents have work access, that's open (or
 * blocked) and unheld, with no OK and no list setting covering it. For an agent
 * asking, only what that agent itself could take once its person says yes.
 * @param {any[]} tasks rows the actor can see
 * @param {any} actor
 * @param {Date} now
 * @param {{ mayAct: (t: any) => { ok: boolean }, agentsCanWork: (listId: string) => boolean }} fns
 */
export function okRequests(tasks, actor, now, { mayAct, agentsCanWork }) {
  const out = [];
  for (const t of tasks) {
    if (t.createdByAccountId === actor.accountId) continue;
    const status = effectiveStatus(t, now);
    if ((status !== "open" && status !== "blocked") || hasLiveClaim(t, now)) continue;
    if (t.assigneeAccountId && t.assigneeAccountId !== actor.accountId) continue;
    if (actor.agentId && t.assigneeAgentId && t.assigneeAgentId !== actor.agentId) continue;
    if ((!t.assigneeAccountId || actor.agentId) && !agentsCanWork(t.listId)) continue;
    if (mayAct(t).ok) continue;
    out.push(t);
  }
  return out.sort(dueOrder).slice(0, LIMITS.plateExtras);
}

/**
 * May this person get an email nudge now? At most one an hour, across every list.
 * @param {number | undefined} lastSentMs @param {number} nowMs
 */
export function nudgeDue(lastSentMs, nowMs) {
  return lastSentMs === undefined || nowMs - lastSentMs >= NUDGE_EVERY_MS;
}
