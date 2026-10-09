/**
 * Shared harness for the Lists route tests (lists.routetest.mts, lists-mcp.routetest.mts,
 * lists-sharing.routetest.mts, lists-phase3.routetest.mts).
 * Not a test file itself (the route-test glob is *.routetest.mts).
 *
 * An in-memory Prisma that supports exactly what src/lib/lists.ts uses, and is
 * strict about it: unknown fields, unsupported filter operators or query
 * arguments, missing required columns and wrong column types all throw, the
 * way Prisma would, so a typo in lists.ts can't pass silently.
 *
 * Transactions model PostgreSQL SERIALIZABLE closely enough for claims: each
 * transaction works on its own snapshot (read-your-own-writes), and at commit
 * the first committer wins: if any row it wrote was committed by someone else
 * after its snapshot, it aborts with Prisma's P2034, which lists.ts retries.
 * Reads are not tracked (no predicate locks), so this is snapshot isolation;
 * write skew across different rows is not detected. txMode "live" instead runs
 * every statement against the committed rows (READ COMMITTED with an undo log
 * for rollback), to prove the conditional claim write holds on its own.
 *
 * Unique keys (primary keys, @unique columns, and the migration's COALESCE
 * unique indexes, where NULL counts as one value) raise P2002 on a duplicate,
 * and the migrations' CHECK constraints are enforced on every write.
 *
 * mock.module() may be called once per specifier per process: each test file
 * calls installMocks() once in before(), and per-test behaviour is driven by
 * mutating `state`.
 */
import { mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";

export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export type Table =
  | "taskList" | "taskListMember" | "taskListAgentGrant" | "taskItem" | "taskEntry" | "account" | "agentToken"
  | "taskAgentOk" | "taskMention" | "taskReaction" | "taskListEvent" | "trustedPeer" | "accountAudit" | "viewToken"
  | "taskListTemplate" | "listsPreference";
type Store = Record<Table, Row[]>;
type Kind = "string" | "int" | "float" | "bool" | "date" | "json";
type Field = { kind: Kind; optional?: boolean; def?: () => unknown; updatedAt?: boolean };

// Strictly increasing timestamps, so "latest" is never a tie between two rows written in the same millisecond.
let lastTick = 0;
export function tick(): Date {
  lastTick = Math.max(Date.now(), lastTick + 1);
  return new Date(lastTick);
}
/** Wait until the wall clock has passed every timestamp tick() handed out. */
export async function catchUpClock() {
  await new Promise((r) => setTimeout(r, Math.max(0, lastTick - Date.now()) + 5));
}

const F = (kind: Kind, extra: Partial<Field> = {}): Field => ({ kind, ...extra });
const opt = (kind: Kind): Field => F(kind, { optional: true });
type Model = {
  pk: string[];
  fields: Record<string, Field>;
  relations?: Record<string, [Table, string, string]>;
  /** Other unique keys. NULL counts as one value, like the migration's COALESCE unique indexes. */
  unique?: string[][];
  /** The migrations' CHECK constraints, by name. */
  checks?: Record<string, (row: Row) => boolean>;
};
const oneOf = (k: string, values: string[]) => (r: Row) => values.includes(r[k]);
const MODELS: Record<Table, Model> = {
  taskList: {
    pk: ["id"],
    fields: {
      id: F("string", { def: randomUUID }), ownerAccountId: F("string"), name: F("string"), emoji: opt("string"), archivedAt: opt("date"),
      createdAt: F("date", { def: tick }), updatedAt: F("date", { updatedAt: true }),
    },
  },
  taskListMember: {
    pk: ["listId", "accountId"],
    fields: {
      listId: F("string"), accountId: F("string"), role: F("string"), agentsTakeFrom: F("string", { def: () => "me" }),
      notify: F("string", { def: () => "off" }), addedByAccountId: F("string"), joinedAt: F("date", { def: tick }),
    },
    relations: { list: ["taskList", "listId", "id"] },
    checks: {
      TaskListMember_role_check: oneOf("role", ["owner", "member"]),
      TaskListMember_agentsTakeFrom_check: oneOf("agentsTakeFrom", ["me", "anyone"]),
      TaskListMember_notify_check: oneOf("notify", ["off", "mentions_reviews"]),
    },
  },
  taskListAgentGrant: {
    pk: ["listId", "agentTokenId"],
    fields: { listId: F("string"), agentTokenId: F("string"), accountId: F("string"), access: F("string"), createdAt: F("date", { def: tick }) },
    relations: { list: ["taskList", "listId", "id"] },
    checks: { TaskListAgentGrant_access_check: oneOf("access", ["view", "work"]) },
  },
  taskItem: {
    pk: ["id"],
    fields: {
      id: F("string", { def: randomUUID }), listId: F("string"), title: F("string"), notes: F("string", { def: () => "" }),
      version: F("int", { def: () => 1 }), status: F("string", { def: () => "open" }), position: F("float"), dueAt: opt("date"),
      createdByAccountId: F("string"), createdByAgentId: opt("string"), assigneeAccountId: opt("string"),
      assigneeAgents: F("bool", { def: () => false }), assigneeAgentId: opt("string"), agentSeenAt: opt("date"),
      claimAccountId: opt("string"), claimAgentId: opt("string"), claimedAt: opt("date"), claimExpiresAt: opt("date"),
      reviewerAccountId: opt("string"), completedAt: opt("date"), completedByAccountId: opt("string"), completedByAgentId: opt("string"),
      summary: opt("string"), createdAt: F("date", { def: tick }), updatedAt: F("date", { updatedAt: true }),
    },
    relations: { list: ["taskList", "listId", "id"] },
  },
  taskEntry: {
    pk: ["id"],
    fields: {
      id: F("string", { def: randomUUID }), taskId: F("string"), kind: F("string"), authorAccountId: F("string"), authorAgentId: opt("string"),
      body: F("string"), eventType: opt("string"), createdAt: F("date", { def: tick }),
    },
    relations: { task: ["taskItem", "taskId", "id"] },
    checks: {
      TaskEntry_kind_check: oneOf("kind", ["comment", "progress", "event"]),
      TaskEntry_body_size: (r) => [...r.body].length >= 1 && [...r.body].length <= 8000,
    },
  },
  account: {
    pk: ["id"],
    fields: {
      id: F("string", { def: randomUUID }), handle: F("string"), displayName: opt("string"), email: opt("string"), emailVerifiedAt: opt("date"),
      notifyIdleFrames: F("bool", { def: () => true }), createdAt: F("date", { def: tick }),
    },
    unique: [["handle"]],
  },
  agentToken: {
    pk: ["id"],
    fields: {
      id: F("string", { def: randomUUID }), accountId: F("string"), keyHash: F("string"), name: F("string"), runtimeType: F("string", { def: () => "other" }),
      createdAt: F("date", { def: tick }), lastUsedAt: opt("date"), revokedAt: opt("date"), scope: F("string", { def: () => "full" }),
    },
  },
  // Lists Phase 2 (migration 20261009210000_task_lists_sharing).
  taskAgentOk: {
    pk: ["taskId", "accountId"],
    fields: { taskId: F("string"), accountId: F("string"), via: F("string"), viaAgentId: opt("string"), createdAt: F("date", { def: tick }) },
    relations: { task: ["taskItem", "taskId", "id"] },
    checks: {
      TaskAgentOk_via_check: oneOf("via", ["web", "user_in_chat", "list_setting"]),
      TaskAgentOk_chat_agent: (r) => r.via !== "user_in_chat" || r.viaAgentId !== null,
    },
  },
  taskMention: {
    pk: ["id"],
    fields: {
      id: F("string", { def: randomUUID }), entryId: F("string"), taskId: F("string"), accountId: F("string"), agentId: opt("string"),
      seenAt: opt("date"), createdAt: F("date", { def: tick }),
    },
    relations: { task: ["taskItem", "taskId", "id"], entry: ["taskEntry", "entryId", "id"] },
    unique: [["entryId", "accountId", "agentId"]],
  },
  taskReaction: {
    pk: ["id"],
    fields: {
      id: F("string", { def: randomUUID }), taskId: F("string"), accountId: F("string"), agentId: opt("string"), emoji: F("string"),
      createdAt: F("date", { def: tick }),
    },
    relations: { task: ["taskItem", "taskId", "id"] },
    unique: [["taskId", "accountId", "agentId", "emoji"]],
    checks: { TaskReaction_emoji_check: oneOf("emoji", ["\u{1F44D}", "\u{1F389}", "\u{1F64F}", "\u2705"]) },
  },
  taskListEvent: {
    pk: ["id"],
    fields: {
      id: F("string", { def: randomUUID }), listId: F("string"), eventType: F("string"), actorAccountId: F("string"), subjectAccountId: F("string"),
      createdAt: F("date", { def: tick }),
    },
    relations: { list: ["taskList", "listId", "id"] },
    checks: { TaskListEvent_eventType_check: oneOf("eventType", ["member_added", "member_left", "member_removed"]) },
  },
  // Lists Phase 3 (migration 20261009230000_task_lists_phase3). Both reference Account in SQL only.
  taskListTemplate: {
    pk: ["id"],
    fields: {
      id: F("string", { def: randomUUID }), ownerAccountId: F("string"), name: F("string"), emoji: opt("string"), items: F("json"),
      createdAt: F("date", { def: tick }),
    },
    checks: {
      TaskListTemplate_name_size: (r) => [...r.name].length >= 1 && [...r.name].length <= 80,
      TaskListTemplate_emoji_size: (r) => r.emoji === null || ([...r.emoji].length >= 1 && [...r.emoji].length <= 16),
      TaskListTemplate_items_shape: (r) => Array.isArray(r.items) && r.items.length >= 1 && r.items.length <= 200,
      TaskListTemplate_items_size: (r) => Buffer.byteLength(JSON.stringify(r.items), "utf8") <= 1_000_000,
    },
  },
  listsPreference: {
    pk: ["accountId"],
    fields: {
      accountId: F("string"), digest: F("string", { def: () => "off" }), digestHour: F("int", { def: () => 8 }), timezone: opt("string"),
      lastDigestAt: opt("date"),
    },
    checks: {
      ListsPreference_digest_check: oneOf("digest", ["off", "daily"]),
      ListsPreference_digestHour_check: (r) => r.digestHour >= 0 && r.digestHour <= 23,
      ListsPreference_timezone_size: (r) => r.timezone === null || (r.timezone.length >= 1 && r.timezone.length <= 64),
    },
  },
  // Outside Lists: friendship (src/app/api/trust/*), the audit log, and one-time sign-in links.
  trustedPeer: {
    pk: ["id"],
    fields: {
      id: F("string", { def: randomUUID }), accountId: F("string"), trustedAccountId: F("string"), establishedAt: F("date", { def: tick }),
      lastUsedAt: opt("date"),
    },
    unique: [["accountId", "trustedAccountId"]],
  },
  accountAudit: {
    pk: ["id"],
    fields: { id: F("string", { def: randomUUID }), accountId: F("string"), eventType: F("string"), detail: F("json"), createdAt: F("date", { def: tick }) },
  },
  viewToken: {
    pk: ["token"],
    fields: {
      token: F("string"), accountId: F("string"), purpose: F("string", { def: () => "account" }), createdAt: F("date", { def: tick }),
      expiresAt: F("date"), usedAt: opt("date"),
    },
  },
};
export const TABLES = Object.keys(MODELS) as Table[];
const emptyStore = (): Store => Object.fromEntries(TABLES.map((t) => [t, []])) as unknown as Store;

// ── state the tests drive ────────────────────────────────────────────────────

export const state = {
  db: emptyStore(),
  versions: new Map<string, number>(), // row key → commit sequence that last wrote it
  seq: 0,
  txMode: "serializable" as "serializable" | "live",
  txCalls: 0,
  /** One per attempt, raised at COMMIT after the callback ran (its writes discarded), like a Postgres abort. */
  txFaults: [] as unknown[],
  barrier: null as null | { need: number; arrived: number; open: () => void; opened: Promise<void> },
  /** fireInboxEvent calls, with how many tasks were COMMITTED when it fired. */
  fired: [] as Array<{ accountId: string; kind: string; committedTasks: number }>,
  /** sendListNudgeEmail calls, as the email module received them. */
  emails: [] as Row[],
  /** sendListDigestEmail calls (Phase 3), and what the sender answers (false: log-only or refused). */
  digests: [] as Row[],
  digestSendOk: true,
  rateLimited: false,
};

/** Hold transactions at their start until `need` of them have taken their snapshot, then let them all run. */
export function holdUntil(need: number) {
  let open = () => {};
  const opened = new Promise<void>((r) => { open = r; });
  state.barrier = { need, arrived: 0, open, opened };
}

export const serializationFailure = () =>
  new PrismaClientKnownRequestError("Transaction failed due to a write conflict or a deadlock. Please retry your transaction", { code: "P2034", clientVersion: "5.22.0" });

// ── the in-memory client ─────────────────────────────────────────────────────

const isFilter = (v: unknown): v is Row => v !== null && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v);
const scalar = (v: unknown) => (v instanceof Date ? v.getTime() : v);
function eq(a: unknown, b: unknown) {
  if (b === null) return a === null || a === undefined;
  if (b instanceof Date || a instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  return a === b;
}
function cmp(a: unknown, b: unknown, what: string) {
  const x = scalar(a), y = scalar(b);
  assert.equal(typeof x, typeof y, `comparing ${what}: ${typeof x} with ${typeof y} (pass a Date for a DateTime column)`);
  return (x as number) < (y as number) ? -1 : (x as number) > (y as number) ? 1 : 0;
}

function matchField(val: unknown, filter: unknown, name: string): boolean {
  if (!isFilter(filter)) return eq(val, filter);
  const insensitive = filter.mode === "insensitive";
  if (filter.mode !== undefined) assert.ok(insensitive && "contains" in filter, `${name}: mode only with contains`);
  for (const [op, arg] of Object.entries(filter)) {
    if (arg === undefined || op === "mode") continue;
    const isNull = val === null || val === undefined;
    switch (op) {
      case "equals": if (!eq(val, arg)) return false; break;
      case "not":
        assert.ok(!isFilter(arg), `${name}: nested not filters are unsupported`);
        // SQL semantics: NOT NULL for null, and `col <> x` is never true for a NULL column.
        if (arg === null ? isNull : isNull || eq(val, arg)) return false;
        break;
      case "in":
        assert.ok(Array.isArray(arg), `${name}: in needs an array`);
        if (isNull || !arg.some((x: unknown) => eq(val, x))) return false;
        break;
      case "gt": case "gte": case "lt": case "lte": {
        if (isNull || arg === null) return false; // NULL compares as unknown
        const c = cmp(val, arg, name);
        if (!(op === "gt" ? c > 0 : op === "gte" ? c >= 0 : op === "lt" ? c < 0 : c <= 0)) return false;
        break;
      }
      case "contains":
        assert.equal(typeof arg, "string", `${name}: contains needs text`);
        if (typeof val !== "string") return false;
        if (!(insensitive ? val.toLowerCase().includes((arg as string).toLowerCase()) : val.includes(arg as string))) return false;
        break;
      default:
        assert.fail(`unsupported filter operator ${op} on ${name}`);
    }
  }
  return true;
}

function matchWhere(db: Store, table: Table, row: Row, where: unknown): boolean {
  if (where === undefined) return true;
  assert.ok(isFilter(where), `${table}: where must be an object`);
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    if (k === "AND" || k === "NOT") {
      const all = (Array.isArray(v) ? v : [v]).map((w) => matchWhere(db, table, row, w));
      if (k === "AND" ? !all.every(Boolean) : all.some(Boolean)) return false;
      continue;
    }
    if (k === "OR") {
      assert.ok(Array.isArray(v), `${table}: OR needs an array`);
      if (!v.some((w) => matchWhere(db, table, row, w))) return false;
      continue;
    }
    const rel = MODELS[table].relations?.[k];
    if (rel) {
      const [target, fk, ref] = rel;
      const other = db[target].find((r) => r[ref] === row[fk]);
      if (!other || !matchWhere(db, target, other, v)) return false;
      continue;
    }
    assert.ok(k in MODELS[table].fields, `unknown column ${table}.${k} in where`);
    if (!matchField(row[k], v, `${table}.${k}`)) return false;
  }
  return true;
}

function sortRows(table: Table, rows: Row[], orderBy: unknown): Row[] {
  if (orderBy === undefined) return rows;
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) => Object.entries(o as Row));
  for (const [k, dir] of keys) {
    assert.ok(k in MODELS[table].fields, `unknown column ${table}.${k} in orderBy`);
    assert.ok(dir === "asc" || dir === "desc", `orderBy ${k}: ${String(dir)}`);
  }
  return rows
    .map((r, i) => [r, i] as const)
    .sort(([a, ia], [b, ib]) => {
      for (const [k, dir] of keys) {
        const an = a[k] === null || a[k] === undefined, bn = b[k] === null || b[k] === undefined;
        if (an && bn) continue;
        // PostgreSQL: NULLS LAST ascending, NULLS FIRST descending.
        if (an || bn) return (an ? 1 : -1) * (dir === "asc" ? 1 : -1);
        const c = cmp(a[k], b[k], `${table}.${k}`);
        if (c) return dir === "asc" ? c : -c;
      }
      return ia - ib;
    })
    .map(([r]) => r);
}

function project(table: Table, row: Row, select: unknown): Row {
  if (select === undefined) return structuredClone(row);
  const out: Row = {};
  for (const [k, on] of Object.entries(select as Row)) {
    assert.ok(k in MODELS[table].fields, `unknown column ${table}.${k} in select`);
    if (on === true) out[k] = structuredClone(row[k]);
  }
  return out;
}

function checkArgs(table: Table, op: string, args: Row, allowed: string[]) {
  for (const k of Object.keys(args ?? {})) assert.ok(allowed.includes(k), `${table}.${op}: unsupported argument ${k}`);
}

function checkValue(table: Table, k: string, v: unknown): unknown {
  const field = MODELS[table].fields[k];
  assert.ok(field, `unknown column ${table}.${k} in data`);
  if (v === null) {
    assert.ok(field.optional, `${table}.${k} is required and can't be null`);
    return null;
  }
  if (field.kind === "json") return structuredClone(v);
  assert.ok(!isFilter(v), `${table}.${k}: atomic update operators are unsupported here`);
  const ok = { string: typeof v === "string", int: Number.isInteger(v), float: typeof v === "number" && Number.isFinite(v), bool: typeof v === "boolean", date: v instanceof Date && Number.isFinite(v.getTime()) }[field.kind];
  assert.ok(ok, `${table}.${k} must be ${field.kind}, got ${JSON.stringify(v)}`);
  return v instanceof Date ? new Date(v.getTime()) : v;
}

export const rowKey = (table: Table, row: Row) => `${table}|${MODELS[table].pk.map((k) => row[k]).join("|")}`;

function uniqueViolation(table: Table, fields = MODELS[table].pk) {
  return new PrismaClientKnownRequestError(`Unique constraint failed on the fields: (${fields.join(",")})`, { code: "P2002", clientVersion: "5.22.0" });
}

/** Raise what PostgreSQL would for a row that breaks a unique key or a CHECK constraint. */
function checkRow(table: Table, rowsNow: Row[], row: Row) {
  for (const [name, holds] of Object.entries(MODELS[table].checks ?? {})) {
    if (!holds(row)) {
      throw new PrismaClientKnownRequestError(`new row for relation violates check constraint "${name}"`, { code: "P2010", clientVersion: "5.22.0", meta: { code: "23514" } });
    }
  }
  for (const fields of MODELS[table].unique ?? []) {
    const key = (r: Row) => JSON.stringify(fields.map((f) => scalar(r[f] ?? null)));
    if (rowsNow.some((r) => r !== row && key(r) === key(row))) throw uniqueViolation(table, fields);
  }
}

/**
 * findUnique's where: the primary key, one @unique column ({ handle }), or a compound unique by
 * Prisma's generated name ({ accountId_trustedAccountId: { accountId, trustedAccountId } }).
 */
function uniqueWhere(table: Table, where: Row): Row {
  const keys = Object.keys(where ?? {}).sort();
  const sets = [MODELS[table].pk, ...(MODELS[table].unique ?? [])];
  const compound = keys.length === 1 ? sets.find((f) => f.length > 1 && f.join("_") === keys[0]) : undefined;
  if (compound) {
    const inner = where[keys[0]] as Row;
    assert.deepEqual(Object.keys(inner).sort(), [...compound].sort(), `${table}.findUnique ${keys[0]} needs ${compound.join(", ")}`);
    return inner;
  }
  assert.ok(sets.some((f) => JSON.stringify([...f].sort()) === JSON.stringify(keys)), `${table}.findUnique needs the primary key or a unique key, got ${keys.join(", ")}`);
  return where;
}

type WriteLog = (table: Table, key: string, before: Row | null) => void;

function makeClient(getDb: () => Store, wrote: WriteLog) {
  const client: Row = {};
  for (const table of TABLES) {
    const fields = MODELS[table].fields;
    const all = () => getDb()[table];
    const find = (where: unknown) => all().filter((r) => matchWhere(getDb(), table, r, where));
    const stamp = (row: Row, data: Row) => {
      for (const [k, f] of Object.entries(fields)) if (f.updatedAt && !(k in data)) row[k] = tick();
    };
    const apply = (row: Row, data: Row) => {
      const before = structuredClone(row);
      for (const [k, v] of Object.entries(data)) {
        if (v === undefined) continue;
        if (MODELS[table].pk.includes(k)) assert.ok(eq(row[k], v), `${table}: primary key ${k} can't change`);
        row[k] = checkValue(table, k, v);
      }
      stamp(row, data);
      checkRow(table, all(), row);
      wrote(table, rowKey(table, row), before);
    };
    client[table] = {
      findFirst: async (args: Row = {}) => {
        checkArgs(table, "findFirst", args, ["where", "orderBy", "select"]);
        const r = sortRows(table, find(args.where), args.orderBy)[0];
        return r ? project(table, r, args.select) : null;
      },
      findUnique: async (args: Row) => {
        checkArgs(table, "findUnique", args, ["where", "select"]);
        const r = find(uniqueWhere(table, args.where))[0];
        return r ? project(table, r, args.select) : null;
      },
      findMany: async (args: Row = {}) => {
        checkArgs(table, "findMany", args, ["where", "orderBy", "select", "take"]);
        if (args.take !== undefined) assert.ok(Number.isInteger(args.take) && args.take > 0, `${table}.findMany take`);
        return sortRows(table, find(args.where), args.orderBy).slice(0, args.take ?? Infinity).map((r) => project(table, r, args.select));
      },
      count: async (args: Row = {}) => {
        checkArgs(table, "count", args, ["where"]);
        return find(args.where).length;
      },
      groupBy: async (args: Row) => {
        checkArgs(table, "groupBy", args, ["by", "where", "_count"]);
        assert.deepEqual(args._count, { _all: true }, `${table}.groupBy: only _count._all is supported`);
        const groups = new Map<string, Row>();
        for (const r of find(args.where)) {
          const key = JSON.stringify(args.by.map((k: string) => r[k]));
          const g = groups.get(key) ?? { ...Object.fromEntries(args.by.map((k: string) => [k, r[k]])), _count: { _all: 0 } };
          g._count._all++;
          groups.set(key, g);
        }
        return [...groups.values()];
      },
      create: async (args: Row) => {
        checkArgs(table, "create", args, ["data", "select"]);
        const row: Row = {};
        for (const [k, f] of Object.entries(fields)) {
          const given = args.data[k];
          if (given !== undefined) row[k] = checkValue(table, k, given);
          else if (f.def) row[k] = f.def();
          else if (f.updatedAt) row[k] = tick();
          else {
            assert.ok(f.optional, `${table}.create: ${k} is required`);
            row[k] = null;
          }
        }
        for (const k of Object.keys(args.data)) assert.ok(k in fields, `unknown column ${table}.${k} in data`);
        const key = rowKey(table, row);
        if (all().some((r) => rowKey(table, r) === key)) throw uniqueViolation(table);
        checkRow(table, all(), row);
        all().push(row);
        wrote(table, key, null);
        return project(table, row, args.select);
      },
      update: async (args: Row) => {
        checkArgs(table, "update", args, ["where", "data"]);
        assert.deepEqual(Object.keys(args.where).sort(), [...MODELS[table].pk].sort(), `${table}.update needs the primary key`);
        const row = find(args.where)[0];
        if (!row) throw new PrismaClientKnownRequestError("Record to update not found.", { code: "P2025", clientVersion: "5.22.0" });
        apply(row, args.data);
        return structuredClone(row);
      },
      updateMany: async (args: Row) => {
        checkArgs(table, "updateMany", args, ["where", "data"]);
        const rows = find(args.where);
        for (const r of rows) apply(r, args.data);
        return { count: rows.length };
      },
      deleteMany: async (args: Row) => {
        checkArgs(table, "deleteMany", args, ["where"]);
        const doomed = find(args.where);
        for (const r of doomed) {
          all().splice(all().indexOf(r), 1);
          wrote(table, rowKey(table, r), structuredClone(r));
        }
        return { count: doomed.length };
      },
    };
  }
  return client;
}

async function arrive() {
  const b = state.barrier;
  if (!b) return;
  b.arrived++;
  if (b.arrived >= b.need) {
    state.barrier = null;
    b.open();
  }
  await b.opened;
}

function bump(key: string) {
  state.versions.set(key, ++state.seq);
}

/** Outside any transaction (e.g. tasksWaitingForAgents): straight to the committed rows. */
const direct = makeClient(() => state.db, (_t, key) => bump(key));

export const prisma: Row = {
  ...direct,
  $transaction: async (fn: unknown, options?: { isolationLevel?: string }) => {
    state.txCalls++;
    assert.equal(typeof fn, "function", "lists.ts uses interactive transactions only");
    assert.equal(options?.isolationLevel, "Serializable", "every Lists transaction must be Serializable");
    const run = fn as (tx: Row) => Promise<unknown>;
    if (state.txMode === "live") {
      const undo: Array<[Table, string, Row | null]> = [];
      await arrive();
      const tx = makeClient(() => state.db, (table, key, before) => { undo.push([table, key, before]); bump(key); });
      try {
        const result = await run(tx);
        const fault = state.txFaults.shift();
        if (fault) throw fault;
        return result;
      } catch (e) {
        for (const [table, key, before] of undo.reverse()) {
          const rows = state.db[table];
          const i = rows.findIndex((r) => rowKey(table, r) === key);
          if (before === null) { if (i >= 0) rows.splice(i, 1); } else if (i >= 0) rows[i] = before; else rows.push(before);
        }
        throw e;
      }
    }
    const startSeq = state.seq;
    const local = structuredClone(state.db);
    const written = new Map<string, Table>();
    await arrive();
    const result = await run(makeClient(() => local, (table, key) => written.set(key, table)));
    const fault = state.txFaults.shift();
    if (fault) throw fault;
    for (const key of written.keys()) if ((state.versions.get(key) ?? 0) > startSeq) throw serializationFailure();
    // Commit: copy each written row (or its deletion) into the committed store.
    for (const [key, table] of written) {
      const mine = local[table].find((r) => rowKey(table, r) === key);
      const rows = state.db[table];
      const i = rows.findIndex((r) => rowKey(table, r) === key);
      if (!mine) { if (i >= 0) rows.splice(i, 1); } else if (i >= 0) rows[i] = mine; else rows.push(mine);
      bump(key);
    }
    return result;
  },
};

// ── people, agents, auth ─────────────────────────────────────────────────────

export const A = { id: "acct-a", handle: "skylar", displayName: "Skylar" };
export const B = { id: "acct-b", handle: "alex", displayName: "Alex" };
/** Someone Skylar isn't friends with. Her handle is in the "@bc" form real accounts get. */
export const C = { id: "acct-c", handle: "carol@bc", displayName: "Carol" };
/** Skylar's agents. A3 is a connector key (claude.ai over OAuth). AR is revoked. */
export const A1 = "a1a1a1a1-0000-4000-8000-000000000001";
export const A2 = "a2a2a2a2-0000-4000-8000-000000000002";
export const A3 = "a3a3a3a3-0000-4000-8000-000000000003";
export const AR = "a4a4a4a4-0000-4000-8000-000000000004";
/** Alex's agents. B2 shares a name with Skylar's A1. */
export const B1 = "b1b1b1b1-0000-4000-8000-000000000001";
export const B2 = "b2b2b2b2-0000-4000-8000-000000000002";
/** Carol's agent. */
export const C1 = "c1c1c1c1-0000-4000-8000-000000000001";

export function resetStore() {
  state.db = emptyStore();
  state.versions = new Map();
  state.seq = 0;
  state.txMode = "serializable";
  state.txCalls = 0;
  state.txFaults = [];
  state.barrier = null;
  state.fired = [];
  state.emails = [];
  state.digests = [];
  state.digestSendOk = true;
  state.rateLimited = false;
  const t = tick();
  for (const p of [A, B, C]) {
    state.db.account.push({ ...p, email: `${p.handle.replace(/@bc$/, "")}@example.invalid`, emailVerifiedAt: t, notifyIdleFrames: true, createdAt: t });
  }
  const agent = (id: string, accountId: string, name: string, extra: Row = {}) =>
    state.db.agentToken.push({ id, accountId, keyHash: `hash-${id}`, name, runtimeType: "claude_code", createdAt: tick(), lastUsedAt: null, revokedAt: null, scope: "full", ...extra });
  agent(A1, A.id, "Claude Code");
  agent(A2, A.id, "Codex", { runtimeType: "codex" });
  agent(A3, A.id, "claude.ai", { scope: "connector", runtimeType: "other" });
  agent(AR, A.id, "Old laptop", { revokedAt: tick() });
  agent(B1, B.id, "Alex's Claude");
  agent(B2, B.id, "Claude Code");
  agent(C1, C.id, "Carol's Codex", { runtimeType: "codex" });
}

const SESSIONS: Record<string, typeof A> = { "sess-a": A, "sess-b": B, "sess-c": C };
export const SESSION_COOKIE_NAME = "bc_session";
export const CSRF_COOKIE_NAME = "bc_csrf";
export const CSRF_HEADER = "x-bc-csrf";

async function getAuthContext(header: string | null) {
  const token = /^Bearer (.+)$/.exec(header ?? "")?.[1];
  if (!token) return null;
  // A context with no agent identity (the shape a pre-per-agent key would have).
  if (token === "keyless") return { account: { ...A }, agentTokenId: null, scope: "full" };
  const agent = state.db.agentToken.find((a) => `key-${a.id}` === token && !a.revokedAt);
  if (!agent) return null;
  const account = state.db.account.find((a) => a.id === agent.accountId)!;
  return { account: { id: account.id, handle: account.handle, displayName: account.displayName }, agentTokenId: agent.id, scope: agent.scope };
}

export function installMocks({ mcp = false } = {}) {
  process.env.PUBLIC_APP_URL = "https://back-channel.app";
  mock.module("@/lib/db", { namedExports: { prisma } });
  mock.module("@/lib/auth", {
    namedExports: {
      getAuthContext,
      getAccountFromCookie: async (value: string | null | undefined) => (value ? SESSIONS[value] ?? null : null),
      csrfValid: (header: string | null | undefined, cookie: string | null | undefined) => !!header && !!cookie && header === cookie,
      SESSION_COOKIE_NAME,
      CSRF_COOKIE_NAME,
      CSRF_HEADER,
      // One-time sign-in links for email nudges.
      generateViewToken: () => `vt_${randomUUID()}`,
      hashToken: (raw: string) => `hash:${raw}`,
      viewTokenExpiry: () => new Date(Date.now() + 15 * 60_000),
    },
  });
  mock.module("@/lib/email", {
    namedExports: {
      sendListNudgeEmail: async (args: Row) => { state.emails.push(structuredClone(args)); return true; },
      sendListDigestEmail: async (args: Row) => { state.digests.push(structuredClone(args)); return state.digestSendOk; },
    },
  });
  mock.module("@/lib/rate-limit", { namedExports: { rateLimit: () => ({ ok: !state.rateLimited, retryAfterSec: 42 }) } });
  class TooManyWaitersError extends Error {}
  mock.module("@/lib/inbox-bus", {
    namedExports: {
      fireInboxEvent: (accountId: string, kind: string) => { state.fired.push({ accountId, kind, committedTasks: state.db.taskItem.length }); },
      waitForInbox: async () => ({ pending_count: 0, waited_seconds: 0 }),
      TooManyWaitersError,
    },
  });
  if (!mcp) return;
  // The MCP route imports these at load; bc_check_inbox calls sessions/active.
  mock.module("@/lib/inbox-pending", { namedExports: { pendingCount: async () => ({ count: 0, kinds: [] }) } });
  const ok = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });
  mock.module("@/app/api/sessions/active/route", { namedExports: { GET: ok({ sessions: [], agent_payloads_pending: 0, inbox_check: { enabled: true, minutes: 10 } }) } });
  mock.module("@/app/api/inbox/agent-payloads/route", { namedExports: { GET: ok({ payloads: [] }) } });
  for (const route of ["poll", "invites", "invites/[code]/claim", "inbox/request", "sessions/[id]/end", "account/view-token-self"]) {
    mock.module(`@/app/api/${route}/route`, { namedExports: { POST: ok({}) } });
  }
  mock.module("@/app/api/scopes/route", { namedExports: { GET: () => new Response("[]", { status: 200 }) } });
}

// ── requests ─────────────────────────────────────────────────────────────────

export type Who =
  | { agent: string }
  | { bearer: string }
  | { person: "A" | "B" | "C"; csrf?: "ok" | "missing" | "mismatched" }
  | null;
export const SKYLAR: Who = { person: "A" };
export const ALEX: Who = { person: "B" };
export const CAROL: Who = { person: "C" };
export const as = (agent: string): Who => ({ agent });

export function headersFor(who: Who): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (!who) return h;
  if ("agent" in who) h.authorization = `Bearer key-${who.agent}`;
  else if ("bearer" in who) h.authorization = `Bearer ${who.bearer}`;
  else {
    const session = `sess-${who.person.toLowerCase()}`;
    h.cookie = `${SESSION_COOKIE_NAME}=${session}; ${CSRF_COOKIE_NAME}=csrf-${session}`;
    const csrf = who.csrf ?? "ok";
    if (csrf === "ok") h[CSRF_HEADER] = `csrf-${session}`;
    if (csrf === "mismatched") h[CSRF_HEADER] = "csrf-forged";
  }
  return h;
}

export type Res = { status: number; body: any; headers: Headers }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Call the real /api/lists/[[...path]] route handler. */
export async function rest(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, who: Who, body?: unknown): Promise<Res> {
  const route = await import("@/app/api/lists/[[...path]]/route");
  const url = new URL(`https://back-channel.app/api/lists${path}`);
  const segments = url.pathname.replace(/^\/api\/lists\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const req = new NextRequest(url, {
    method,
    headers: headersFor(who),
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const res = await route[method](req, { params: Promise.resolve({ path: segments.length ? segments : undefined }) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

/**
 * GET /api/lists/stream through the real route (Phase 3). `extra` adds or overrides request headers.
 * Returns the response, a reader over its events, and abort (the client going away).
 */
export async function openStream(who: Who, extra: Record<string, string> = {}) {
  const { GET } = await import("@/app/api/lists/stream/route");
  const ac = new AbortController();
  const headers = { ...headersFor(who), ...extra };
  delete headers["content-type"];
  const res = await GET(new NextRequest("https://back-channel.app/api/lists/stream", { headers, signal: ac.signal }));
  const reader = res.body && res.status === 200 ? sseEvents(res.body) : null;
  return { res, events: reader, abort: () => ac.abort() };
}

export type SseEvent = { event: string; id: string | null; data: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Read SSE events off a body: next() resolves with the next event, or null at the end or after `ms`. */
export function sseEvents(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;
  // One read in flight at a time, kept across calls: a read abandoned at a timeout would swallow the next chunk.
  let inFlight: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  const parse = (block: string): SseEvent => {
    const field = (name: string) => block.split("\n").find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2) ?? null;
    const data = field("data");
    return { event: field("event") ?? "message", id: field("id"), data: data === null ? null : JSON.parse(data) };
  };
  return {
    async next(ms = 1_000): Promise<SseEvent | null> {
      const deadline = Date.now() + ms;
      for (;;) {
        const cut = buffer.indexOf("\n\n");
        if (cut >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          if (block.startsWith(":")) continue;
          return parse(block);
        }
        if (ended) return null;
        const left = deadline - Date.now();
        if (left <= 0) return null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        inFlight ??= reader.read();
        const chunk = await Promise.race([
          inFlight,
          new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), left); }),
        ]);
        clearTimeout(timer);
        if (chunk === "timeout") return null;
        inFlight = null;
        if (chunk.done) ended = true;
        else buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    /** Every event that arrives within `ms`. */
    async drain(ms = 100): Promise<SseEvent[]> {
      const out: SseEvent[] = [];
      for (;;) {
        const e = await this.next(ms);
        if (!e) return out;
        out.push(e);
      }
    },
    cancel: () => reader.cancel().catch(() => {}),
  };
}

/** POST /api/lists/digest/run through the real route, with the secret header when given. */
export async function runDigestRoute(secret?: string) {
  const { POST } = await import("@/app/api/lists/digest/run/route");
  const res = await POST(new NextRequest("https://back-channel.app/api/lists/digest/run", { method: "POST", headers: secret === undefined ? {} : { "x-lists-digest-secret": secret } }));
  return { status: res.status, body: await res.json() };
}

/** POST /api/mcp tools/call (or any method) with a bearer, through the real MCP route. */
export async function mcp(who: Who, method: string, params?: unknown) {
  const { POST } = await import("@/app/api/mcp/route");
  const req = new NextRequest("https://back-channel.app/api/mcp", {
    method: "POST",
    headers: headersFor(who),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
  const res = await POST(req);
  return { status: res.status, json: await res.json() };
}

/** One tool call. Returns the HTTP status the tool saw and its parsed JSON body. */
export async function tool(who: Who, name: string, args: Row = {}) {
  const { status, json } = await mcp(who, "tools/call", { name, arguments: args });
  assert.equal(status, 200, `MCP transport status for ${name}`);
  if (json.error) return { rpcError: json.error as { code: number; message: string }, isError: true, httpStatus: 0, body: null as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const text: string = json.result.content[0].text;
  if (!json.result.isError) return { rpcError: null, isError: false, httpStatus: 200, body: JSON.parse(text) };
  const m = /^HTTP (\d+): ([\s\S]*)$/.exec(text);
  assert.ok(m, `tool error text: ${text}`);
  return { rpcError: null, isError: true, httpStatus: Number(m[1]), body: JSON.parse(m[2]) };
}

// ── store helpers ────────────────────────────────────────────────────────────

/** Put a row straight into the committed store, with the schema's defaults (for bulk setup). */
export function seedRow(table: Table, data: Row): Row {
  const row: Row = {};
  for (const [k, f] of Object.entries(MODELS[table].fields)) {
    row[k] = data[k] !== undefined ? checkValue(table, k, data[k]) : f.def ? f.def() : f.updatedAt ? tick() : (assert.ok(f.optional, `${table}: ${k} is required`), null);
  }
  state.db[table].push(row);
  return row;
}

export const rows = (table: Table) => state.db[table];
export const taskRow = (id: string) => state.db.taskItem.find((t) => t.id === id)!;
export const listRow = (id: string) => state.db.taskList.find((l) => l.id === id)!;
export const entriesOf = (taskId: string) => state.db.taskEntry.filter((e) => e.taskId === taskId);
export const eventsOf = (taskId: string) => entriesOf(taskId).filter((e) => e.kind === "event").map((e) => e.eventType as string);
export const MIN = 60_000;
export const DAY = 24 * 60 * MIN;

export function ok(res: Res, what = "request"): any { // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(res.status, 200, `${what}: ${JSON.stringify(res.body)}`);
  return res.body;
}
export function refused(res: Res, status: number, code: string, what = "request") {
  assert.equal(res.status, status, `${what}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body?.error, code, `${what}: ${JSON.stringify(res.body)}`);
  return res.body;
}

/** A list owned by Skylar (via the dashboard), with work access for `agents`. */
export async function makeList(name = "Work", agents: string[] = [A1]): Promise<string> {
  return ok(await rest("POST", "", SKYLAR, { name, agents }), `create ${name}`).list.id;
}
export async function addTask(listId: string, who: Who, item: Row): Promise<Row> {
  return ok(await rest("POST", `/${listId}/tasks`, who, item), `add ${item.title}`).tasks[0];
}
export async function setAccess(listId: string, agentId: string, access: "none" | "view" | "work", who: Who = SKYLAR) {
  return rest("PUT", `/${listId}/agents`, who, { agent_id: agentId, access });
}

// ── friends and sharing ──────────────────────────────────────────────────────

/** Make two people friends: both directed trust rows, as accepting a friend invite does. */
export function befriend(a: Row, b: Row) {
  for (const [x, y] of [[a, b], [b, a]]) {
    if (!state.db.trustedPeer.some((t) => t.accountId === x.id && t.trustedAccountId === y.id)) seedRow("trustedPeer", { accountId: x.id, trustedAccountId: y.id });
  }
}
/** One side stops trusting the other, straight in the store (no cleanup hook runs). */
export function untrust(from: Row, to: Row) {
  state.db.trustedPeer = state.db.trustedPeer.filter((t) => !(t.accountId === from.id && t.trustedAccountId === to.id));
}
/** Skylar adds a friend to her list from the dashboard. */
export async function share(listId: string, handle = "alex", who: Who = SKYLAR) {
  return ok(await rest("POST", `/${listId}/members`, who, { handle }), `add ${handle}`);
}
/** Skylar's list shared with Alex, with work access for Skylar's `agents` and Alex's `alexAgents`. */
export async function sharedList(name = "Trip", agents: string[] = [A1], alexAgents: string[] = [B1]): Promise<string> {
  befriend(A, B);
  const id = await makeList(name, agents);
  await share(id);
  for (const agent of alexAgents) ok(await setAccess(id, agent, "work", ALEX), `Alex grants ${agent}`);
  return id;
}
