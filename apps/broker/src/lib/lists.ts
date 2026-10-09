/**
 * Lists: task lists for people and their agents (docs/lists.md).
 *
 * The I/O half. Every decision (who may do what, claims, lapses, the OK rule,
 * what a task looks like to an agent) lives in lists/rules.mjs, which has no
 * database and is covered by `node --test`. This file authenticates, loads
 * rows, asks the rules, writes, and shapes responses.
 *
 * Callers:
 *  - REST: src/app/api/lists/[[...path]]/route.ts → listsRoute()
 *  - MCP:  src/app/api/mcp/route.ts → listsTool() for the bc_task* tools
 *
 * Auth: an agent key (full or connector: lists are for every host, including
 * claude.ai and ChatGPT over OAuth) or the dashboard cookie with CSRF on
 * writes. Deciding which of a person's agents may work a list is cookie-only:
 * trust is a human act, and no tool lets an agent widen its own access.
 *
 * List content is stored readable on purpose (decision 2026-10-09). Secret-
 * shaped text is refused by the rules before anything is written.
 */
import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
// Namespace import on purpose: route tests replace @/lib/auth wholesale with a
// few named exports, and a named import of anything they left out would fail
// at link time for every module that loads this one (the MCP route does).
import * as auth from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isSerializationFailure, withSerializableRetry } from "@/lib/serializable";
import { fireInboxEvent } from "@/lib/inbox-bus";
import * as R from "@/lib/lists/rules.mjs";

type Tx = Prisma.TransactionClient;
type Input = Record<string, unknown>;
type Caller = { accountId: string; agentId: string | null; viaCookie: boolean };
type Actor = { accountId: string; agentId: string | null; role: string | null; agentAccess: string | null };
type Names = { accounts: Map<string, { handle: string; displayName?: string | null }>; agents: Map<string, { name: string; accountId: string; runtimeType?: string | null }> };
// Rows are typed loosely on purpose: the rules module is plain JS and owns their meaning.
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type ListsOp =
  | "lists" | "createList" | "getList" | "updateList" | "setAgentAccess" | "plate" | "search" | "changes"
  | "tasks" | "addTasks" | "getTask" | "updateTask" | "claim" | "release" | "done" | "review" | "entries" | "addEntry";

const WRITES = new Set<ListsOp>(["createList", "updateList", "setAgentAccess", "addTasks", "updateTask", "claim", "release", "done", "review", "addEntry"]);
const DAY = 24 * 60 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fail = (status: number, code: string, message: string, extra?: Record<string, unknown>): never => {
  throw new R.ListRuleError(status, code, message, extra);
};
const NOT_AVAILABLE = () => fail(404, "not_available", "That list or task isn't available.");
const respond = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
const conflict = (e: unknown) => isSerializationFailure(e) || (!!e && typeof e === "object" && "code" in e && (e as { code?: unknown }).code === "P2002");

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

/** The caller's standing on one list, or null when they can't see it (never says which). */
async function standing(tx: Tx, caller: Caller, listId: string) {
  if (!UUID.test(listId)) return null;
  const list = await tx.taskList.findFirst({ where: { id: listId } });
  if (!list) return null;
  const member = await tx.taskListMember.findFirst({ where: { listId, accountId: caller.accountId } });
  if (!member) return null;
  let agentAccess: string | null = null;
  if (caller.agentId) {
    const grant = await tx.taskListAgentGrant.findFirst({ where: { listId, agentTokenId: caller.agentId, accountId: caller.accountId } });
    agentAccess = grant?.access ?? null;
  }
  const actor: Actor = { accountId: caller.accountId, agentId: caller.agentId, role: member.role, agentAccess };
  if (!R.canView(actor)) return null;
  const memberCount = await tx.taskListMember.count({ where: { listId } });
  return { list: list as Row, member: member as Row, actor, shared: memberCount > 1 };
}

/** Every list this caller can see. A person: their memberships. An agent: lists its person granted it. */
async function visibleListIds(tx: Tx, caller: Caller, { includeArchived = false } = {}): Promise<string[]> {
  const memberships = await tx.taskListMember.findMany({ where: { accountId: caller.accountId }, select: { listId: true } });
  let ids = memberships.map((m: Row) => m.listId as string);
  if (caller.agentId) {
    const grants = await tx.taskListAgentGrant.findMany({ where: { agentTokenId: caller.agentId, accountId: caller.accountId }, select: { listId: true } });
    const granted = new Set(grants.map((g: Row) => g.listId as string));
    ids = ids.filter((id) => granted.has(id));
  }
  if (!ids.length || includeArchived) return ids;
  const live = await tx.taskList.findMany({ where: { id: { in: ids }, archivedAt: null }, select: { id: true } });
  return live.map((l: Row) => l.id as string);
}

// ── names and views ─────────────────────────────────────────────────────────

async function loadNames(tx: Tx, rows: Row[]): Promise<Names> {
  const accountIds = new Set<string>();
  const agentIds = new Set<string>();
  for (const r of rows) {
    for (const k of ["createdByAccountId", "assigneeAccountId", "claimAccountId", "reviewerAccountId", "completedByAccountId", "authorAccountId"]) if (r[k]) accountIds.add(r[k]);
    for (const k of ["createdByAgentId", "assigneeAgentId", "claimAgentId", "completedByAgentId", "authorAgentId"]) if (r[k]) agentIds.add(r[k]);
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

function mayActFor(task: Row, accountId: string, member: Row | null, names: Names) {
  const author = names.accounts.get(task.createdByAccountId);
  return R.agentMayAct(task as never, accountId, {
    agentsTakeFrom: member?.agentsTakeFrom ?? "me",
    okAccountIds: [],
    authorName: author?.displayName || author?.handle || "Someone else",
  });
}

function holderLabel(names: Names, actor: Actor) {
  return (t: Row) => R.whoLabel(R.who(names as never, t.claimAccountId, t.claimAgentId, actor));
}

type ListRef = { id: string; name: string; shared: boolean };
function viewOf(task: Row, ctx: { actor: Actor; names: Names; list: ListRef; member: Row | null; now: Date }) {
  return R.taskView(task, { actor: ctx.actor, names: ctx.names as never, list: ctx.list, mayAct: mayActFor(task, ctx.actor.accountId, ctx.member, ctx.names), now: ctx.now });
}

// ── writes shared by every operation ───────────────────────────────────────

async function addEvent(tx: Tx, taskId: string, by: { accountId: string; agentId: string | null }, eventType: keyof typeof R.EVENT_PHRASES, detail?: string) {
  const phrase = R.EVENT_PHRASES[eventType];
  const body = detail ? `${phrase}: ${detail.slice(0, 1_000)}` : phrase;
  await tx.taskEntry.create({ data: { taskId, kind: "event", eventType, authorAccountId: by.accountId, authorAgentId: by.agentId, body } });
}

/**
 * An agent claim that ran out is released here, in the same transaction as
 * whatever touched the task, with an activity line saying so. Never silent.
 */
async function settleLapse(tx: Tx, task: Row, now: Date): Promise<Row> {
  if (!R.claimLapsed(task, now)) return task;
  const released = await tx.taskItem.updateMany({
    where: { id: task.id, claimAgentId: task.claimAgentId, claimExpiresAt: { lte: now } },
    data: R.releasePatch(task),
  });
  if (released.count !== 1) return (await tx.taskItem.findFirst({ where: { id: task.id } })) as Row;
  const last = await tx.taskEntry.findFirst({ where: { taskId: task.id, kind: "progress", authorAgentId: task.claimAgentId }, orderBy: { createdAt: "desc" } });
  await addEvent(tx, task.id, { accountId: task.claimAccountId, agentId: task.claimAgentId }, "lapsed", last ? `last progress was "${String(last.body).slice(0, 300)}"` : undefined);
  return (await tx.taskItem.findFirst({ where: { id: task.id } })) as Row;
}

async function loadTask(tx: Tx, caller: Caller, taskId: unknown, now: Date) {
  if (typeof taskId !== "string" || !UUID.test(taskId)) return NOT_AVAILABLE();
  const found = await tx.taskItem.findFirst({ where: { id: taskId } });
  if (!found) return NOT_AVAILABLE();
  const s = await standing(tx, caller, found.listId);
  if (!s) return NOT_AVAILABLE();
  const task = await settleLapse(tx, found as Row, now);
  return { ...s, task };
}

async function renewIfClaimant(tx: Tx, task: Row, actor: Actor, now: Date) {
  const patch = R.renewPatch(task, actor, now);
  if (patch) await tx.taskItem.updateMany({ where: { id: task.id, claimAgentId: actor.agentId }, data: patch });
}

/** Resolve an assignee from the rules' vocabulary into columns. Agents must be the caller's own, with access here. */
async function assigneeColumns(tx: Tx, caller: Caller, listId: string, value: unknown) {
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
      const grant = await tx.taskListAgentGrant.findFirst({ where: { listId, agentTokenId: a.agentId, accountId: caller.accountId, access: "work" } });
      if (!grant) return fail(400, "invalid_assignee", `${agent.name ?? "That agent"} can't work on this list yet. Give it access in the list's settings first.`);
      return { ...none, assigneeAccountId: caller.accountId, assigneeAgentId: a.agentId };
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

// ── operations ──────────────────────────────────────────────────────────────

type Ctx = { tx: Tx; caller: Caller; input: Input; now: Date; after: Array<() => void> };

async function opLists({ tx, caller }: Ctx) {
  const ids = await visibleListIds(tx, caller, { includeArchived: !caller.agentId });
  const lists = ids.length ? await tx.taskList.findMany({ where: { id: { in: ids } }, orderBy: { createdAt: "asc" } }) : [];
  const counts = ids.length ? await tx.taskItem.groupBy({ by: ["listId", "status"], where: { listId: { in: ids } }, _count: { _all: true } }) : [];
  const members = ids.length ? await tx.taskListMember.findMany({ where: { listId: { in: ids } }, select: { listId: true, accountId: true, role: true } }) : [];
  const grants = ids.length && !caller.agentId
    ? await tx.taskListAgentGrant.findMany({ where: { listId: { in: ids }, accountId: caller.accountId } })
    : [];
  return {
    lists: lists.map((l: Row) => {
      const c: Record<string, number> = {};
      for (const g of counts as Row[]) if (g.listId === l.id) c[g.status] = g._count?._all ?? g._count ?? 0;
      const mine = (members as Row[]).filter((m) => m.listId === l.id);
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

async function opCreateList({ tx, caller, input }: Ctx) {
  const name = R.cleanText(input.name, { field: "name", max: R.LIMITS.listName, required: true, singleLine: true })!;
  const emoji = R.cleanText(input.emoji, { field: "emoji", max: R.LIMITS.emoji, singleLine: true }) || null;
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
  return { list: { id: list.id, name: list.name, emoji: list.emoji ?? null, archived: false, shared: false, your_role: "owner" } };
}

async function opGetList({ tx, caller, input, now }: Ctx) {
  const s = await standing(tx, caller, String(input.list_id ?? ""));
  if (!s) return NOT_AVAILABLE();
  const recent = new Date(now.getTime() - 7 * DAY);
  const rows = await tx.taskItem.findMany({
    where: { listId: s.list.id, OR: [{ status: { in: [...R.ACTIVE] } }, { updatedAt: { gt: recent } }] },
    orderBy: [{ position: "asc" }],
    take: 1_000,
  });
  const settled: Row[] = [];
  for (const t of rows as Row[]) settled.push(await settleLapse(tx, t, now));
  const names = await loadNames(tx, settled);
  const ref = listRef(s);
  const result: Row = {
    list: { ...ref, emoji: s.list.emoji ?? null, archived: !!s.list.archivedAt, your_role: s.member.role, agents_take_from: s.member.agentsTakeFrom },
    tasks: settled.map((t) => viewOf(t, { actor: s.actor, names, list: ref, member: s.member, now })),
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

async function opUpdateList({ tx, caller, input }: Ctx) {
  const s = await standing(tx, caller, String(input.list_id ?? ""));
  if (!s) return NOT_AVAILABLE();
  if (!R.canManage(s.actor)) fail(403, "not_allowed", "Only the list's owner can change it.");
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

async function opSetAgentAccess({ tx, caller, input }: Ctx) {
  // Cookie-only: a person decides which of their agents work where. No agent,
  // and no tool, can widen any agent's access.
  if (!caller.viaCookie) fail(403, "people_only", "Only a person, in the Back Channel dashboard, can change which agents work on a list.");
  const s = await standing(tx, caller, String(input.list_id ?? ""));
  if (!s) return NOT_AVAILABLE();
  const agentId = input.agent_id;
  const access = input.access;
  if (typeof agentId !== "string" || !["none", "view", "work"].includes(String(access))) fail(400, "invalid_access", "Pass agent_id and access: none, view or work.");
  const agent = await tx.agentToken.findFirst({ where: { id: agentId as string, accountId: caller.accountId, revokedAt: null } });
  if (!agent) fail(400, "invalid_agent", "That isn't one of your connected agents.");
  await tx.taskListAgentGrant.deleteMany({ where: { listId: s.list.id, agentTokenId: agentId as string } });
  if (access !== "none") await tx.taskListAgentGrant.create({ data: { listId: s.list.id, agentTokenId: agentId as string, accountId: caller.accountId, access: access as string } });
  return { agent_id: agentId, access };
}

async function opPlate({ tx, caller, now }: Ctx) {
  const ids = await visibleListIds(tx, caller);
  if (!ids.length) {
    return { lists: [], doing: [], up_next: [], claimable: [], waiting_on_you: [], done_recently: [], hint: caller.agentId
      ? "No lists are shared with this agent yet. Your person can create one and give this agent access, or you can start a personal list with bc_list_create."
      : "No lists yet." };
  }
  const [lists, members, grants] = await Promise.all([
    tx.taskList.findMany({ where: { id: { in: ids } } }),
    tx.taskListMember.findMany({ where: { listId: { in: ids } }, select: { listId: true, accountId: true, role: true, agentsTakeFrom: true } }),
    caller.agentId ? tx.taskListAgentGrant.findMany({ where: { listId: { in: ids }, agentTokenId: caller.agentId, accountId: caller.accountId } }) : Promise.resolve([]),
  ]);
  const rows = await tx.taskItem.findMany({
    where: { listId: { in: ids }, OR: [{ status: { in: [...R.ACTIVE] } }, { status: "done", completedAt: { gt: new Date(now.getTime() - DAY) } }] },
    take: 2_000,
  });
  const settled: Row[] = [];
  for (const t of rows as Row[]) settled.push(await settleLapse(tx, t, now));
  const names = await loadNames(tx, settled);
  const byList = new Map((lists as Row[]).map((l) => [l.id, l]));
  const actorFor = (listId: string): Actor => {
    const m = (members as Row[]).find((x) => x.listId === listId && x.accountId === caller.accountId);
    const g = (grants as Row[]).find((x) => x.listId === listId);
    return { accountId: caller.accountId, agentId: caller.agentId, role: m?.role ?? null, agentAccess: caller.agentId ? g?.access ?? null : null };
  };
  const memberFor = (listId: string) => (members as Row[]).find((x) => x.listId === listId && x.accountId === caller.accountId) ?? null;
  const shared = (listId: string) => (members as Row[]).filter((x) => x.listId === listId).length > 1;
  const refFor = (listId: string): ListRef => ({ id: listId, name: byList.get(listId)?.name ?? "", shared: shared(listId) });
  const me: Actor = { accountId: caller.accountId, agentId: caller.agentId, role: "member", agentAccess: caller.agentId ? "work" : null };
  const sections = R.plateSections(settled, me, now, (t: Row) => {
    const actor = actorFor(t.listId);
    return R.claimCheck(t, actor, now, mayActFor(t, caller.accountId, memberFor(t.listId), names)).ok;
  });
  // Up next is work this agent can pick up, so only on lists where it has work access. A view-only
  // agent must not be offered a task for "my agents", nor mark it seen and silence the doorbell
  // for the agents that can do it.
  if (caller.agentId) sections.up_next = sections.up_next.filter((t: Row) => R.canWork(actorFor(t.listId)));
  // A task waiting for this agent stops ringing the doorbell once the agent has seen it here.
  if (caller.agentId && sections.up_next.length) {
    const unseen = sections.up_next.filter((t: Row) => !t.agentSeenAt).map((t: Row) => t.id);
    if (unseen.length) await tx.taskItem.updateMany({ where: { id: { in: unseen }, agentSeenAt: null }, data: { agentSeenAt: now } });
  }
  const view = (t: Row) => viewOf(t, { actor: actorFor(t.listId), names, list: refFor(t.listId), member: memberFor(t.listId), now });
  return {
    lists: (lists as Row[]).map((l) => ({ id: l.id, name: l.name, emoji: l.emoji ?? null, shared: shared(l.id) })),
    doing: sections.doing.map(view),
    up_next: sections.up_next.map(view),
    claimable: sections.claimable.map(view),
    waiting_on_you: sections.waiting_on_you.map(view),
    done_recently: sections.done_recently.map(view),
  };
}

async function opSearch({ tx, caller, input, now }: Ctx) {
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
  for (const t of rows as Row[]) settled.push(await settleLapse(tx, t, now));
  const names = await loadNames(tx, settled);
  const views = [];
  const cache = new Map<string, Awaited<ReturnType<typeof standing>>>();
  for (const t of settled) {
    if (!cache.has(t.listId)) cache.set(t.listId, await standing(tx, caller, t.listId));
    const s = cache.get(t.listId);
    if (!s) continue;
    views.push(viewOf(t, { actor: s.actor, names, list: listRef(s), member: s.member, now }));
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

async function opAddTasks({ tx, caller, input, now, after }: Ctx) {
  const s = input.list_id !== undefined ? await standing(tx, caller, String(input.list_id)) : await resolveList(tx, caller, input.list);
  if (!s) return NOT_AVAILABLE();
  writable(s);
  if (!R.canWork(s.actor)) fail(403, "not_allowed", s.actor.agentId ? "Your person hasn't given this agent work access to this list." : "You can't add tasks to this list.");
  const items: Input[] = Array.isArray(input.tasks) ? (input.tasks as Input[]) : [{ title: input.title, notes: input.notes, assignee: input.assignee, due: input.due }];
  if (!items.length || items.length > R.LIMITS.batchAdd) fail(400, "invalid_tasks", `Add between 1 and ${R.LIMITS.batchAdd} tasks at a time.`);
  const open = await tx.taskItem.count({ where: { listId: s.list.id, status: { in: [...R.ACTIVE] } } });
  if (open + items.length > R.LIMITS.openTasksPerList) fail(429, "too_many_tasks", `This list already has ${open} open tasks. Finish or drop some first.`);
  const last = await tx.taskItem.findFirst({ where: { listId: s.list.id }, orderBy: { position: "desc" }, select: { position: true } });
  let position = (last as Row | null)?.position ?? null;
  const created: Row[] = [];
  let ringAgents = false;
  for (const item of items) {
    if (!item || typeof item !== "object") fail(400, "invalid_tasks", "Each task needs a title.");
    const title = R.cleanText(item.title, { field: "title", max: R.LIMITS.title, required: true, singleLine: true })!;
    const notes = R.cleanText(item.notes, { field: "notes", max: R.LIMITS.notes }) ?? "";
    const dueAt = R.parseDue(item.due, now) ?? null;
    const assignee = await assigneeColumns(tx, caller, s.list.id, item.assignee);
    position = R.nextPosition(position);
    const task = await tx.taskItem.create({
      data: {
        listId: s.list.id, title, notes, position, dueAt, createdByAccountId: caller.accountId, createdByAgentId: caller.agentId,
        ...(assignee ?? {}),
      },
    });
    await addEvent(tx, task.id, caller, "created");
    if (forAgents(assignee)) ringAgents = true;
    created.push(task as Row);
  }
  if (ringAgents) after.push(() => fireInboxEvent(caller.accountId, "task"));
  const names = await loadNames(tx, created);
  return { tasks: created.map((t) => viewOf(t, { actor: s.actor, names, list: listRef(s), member: s.member, now })) };
}

async function taskResult(tx: Tx, s: { actor: Actor; member: Row; list: Row; shared: boolean }, taskId: string, now: Date, withEntries = false) {
  const task = (await tx.taskItem.findFirst({ where: { id: taskId } })) as Row;
  const entries = withEntries
    ? ((await tx.taskEntry.findMany({ where: { taskId }, orderBy: { createdAt: "desc" }, take: 50 })) as Row[]).reverse()
    : [];
  const names = await loadNames(tx, [task, ...entries]);
  const view: Row = viewOf(task, { actor: s.actor, names, list: listRef(s), member: s.member, now });
  if (withEntries) view.entries = entries.map((e) => R.entryView(e, { actor: s.actor, names: names as never }));
  return { task: view };
}

async function opGetTask({ tx, caller, input, now }: Ctx) {
  const s = await loadTask(tx, caller, input.task_id, now);
  return taskResult(tx, s, s.task.id, now, true);
}

async function opEntries({ tx, caller, input, now }: Ctx) {
  const s = await loadTask(tx, caller, input.task_id, now);
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

async function opAddEntry({ tx, caller, input, now }: Ctx) {
  const s = await loadTask(tx, caller, input.task_id, now);
  writable(s);
  const kind = input.kind === "progress" ? "progress" : input.kind === "comment" || input.kind === undefined ? "comment" : fail(400, "invalid_kind", "kind must be comment or progress");
  if (kind === "progress" ? !R.canWork(s.actor) : !R.canComment(s.actor)) fail(403, "not_allowed", "You can't write on this task.");
  const text = R.cleanText(input.text, { field: "text", max: R.LIMITS.entry, required: true })!;
  await guardEntryRoom(tx, s.task.id);
  await tx.taskEntry.create({ data: { taskId: s.task.id, kind, authorAccountId: caller.accountId, authorAgentId: caller.agentId, body: text } });
  await tx.taskItem.updateMany({ where: { id: s.task.id }, data: { updatedAt: now } });
  await renewIfClaimant(tx, s.task, s.actor, now);
  return taskResult(tx, s, s.task.id, now);
}

async function opClaim({ tx, caller, input, now }: Ctx) {
  const s = await loadTask(tx, caller, input.task_id, now);
  writable(s);
  const names = await loadNames(tx, [s.task]);
  const check = R.claimCheck(s.task, s.actor, now, mayActFor(s.task, caller.accountId, s.member, names), holderLabel(names, s.actor));
  if (!check.ok) {
    const holder = check.code === "already_claimed" ? R.who(names as never, s.task.claimAccountId, s.task.claimAgentId, s.actor) : undefined;
    return fail(409, check.code!, check.why!, holder ? { claim: { by: holder, since: s.task.claimedAt } } : undefined);
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
  } else {
    await renewIfClaimant(tx, s.task, s.actor, now);
  }
  return taskResult(tx, s, s.task.id, now);
}

async function opRelease({ tx, caller, input, now }: Ctx) {
  const s = await loadTask(tx, caller, input.task_id, now);
  writable(s);
  const reason = R.cleanText(input.reason, { field: "reason", max: 1_000 });
  const owner = R.canManage(s.actor);
  if (!R.hasLiveClaim(s.task, now)) fail(409, "not_claimed", "Nobody is on this task.");
  if (!R.isClaimant(s.task, s.actor) && !owner) fail(403, "not_claimant", "Only whoever is on it (or the list's owner) can let it go.");
  await tx.taskItem.updateMany({ where: { id: s.task.id }, data: R.releasePatch(s.task) });
  await addEvent(tx, s.task.id, caller, "released", reason);
  return taskResult(tx, s, s.task.id, now);
}

async function opDone({ tx, caller, input, now }: Ctx) {
  const s = await loadTask(tx, caller, input.task_id, now);
  writable(s);
  const names = await loadNames(tx, [s.task]);
  const check = R.finishCheck(s.task, s.actor, now, mayActFor(s.task, caller.accountId, s.member, names), R.canManage(s.actor), holderLabel(names, s.actor));
  if (!check.ok) fail(409, check.code!, check.why!);
  let summary = R.cleanText(input.summary, { field: "summary", max: R.LIMITS.summary });
  const evidence = R.cleanText(input.evidence, { field: "evidence", max: 2_000 });
  if (evidence) summary = `${summary ?? ""}${summary ? "\n\n" : ""}Evidence: ${evidence}`.slice(0, R.LIMITS.summary);
  const patch = R.donePatch(s.task, s.actor, now, summary);
  await tx.taskItem.updateMany({ where: { id: s.task.id }, data: patch });
  await addEvent(tx, s.task.id, caller, patch.status === "needs_review" ? "needs_review" : "done");
  return taskResult(tx, s, s.task.id, now);
}

async function opReview({ tx, caller, input, now }: Ctx) {
  const s = await loadTask(tx, caller, input.task_id, now);
  writable(s);
  const verdict = input.verdict === "accept" || input.verdict === "send_back" ? input.verdict : fail(400, "invalid_verdict", "verdict must be accept or send_back");
  const check = R.reviewCheck(s.task, s.actor, now, verdict, R.canManage(s.actor));
  if (!check.ok) fail(409, check.code!, check.why!);
  const comment = R.cleanText(input.comment, { field: "comment", max: R.LIMITS.entry, required: verdict === "send_back" });
  await tx.taskItem.updateMany({ where: { id: s.task.id }, data: R.reviewPatch(s.task, verdict, now) });
  if (comment) await tx.taskEntry.create({ data: { taskId: s.task.id, kind: "comment", authorAccountId: caller.accountId, authorAgentId: null, body: comment } });
  await addEvent(tx, s.task.id, caller, verdict === "accept" ? "accepted" : "sent_back");
  return taskResult(tx, s, s.task.id, now);
}

async function opUpdateTask({ tx, caller, input, now, after }: Ctx) {
  const s = await loadTask(tx, caller, input.task_id, now);
  writable(s);
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

  const assignee = await assigneeColumns(tx, caller, s.list.id, input.assignee);
  if (assignee) {
    Object.assign(data, assignee);
    events.push(["assigned", undefined]);
    if (forAgents(assignee)) after.push(() => fireInboxEvent(caller.accountId, "task"));
  }

  if (input.status !== undefined) {
    const change = String(input.status);
    if (!["blocked", "unblocked", "dropped", "restored", "reopened"].includes(change)) {
      fail(400, "invalid_status", "status here is blocked, unblocked, dropped, restored or reopened. Use bc_task_claim to pick up or let go, and bc_task_done to finish.");
    }
    const reason = R.cleanText(input.reason, { field: "reason", max: 1_000, required: change === "blocked" });
    const result = R.statusChange(task, s.actor, now, change as never, R.canManage(s.actor));
    if (!result.ok) fail(409, result.code, result.why);
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
    await tx.taskEntry.create({ data: { taskId: task.id, kind: "progress", authorAccountId: caller.accountId, authorAgentId: caller.agentId, body: progress } });
    if (!Object.keys(data).length) await tx.taskItem.updateMany({ where: { id: task.id }, data: { updatedAt: now } });
  }
  for (const [type, detail] of events) await addEvent(tx, task.id, caller, type, detail);
  const fresh = (await tx.taskItem.findFirst({ where: { id: task.id } })) as Row;
  await renewIfClaimant(tx, fresh, s.actor, now);
  return taskResult(tx, s, task.id, now);
}

const OPS: Record<ListsOp, (ctx: Ctx) => Promise<unknown>> = {
  lists: opLists, createList: opCreateList, getList: opGetList, updateList: opUpdateList, setAgentAccess: opSetAgentAccess,
  plate: opPlate, search: opSearch, changes: opChanges, tasks: opSearch, addTasks: opAddTasks, getTask: opGetTask,
  updateTask: opUpdateTask, claim: opClaim, release: opRelease, done: opDone, review: opReview, entries: opEntries, addEntry: opAddEntry,
};

/** Run one operation for whoever is calling. Shared by the REST route and the MCP tools. */
export async function lists(req: NextRequest, op: ListsOp, input: Input): Promise<NextResponse> {
  try {
    const caller = await resolveCaller(req);
    const write = WRITES.has(op);
    const limit = rateLimit(write ? "lists-write" : "lists-read", caller.agentId ?? caller.accountId, write ? 60 : 240, 60_000);
    if (!limit.ok) {
      const res = respond({ error: "rate_limited", message: "Too many list changes at once. Wait a moment and retry." }, 429);
      res.headers.set("Retry-After", String(limit.retryAfterSec));
      return res;
    }
    const after: Array<() => void> = [];
    const result = await withSerializableRetry(
      () => {
        after.length = 0;
        return prisma.$transaction((tx: Tx) => OPS[op]({ tx, caller, input, now: new Date(), after }), { isolationLevel: "Serializable" });
      },
      { retryable: conflict },
    );
    for (const fn of after) fn();
    return respond(result);
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
 *   GET    /api/lists/:id                 getList         PATCH /api/lists/:id          updateList
 *   PUT    /api/lists/:id/agents          setAgentAccess  (people only)
 *   GET    /api/lists/:id/tasks           tasks           POST /api/lists/:id/tasks     addTasks
 *   GET    /api/lists/tasks/:taskId       getTask         PATCH /api/lists/tasks/:taskId updateTask
 *   POST   /api/lists/tasks/:taskId/{claim,release,done,review}
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
  else if (a === "tasks" && b) {
    const withId = async (i: Input) => ({ ...i, task_id: b });
    if (!c) route = m === "GET" ? ["getTask", { task_id: b }] : m === "PATCH" ? ["updateTask", async () => withId(await body())] : null;
    else if (c === "entries") route = m === "GET" ? ["entries", { ...query, task_id: b }] : m === "POST" ? ["addEntry", async () => withId(await body())] : null;
    else if (["claim", "release", "done", "review"].includes(c) && m === "POST") route = [c as ListsOp, async () => withId(await body())];
  } else if (a !== "tasks") {
    const withList = async (i: Input) => ({ ...i, list_id: a });
    if (!b) route = m === "GET" ? ["getList", { list_id: a }] : m === "PATCH" ? ["updateList", async () => withList(await body())] : null;
    else if (b === "agents" && m === "PUT") route = ["setAgentAccess", async () => withList(await body())];
    else if (b === "tasks") route = m === "GET" ? ["tasks", { ...query, list_id: a }] : m === "POST" ? ["addTasks", async () => withList(await body())] : null;
  }
  // Each endpoint has a fixed depth. A longer path is an unknown endpoint, not the shorter one:
  // GET /api/lists/:id/tasks/:taskId must not quietly answer with the whole list.
  if (path.length > (a === "tasks" ? 3 : 2)) route = null;
  if (!route) return respond({ error: "not_found", message: "No such lists endpoint." }, 404);
  try {
    const [op, input] = route;
    return await lists(req, op, typeof input === "function" ? await input() : input);
  } catch (e) {
    if (e instanceof R.ListRuleError) return respond({ error: e.code, message: e.message }, e.status);
    throw e;
  }
}

// ── MCP: the bc_task* tools (catalog in src/lib/mcp/list-tools.mjs) ─────────

const TOOL_OPS: Record<string, (args: Input) => [ListsOp, Input]> = {
  bc_tasks: (args) => (args.list !== undefined || args.status !== undefined || args.q !== undefined ? ["search", { q: args.q, status: args.status, list_id: args.list }] : ["plate", {}]),
  bc_task_get: (args) => ["getTask", { task_id: args.task_id }],
  bc_task_add: (args) => ["addTasks", args],
  bc_task_claim: (args) => [args.action === "release" ? "release" : "claim", { task_id: args.task_id, reason: args.reason }],
  bc_task_update: (args) => ["updateTask", args],
  bc_task_done: (args) => ["done", { task_id: args.task_id, summary: args.summary, evidence: args.evidence }],
  bc_task_comment: (args) => ["addEntry", { task_id: args.task_id, kind: "comment", text: args.text }],
  bc_list_create: (args) => ["createList", { name: args.name, emoji: args.emoji }],
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
 * Doorbell helper for bc_check_inbox: open tasks waiting for this account's
 * agents that none of them has seen yet. Best effort: a failure reads as 0.
 */
export async function tasksWaitingForAgents(accountId: string): Promise<number> {
  try {
    return await prisma.taskItem.count({
      where: { assigneeAccountId: accountId, status: "open", agentSeenAt: null, OR: [{ assigneeAgents: true }, { assigneeAgentId: { not: null } }], list: { archivedAt: null } },
    });
  } catch {
    return 0;
  }
}
