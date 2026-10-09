/**
 * Lists: task lists for people and their agents (docs/lists.md).
 *
 * The I/O half. Every decision (who may do what, claims, lapses, the OK rule,
 * mentions, what a task looks like to an agent) lives in lists/rules.mjs, which
 * has no database and is covered by `node --test`. This file authenticates,
 * loads rows, asks the rules, writes, and shapes responses.
 *
 * Callers:
 *  - REST: src/app/api/lists/[[...path]]/route.ts → listsRoute()
 *  - MCP:  src/app/api/mcp/route.ts → listsTool() for the bc_task* tools
 *  - Trust: src/app/api/trust/[handle]/route.ts → endListSharing() when a friend is untrusted
 *
 * Auth: an agent key (full or connector: lists are for every host, including
 * claude.ai and ChatGPT over OAuth) or the dashboard cookie with CSRF on
 * writes. Deciding which of a person's agents may work a list, who is on a
 * list, and OKing a task in the dashboard are cookie-only: trust is a human
 * act, and no tool lets an agent widen its own access.
 *
 * Sharing (Phase 2): a list's members are its owner and friends the owner
 * added. A member other than the owner counts only while they and the owner
 * are still mutual friends, checked on every request, so a revoked friend and
 * their agents fail closed on their very next call whether or not the cleanup
 * in endListSharing() ran.
 *
 * List content is stored readable on purpose (decision 2026-10-09). Secret-
 * shaped text is refused by the rules before anything is written.
 *
 * Phase 3: every write tells the people who can see the list that something
 * changed (lists/bus.mjs, behind GET /api/lists/stream), after commit and with
 * no content. Lists can start from a template (built in, or one the person
 * saved) or as a copy of another list. digestFor() gathers what the opt-in
 * daily digest says (src/lib/lists-digest.ts sends it).
 */
import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
// Namespace imports on purpose: route tests replace @/lib/auth and @/lib/email
// wholesale with a few named exports, and a named import of anything they left
// out would fail at link time for every module that loads this one.
import * as auth from "@/lib/auth";
import * as email from "@/lib/email";
import { rateLimit } from "@/lib/rate-limit";
import { isSerializationFailure, withSerializableRetry } from "@/lib/serializable";
import { fireInboxEvent } from "@/lib/inbox-bus";
import * as R from "@/lib/lists/rules.mjs";
import * as listsBus from "@/lib/lists/bus.mjs";
import * as T from "@/lib/lists/templates.mjs";
import * as D from "@/lib/lists/digest.mjs";

type Tx = Prisma.TransactionClient;
type Input = Record<string, unknown>;
type Caller = { accountId: string; agentId: string | null; viaCookie: boolean };
type Actor = { accountId: string; agentId: string | null; role: string | null; agentAccess: string | null };
type Names = { accounts: Map<string, { handle: string; displayName?: string | null }>; agents: Map<string, { name: string; accountId: string; runtimeType?: string | null }> };
// Rows are typed loosely on purpose: the rules module is plain JS and owns their meaning.
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
/** The caller's place on one list. `members` are the members who still count (see standing()). */
type Standing = { list: Row; member: Row; actor: Actor; shared: boolean; members: Row[] };

export type ListsOp =
  | "lists" | "createList" | "getList" | "updateList" | "setAgentAccess" | "plate" | "search" | "changes"
  | "tasks" | "addTasks" | "getTask" | "updateTask" | "claim" | "release" | "done" | "review" | "entries" | "addEntry"
  | "addMember" | "removeMember" | "updateMe" | "ok" | "react"
  | "templates" | "saveTemplate" | "deleteTemplate" | "preferences" | "updatePreferences";

const WRITES = new Set<ListsOp>([
  "createList", "updateList", "setAgentAccess", "addTasks", "updateTask", "claim", "release", "done", "review", "addEntry",
  "addMember", "removeMember", "updateMe", "ok", "react", "saveTemplate", "deleteTemplate", "updatePreferences",
]);
const DAY = 24 * 60 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fail = (status: number, code: string, message: string, extra?: Record<string, unknown>): never => {
  throw new R.ListRuleError(status, code, message, extra);
};
const NOT_AVAILABLE = () => fail(404, "not_available", "That list or task isn't available.");
const respond = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
// A rule refusal about WHO is asking is 403; one about the task's state (held, wrong status, too late) is 409.
const PERMISSION_REFUSALS = new Set(["not_allowed", "people_only", "not_reviewer", "not_claimant"]);
const refusalStatus = (code: string) => (PERMISSION_REFUSALS.has(code) ? 403 : 409);
const conflict = (e: unknown) => isSerializationFailure(e) || (!!e && typeof e === "object" && "code" in e && (e as { code?: unknown }).code === "P2002");
const peopleOnly = (what: string) => fail(403, "people_only", `Only a person, in the Back Channel dashboard, can ${what}.`);

// ── auth ────────────────────────────────────────────────────────────────────

async function resolveCaller(req: NextRequest): Promise<Caller> {
  const authorization = req.headers.get("authorization");
  if (authorization) {
    const ctx = await auth.getAuthContext(authorization);
    if (!ctx) return fail(401, "unauthorized", "Unauthorized");
    // Fail closed: a bearer key must be a specific agent. Treating one with no
    // agent identity as the person would hand it people-only powers (review,
    // deciding which agents work a list).
    if (!ctx.agentTokenId) return fail(401, "agent_key_required", "Lists need a per-agent key. Connect this agent from the Back Channel dashboard.");
    return { accountId: ctx.account.id, agentId: ctx.agentTokenId, viaCookie: false };
  }
  const account = await auth.getAccountFromCookie(req.cookies.get(auth.SESSION_COOKIE_NAME)?.value);
  if (!account) return fail(401, "unauthorized", "Unauthorized");
  if (req.method !== "GET" && !auth.csrfValid(req.headers.get(auth.CSRF_HEADER), req.cookies.get(auth.CSRF_COOKIE_NAME)?.value)) {
    return fail(403, "csrf", "Refresh the page and try again.");
  }
  return { accountId: account.id, agentId: null, viaCookie: true };
}

// ── friendship and membership ───────────────────────────────────────────────

/** Directed trust rows among these accounts, as "from>to". */
async function trustEdges(tx: Tx, accountIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(accountIds)];
  if (ids.length < 2) return new Set();
  const rows = await tx.trustedPeer.findMany({
    where: { accountId: { in: ids }, trustedAccountId: { in: ids } },
    select: { accountId: true, trustedAccountId: true },
  });
  return new Set((rows as Row[]).map((r) => `${r.accountId}>${r.trustedAccountId}`));
}

/** Each list's members who still count: the owner, and members still mutual friends with the owner. */
async function liveMembers(tx: Tx, lists: Row[]): Promise<Map<string, Row[]>> {
  const out = new Map<string, Row[]>(lists.map((l) => [l.id as string, []]));
  if (!lists.length) return out;
  const rows = (await tx.taskListMember.findMany({ where: { listId: { in: lists.map((l) => l.id) } } })) as Row[];
  const owner = new Map(lists.map((l) => [l.id as string, l.ownerAccountId as string]));
  const edges = rows.some((m) => m.role !== "owner") ? await trustEdges(tx, [...rows.map((m) => m.accountId), ...owner.values()]) : new Set<string>();
  for (const m of rows) if (R.memberCounts(m as never, owner.get(m.listId)!, edges)) out.get(m.listId)!.push(m);
  return out;
}

/** The caller's standing on one list, or null when they can't see it (never says which). */
async function standing(tx: Tx, caller: Caller, listId: string): Promise<Standing | null> {
  if (!UUID.test(listId)) return null;
  const list = (await tx.taskList.findFirst({ where: { id: listId } })) as Row | null;
  if (!list) return null;
  const members = (await liveMembers(tx, [list])).get(list.id)!;
  const member = members.find((m) => m.accountId === caller.accountId);
  if (!member) return null;
  let agentAccess: string | null = null;
  if (caller.agentId) {
    const grant = await tx.taskListAgentGrant.findFirst({ where: { listId, agentTokenId: caller.agentId, accountId: caller.accountId } });
    agentAccess = grant?.access ?? null;
  }
  const actor: Actor = { accountId: caller.accountId, agentId: caller.agentId, role: member.role, agentAccess };
  if (!R.canView(actor)) return null;
  return { list, member, actor, shared: members.length > 1, members };
}

/**
 * Every list this caller can see. A person: their memberships that still count.
 * An agent: those its person granted it.
 */
async function visibleListIds(tx: Tx, caller: { accountId: string; agentId: string | null }, { includeArchived = false } = {}): Promise<string[]> {
  const memberships = (await tx.taskListMember.findMany({ where: { accountId: caller.accountId }, select: { listId: true, role: true } })) as Row[];
  let ids = memberships.map((m) => m.listId as string);
  if (caller.agentId) {
    const grants = await tx.taskListAgentGrant.findMany({ where: { agentTokenId: caller.agentId, accountId: caller.accountId }, select: { listId: true } });
    const granted = new Set(grants.map((g: Row) => g.listId as string));
    ids = ids.filter((id) => granted.has(id));
  }
  if (!ids.length) return ids;
  const lists = (await tx.taskList.findMany({
    where: { id: { in: ids }, ...(includeArchived ? {} : { archivedAt: null }) },
    select: { id: true, ownerAccountId: true },
  })) as Row[];
  const owners = lists.map((l) => l.ownerAccountId as string).filter((o) => o !== caller.accountId);
  const edges = owners.length ? await trustEdges(tx, [caller.accountId, ...owners]) : new Set<string>();
  const role = new Map(memberships.map((m) => [m.listId as string, m.role as string]));
  return lists.filter((l) => R.memberCounts({ accountId: caller.accountId, role: role.get(l.id)! }, l.ownerAccountId, edges)).map((l) => l.id as string);
}

/** A member of this list by handle ("alex", "@alex", "alex@bc"), or null. */
async function memberByHandle(tx: Tx, s: Standing, typed: string): Promise<Row | null> {
  const accounts = (await tx.account.findMany({ where: { id: { in: s.members.map((m) => m.accountId) } }, select: { id: true, handle: true } })) as Row[];
  const hit = accounts.find((a) => R.handleMatches(a.handle, typed));
  return hit ? s.members.find((m) => m.accountId === hit.id) ?? null : null;
}

/** Any account by handle, preferring an exact match over the "@bc" form. */
async function accountByHandle(tx: Tx, typed: unknown): Promise<Row | null> {
  const candidates = R.handleCandidates(typed);
  if (!candidates.length) return null;
  const found = (await tx.account.findMany({ where: { handle: { in: candidates } }, select: { id: true, handle: true } })) as Row[];
  for (const c of candidates) {
    const hit = found.find((a) => a.handle === c);
    if (hit) return hit;
  }
  return null;
}

// ── names and views ─────────────────────────────────────────────────────────

const ACCOUNT_KEYS = ["createdByAccountId", "assigneeAccountId", "claimAccountId", "reviewerAccountId", "completedByAccountId", "authorAccountId", "accountId", "actorAccountId", "subjectAccountId"];
const AGENT_KEYS = ["createdByAgentId", "assigneeAgentId", "claimAgentId", "completedByAgentId", "authorAgentId", "agentId"];

async function loadNames(tx: Tx, rows: Row[]): Promise<Names> {
  const accountIds = new Set<string>();
  const agentIds = new Set<string>();
  for (const r of rows) {
    for (const k of ACCOUNT_KEYS) if (r[k]) accountIds.add(r[k]);
    for (const k of AGENT_KEYS) if (r[k]) agentIds.add(r[k]);
  }
  const [accounts, agents] = await Promise.all([
    accountIds.size ? tx.account.findMany({ where: { id: { in: [...accountIds] } }, select: { id: true, handle: true, displayName: true } }) : [],
    agentIds.size ? tx.agentToken.findMany({ where: { id: { in: [...agentIds] } }, select: { id: true, name: true, accountId: true, runtimeType: true } }) : [],
  ]);
  return {
    accounts: new Map(accounts.map((a: Row) => [a.id, { handle: a.handle, displayName: a.displayName }])),
    agents: new Map(agents.map((a: Row) => [a.id, { name: a.name ?? "agent", accountId: a.accountId, runtimeType: a.runtimeType }])),
  };
}

type ListRef = { id: string; name: string; shared: boolean };
type Lines = Map<string, { progress?: Row; blocked?: Row }>;
/** What a set of task views needs besides the tasks: names, the caller's own OKs (task id → via), reactions, and optionally the latest lines. */
type Lens = { names: Names; oks: Map<string, string>; reactions: Map<string, Row[]>; lines?: Lines };

async function lensFor(tx: Tx, caller: Caller, tasks: Row[], { lines = false, extra = [] as Row[] } = {}): Promise<Lens> {
  const ids = [...new Set(tasks.map((t) => t.id as string))];
  const latest = lines ? await latestLines(tx, tasks) : null;
  const [names, oks, reactions] = await Promise.all([
    loadNames(tx, [...tasks, ...extra, ...(latest?.authors ?? [])]),
    ids.length ? tx.taskAgentOk.findMany({ where: { taskId: { in: ids }, accountId: caller.accountId }, select: { taskId: true, via: true } }) : [],
    ids.length ? tx.taskReaction.findMany({ where: { taskId: { in: ids } }, select: { taskId: true, accountId: true, agentId: true, emoji: true } }) : [],
  ]);
  const byTask = new Map<string, Row[]>();
  for (const r of reactions as Row[]) byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r]);
  return { names, oks: new Map((oks as Row[]).map((o) => [o.taskId as string, o.via as string])), reactions: byTask, ...(latest ? { lines: latest.lines } : {}) };
}

/** The OK rule for this account on this task. `oks` holds only the caller's own OKs: an OK never covers anyone else's agents. */
function mayActFor(task: Row, accountId: string, member: Row | null, lens: Pick<Lens, "names" | "oks">) {
  const author = lens.names.accounts.get(task.createdByAccountId);
  const via = lens.oks.get(task.id);
  const mayAct = R.agentMayAct(task as never, accountId, {
    agentsTakeFrom: member?.agentsTakeFrom ?? "me",
    okAccountIds: via ? [accountId] : [],
    authorName: author?.displayName || author?.handle || "Someone else",
  });
  // An OK recorded because the person's list setting allowed it reads as that, not as "you OK'd it".
  if (mayAct.ok && via === "list_setting" && task.createdByAccountId !== accountId && member?.agentsTakeFrom !== "anyone") {
    return { ok: true, why: "your agents took it on under your list setting" };
  }
  return mayAct;
}

function holderLabel(names: Names, actor: Actor) {
  return (t: Row) => R.whoLabel(R.who(names as never, t.claimAccountId, t.claimAgentId, actor));
}

function viewOf(task: Row, ctx: { actor: Actor; lens: Lens; list: ListRef; member: Row | null; now: Date }) {
  const { lens } = ctx;
  return R.taskView(task, {
    actor: ctx.actor, names: lens.names as never, list: ctx.list, mayAct: mayActFor(task, ctx.actor.accountId, ctx.member, lens), now: ctx.now,
    reactions: lens.reactions.get(task.id) ?? [],
    ...(lens.lines ? { lines: lens.lines.get(task.id) ?? {} } : {}),
  });
}

/** The latest progress line and "blocked" event of every task being worked, in one query, so a page never fetches per task. */
async function latestLines(tx: Tx, tasks: Row[]): Promise<{ lines: Lines; authors: Row[] }> {
  const ids = tasks.filter((t) => t.status === "in_progress" || t.status === "blocked").map((t) => t.id);
  const lines: Lines = new Map();
  if (!ids.length) return { lines, authors: [] };
  const rows = (await tx.taskEntry.findMany({
    where: { taskId: { in: ids }, OR: [{ kind: "progress" }, { kind: "event", eventType: "blocked" }] },
    orderBy: { createdAt: "desc" },
    take: 500,
  })) as Row[];
  for (const e of rows) {
    const cur = lines.get(e.taskId) ?? {};
    if (e.kind === "progress" && !cur.progress) cur.progress = e;
    if (e.kind === "event" && !cur.blocked) cur.blocked = e;
    lines.set(e.taskId, cur);
  }
  return { lines, authors: [...lines.values()].flatMap((l) => [l.progress, l.blocked]).filter(Boolean) as Row[] };
}

// ── writes shared by every operation ───────────────────────────────────────

async function addEvent(tx: Tx, taskId: string, by: { accountId: string; agentId: string | null }, eventType: keyof typeof R.EVENT_PHRASES, detail?: string) {
  const phrase = R.EVENT_PHRASES[eventType];
  const body = detail ? `${phrase}: ${detail.slice(0, 1_000)}` : phrase;
  await tx.taskEntry.create({ data: { taskId, kind: "event", eventType, authorAccountId: by.accountId, authorAgentId: by.agentId, body } });
}
async function addEventLine(tx: Tx, taskId: string, by: { accountId: string; agentId: string | null }, eventType: keyof typeof R.EVENT_PHRASES, body: string) {
  await tx.taskEntry.create({ data: { taskId, kind: "event", eventType, authorAccountId: by.accountId, authorAgentId: by.agentId, body } });
}

/**
 * An agent claim that ran out is released here, in the same transaction as
 * whatever touched the task, with an activity line saying so. Never silent.
 * `touched` collects the list, so open pages hear that the task changed.
 */
async function settleLapse(tx: Tx, task: Row, now: Date, touched?: Set<string>): Promise<Row> {
  if (!R.claimLapsed(task, now)) return task;
  const released = await tx.taskItem.updateMany({
    where: { id: task.id, claimAgentId: task.claimAgentId, claimExpiresAt: { lte: now } },
    data: R.releasePatch(task),
  });
  if (released.count !== 1) return (await tx.taskItem.findFirst({ where: { id: task.id } })) as Row;
  const last = await tx.taskEntry.findFirst({ where: { taskId: task.id, kind: "progress", authorAgentId: task.claimAgentId }, orderBy: { createdAt: "desc" } });
  await addEvent(tx, task.id, { accountId: task.claimAccountId, agentId: task.claimAgentId }, "lapsed", last ? `last progress was "${String(last.body).slice(0, 300)}"` : undefined);
  touched?.add(task.listId);
  return (await tx.taskItem.findFirst({ where: { id: task.id } })) as Row;
}

async function loadTask(tx: Tx, caller: Caller, taskId: unknown, now: Date, touched?: Set<string>) {
  if (typeof taskId !== "string" || !UUID.test(taskId)) return NOT_AVAILABLE();
  const found = await tx.taskItem.findFirst({ where: { id: taskId } });
  if (!found) return NOT_AVAILABLE();
  const s = await standing(tx, caller, found.listId);
  if (!s) return NOT_AVAILABLE();
  const task = await settleLapse(tx, found as Row, now, touched);
  return { ...s, task };
}

async function renewIfClaimant(tx: Tx, task: Row, actor: Actor, now: Date) {
  const patch = R.renewPatch(task, actor, now);
  if (patch) await tx.taskItem.updateMany({ where: { id: task.id, claimAgentId: actor.agentId }, data: patch });
}

/**
 * Resolve an assignee from the rules' vocabulary into columns. A specific agent must be the caller's
 * own, with work access here; "@alex" and "@alex's agents" must be on the list. Nobody picks someone
 * else's agent: "@alex's agents" leaves the choice to Alex.
 */
async function assigneeColumns(tx: Tx, caller: Caller, s: Standing, value: unknown) {
  const a = R.parseAssignee(value);
  if (!a) return undefined;
  const none = { assigneeAccountId: null, assigneeAgents: false, assigneeAgentId: null, agentSeenAt: null };
  switch (a.kind) {
    case "nobody": return none;
    case "me": return { ...none, assigneeAccountId: caller.accountId };
    case "my_agents": return { ...none, assigneeAccountId: caller.accountId, assigneeAgents: true };
    case "this_agent":
      if (!caller.agentId) return fail(400, "invalid_assignee", "this_agent only makes sense when an agent is calling. Use me or my_agents.");
      return { ...none, assigneeAccountId: caller.accountId, assigneeAgentId: caller.agentId };
    case "agent": {
      const agent = await tx.agentToken.findFirst({ where: { id: a.agentId, accountId: caller.accountId, revokedAt: null } });
      if (!agent) return fail(400, "invalid_assignee", "That isn't one of your connected agents.");
      const grant = await tx.taskListAgentGrant.findFirst({ where: { listId: s.list.id, agentTokenId: a.agentId, accountId: caller.accountId, access: "work" } });
      if (!grant) return fail(400, "invalid_assignee", `${agent.name ?? "That agent"} can't work on this list yet. Give it access in the list's settings first.`);
      return { ...none, assigneeAccountId: caller.accountId, assigneeAgentId: a.agentId };
    }
    case "person":
    case "person_agents": {
      const member = await memberByHandle(tx, s, a.handle);
      if (!member) return fail(400, "invalid_assignee", `Nobody called @${a.handle.replace(/@bc$/i, "")} is on this list.`);
      return { ...none, assigneeAccountId: member.accountId, assigneeAgents: a.kind === "person_agents" };
    }
  }
  return undefined;
}
const forAgents = (cols: Row | undefined) => !!cols && !!cols.assigneeAccountId && (cols.assigneeAgents || !!cols.assigneeAgentId);

function listRef(s: { list: Row; shared: boolean }): ListRef {
  return { id: s.list.id, name: s.list.name, shared: s.shared };
}
function writable(s: { list: Row }) {
  if (s.list.archivedAt) fail(409, "archived", "This list is archived. Unarchive it to make changes.");
}

// ── OKs, mentions, nudges ───────────────────────────────────────────────────

/**
 * `after` runs once the transaction commits; `rung` and `nudged` keep that to one doorbell and one email per person per request.
 * `touched` (list ids) and `audience` (account ids) say who hears `changed` on the live stream after commit.
 */
type Ctx = {
  tx: Tx; caller: Caller; input: Input; now: Date; after: Array<() => void>; rung: Set<string>; nudged: Set<string>;
  touched: Set<string>; audience: Set<string>;
};

/** Something on this list changed: everyone who can see it hears so after commit (see announce()). */
function touch(ctx: Ctx, listId: string) {
  ctx.touched.add(listId);
}

/**
 * Queue a `changed` on the live stream, after commit, for everyone who can see
 * a touched list (its members who still count) and anyone added to `audience`
 * by hand (a person who just left, or whose own settings changed). Metadata
 * only: the stream never says what changed.
 */
async function announce(ctx: Ctx) {
  if (ctx.touched.size) {
    const lists = (await ctx.tx.taskList.findMany({ where: { id: { in: [...ctx.touched] } }, select: { id: true, ownerAccountId: true } })) as Row[];
    for (const members of (await liveMembers(ctx.tx, lists)).values()) for (const m of members) ctx.audience.add(m.accountId);
  }
  for (const accountId of ctx.audience) ctx.after.push(() => listsBus.fireListsChanged(accountId));
}

/**
 * Run one operation in a serializable transaction with retry, then its after-commit effects
 * (doorbells, nudges, the live stream). Shared by every REST and MCP call and by digestFor().
 */
async function transact<T>(caller: Caller, input: Input, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const after: Array<() => void> = [];
  const rung = new Set<string>();
  const nudged = new Set<string>();
  const touched = new Set<string>();
  const audience = new Set<string>();
  const result = await withSerializableRetry(
    () => {
      after.length = 0;
      rung.clear();
      nudged.clear();
      touched.clear();
      audience.clear();
      return prisma.$transaction(async (tx: Tx) => {
        const ctx: Ctx = { tx, caller, input, now: new Date(), after, rung, nudged, touched, audience };
        const out = await fn(ctx);
        await announce(ctx);
        return out;
      }, { isolationLevel: "Serializable" });
    },
    { retryable: conflict },
  );
  for (const run of after) run();
  return result;
}

/** Ring this account's doorbell (kind "task") after commit, once per request: the doorbell carries an absolute count. */
function ring(ctx: Ctx, accountId: string) {
  if (ctx.rung.has(accountId)) return;
  ctx.rung.add(accountId);
  ctx.after.push(() => fireInboxEvent(accountId, "task"));
}

/** Record that this person OK'd a task for their own agents, with an activity line naming how. */
async function recordOk(tx: Tx, task: Row, caller: Caller, via: "web" | "user_in_chat", names: Names) {
  await tx.taskAgentOk.create({ data: { taskId: task.id, accountId: caller.accountId, via, viaAgentId: caller.agentId } });
  // The line is the person's: they said yes. A chat OK names the agent that recorded it.
  const agentName = caller.agentId ? names.agents.get(caller.agentId)?.name ?? null : null;
  await addEventLine(tx, task.id, { accountId: caller.accountId, agentId: null }, "ok", R.okLine(via, agentName));
}

/** Would this member's agents need their OK before acting on this task? */
async function needsOkFrom(tx: Tx, task: Row, member: Row): Promise<boolean> {
  if (task.createdByAccountId === member.accountId || member.agentsTakeFrom === "anyone") return false;
  return !(await tx.taskAgentOk.findFirst({ where: { taskId: task.id, accountId: member.accountId } }));
}

const lastNudge = new Map<string, number>();
/** Test hook: forget when anyone was last emailed. */
export function resetListNudges() {
  lastNudge.clear();
}
const appUrl = () => process.env.PUBLIC_APP_URL ?? "https://back-channel.app";

async function callerLabel(tx: Tx, caller: Caller) {
  const names = await loadNames(tx, [{ authorAccountId: caller.accountId, authorAgentId: caller.agentId }]);
  return R.whoLabel(R.who(names as never, caller.accountId, caller.agentId, null));
}

/**
 * Queue an opt-in email nudge (a mention, a result to check, or a task for
 * their agents that needs their OK). Only for members who turned it on for this
 * list and whose account still allows email; at most one per person per hour
 * across all lists; never about something the person did themselves. The email
 * says who and which list and task, nothing more, and links straight to the task
 * with a one-time sign-in like the idle-message email. Sent after commit, never
 * awaited: a nudge can't fail or slow the change that caused it.
 */
async function nudge(ctx: Ctx, s: Standing, task: Row, accountId: string, kind: "mention" | "review" | "ok") {
  const { tx, caller, now } = ctx;
  if (accountId === caller.accountId && !caller.agentId) return;
  const member = s.members.find((m) => m.accountId === accountId);
  if (!member || member.notify !== "mentions_reviews") return;
  if (ctx.nudged.has(accountId) || !R.nudgeDue(lastNudge.get(accountId), now.getTime())) return;
  const account = (await tx.account.findFirst({ where: { id: accountId }, select: { handle: true, email: true, emailVerifiedAt: true, notifyIdleFrames: true } })) as Row | null;
  if (!account?.email || !account.emailVerifiedAt || account.notifyIdleFrames === false) return;
  ctx.nudged.add(accountId);
  const raw = auth.generateViewToken();
  await tx.viewToken.create({ data: { token: auth.hashToken(raw), accountId, purpose: "account", expiresAt: auth.viewTokenExpiry() } });
  const enc = encodeURIComponent;
  const args = {
    to: account.email as string, handle: account.handle as string, kind, by: await callerLabel(tx, caller),
    listName: s.list.name as string, taskTitle: task.title as string,
    url: `${appUrl()}/account?vt=${enc(raw)}&tab=lists&list=${enc(s.list.id)}&task=${enc(task.id)}`,
  };
  ctx.after.push(() => {
    // Checked again after commit: another request may have used this hour's nudge meanwhile.
    if (!R.nudgeDue(lastNudge.get(accountId), Date.now())) return;
    lastNudge.set(accountId, Date.now());
    try {
      void Promise.resolve(email.sendListNudgeEmail(args)).catch(() => {});
    } catch {
      // best effort
    }
  });
}

/**
 * Record who a comment or progress line mentions: people on the list, and
 * members' agents with access to it. A mentioned agent rings its person's
 * doorbell (it stops counting once that agent's plate or bc_task_get shows it);
 * a mentioned person sees it on their plate and may get an email nudge.
 */
async function recordMentions(ctx: Ctx, s: Standing, task: Row, entry: Row) {
  const { tx, caller } = ctx;
  if (typeof entry.body !== "string" || !entry.body.includes("@")) return;
  const memberIds = s.members.map((m) => m.accountId as string);
  const [accounts, grants] = await Promise.all([
    tx.account.findMany({ where: { id: { in: memberIds } }, select: { id: true, handle: true } }),
    tx.taskListAgentGrant.findMany({ where: { listId: s.list.id, accountId: { in: memberIds } } }),
  ]);
  const agents = (grants as Row[]).length
    ? ((await tx.agentToken.findMany({ where: { id: { in: (grants as Row[]).map((g) => g.agentTokenId) }, revokedAt: null }, select: { id: true, accountId: true, name: true } })) as Row[])
        .filter((a) => (grants as Row[]).some((g) => g.agentTokenId === a.id && g.accountId === a.accountId))
    : [];
  const found = R.parseMentions(entry.body, {
    people: (accounts as Row[]).map((a) => ({ accountId: a.id, handle: a.handle })),
    agents: agents.map((a) => ({ id: a.id, accountId: a.accountId, name: a.name ?? "agent" })),
    author: { accountId: caller.accountId, agentId: caller.agentId },
  });
  for (const m of found) await tx.taskMention.create({ data: { entryId: entry.id, taskId: task.id, accountId: m.accountId, agentId: m.agentId } });
  for (const m of found) if (m.agentId) ring(ctx, m.accountId);
  for (const m of found) if (!m.agentId) await nudge(ctx, s, task, m.accountId, "mention");
}

/** An entry written by the caller, with its mentions recorded. */
async function writeEntry(ctx: Ctx, s: Standing, task: Row, kind: "comment" | "progress", body: string, agentId: string | null = ctx.caller.agentId) {
  const entry = (await ctx.tx.taskEntry.create({ data: { taskId: task.id, kind, authorAccountId: ctx.caller.accountId, authorAgentId: agentId, body } })) as Row;
  await recordMentions(ctx, s, task, entry);
  return entry;
}

/** A task was just given to a member's agents: ring that member's doorbell, and nudge them if their agents need their OK. */
async function afterAssigning(ctx: Ctx, s: Standing, task: Row, cols: Row | undefined) {
  if (!forAgents(cols)) return;
  const target = cols!.assigneeAccountId as string;
  ring(ctx, target);
  const member = s.members.find((m) => m.accountId === target);
  if (target !== ctx.caller.accountId && member && (await needsOkFrom(ctx.tx, task, member))) await nudge(ctx, s, task, target, "ok");
}

// ── leaving a list ──────────────────────────────────────────────────────────

/**
 * Take one person off a list: their membership and their agents' access end,
 * whatever they or their agents held is released with a line naming the task,
 * tasks waiting for them go back to anyone, and their unread mentions there are
 * cleared so nobody's doorbell rings for a list they can't open. Their past work
 * (tasks, progress, comments, OKs, reactions) stays, attributed to them.
 */
async function removeMembership(tx: Tx, list: Row, accountId: string, how: "left" | "removed", byAccountId: string, now: Date) {
  await tx.taskListMember.deleteMany({ where: { listId: list.id, accountId } });
  await tx.taskListAgentGrant.deleteMany({ where: { listId: list.id, accountId } });
  const touched = (await tx.taskItem.findMany({
    where: { listId: list.id, status: { in: [...R.ACTIVE] }, OR: [{ claimAccountId: accountId }, { assigneeAccountId: accountId }] },
  })) as Row[];
  for (const t of touched) {
    const held = t.claimAccountId === accountId && (t.status === "in_progress" || t.status === "blocked");
    const data: Row = {};
    if (held) Object.assign(data, R.releasePatch(t));
    if (t.assigneeAccountId === accountId) Object.assign(data, { assigneeAccountId: null, assigneeAgents: false, assigneeAgentId: null, agentSeenAt: null });
    if (!Object.keys(data).length) continue;
    await tx.taskItem.updateMany({ where: { id: t.id }, data });
    await addEventLine(tx, t.id, { accountId, agentId: null }, "member_left", R.memberLeftLine(t.title, how, held));
  }
  await tx.taskMention.updateMany({ where: { accountId, seenAt: null, task: { listId: list.id } }, data: { seenAt: now } });
  await tx.taskListEvent.create({
    data: { listId: list.id, eventType: how === "left" ? "member_left" : "member_removed", actorAccountId: how === "left" ? accountId : byAccountId, subjectAccountId: accountId },
  });
  await tx.taskList.update({ where: { id: list.id }, data: { updatedAt: now } });
}

/**
 * Called when `accountId` stops trusting `peerId` (DELETE /api/trust/:handle).
 * Friendship is what membership rests on, so every list one of them owns and
 * the other is on ends for the member now: the same as leaving (if the member
 * revoked) or being taken off (if the owner did). Access already failed closed
 * at the revocation itself; this makes it tidy and visible. Best effort: it logs
 * and returns on failure, never throws into the trust route.
 */
export async function endListSharing(accountId: string, peerId: string): Promise<void> {
  if (!accountId || !peerId || accountId === peerId) return;
  try {
    // Both people's pages hear about it, and so does everyone else still on those lists.
    await transact({ accountId, agentId: null, viaCookie: false }, {}, async (ctx) => {
      const rows = (await ctx.tx.taskListMember.findMany({
        where: { role: "member", OR: [{ accountId: peerId, list: { ownerAccountId: accountId } }, { accountId, list: { ownerAccountId: peerId } }] },
      })) as Row[];
      for (const m of rows) {
        const list = (await ctx.tx.taskList.findFirst({ where: { id: m.listId } })) as Row;
        await removeMembership(ctx.tx, list, m.accountId, m.accountId === accountId ? "left" : "removed", accountId, ctx.now);
        touch(ctx, list.id);
        ctx.audience.add(m.accountId);
      }
    });
  } catch (e) {
    console.error("[lists] endListSharing failed:", e instanceof Error ? e.name : typeof e);
  }
}

// ── operations ──────────────────────────────────────────────────────────────

async function opLists({ tx, caller }: Ctx) {
  const ids = await visibleListIds(tx, caller, { includeArchived: !caller.agentId });
  const lists = (ids.length ? await tx.taskList.findMany({ where: { id: { in: ids } }, orderBy: { createdAt: "asc" } }) : []) as Row[];
  const counts = ids.length ? await tx.taskItem.groupBy({ by: ["listId", "status"], where: { listId: { in: ids } }, _count: { _all: true } }) : [];
  const members = await liveMembers(tx, lists);
  const grants = ids.length && !caller.agentId
    ? await tx.taskListAgentGrant.findMany({ where: { listId: { in: ids }, accountId: caller.accountId } })
    : [];
  return {
    lists: lists.map((l: Row) => {
      const c: Record<string, number> = {};
      for (const g of counts as Row[]) if (g.listId === l.id) c[g.status] = g._count?._all ?? g._count ?? 0;
      const mine = members.get(l.id) ?? [];
      return {
        id: l.id,
        name: l.name,
        emoji: l.emoji ?? null,
        archived: !!l.archivedAt,
        shared: mine.length > 1,
        your_role: mine.find((m) => m.accountId === caller.accountId)?.role ?? null,
        counts: { open: c.open ?? 0, in_progress: c.in_progress ?? 0, blocked: c.blocked ?? 0, needs_review: c.needs_review ?? 0, done: c.done ?? 0 },
        ...(caller.agentId ? {} : { agents: (grants as Row[]).filter((g) => g.listId === l.id).map((g) => ({ agent_id: g.agentTokenId, access: g.access })) }),
      };
    }),
  };
}

/** What a new list starts with: a template's items, or a copy of another list's unfinished tasks. */
type Seed = { name: string; emoji: string | null; tasks: Array<{ title: string; notes: string; createdByAccountId?: string; createdByAgentId?: string | null }>; copied: boolean };

/**
 * A `template` argument as a seed: "builtin:<slug>", one of the caller's (or, for an agent, its person's)
 * saved templates by id, or either by name. Nobody else's saved templates are reachable.
 */
async function templateSeed(tx: Tx, caller: Caller, value: unknown): Promise<Seed> {
  let ref: ReturnType<typeof T.parseTemplateRef> | ReturnType<typeof T.matchTemplateName> = T.parseTemplateRef(value);
  if (ref.kind === "name") {
    const saved = (await tx.taskListTemplate.findMany({ where: { ownerAccountId: caller.accountId }, select: { id: true, name: true }, orderBy: { createdAt: "asc" } })) as Row[];
    const wanted = ref.name;
    ref = T.matchTemplateName(wanted, saved as Array<{ id: string; name: string }>);
    if (ref === "ambiguous") return fail(400, "ambiguous_template", `More than one of your templates is called "${wanted}". Use its id instead.`);
    if (!ref) {
      const yours = saved.map((t) => `"${t.name}"`).join(", ");
      return fail(404, "no_such_template", `No template called "${wanted}". ${yours ? `Yours: ${yours}. ` : ""}${T.builtinHint()}`);
    }
  }
  if (ref.kind === "builtin") {
    const b = T.builtinTemplate(ref.slug)!;
    return { name: b.name, emoji: b.emoji, tasks: b.items.map((i) => ({ title: i.title, notes: i.notes })), copied: false };
  }
  const row = (await tx.taskListTemplate.findFirst({ where: { id: ref.id, ownerAccountId: caller.accountId } })) as Row | null;
  if (!row) return fail(404, "no_such_template", "That template isn't available.");
  return { name: row.name, emoji: row.emoji ?? null, tasks: T.cleanTemplateItems(row.items), copied: false };
}

/**
 * A copy of a list the person can see: its name with "(copy)", its emoji, and its unfinished tasks'
 * titles, notes and order. Not assignees, claims, comments or history. Each task keeps who wrote it,
 * so a friend's task stays a request on the copy (the OK rule). People only: an agent copying a
 * friend's tasks into a list of its own is the kind of laundering the OK rule exists to stop.
 */
async function duplicateSeed(tx: Tx, caller: Caller, listId: unknown): Promise<Seed> {
  if (!caller.viaCookie) return peopleOnly("duplicate a list");
  const s = await standing(tx, caller, String(listId ?? ""));
  if (!s) return NOT_AVAILABLE();
  const rows = (await tx.taskItem.findMany({ where: { listId: s.list.id, status: { in: [...R.ACTIVE] } }, orderBy: { position: "asc" }, take: R.LIMITS.openTasksPerList })) as Row[];
  return { name: T.copyName(s.list.name), emoji: s.list.emoji ?? null, tasks: T.tasksToDuplicate(rows), copied: true };
}

async function opCreateList(ctx: Ctx) {
  const { tx, caller, input } = ctx;
  const fromTemplate = input.template !== undefined && input.template !== null;
  const fromList = input.duplicate !== undefined && input.duplicate !== null;
  if (fromTemplate && fromList) fail(400, "invalid_create", "Start from a template or duplicate a list, not both.");
  const seed = fromTemplate ? await templateSeed(tx, caller, input.template) : fromList ? await duplicateSeed(tx, caller, input.duplicate) : null;
  const name = R.cleanText(input.name ?? seed?.name, { field: "name", max: R.LIMITS.listName, required: true, singleLine: true })!;
  const emoji = (input.emoji !== undefined ? R.cleanText(input.emoji, { field: "emoji", max: R.LIMITS.emoji, singleLine: true }) : seed?.emoji) || null;
  const owned = await tx.taskList.count({ where: { ownerAccountId: caller.accountId, archivedAt: null } });
  if (owned >= R.LIMITS.listsPerAccount) fail(429, "too_many_lists", `You already have ${R.LIMITS.listsPerAccount} lists. Archive one first.`);
  // Which agents may work here. A person picks theirs in the browser. An agent
  // that creates a list gets work access to it, and nothing more: it can't
  // hand access to the person's other agents.
  let agentIds: string[] = [];
  if (caller.agentId) {
    if (input.agents !== undefined) fail(403, "people_only", "Only a person can choose which agents work on a list.");
    agentIds = [caller.agentId];
  } else if (input.agents !== undefined) {
    if (!Array.isArray(input.agents) || input.agents.some((a) => typeof a !== "string")) fail(400, "invalid_agents", "agents must be a list of agent ids");
    const wanted = [...new Set(input.agents as string[])];
    const mine = wanted.length ? await tx.agentToken.findMany({ where: { id: { in: wanted }, accountId: caller.accountId, revokedAt: null }, select: { id: true } }) : [];
    if (mine.length !== wanted.length) fail(400, "invalid_agents", "Some of those aren't your connected agents.");
    agentIds = wanted;
  }
  const list = await tx.taskList.create({ data: { ownerAccountId: caller.accountId, name, emoji } });
  await tx.taskListMember.create({ data: { listId: list.id, accountId: caller.accountId, role: "owner", addedByAccountId: caller.accountId } });
  for (const agentTokenId of agentIds) await tx.taskListAgentGrant.create({ data: { listId: list.id, agentTokenId, accountId: caller.accountId, access: "work" } });
  // A template's items are the caller's tasks now; a copy keeps who wrote each and says who copied it.
  let position: number | null = null;
  for (const item of seed?.tasks ?? []) {
    const title = R.cleanText(item.title, { field: "title", max: R.LIMITS.title, required: true, singleLine: true })!;
    const notes = R.cleanText(item.notes, { field: "notes", max: R.LIMITS.notes }) ?? "";
    position = R.nextPosition(position);
    const by = seed!.copied && item.createdByAccountId
      ? { createdByAccountId: item.createdByAccountId, createdByAgentId: item.createdByAgentId ?? null }
      : { createdByAccountId: caller.accountId, createdByAgentId: caller.agentId };
    const task = (await tx.taskItem.create({ data: { listId: list.id, title, notes, position, ...by } })) as Row;
    await addEvent(tx, task.id, caller, seed!.copied ? "copied" : "created");
  }
  touch(ctx, list.id);
  return {
    list: { id: list.id, name: list.name, emoji: list.emoji ?? null, archived: false, shared: false, your_role: "owner" },
    ...(seed ? { tasks_added: seed.tasks.length } : {}),
  };
}

/** Everyone on the list, owner first, with the agents each has given access here (what @mentions reach). */
async function memberViews(tx: Tx, s: Standing) {
  const grants = (await tx.taskListAgentGrant.findMany({ where: { listId: s.list.id } })) as Row[];
  const agents = grants.length
    ? ((await tx.agentToken.findMany({ where: { id: { in: grants.map((g) => g.agentTokenId) }, revokedAt: null }, select: { id: true, name: true, accountId: true } })) as Row[])
    : [];
  const names = await loadNames(tx, s.members);
  const order = [...s.members].sort((a, b) => (a.role === "owner" ? -1 : b.role === "owner" ? 1 : new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime()));
  return order.map((m) => R.memberView(m as never, names as never, s.actor, grants
    .filter((g) => g.accountId === m.accountId)
    .flatMap((g) => {
      const a = agents.find((x) => x.id === g.agentTokenId && x.accountId === m.accountId);
      return a ? [{ id: a.id, name: a.name ?? "agent", access: g.access }] : [];
    })));
}

async function opGetList({ tx, caller, input, now, touched }: Ctx) {
  const s = await standing(tx, caller, String(input.list_id ?? ""));
  if (!s) return NOT_AVAILABLE();
  const recent = new Date(now.getTime() - 7 * DAY);
  const rows = await tx.taskItem.findMany({
    where: { listId: s.list.id, OR: [{ status: { in: [...R.ACTIVE] } }, { updatedAt: { gt: recent } }] },
    orderBy: [{ position: "asc" }],
    take: 1_000,
  });
  const settled: Row[] = [];
  for (const t of rows as Row[]) settled.push(await settleLapse(tx, t, now, touched));
  const events = ((await tx.taskListEvent.findMany({ where: { listId: s.list.id }, orderBy: { createdAt: "desc" }, take: R.LIMITS.plateExtras })) as Row[]).reverse();
  const lens = await lensFor(tx, caller, settled, { lines: true, extra: events });
  const ref = listRef(s);
  const result: Row = {
    list: {
      ...ref, emoji: s.list.emoji ?? null, archived: !!s.list.archivedAt, your_role: s.member.role,
      agents_take_from: s.member.agentsTakeFrom, notify: s.member.notify ?? "off",
    },
    members: await memberViews(tx, s),
    activity: events.map((e) => R.listEventView(e as never, { actor: s.actor, names: lens.names as never })),
    tasks: settled.map((t) => viewOf(t, { actor: s.actor, lens, list: ref, member: s.member, now })),
  };
  if (!caller.agentId) {
    // The access editor: every one of this person's live agents and what it may do here.
    const [agents, grants] = await Promise.all([
      tx.agentToken.findMany({ where: { accountId: caller.accountId, revokedAt: null }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, runtimeType: true, lastUsedAt: true, scope: true } }),
      tx.taskListAgentGrant.findMany({ where: { listId: s.list.id, accountId: caller.accountId } }),
    ]);
    result.your_agents = (agents as Row[]).map((a) => ({
      id: a.id, name: a.name, runtime_type: a.runtimeType ?? null, last_used_at: a.lastUsedAt ? new Date(a.lastUsedAt).toISOString() : null,
      hosted: a.scope !== "full", access: (grants as Row[]).find((g) => g.agentTokenId === a.id)?.access ?? "none",
    }));
  }
  return result;
}

async function opUpdateList(ctx: Ctx) {
  const { tx, caller, input } = ctx;
  const s = await standing(tx, caller, String(input.list_id ?? ""));
  if (!s) return NOT_AVAILABLE();
  if (!R.canManage(s.actor)) fail(403, "not_allowed", "Only the list's owner can change it.");
  touch(ctx, s.list.id);
  const data: Row = {};
  const name = R.cleanText(input.name, { field: "name", max: R.LIMITS.listName, singleLine: true });
  if (name !== undefined) { if (!name) fail(400, "invalid_name", "name can't be empty"); data.name = name; }
  const emoji = R.cleanText(input.emoji, { field: "emoji", max: R.LIMITS.emoji, singleLine: true });
  if (emoji !== undefined || input.emoji === null) data.emoji = emoji || null;
  if (input.archived !== undefined) {
    if (typeof input.archived !== "boolean") fail(400, "invalid_archived", "archived must be true or false");
    data.archivedAt = input.archived ? new Date() : null;
  }
  if (!Object.keys(data).length) fail(400, "nothing_to_change", "Nothing to change.");
  const list = await tx.taskList.update({ where: { id: s.list.id }, data });
  return { list: { id: list.id, name: list.name, emoji: list.emoji ?? null, archived: !!list.archivedAt } };
}

async function opSetAgentAccess(ctx: Ctx) {
  const { tx, caller, input, now } = ctx;
  // Cookie-only: a person decides which of their agents work where. No agent,
  // and no tool, can widen any agent's access.
  if (!caller.viaCookie) fail(403, "people_only", "Only a person, in the Back Channel dashboard, can change which agents work on a list.");
  const s = await standing(tx, caller, String(input.list_id ?? ""));
  if (!s) return NOT_AVAILABLE();
  touch(ctx, s.list.id);
  const agentId = input.agent_id;
  const access = input.access;
  if (typeof agentId !== "string" || !["none", "view", "work"].includes(String(access))) fail(400, "invalid_access", "Pass agent_id and access: none, view or work.");
  const agent = await tx.agentToken.findFirst({ where: { id: agentId as string, accountId: caller.accountId, revokedAt: null } });
  if (!agent) fail(400, "invalid_agent", "That isn't one of your connected agents.");
  await tx.taskListAgentGrant.deleteMany({ where: { listId: s.list.id, agentTokenId: agentId as string } });
  if (access !== "none") await tx.taskListAgentGrant.create({ data: { listId: s.list.id, agentTokenId: agentId as string, accountId: caller.accountId, access: access as string } });
  // Work access taken away: the agent lets go of what it holds here now, with a line saying so,
  // rather than keeping a claim it can no longer act on until it lapses.
  if (access !== "work") {
    const held = await tx.taskItem.findMany({ where: { listId: s.list.id, claimAgentId: agentId as string, status: { in: ["in_progress", "blocked"] } } });
    for (const t of held as Row[]) {
      await tx.taskItem.updateMany({ where: { id: t.id, claimAgentId: agentId as string }, data: R.releasePatch(t) });
      await addEvent(tx, t.id, { accountId: t.claimAccountId, agentId: agentId as string }, "released", "its work access on this list was removed");
    }
  }
  // No access at all: it can't open these tasks any more, so its mentions here stop ringing the doorbell.
  if (access === "none") await tx.taskMention.updateMany({ where: { agentId: agentId as string, seenAt: null, task: { listId: s.list.id } }, data: { seenAt: now } });
  return { agent_id: agentId, access };
}

async function opAddMember(ctx: Ctx) {
  const { tx, caller, input, now } = ctx;
  // Sharing moves content across an account boundary, and trust is a human act: cookie only.
  if (!caller.viaCookie) peopleOnly("share a list");
  const s = await standing(tx, caller, String(input.list_id ?? ""));
  if (!s) return NOT_AVAILABLE();
  if (!R.canManage(s.actor)) fail(403, "not_allowed", "Only the list's owner can add people to it.");
  writable(s);
  touch(ctx, s.list.id);
  if (typeof input.handle !== "string" || !input.handle.trim()) fail(400, "invalid_handle", "Say who to add: their handle.");
  // One answer for a stranger and for a handle that doesn't exist, so this never says which.
  const notAFriend = () => fail(403, "not_a_friend", "You can only add friends to a list.");
  const target = await accountByHandle(tx, input.handle);
  if (!target) return notAFriend();
  if (target.id !== caller.accountId) {
    if (!R.mutualFriends(await trustEdges(tx, [caller.accountId, target.id]), caller.accountId, target.id)) return notAFriend();
    const existing = await tx.taskListMember.findFirst({ where: { listId: s.list.id, accountId: target.id } });
    if (!existing) {
      const count = await tx.taskListMember.count({ where: { listId: s.list.id } });
      if (count >= R.LIMITS.membersPerList) fail(429, "too_many_members", `A list can have ${R.LIMITS.membersPerList} people on it.`);
      await tx.taskListMember.create({ data: { listId: s.list.id, accountId: target.id, role: "member", addedByAccountId: caller.accountId } });
      await tx.taskListEvent.create({ data: { listId: s.list.id, eventType: "member_added", actorAccountId: caller.accountId, subjectAccountId: target.id } });
      await tx.taskList.update({ where: { id: s.list.id }, data: { updatedAt: now } });
    }
  }
  const fresh = (await standing(tx, caller, s.list.id))!;
  return { members: await memberViews(tx, fresh) };
}

async function opRemoveMember(ctx: Ctx) {
  const { tx, caller, input, now } = ctx;
  if (!caller.viaCookie) peopleOnly("change who is on a list");
  const s = await standing(tx, caller, String(input.list_id ?? ""));
  if (!s) return NOT_AVAILABLE();
  const target = await memberByHandle(tx, s, String(input.handle ?? ""));
  const check = R.removalCheck(s.actor, target?.accountId ?? "", target?.role ?? null);
  if (!check.ok) return fail(check.status, check.code, check.why);
  await removeMembership(tx, s.list, target!.accountId, check.how, caller.accountId, now);
  // The person who came off isn't a member any more, so they're told by hand: their page drops the list.
  touch(ctx, s.list.id);
  ctx.audience.add(target!.accountId);
  if (check.how === "left") return { left: true };
  const fresh = (await standing(tx, caller, s.list.id))!;
  return { members: await memberViews(tx, fresh) };
}

async function opUpdateMe(ctx: Ctx) {
  const { tx, caller, input } = ctx;
  // Each person sets only their own: whose tasks their agents take without asking, and email nudges.
  if (!caller.viaCookie) peopleOnly("change these settings");
  const s = await standing(tx, caller, String(input.list_id ?? ""));
  if (!s) return NOT_AVAILABLE();
  const data: Row = {};
  if (input.agents_take_from !== undefined) {
    if (!R.AGENTS_TAKE_FROM.includes(input.agents_take_from as string)) fail(400, "invalid_agents_take_from", "agents_take_from must be me or anyone");
    data.agentsTakeFrom = input.agents_take_from;
  }
  if (input.notify !== undefined) {
    if (!R.NOTIFY.includes(input.notify as string)) fail(400, "invalid_notify", "notify must be off or mentions_reviews");
    data.notify = input.notify;
  }
  if (!Object.keys(data).length) fail(400, "nothing_to_change", "Pass agents_take_from or notify.");
  await tx.taskListMember.updateMany({ where: { listId: s.list.id, accountId: caller.accountId }, data });
  // Only this person's own view changes (their OK requests, their settings): their other tabs hear it.
  ctx.audience.add(caller.accountId);
  const me = (await tx.taskListMember.findFirst({ where: { listId: s.list.id, accountId: caller.accountId } })) as Row;
  return { me: { agents_take_from: me.agentsTakeFrom, notify: me.notify } };
}

/** Unread mentions of the caller (a person: of them; an agent: of it and of its person) on these lists, newest first. */
async function unreadMentions(tx: Tx, caller: Caller, listIds: string[]) {
  if (!listIds.length) return { mentions: [] as Row[], tasks: [] as Row[], entries: [] as Row[] };
  const rows = (await tx.taskMention.findMany({
    where: { accountId: caller.accountId, seenAt: null, ...(caller.agentId ? { OR: [{ agentId: caller.agentId }, { agentId: null }] } : { agentId: null }) },
    orderBy: { createdAt: "desc" },
    take: 200,
  })) as Row[];
  if (!rows.length) return { mentions: [], tasks: [], entries: [] };
  const tasks = (await tx.taskItem.findMany({ where: { id: { in: [...new Set(rows.map((m) => m.taskId))] }, listId: { in: listIds } } })) as Row[];
  const visible = new Set(tasks.map((t) => t.id));
  const mentions = rows.filter((m) => visible.has(m.taskId)).slice(0, R.LIMITS.plateExtras);
  const entries = mentions.length ? ((await tx.taskEntry.findMany({ where: { id: { in: mentions.map((m) => m.entryId) } } })) as Row[]) : [];
  return { mentions, tasks, entries };
}

async function opPlate({ tx, caller, now, touched }: Ctx) {
  const ids = await visibleListIds(tx, caller);
  if (!ids.length) {
    return { lists: [], doing: [], up_next: [], claimable: [], waiting_on_you: [], ok_requests: [], mentions: [], done_recently: [], hint: caller.agentId
      ? "No lists are shared with this agent yet. Your person can create one and give this agent access, or you can start a personal list with bc_list_create."
      : "No lists yet." };
  }
  const lists = (await tx.taskList.findMany({ where: { id: { in: ids } } })) as Row[];
  const [members, grants] = await Promise.all([
    liveMembers(tx, lists),
    // A person: which lists any of their live agents can work. An agent: its own grants.
    caller.agentId
      ? tx.taskListAgentGrant.findMany({ where: { listId: { in: ids }, agentTokenId: caller.agentId, accountId: caller.accountId } })
      : tx.taskListAgentGrant.findMany({ where: { listId: { in: ids }, accountId: caller.accountId, access: "work" } }),
  ]);
  const rows = await tx.taskItem.findMany({
    where: { listId: { in: ids }, OR: [{ status: { in: [...R.ACTIVE] } }, { status: "done", completedAt: { gt: new Date(now.getTime() - DAY) } }] },
    take: 2_000,
  });
  const settled: Row[] = [];
  for (const t of rows as Row[]) settled.push(await settleLapse(tx, t, now, touched));
  const unread = await unreadMentions(tx, caller, ids);
  const byId = new Map(settled.map((t) => [t.id as string, t]));
  for (const t of unread.tasks) if (!byId.has(t.id)) byId.set(t.id, await settleLapse(tx, t, now, touched));
  const all = [...byId.values()];
  const lens = await lensFor(tx, caller, all, { lines: true, extra: [...unread.entries, ...unread.mentions] });

  const byList = new Map(lists.map((l) => [l.id as string, l]));
  const memberFor = (listId: string) => (members.get(listId) ?? []).find((x) => x.accountId === caller.accountId) ?? null;
  const actorFor = (listId: string): Actor => {
    const g = (grants as Row[]).find((x) => x.listId === listId);
    return { accountId: caller.accountId, agentId: caller.agentId, role: memberFor(listId)?.role ?? null, agentAccess: caller.agentId ? g?.access ?? null : null };
  };
  let workable = new Set<string>();
  if (caller.agentId) workable = new Set((grants as Row[]).filter((g) => g.access === "work").map((g) => g.listId as string));
  else if ((grants as Row[]).length) {
    const live = await tx.agentToken.findMany({ where: { id: { in: (grants as Row[]).map((g) => g.agentTokenId) }, accountId: caller.accountId, revokedAt: null }, select: { id: true } });
    const liveIds = new Set((live as Row[]).map((a) => a.id));
    workable = new Set((grants as Row[]).filter((g) => liveIds.has(g.agentTokenId)).map((g) => g.listId as string));
  }
  const shared = (listId: string) => (members.get(listId) ?? []).length > 1;
  const refFor = (listId: string): ListRef => ({ id: listId, name: byList.get(listId)?.name ?? "", shared: shared(listId) });
  const mayAct = (t: Row) => mayActFor(t, caller.accountId, memberFor(t.listId), lens);
  const me: Actor = { accountId: caller.accountId, agentId: caller.agentId, role: "member", agentAccess: caller.agentId ? "work" : null };
  const sections = R.plateSections(settled, me, now, (t: Row) => R.claimCheck(t, actorFor(t.listId), now, mayAct(t)).ok);
  // Up next is work this agent can pick up, so only on lists where it has work access. A view-only
  // agent must not be offered a task for "my agents", nor mark it seen and silence the doorbell
  // for the agents that can do it.
  if (caller.agentId) sections.up_next = sections.up_next.filter((t: Row) => R.canWork(actorFor(t.listId)));
  // A task waiting for this agent stops ringing the doorbell once the agent has seen it here.
  if (caller.agentId && sections.up_next.length) {
    const unseen = sections.up_next.filter((t: Row) => !t.agentSeenAt).map((t: Row) => t.id);
    if (unseen.length) await tx.taskItem.updateMany({ where: { id: { in: unseen }, agentSeenAt: null }, data: { agentSeenAt: now } });
  }
  const okRequests = R.okRequests(settled, me, now, { mayAct, agentsCanWork: (listId: string) => workable.has(listId) });
  // Mentions of this agent stop ringing its person's doorbell once it has seen them here. Its
  // person's own mentions wait for the person.
  if (caller.agentId) {
    const seen = unread.mentions.filter((m) => m.agentId === caller.agentId).map((m) => m.id);
    if (seen.length) await tx.taskMention.updateMany({ where: { id: { in: seen }, seenAt: null }, data: { seenAt: now } });
  }
  const view = (t: Row) => viewOf(t, { actor: actorFor(t.listId), lens, list: refFor(t.listId), member: memberFor(t.listId), now });
  const entryById = new Map(unread.entries.map((e) => [e.id as string, e]));
  return {
    lists: lists.map((l) => ({ id: l.id, name: l.name, emoji: l.emoji ?? null, shared: shared(l.id) })),
    doing: sections.doing.map(view),
    up_next: sections.up_next.map(view),
    claimable: sections.claimable.map(view),
    waiting_on_you: sections.waiting_on_you.map(view),
    ok_requests: okRequests.map(view),
    mentions: unread.mentions.flatMap((m) => {
      const entry = entryById.get(m.entryId);
      const task = byId.get(m.taskId);
      if (!entry || !task) return [];
      const actor = actorFor(task.listId);
      return [{
        id: m.id,
        of: R.who(lens.names as never, m.accountId, m.agentId, actor),
        entry: R.entryView(entry, { actor, names: lens.names as never }),
        task: view(task),
      }];
    }),
    done_recently: sections.done_recently.map(view),
  };
}

async function opSearch({ tx, caller, input, now, touched }: Ctx) {
  const q = R.cleanText(input.q, { field: "q", max: 200, singleLine: true });
  const listFilter = input.list_id !== undefined ? String(input.list_id) : undefined;
  const status = input.status !== undefined ? String(input.status) : undefined;
  if (status && !R.STATUSES.includes(status)) fail(400, "invalid_status", `status must be one of: ${R.STATUSES.join(", ")}`);
  // One list asked for by id reads even when archived (as getList and getTask do); only a search
  // across lists leaves archived ones out.
  let ids = await visibleListIds(tx, caller, { includeArchived: listFilter !== undefined });
  if (listFilter) ids = ids.filter((id) => id === listFilter);
  if (!ids.length) return listFilter ? NOT_AVAILABLE() : { tasks: [] };
  const where: Row = { listId: { in: ids } };
  if (status) where.status = status;
  else where.status = { in: [...R.ACTIVE] };
  if (q) where.AND = [{ OR: [{ title: { contains: q, mode: "insensitive" } }, { notes: { contains: q, mode: "insensitive" } }] }];
  const rows = await tx.taskItem.findMany({ where, orderBy: [{ position: "asc" }], take: R.LIMITS.pageSize });
  const settled: Row[] = [];
  for (const t of rows as Row[]) settled.push(await settleLapse(tx, t, now, touched));
  const lens = await lensFor(tx, caller, settled);
  const views = [];
  const cache = new Map<string, Standing | null>();
  for (const t of settled) {
    if (!cache.has(t.listId)) cache.set(t.listId, await standing(tx, caller, t.listId));
    const s = cache.get(t.listId);
    if (!s) continue;
    views.push(viewOf(t, { actor: s.actor, lens, list: listRef(s), member: s.member, now }));
  }
  return { tasks: views, ...(rows.length === R.LIMITS.pageSize ? { more: true } : {}) };
}

async function opChanges({ tx, caller, input }: Ctx) {
  const since = typeof input.since === "string" ? new Date(input.since) : null;
  const at = new Date().toISOString();
  if (!since || !Number.isFinite(since.getTime())) return { at, changed: true };
  const ids = await visibleListIds(tx, caller, { includeArchived: true });
  if (!ids.length) return { at, changed: false };
  const [task, list] = await Promise.all([
    tx.taskItem.findFirst({ where: { listId: { in: ids }, updatedAt: { gt: since } }, select: { id: true } }),
    tx.taskList.findFirst({ where: { id: { in: ids }, updatedAt: { gt: since } }, select: { id: true } }),
  ]);
  return { at, changed: !!task || !!list };
}

/** Resolve the `list` argument the tools take: an id, or a list name the caller can see. */
async function resolveList(tx: Tx, caller: Caller, value: unknown) {
  if (typeof value !== "string" || !value.trim()) fail(400, "invalid_list", "Say which list: its id or its name.");
  const v = (value as string).trim();
  if (UUID.test(v)) {
    const s = await standing(tx, caller, v);
    if (!s) return NOT_AVAILABLE();
    return s;
  }
  const ids = await visibleListIds(tx, caller);
  const lists = ids.length ? await tx.taskList.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const wanted = v.toLowerCase().replace(/\s+list$/, "");
  const match = (lists as Row[]).filter((l) => l.name.toLowerCase() === wanted || l.name.toLowerCase() === v.toLowerCase());
  if (match.length === 1) return (await standing(tx, caller, match[0].id))!;
  const known = (lists as Row[]).map((l) => l.name).join(", ") || "none yet";
  return fail(404, "no_such_list", match.length > 1 ? `More than one list is called "${v}". Use the list id instead.` : `No list called "${v}". Lists you can use: ${known}.`);
}

async function opAddTasks(ctx: Ctx) {
  const { tx, caller, input, now, touched } = ctx;
  const s = input.list_id !== undefined ? await standing(tx, caller, String(input.list_id)) : await resolveList(tx, caller, input.list);
  if (!s) return NOT_AVAILABLE();
  writable(s);
  touched.add(s.list.id);
  if (!R.canWork(s.actor)) fail(403, "not_allowed", s.actor.agentId ? "Your person hasn't given this agent work access to this list." : "You can't add tasks to this list.");
  const items: Input[] = Array.isArray(input.tasks) ? (input.tasks as Input[]) : [{ title: input.title, notes: input.notes, assignee: input.assignee, due: input.due }];
  if (!items.length || items.length > R.LIMITS.batchAdd) fail(400, "invalid_tasks", `Add between 1 and ${R.LIMITS.batchAdd} tasks at a time.`);
  const open = await tx.taskItem.count({ where: { listId: s.list.id, status: { in: [...R.ACTIVE] } } });
  if (open + items.length > R.LIMITS.openTasksPerList) fail(429, "too_many_tasks", `This list already has ${open} open tasks. Finish or drop some first.`);
  const last = await tx.taskItem.findFirst({ where: { listId: s.list.id }, orderBy: { position: "desc" }, select: { position: true } });
  let position = (last as Row | null)?.position ?? null;
  const created: Row[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") fail(400, "invalid_tasks", "Each task needs a title.");
    const title = R.cleanText(item.title, { field: "title", max: R.LIMITS.title, required: true, singleLine: true })!;
    const notes = R.cleanText(item.notes, { field: "notes", max: R.LIMITS.notes }) ?? "";
    const dueAt = R.parseDue(item.due, now) ?? null;
    const assignee = await assigneeColumns(tx, caller, s, item.assignee);
    position = R.nextPosition(position);
    const task = (await tx.taskItem.create({
      data: {
        listId: s.list.id, title, notes, position, dueAt, createdByAccountId: caller.accountId, createdByAgentId: caller.agentId,
        ...(assignee ?? {}),
      },
    })) as Row;
    await addEvent(tx, task.id, caller, "created");
    await afterAssigning(ctx, s, task, assignee);
    created.push(task);
  }
  const lens = await lensFor(tx, caller, created);
  return { tasks: created.map((t) => viewOf(t, { actor: s.actor, lens, list: listRef(s), member: s.member, now })) };
}

async function taskResult(tx: Tx, caller: Caller, s: Standing, taskId: string, now: Date, withEntries = false) {
  const task = (await tx.taskItem.findFirst({ where: { id: taskId } })) as Row;
  const entries = withEntries
    ? ((await tx.taskEntry.findMany({ where: { taskId }, orderBy: { createdAt: "desc" }, take: 50 })) as Row[]).reverse()
    : [];
  const lens = await lensFor(tx, caller, [task], { extra: entries });
  const view: Row = viewOf(task, { actor: s.actor, lens, list: listRef(s), member: s.member, now });
  if (withEntries) view.entries = entries.map((e) => R.entryView(e, { actor: s.actor, names: lens.names as never }));
  return { task: view };
}

async function opGetTask({ tx, caller, input, now, touched }: Ctx) {
  const s = await loadTask(tx, caller, input.task_id, now, touched);
  // Reading the task is seeing what mentions the caller on it: a person's mentions of them, an agent's of it.
  await tx.taskMention.updateMany({ where: { taskId: s.task.id, accountId: caller.accountId, agentId: caller.agentId, seenAt: null }, data: { seenAt: now } });
  return taskResult(tx, caller, s, s.task.id, now, true);
}

async function opEntries({ tx, caller, input, now, touched }: Ctx) {
  const s = await loadTask(tx, caller, input.task_id, now, touched);
  const before = typeof input.before === "string" ? await tx.taskEntry.findFirst({ where: { id: input.before, taskId: s.task.id } }) : null;
  const rows = (await tx.taskEntry.findMany({
    where: { taskId: s.task.id, ...(before ? { createdAt: { lt: (before as Row).createdAt } } : {}) },
    orderBy: { createdAt: "desc" },
    take: R.LIMITS.pageSize,
  })) as Row[];
  const names = await loadNames(tx, rows);
  return { entries: rows.reverse().map((e) => R.entryView(e, { actor: s.actor, names: names as never })), ...(rows.length === R.LIMITS.pageSize ? { more: true } : {}) };
}

async function guardEntryRoom(tx: Tx, taskId: string) {
  const n = await tx.taskEntry.count({ where: { taskId, kind: { in: ["comment", "progress"] } } });
  if (n >= R.LIMITS.entriesPerTask) fail(429, "too_many_entries", "This task has a lot of history already. Finish it and start a new one for what's next.");
}

async function opAddEntry(ctx: Ctx) {
  const { tx, caller, input, now, touched } = ctx;
  const s = await loadTask(tx, caller, input.task_id, now, touched);
  writable(s);
  touched.add(s.list.id);
  const kind = input.kind === "progress" ? "progress" : input.kind === "comment" || input.kind === undefined ? "comment" : fail(400, "invalid_kind", "kind must be comment or progress");
  if (kind === "progress" ? !R.canWork(s.actor) : !R.canComment(s.actor)) fail(403, "not_allowed", "You can't write on this task.");
  const text = R.cleanText(input.text, { field: "text", max: R.LIMITS.entry, required: true })!;
  await guardEntryRoom(tx, s.task.id);
  await writeEntry(ctx, s, s.task, kind, text);
  await tx.taskItem.updateMany({ where: { id: s.task.id }, data: { updatedAt: now } });
  await renewIfClaimant(tx, s.task, s.actor, now);
  return taskResult(tx, caller, s, s.task.id, now);
}

async function opClaim({ tx, caller, input, now, touched }: Ctx) {
  // ok_from: "user_in_chat" is an agent saying its person just said yes to this task in the chat.
  // The broker can't prove a person was there; it records the claim as theirs, visibly.
  const okFrom = input.ok_from;
  if (okFrom !== undefined && okFrom !== null) {
    if (!caller.agentId) fail(400, "invalid_ok_from", "ok_from is for agents. In the dashboard, use OK for my agents.");
    if (okFrom !== "user_in_chat") fail(400, "invalid_ok_from", "ok_from can only be \"user_in_chat\", and only when your person said yes to this task in this conversation.");
  }
  const s = await loadTask(tx, caller, input.task_id, now, touched);
  writable(s);
  touched.add(s.list.id);
  const lens = await lensFor(tx, caller, [s.task], { extra: [{ authorAccountId: caller.accountId, authorAgentId: caller.agentId }] });
  if (okFrom && R.canWork(s.actor)) {
    const ok = R.okCheck(s.task, s.actor, now, lens.oks.has(s.task.id));
    if (ok.ok && ok.needed) {
      await recordOk(tx, s.task, caller, "user_in_chat", lens.names);
      lens.oks.set(s.task.id, "user_in_chat");
    }
  }
  const mayAct = mayActFor(s.task, caller.accountId, s.member, lens);
  const check = R.claimCheck(s.task, s.actor, now, mayAct, holderLabel(lens.names, s.actor));
  if (!check.ok) {
    const holder = check.code === "already_claimed" ? R.who(lens.names as never, s.task.claimAccountId, s.task.claimAgentId, s.actor) : undefined;
    return fail(refusalStatus(check.code!), check.code!, check.why!, holder ? { claim: { by: holder, since: s.task.claimedAt } } : undefined);
  }
  if (!check.already) {
    // Belt and braces on top of the serializable transaction: only an unheld
    // (or lapsed) task can be claimed, whatever this transaction believed.
    const won = await tx.taskItem.updateMany({
      where: { id: s.task.id, OR: [{ claimAccountId: null }, { claimAgentId: { not: null }, claimExpiresAt: { lte: now } }] },
      data: R.claimPatch(s.task, s.actor, now),
    });
    if (won.count !== 1) fail(409, "already_claimed", "Someone else just picked this up.");
    await addEvent(tx, s.task.id, caller, "claimed");
    // An agent took a friend's task because its person's list setting allows it: keep that as the
    // OK, so the reason is on record and survives the setting changing back mid-task.
    if (caller.agentId && s.task.createdByAccountId !== caller.accountId && !lens.oks.has(s.task.id)) {
      await tx.taskAgentOk.create({ data: { taskId: s.task.id, accountId: caller.accountId, via: "list_setting", viaAgentId: caller.agentId } });
    }
  } else {
    await renewIfClaimant(tx, s.task, s.actor, now);
  }
  return taskResult(tx, caller, s, s.task.id, now);
}

async function opOk({ tx, caller, input, now, touched }: Ctx) {
  if (!caller.viaCookie) {
    fail(403, "people_only", "Only a person OKs a task for their agents, in the Back Channel dashboard. If your person said yes in this chat, claim it with ok_from: \"user_in_chat\".");
  }
  const s = await loadTask(tx, caller, input.task_id, now, touched);
  writable(s);
  touched.add(s.list.id);
  const lens = await lensFor(tx, caller, [s.task]);
  const check = R.okCheck(s.task, s.actor, now, lens.oks.has(s.task.id));
  if (!check.ok) fail(refusalStatus(check.code), check.code, check.why);
  if ((check as { needed: boolean }).needed) {
    await recordOk(tx, s.task, caller, "web", lens.names);
    await tx.taskItem.updateMany({ where: { id: s.task.id }, data: { updatedAt: now } });
  }
  return taskResult(tx, caller, s, s.task.id, now);
}

async function opReact({ tx, caller, input, now, touched }: Ctx) {
  const s = await loadTask(tx, caller, input.task_id, now, touched);
  writable(s);
  touched.add(s.list.id);
  if (!R.canComment(s.actor)) fail(403, "not_allowed", "You can't react on this task.");
  const emoji = R.cleanEmoji(input.emoji);
  const mine = await tx.taskReaction.findFirst({ where: { taskId: s.task.id, accountId: caller.accountId, agentId: caller.agentId, emoji } });
  if (mine) await tx.taskReaction.deleteMany({ where: { id: (mine as Row).id } });
  else await tx.taskReaction.create({ data: { taskId: s.task.id, accountId: caller.accountId, agentId: caller.agentId, emoji } });
  // No activity line for a reaction; the bump is so other people's open pages refresh.
  await tx.taskItem.updateMany({ where: { id: s.task.id }, data: { updatedAt: now } });
  return taskResult(tx, caller, s, s.task.id, now);
}

async function opRelease({ tx, caller, input, now, touched }: Ctx) {
  const s = await loadTask(tx, caller, input.task_id, now, touched);
  writable(s);
  touched.add(s.list.id);
  const reason = R.cleanText(input.reason, { field: "reason", max: 1_000 });
  const owner = R.canManage(s.actor);
  if (!R.hasLiveClaim(s.task, now)) fail(409, "not_claimed", "Nobody is on this task.");
  if (!R.isClaimant(s.task, s.actor) && !owner) fail(403, "not_claimant", "Only whoever is on it (or the list's owner) can let it go.");
  await tx.taskItem.updateMany({ where: { id: s.task.id }, data: R.releasePatch(s.task) });
  await addEvent(tx, s.task.id, caller, "released", reason);
  return taskResult(tx, caller, s, s.task.id, now);
}

async function opDone(ctx: Ctx) {
  const { tx, caller, input, now, touched } = ctx;
  const s = await loadTask(tx, caller, input.task_id, now, touched);
  writable(s);
  touched.add(s.list.id);
  const lens = await lensFor(tx, caller, [s.task]);
  const check = R.finishCheck(s.task, s.actor, now, mayActFor(s.task, caller.accountId, s.member, lens), R.canManage(s.actor), holderLabel(lens.names, s.actor));
  if (!check.ok) fail(refusalStatus(check.code!), check.code!, check.why!);
  let summary = R.cleanText(input.summary, { field: "summary", max: R.LIMITS.summary });
  const evidence = R.cleanText(input.evidence, { field: "evidence", max: 2_000 });
  if (evidence) summary = `${summary ?? ""}${summary ? "\n\n" : ""}Evidence: ${evidence}`.slice(0, R.LIMITS.summary);
  const patch = R.donePatch(s.task, s.actor, now, summary);
  await tx.taskItem.updateMany({ where: { id: s.task.id }, data: patch });
  await addEvent(tx, s.task.id, caller, patch.status === "needs_review" ? "needs_review" : "done");
  if (patch.status === "needs_review" && patch.reviewerAccountId) await nudge(ctx, s, s.task, patch.reviewerAccountId, "review");
  return taskResult(tx, caller, s, s.task.id, now);
}

async function opReview(ctx: Ctx) {
  const { tx, caller, input, now, touched } = ctx;
  const s = await loadTask(tx, caller, input.task_id, now, touched);
  writable(s);
  touched.add(s.list.id);
  const verdict = input.verdict === "accept" || input.verdict === "send_back" ? input.verdict : fail(400, "invalid_verdict", "verdict must be accept or send_back");
  const check = R.reviewCheck(s.task, s.actor, now, verdict, R.canManage(s.actor));
  if (!check.ok) fail(refusalStatus(check.code!), check.code!, check.why!);
  const comment = R.cleanText(input.comment, { field: "comment", max: R.LIMITS.entry, required: verdict === "send_back" });
  await tx.taskItem.updateMany({ where: { id: s.task.id }, data: R.reviewPatch(s.task, verdict, now) });
  if (comment) await writeEntry(ctx, s, s.task, "comment", comment, null);
  await addEvent(tx, s.task.id, caller, verdict === "accept" ? "accepted" : "sent_back");
  return taskResult(tx, caller, s, s.task.id, now);
}

async function opUpdateTask(ctx: Ctx) {
  const { tx, caller, input, now, touched } = ctx;
  const s = await loadTask(tx, caller, input.task_id, now, touched);
  writable(s);
  touched.add(s.list.id);
  if (!R.canWork(s.actor)) fail(403, "not_allowed", s.actor.agentId ? "Your person hasn't given this agent work access to this list." : "You can't change tasks on this list.");
  const task = s.task;
  const data: Row = {};
  const events: Array<[keyof typeof R.EVENT_PHRASES, string | undefined]> = [];

  const title = R.cleanText(input.title, { field: "title", max: R.LIMITS.title, singleLine: true });
  const notes = R.cleanText(input.notes, { field: "notes", max: R.LIMITS.notes });
  if (title !== undefined || notes !== undefined) {
    if (title === "") fail(400, "invalid_title", "title can't be empty");
    if (typeof input.version !== "number") fail(400, "version_required", "Pass version (from bc_task_get) when changing the title or notes, so nobody's edit is lost.");
    if (input.version !== task.version) {
      fail(409, "edit_conflict", "Someone changed this task since you read it. Merge your change into the current text and try again.", {
        current: { title: task.title, notes: task.notes, version: task.version },
      });
    }
    if (title !== undefined) data.title = title;
    if (notes !== undefined) data.notes = notes;
    data.version = task.version + 1;
    events.push(["edited", undefined]);
  }
  const dueAt = R.parseDue(input.due, now);
  if (dueAt !== undefined) data.dueAt = dueAt;

  const assignee = await assigneeColumns(tx, caller, s, input.assignee);
  if (assignee) {
    Object.assign(data, assignee);
    events.push(["assigned", undefined]);
  }

  if (input.status !== undefined) {
    const change = String(input.status);
    if (!["blocked", "unblocked", "dropped", "restored", "reopened"].includes(change)) {
      fail(400, "invalid_status", "status here is blocked, unblocked, dropped, restored or reopened. Use bc_task_claim to pick up or let go, and bc_task_done to finish.");
    }
    const reason = R.cleanText(input.reason, { field: "reason", max: 1_000, required: change === "blocked" });
    const result = R.statusChange(task, s.actor, now, change as never, R.canManage(s.actor));
    if (!result.ok) fail(refusalStatus(result.code), result.code, result.why);
    Object.assign(data, (result as { patch: Row }).patch);
    events.push([change as keyof typeof R.EVENT_PHRASES, reason]);
  }

  const progress = R.cleanText(input.progress, { field: "progress", max: R.LIMITS.entry });
  if (!Object.keys(data).length && !progress) fail(400, "nothing_to_change", "Nothing to change. Pass progress, notes, title, due, assignee or status.");

  if (Object.keys(data).length) {
    // Edits carry the version they were made against, so a concurrent edit loses loudly instead of silently.
    const where: Row = { id: task.id, ...(data.version ? { version: task.version } : {}) };
    const updated = await tx.taskItem.updateMany({ where, data });
    if (updated.count !== 1) fail(409, "edit_conflict", "Someone changed this task at the same moment. Read it again and retry.");
  }
  if (progress) {
    await guardEntryRoom(tx, task.id);
    await writeEntry(ctx, s, task, "progress", progress);
    if (!Object.keys(data).length) await tx.taskItem.updateMany({ where: { id: task.id }, data: { updatedAt: now } });
  }
  for (const [type, detail] of events) await addEvent(tx, task.id, caller, type, detail);
  const fresh = (await tx.taskItem.findFirst({ where: { id: task.id } })) as Row;
  if (assignee) await afterAssigning(ctx, s, fresh, assignee);
  await renewIfClaimant(tx, fresh, s.actor, now);
  return taskResult(tx, caller, s, task.id, now);
}

// ── templates (Phase 3) ─────────────────────────────────────────────────────

/** The built-ins, then this person's saved templates, oldest first. An agent sees its person's. */
async function opTemplates({ tx, caller }: Ctx) {
  const saved = (await tx.taskListTemplate.findMany({ where: { ownerAccountId: caller.accountId }, orderBy: { createdAt: "asc" } })) as Row[];
  return {
    templates: [
      ...T.BUILTIN_TEMPLATES.map((b) => T.templateView(b)),
      ...saved.map((t) => T.templateView({ id: t.id, name: t.name, emoji: t.emoji, items: Array.isArray(t.items) ? t.items : [], createdAt: t.createdAt })),
    ],
  };
}

/**
 * "Save as template": the list's unfinished tasks that this person or their agents wrote, titles and
 * notes in order. People only, in the dashboard. `skipped` counts unfinished tasks someone else wrote,
 * which stay out (see templates.mjs).
 */
async function opSaveTemplate({ tx, caller, input }: Ctx) {
  if (!caller.viaCookie) peopleOnly("save a list as a template");
  const s = await standing(tx, caller, String(input.list_id ?? ""));
  if (!s) return NOT_AVAILABLE();
  const owned = await tx.taskListTemplate.count({ where: { ownerAccountId: caller.accountId } });
  if (owned >= T.TEMPLATE_LIMITS.perAccount) fail(429, "too_many_templates", `You already have ${T.TEMPLATE_LIMITS.perAccount} templates. Delete one first.`);
  const rows = (await tx.taskItem.findMany({ where: { listId: s.list.id, status: { in: [...R.ACTIVE] } }, orderBy: { position: "asc" }, take: R.LIMITS.openTasksPerList })) as Row[];
  const { items, skipped } = T.itemsFromTasks(rows, caller.accountId);
  if (!items.length) {
    fail(400, "empty_template", skipped
      ? "A template keeps only tasks you or your agents wrote, and every unfinished task here was written by someone else."
      : "There are no unfinished tasks on this list to save.");
  }
  if (items.length > T.TEMPLATE_LIMITS.items) fail(400, "template_too_big", `This list has ${items.length} unfinished tasks. A template holds up to ${T.TEMPLATE_LIMITS.items}.`);
  const clean = T.cleanTemplateItems(items);
  const name = R.cleanText(input.name ?? s.list.name, { field: "name", max: R.LIMITS.listName, required: true, singleLine: true })!;
  const emoji = (input.emoji !== undefined ? R.cleanText(input.emoji, { field: "emoji", max: R.LIMITS.emoji, singleLine: true }) : s.list.emoji) || null;
  const row = (await tx.taskListTemplate.create({ data: { ownerAccountId: caller.accountId, name, emoji, items: clean } })) as Row;
  return { template: T.templateView({ id: row.id, name: row.name, emoji: row.emoji, items: clean, createdAt: row.createdAt }), skipped };
}

async function opDeleteTemplate({ tx, caller, input }: Ctx) {
  if (!caller.viaCookie) peopleOnly("delete a template");
  const id = String(input.template_id ?? "");
  if (!UUID.test(id)) return fail(404, "not_available", "That template isn't available.");
  const gone = await tx.taskListTemplate.deleteMany({ where: { id, ownerAccountId: caller.accountId } });
  if (gone.count !== 1) return fail(404, "not_available", "That template isn't available.");
  return { deleted: true };
}

// ── the daily digest's settings (Phase 3) ───────────────────────────────────

async function emailReady(tx: Tx, accountId: string) {
  const a = (await tx.account.findFirst({ where: { id: accountId }, select: { email: true, emailVerifiedAt: true } })) as Row | null;
  return !!a?.email && !!a.emailVerifiedAt;
}

/** The person's own Lists settings (the daily digest). People only: it's about their email. */
async function opPreferences({ tx, caller }: Ctx) {
  if (!caller.viaCookie) peopleOnly("see these settings");
  const row = await tx.listsPreference.findFirst({ where: { accountId: caller.accountId } });
  return { preferences: D.preferenceView(row, { emailReady: await emailReady(tx, caller.accountId) }) };
}

/**
 * Turn the daily digest on or off, or change its hour or timezone. Turning it on after today's hour
 * has passed records today's as had, so the first one comes at that hour tomorrow, not at the next run.
 */
async function opUpdatePreferences({ tx, caller, input, now }: Ctx) {
  if (!caller.viaCookie) peopleOnly("change these settings");
  const patch: Row = D.cleanPreference(input);
  const current = (await tx.listsPreference.findFirst({ where: { accountId: caller.accountId } })) as Row | null;
  const next = { digest: "off", digestHour: D.DEFAULT_DIGEST_HOUR, timezone: null, lastDigestAt: null, ...(current ?? {}), ...patch };
  if (next.digest === "daily" && current?.digest !== "daily") {
    const anchor = D.enableAnchor(now, next.timezone, next.digestHour);
    if (anchor) patch.lastDigestAt = anchor;
  }
  if (current) await tx.listsPreference.updateMany({ where: { accountId: caller.accountId }, data: patch });
  else await tx.listsPreference.create({ data: { accountId: caller.accountId, ...patch } });
  const row = await tx.listsPreference.findFirst({ where: { accountId: caller.accountId } });
  return { preferences: D.preferenceView(row, { emailReady: await emailReady(tx, caller.accountId) }) };
}

const OPS: Record<ListsOp, (ctx: Ctx) => Promise<unknown>> = {
  lists: opLists, createList: opCreateList, getList: opGetList, updateList: opUpdateList, setAgentAccess: opSetAgentAccess,
  plate: opPlate, search: opSearch, changes: opChanges, tasks: opSearch, addTasks: opAddTasks, getTask: opGetTask,
  updateTask: opUpdateTask, claim: opClaim, release: opRelease, done: opDone, review: opReview, entries: opEntries, addEntry: opAddEntry,
  addMember: opAddMember, removeMember: opRemoveMember, updateMe: opUpdateMe, ok: opOk, react: opReact,
  templates: opTemplates, saveTemplate: opSaveTemplate, deleteTemplate: opDeleteTemplate,
  preferences: opPreferences, updatePreferences: opUpdatePreferences,
};

/**
 * Run one operation for whoever is calling. Shared by the REST route and the MCP tools.
 * `input` may be a function: the REST route passes one that reads the body, so an
 * unauthenticated caller gets 401 before its body is ever parsed.
 */
export async function lists(req: NextRequest, op: ListsOp, inputOrReader: Input | (() => Promise<Input>)): Promise<NextResponse> {
  try {
    const caller = await resolveCaller(req);
    const write = WRITES.has(op);
    const limit = rateLimit(write ? "lists-write" : "lists-read", caller.agentId ?? caller.accountId, write ? 60 : 240, 60_000);
    if (!limit.ok) {
      const res = respond({ error: "rate_limited", message: "Too many list changes at once. Wait a moment and retry." }, 429);
      res.headers.set("Retry-After", String(limit.retryAfterSec));
      return res;
    }
    const input = typeof inputOrReader === "function" ? await inputOrReader() : inputOrReader;
    return respond(await transact(caller, input, OPS[op]));
  } catch (e) {
    if (e instanceof R.ListRuleError) return respond({ error: e.code, message: e.message, ...(e.extra ?? {}) }, e.status);
    if (conflict(e)) {
      const res = respond({ error: "busy", message: "Someone else was changing this at the same moment. Retry.", retryable: true }, 503);
      res.headers.set("Retry-After", "1");
      return res;
    }
    // Never log task content or bearer tokens.
    console.error(`[lists] ${op} failed:`, e instanceof Error ? e.name : typeof e);
    return respond({ error: "unavailable", message: "Lists are unavailable right now. Try again shortly." }, 503);
  }
}

// ── REST: /api/lists/... ───────────────────────────────────────────────────

async function readJson(req: NextRequest): Promise<Input> {
  const text = await req.text();
  if (!text) return {};
  if (text.length > 256 * 1024) fail(413, "too_large", "Request too large");
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "invalid_json", "Send a JSON object.");
    return body as Input;
  } catch {
    return fail(400, "invalid_json", "Send a JSON object.");
  }
}

/**
 * Map a REST request onto an operation.
 *   GET    /api/lists                     lists           POST /api/lists               createList
 *   GET    /api/lists/plate               plate           GET  /api/lists/search?q=     search
 *   GET    /api/lists/changes?since=      changes
 *   POST   /api/lists {template | duplicate}              createList, seeded (Phase 3)
 *   GET    /api/lists/templates           templates       POST /api/lists/templates     saveTemplate (people only)
 *   DELETE /api/lists/templates/:id       deleteTemplate  (people only)
 *   GET    /api/lists/preferences         preferences     PATCH /api/lists/preferences  updatePreferences (people only)
 *   GET    /api/lists/:id                 getList         PATCH /api/lists/:id          updateList
 *   PUT    /api/lists/:id/agents          setAgentAccess  (people only)
 *   POST   /api/lists/:id/members         addMember       (owner, people only)
 *   DELETE /api/lists/:id/members/:handle removeMember    (owner removes; anyone else leaves)
 *   PATCH  /api/lists/:id/me              updateMe        (people only, their own settings)
 *   GET    /api/lists/:id/tasks           tasks           POST /api/lists/:id/tasks     addTasks
 *   GET    /api/lists/tasks/:taskId       getTask         PATCH /api/lists/tasks/:taskId updateTask
 *   POST   /api/lists/tasks/:taskId/{claim,release,done,review,ok,react}
 *   GET    /api/lists/tasks/:taskId/entries               POST .../entries              addEntry
 */
export async function listsRoute(req: NextRequest, path: string[]): Promise<NextResponse> {
  const m = req.method;
  const [a, b, c] = path;
  const query = Object.fromEntries(req.nextUrl.searchParams.entries());
  let route: [ListsOp, Input | (() => Promise<Input>)] | null = null;
  const body = async () => readJson(req);
  if (!a) route = m === "GET" ? ["lists", query] : m === "POST" ? ["createList", body] : null;
  else if (a === "plate" && !b && m === "GET") route = ["plate", query];
  else if (a === "search" && !b && m === "GET") route = ["search", query];
  else if (a === "changes" && !b && m === "GET") route = ["changes", query];
  else if (a === "templates") {
    if (!b) route = m === "GET" ? ["templates", query] : m === "POST" ? ["saveTemplate", body] : null;
    else if (!c && m === "DELETE") route = ["deleteTemplate", { template_id: b }];
  } else if (a === "preferences" && !b) route = m === "GET" ? ["preferences", query] : m === "PATCH" ? ["updatePreferences", body] : null;
  else if (a === "tasks" && b) {
    const withId = async (i: Input) => ({ ...i, task_id: b });
    if (!c) route = m === "GET" ? ["getTask", { task_id: b }] : m === "PATCH" ? ["updateTask", async () => withId(await body())] : null;
    else if (c === "entries") route = m === "GET" ? ["entries", { ...query, task_id: b }] : m === "POST" ? ["addEntry", async () => withId(await body())] : null;
    else if (["claim", "release", "done", "review", "ok", "react"].includes(c) && m === "POST") route = [c as ListsOp, async () => withId(await body())];
  } else if (a !== "tasks") {
    const withList = async (i: Input) => ({ ...i, list_id: a });
    if (!b) route = m === "GET" ? ["getList", { list_id: a }] : m === "PATCH" ? ["updateList", async () => withList(await body())] : null;
    else if (b === "agents" && !c && m === "PUT") route = ["setAgentAccess", async () => withList(await body())];
    else if (b === "members" && !c && m === "POST") route = ["addMember", async () => withList(await body())];
    else if (b === "members" && c && m === "DELETE") route = ["removeMember", { list_id: a, handle: c }];
    else if (b === "me" && !c && m === "PATCH") route = ["updateMe", async () => withList(await body())];
    else if (b === "tasks" && !c) route = m === "GET" ? ["tasks", { ...query, list_id: a }] : m === "POST" ? ["addTasks", async () => withList(await body())] : null;
  }
  // Each endpoint has a fixed depth. A longer path is an unknown endpoint, not the shorter one:
  // GET /api/lists/:id/tasks/:taskId must not quietly answer with the whole list.
  if (path.length > (a === "tasks" || b === "members" ? 3 : 2)) route = null;
  if (!route) return respond({ error: "not_found", message: "No such lists endpoint." }, 404);
  const [op, input] = route;
  return lists(req, op, input);
}

// ── MCP: the bc_task* tools (catalog in src/lib/mcp/list-tools.mjs) ─────────

const TOOL_OPS: Record<string, (args: Input) => [ListsOp, Input]> = {
  bc_tasks: (args) => (args.list !== undefined || args.status !== undefined || args.q !== undefined ? ["search", { q: args.q, status: args.status, list_id: args.list }] : ["plate", {}]),
  bc_task_get: (args) => ["getTask", { task_id: args.task_id }],
  bc_task_add: (args) => ["addTasks", args],
  bc_task_claim: (args) => (args.action === "release" ? ["release", { task_id: args.task_id, reason: args.reason }] : ["claim", { task_id: args.task_id, ok_from: args.ok_from }]),
  bc_task_update: (args) => ["updateTask", args],
  bc_task_done: (args) => ["done", { task_id: args.task_id, summary: args.summary, evidence: args.evidence }],
  bc_task_comment: (args) => ["addEntry", { task_id: args.task_id, kind: "comment", text: args.text }],
  bc_list_create: (args) => ["createList", { name: args.name, emoji: args.emoji, template: args.template }],
};

export function isListTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOL_OPS, name);
}

/** One bc_task* tool call: the same operations, the same rules, the caller's own bearer key. */
export async function listsTool(req: NextRequest, name: string, args: Input): Promise<{ status: number; text: string }> {
  const map = TOOL_OPS[name];
  let [op, input] = map(args);
  // bc_tasks takes a list by name or id; search wants an id.
  if (op === "search" && typeof input.list_id === "string" && !UUID.test(input.list_id)) {
    const named = await lists(req, "lists", {});
    if (named.status !== 200) return { status: named.status, text: await named.text() };
    const all = ((await named.json()) as { lists: Array<{ id: string; name: string }> }).lists;
    const wanted = input.list_id.trim().toLowerCase().replace(/\s+list$/, "");
    const hit = all.filter((l) => l.name.toLowerCase() === wanted || l.name.toLowerCase() === input.list_id!.toString().trim().toLowerCase());
    if (hit.length !== 1) {
      return { status: 404, text: JSON.stringify({ error: "no_such_list", message: `No list called "${input.list_id}". Lists you can use: ${all.map((l) => l.name).join(", ") || "none yet"}.` }) };
    }
    input = { ...input, list_id: hit[0].id };
  }
  if (op === "addTasks" && typeof args.list === "string" && UUID.test(args.list)) input = { ...input, list_id: args.list };
  const res = await lists(req, op, input);
  return { status: res.status, text: await res.text() };
}

/**
 * Doorbell helper for bc_check_inbox and the inbox doorbell: what is waiting
 * for this account's agents that none of them has seen yet. Open tasks
 * assigned to its agents, plus comments and progress lines that mention one of
 * its agents, on lists the account can still open (membership and friendship
 * checked, archived lists left out) and, for a mention, by an agent that still
 * has access there. Best effort: a failure reads as 0.
 */
export async function tasksWaitingForAgents(accountId: string): Promise<number> {
  try {
    const db = prisma as unknown as Tx;
    const ids = await visibleListIds(db, { accountId, agentId: null });
    if (!ids.length) return 0;
    const assigned = await prisma.taskItem.count({
      where: { listId: { in: ids }, assigneeAccountId: accountId, status: "open", agentSeenAt: null, OR: [{ assigneeAgents: true }, { assigneeAgentId: { not: null } }] },
    });
    const mentions = (await prisma.taskMention.findMany({
      where: { accountId, agentId: { not: null }, seenAt: null, task: { listId: { in: ids } } },
      select: { taskId: true, agentId: true },
      take: 500,
    })) as Row[];
    if (!mentions.length) return assigned;
    const tasks = (await prisma.taskItem.findMany({ where: { id: { in: [...new Set(mentions.map((m) => m.taskId))] } }, select: { id: true, listId: true } })) as Row[];
    const grants = (await prisma.taskListAgentGrant.findMany({
      where: { accountId, listId: { in: [...new Set(tasks.map((t) => t.listId))] }, agentTokenId: { in: [...new Set(mentions.map((m) => m.agentId))] } },
      select: { listId: true, agentTokenId: true },
    })) as Row[];
    const live = new Set(((await prisma.agentToken.findMany({ where: { id: { in: grants.map((g) => g.agentTokenId) }, revokedAt: null }, select: { id: true } })) as Row[]).map((a) => a.id));
    const listOf = new Map(tasks.map((t) => [t.id as string, t.listId as string]));
    const granted = new Set(grants.filter((g) => live.has(g.agentTokenId)).map((g) => `${g.listId}|${g.agentTokenId}`));
    return assigned + mentions.filter((m) => granted.has(`${listOf.get(m.taskId)}|${m.agentId}`)).length;
  } catch {
    return 0;
  }
}

/**
 * What one person's daily digest says (src/lib/lists-digest.ts decides when and sends it), from the
 * lists they can still open, archived ones left out:
 *  - finished: tasks their agents finished since `since` (done, or waiting for someone's check);
 *  - needsYou: finished work waiting for their look, and friends' tasks their agents need their OK
 *    for (the plate's waiting_on_you and ok_requests, by the same rules);
 *  - overdue: unfinished tasks due before `overdueBefore` that are theirs: held by them or their
 *    agents, or (when nobody holds them) for them, their agents, or anyone.
 * Titles and list names only, up to D.TITLES_PER_SECTION of each, with full counts.
 */
export async function digestFor(accountId: string, { since, overdueBefore }: { since: Date; overdueBefore: Date }): Promise<D.DigestData> {
  return transact({ accountId, agentId: null, viaCookie: true }, {}, async (ctx) => {
    const { tx, now } = ctx;
    const ids = await visibleListIds(tx, { accountId, agentId: null });
    if (!ids.length) return { finished: [], finishedCount: 0, needsYou: [], needsYouCount: 0, overdue: [], overdueCount: 0 };
    const lists = (await tx.taskList.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })) as Row[];
    const listName = new Map(lists.map((l) => [l.id as string, l.name as string]));
    const ref = (t: Row) => ({ title: t.title as string, list: listName.get(t.listId) ?? "" });
    const finishedWhere = {
      listId: { in: ids }, completedByAccountId: accountId, completedByAgentId: { not: null }, completedAt: { gt: since }, status: { in: ["done", "needs_review"] },
    };
    const finishedCount = await tx.taskItem.count({ where: finishedWhere });
    const finished = (await tx.taskItem.findMany({ where: finishedWhere, orderBy: { completedAt: "desc" }, take: D.TITLES_PER_SECTION, select: { title: true, listId: true } })) as Row[];
    const plate = (await opPlate(ctx)) as { waiting_on_you: Row[]; ok_requests: Row[] };
    const needs = [...plate.waiting_on_you, ...plate.ok_requests.filter((t) => !plate.waiting_on_you.some((w) => w.id === t.id))];
    const late = (await tx.taskItem.findMany({
      where: { listId: { in: ids }, status: { in: ["open", "in_progress", "blocked"] }, dueAt: { lt: overdueBefore } },
      orderBy: { dueAt: "asc" },
      take: 500,
    })) as Row[];
    const overdue = late.filter((t) => (R.hasLiveClaim(t, now) ? t.claimAccountId === accountId : !t.assigneeAccountId || t.assigneeAccountId === accountId));
    return {
      finished: finished.map(ref), finishedCount,
      needsYou: needs.slice(0, D.TITLES_PER_SECTION).map((t) => ({ title: t.title as string, list: (t.list?.name as string) ?? "" })), needsYouCount: needs.length,
      overdue: overdue.slice(0, D.TITLES_PER_SECTION).map(ref), overdueCount: overdue.length,
    };
  });
}
