import { test, before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { NextRequest } from "next/server";
import { PrismaClientKnownRequestError, PrismaClientUnknownRequestError } from "@prisma/client/runtime/library";

const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const encryptionKey = generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "pem" }).toString();
const signingKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
let agents: any[]; let tasks: any[]; let limited = false; let transactionError: string | null = null;
// transactionFaults: one per attempt, raised at COMMIT after the callback ran, with its
// writes rolled back, the way Postgres aborts a serializable transaction.
let transactionFaults: unknown[] = []; let transactionCalls = 0;
function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (v === undefined) return true;
    if (k === "OR") return v.some((w: any) => matches(row, w));
    if (k === "AND") return v.every((w: any) => matches(row, w));
    if (k === "sender" || k === "target") return matches(agents.find(a => a.id === row[`${k}AgentId`]), v);
    if (!row) return false;
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("not" in v) return row[k] !== v.not;
      if ("gt" in v) return row[k] > v.gt;
    }
    return v instanceof Date ? row[k]?.getTime() === v.getTime() : row[k] === v;
  });
}
const db: any = {
  agentToken: {
    findFirst: async ({ where }: any) => agents.find(a => matches(a, where)) ?? null,
    findMany: async ({ where, take }: any) => agents.filter(a => matches(a, where)).slice(0, take),
    update: async ({ where, data }: any) => Object.assign(agents.find(a => matches(a, where)), data),
  },
  dispatchTask: {
    count: async ({ where }: any) => tasks.filter(t => matches(t, where)).length,
    findFirst: async ({ where }: any) => tasks.find(t => matches(t, where)) ?? null,
    findUnique: async ({ where }: any) => tasks.find(t => matches(t, where)) ?? null,
    findMany: async ({ where, take }: any) => tasks.filter(t => matches(t, where)).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).slice(0, take),
    create: async ({ data }: any) => {
      const t = { status: "queued", leaseHash: null, leaseExpiresAt: null, resultSealed: null, createdAt: new Date(), updatedAt: new Date(), ...data };
      tasks.push(t); return t;
    },
    updateMany: async ({ where, data }: any) => {
      if (data.status === "running") { assert.equal(where.status, "queued"); assert.ok(where.expiresAt.gt instanceof Date); }
      if (data.resultSealed) { assert.equal(where.status, "running"); assert.equal(where.leaseHash.length, 64); assert.ok(where.leaseExpiresAt.gt instanceof Date); }
      const rows = tasks.filter(t => matches(t, where));
      for (const t of rows) Object.assign(t, data, { updatedAt: new Date() });
      return { count: rows.length };
    },
  },
};
db.$transaction = async (fn: any, options: any) => {
  transactionCalls++;
  if (transactionError) throw { code: transactionError };
  assert.equal(options.isolationLevel, "Serializable");
  const snapshot = structuredClone({ agents, tasks });
  const result = await fn(db); const fault = transactionFaults.shift();
  if (fault) { ({ agents, tasks } = snapshot); throw fault; }
  return result;
};
before(() => {
  mock.module("@/lib/db", { namedExports: { prisma: db } });
  mock.module("@/lib/auth", { namedExports: { getAuthContext: async (header: string) => {
    if (header === "Bearer legacy") return { account: { id: "account" }, agentTokenId: null };
    const id = header?.replace("Bearer ", "");
    const a = agents.find(a => a.id === id);
    return a ? { account: { id: a.accountId }, agentTokenId: a.id } : null;
  } } });
  mock.module("@/lib/rate-limit", { namedExports: { rateLimit: () => ({ ok: !limited, retryAfterSec: 42 }) } });
});
beforeEach(() => {
  limited = false; tasks = []; transactionError = null; transactionFaults = []; transactionCalls = 0;
  agents = ids.map(id => ({ id, accountId: "account", revokedAt: null, dispatchName: "Worker", dispatchEncryptionKey: encryptionKey, dispatchSigningKey: signingKey, createdAt: new Date() }));
});
function req(body?: any, agent = ids[0], cursor = "") {
  return new NextRequest(`https://back-channel.app/api/dispatch/tasks${cursor}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${agent}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const input = () => ({ id: taskId, targetAgentId: ids[1], expiresAt: new Date(Date.now() + 3600_000).toISOString(), sealed: "opaque-ciphertext" });
async function run(op: any, body?: any, agent = ids[0], id?: string) {
  const { dispatch } = await import("@/lib/dispatch"); return dispatch(req(body, agent), op, id);
}
async function submitClaim() {
  assert.equal((await run("submit", input())).status, 200);
  const r = await run("claim", {}, ids[1], taskId); assert.equal(r.status, 200); return r.json();
}
test("per-agent auth and active enrollment are mandatory; every response is no-store", async () => {
  for (const id of ["missing", "legacy"]) {
    const r = await run("tasks", undefined, id); assert.equal(r.status, 401); assert.equal(r.headers.get("cache-control"), "no-store");
  }
  agents[0].dispatchEncryptionKey = null;
  assert.equal((await run("tasks")).status, 403);
  agents[0].revokedAt = new Date();
  assert.equal((await run("agents")).status, 401);
});
test("enrollment validates algorithms, is idempotent and cannot rotate keys", async () => {
  Object.assign(agents[0], { dispatchEncryptionKey: null, dispatchSigningKey: null, dispatchName: null });
  assert.equal((await run("enroll", { name: "Worker", encryptionKey: signingKey, signingKey })).status, 400);
  const body = { name: "Worker", encryptionKey, signingKey };
  assert.equal((await run("enroll", body)).status, 200);
  assert.equal((await run("enroll", body)).status, 200);
  assert.equal((await run("enroll", { ...body, name: "Changed" })).status, 409);
  assert.equal((await run("enroll", { ...body, signingKey: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString() })).status, 409);
});
test("submissions bind exact idempotency, reject cross-account, self and revoked targets", async () => {
  const body = input(); assert.equal((await run("submit", body)).status, 200);
  assert.equal((await run("submit", body)).status, 200); assert.equal(tasks.length, 1);
  assert.equal((await run("submit", { ...body, sealed: "changed" })).status, 409);
  assert.equal((await run("submit", { ...body, targetAgentId: ids[0] })).status, 400);
  agents[1].accountId = "other"; assert.equal((await run("submit", body)).status, 404);
  agents[1].accountId = "account"; agents[1].revokedAt = new Date(); assert.equal((await run("submit", body)).status, 404);
});
test("claims are CAS, recipient-only and store only a lease hash", async () => {
  const { leaseToken, task } = await submitClaim();
  assert.equal(task.status, "running"); assert.equal(task.leaseHash, undefined); assert.equal(task.leaseToken, undefined);
  assert.notEqual(tasks[0].leaseHash, leaseToken); assert.equal(tasks[0].leaseHash.length, 64);
  assert.ok(tasks[0].leaseExpiresAt.getTime() - Date.now() <= 90_000);
  assert.equal((await run("claim", {}, ids[1], taskId)).status, 409);
  assert.equal((await run("claim", {}, ids[0], taskId)).status, 403);
  assert.equal((await run("claim", {}, ids[2], taskId)).status, 404);
});
test("expiry interrupts running work permanently; no heartbeat or result can revive it", async () => {
  const { leaseToken } = await submitClaim(); tasks[0].leaseExpiresAt = new Date(Date.now() - 1);
  assert.equal((await run("heartbeat", { leaseToken }, ids[1], taskId)).status, 409);
  assert.equal(tasks[0].status, "interrupted");
  assert.equal((await run("claim", {}, ids[1], taskId)).status, 409);
  assert.equal((await run("result", { leaseToken, status: "completed", sealed: "result" }, ids[1], taskId)).status, 409);
});
test("healthy heartbeat renews the lease and task expiry stops even a live lease", async () => {
  const { leaseToken } = await submitClaim(); tasks[0].leaseExpiresAt = new Date(Date.now() + 1000);
  assert.equal((await run("heartbeat", { leaseToken }, ids[1], taskId)).status, 200);
  assert.ok(tasks[0].leaseExpiresAt.getTime() > Date.now() + 85_000);
  tasks[0].expiresAt = new Date(Date.now() - 1);
  assert.equal((await run("heartbeat", { leaseToken }, ids[1], taskId)).status, 409);
  assert.equal(tasks[0].status, "interrupted");
});
test("concurrent claim requests yield exactly one lease", async () => {
  await run("submit", input());
  const results = await Promise.all([run("claim", {}, ids[1], taskId), run("claim", {}, ids[1], taskId)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
});
test("result retries are exact and require the original lease secret", async () => {
  const { leaseToken } = await submitClaim();
  const body = { leaseToken, status: "completed", sealed: "encrypted-result" };
  assert.equal((await run("result", body, ids[1], taskId)).status, 200);
  assert.equal((await run("result", body, ids[1], taskId)).status, 200);
  assert.equal((await run("result", { ...body, sealed: "different" }, ids[1], taskId)).status, 409);
  assert.equal((await run("result", { ...body, leaseToken: "a".repeat(43) }, ids[1], taskId)).status, 409);
  assert.equal(tasks[0].resultSealed, body.sealed);
});
test("sender cancellation invalidates lease; revoked participants lose all operations", async () => {
  const { leaseToken } = await submitClaim();
  assert.equal((await run("cancel", {}, ids[1], taskId)).status, 403);
  assert.equal((await run("cancel", {}, ids[0], taskId)).status, 200);
  assert.equal((await run("heartbeat", { leaseToken }, ids[1], taskId)).status, 409);
  agents[0].revokedAt = new Date();
  assert.equal((await run("heartbeat", { leaseToken }, ids[1], taskId)).status, 404);
  assert.deepEqual((await (await run("tasks", undefined, ids[1])).json()).tasks, []);
});
test("recipient rejects an untrusted queued task without broker plaintext or a lease", async () => {
  await run("submit", input());
  assert.equal((await run("reject", {}, ids[0], taskId)).status, 403);
  assert.equal((await run("reject", {}, ids[2], taskId)).status, 404);
  const { POST } = await import("@/app/api/dispatch/tasks/[id]/reject/route");
  const r = await POST(req({ reason: "untrusted plaintext must not persist" }, ids[1]), { params: Promise.resolve({ id: taskId }) });
  assert.equal(r.status, 200); assert.equal(tasks[0].status, "rejected"); assert.equal(tasks[0].resultSealed, null); assert.equal(tasks[0].reason, undefined);
  assert.equal((await run("reject", {}, ids[1], taskId)).status, 200);
  assert.equal((await run("claim", {}, ids[1], taskId)).status, 409);
  assert.equal((await run("cancel", {}, ids[0], taskId)).status, 200); assert.equal(tasks[0].status, "rejected");
});
test("rejection cannot overwrite a running task", async () => {
  await submitClaim(); assert.equal((await run("reject", {}, ids[1], taskId)).status, 409); assert.equal(tasks[0].status, "running");
});
test("bounded payloads, expiry, rate limits and no leaked task existence", async () => {
  assert.equal((await run("submit", { ...input(), sealed: "x".repeat(131073) })).status, 400);
  assert.equal((await run("submit", { ...input(), expiresAt: new Date(Date.now() + 86401_000).toISOString() })).status, 400);
  limited = true; const r = await run("tasks"); assert.equal(r.status, 429); assert.equal(r.headers.get("retry-after"), "42");
});
test("account-wide active quota caps new jobs but preserves idempotent retries", async () => {
  const body = input(); await run("submit", body);
  for (let i = 1; i < 100; i++) tasks.push({ ...tasks[0], id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, "0")}` });
  assert.equal((await run("submit", body)).status, 200);
  const next = { ...body, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
  assert.equal((await run("submit", next, ids[2])).status, 429);
  tasks[1].expiresAt = new Date(Date.now() - 1);
  assert.equal((await run("submit", next, ids[2])).status, 200);
});
test("serialization and unique races are retryable, distinguishable from a lost lease", async () => {
  for (const code of ["P2034", "P2002"]) {
    transactionError = code; transactionCalls = 0; const started = Date.now();
    const r = await run("submit", input()); assert.equal(r.status, 503);
    assert.equal(r.headers.get("retry-after"), "1"); assert.deepEqual(await r.json(), { error: "Concurrent operation; retry request", retryable: true });
    assert.equal(transactionCalls, 5, "bounded: gives up after five attempts"); assert.ok(Date.now() - started < 1000, "bounded total latency");
  }
});
// Every shape Prisma 5 uses for a Postgres serialization abort (40001) or deadlock
// victim (40P01). CI flake 2026-09-24: 40001 on the enroll UPDATE of AgentToken,
// racing getAuthContext's out-of-transaction lastUsedAt touch, returned 503.
const clientVersion = "5.22.0";
const commitAbort = "Error occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: \"40001\", message: \"could not serialize access due to read/write dependencies among transactions\", severity: \"ERROR\", detail: Some(\"Reason code: Canceled on identification as a pivot, during commit attempt.\"), column: None, hint: Some(\"The transaction might succeed if retried.\") }), transient: false })";
const aborts: [string, () => unknown][] = [
  ["P2034 write conflict", () => new PrismaClientKnownRequestError("Transaction failed due to a write conflict or a deadlock. Please retry your transaction", { code: "P2034", clientVersion })],
  ["P2010 raw 40001", () => new PrismaClientKnownRequestError("Raw query failed. Code: 40001. Message: could not serialize access due to concurrent update", { code: "P2010", clientVersion, meta: { code: "40001", message: "could not serialize access due to concurrent update" } })],
  ["unknown commit-time 40001", () => new PrismaClientUnknownRequestError(commitAbort, { clientVersion })],
  ["P2028 deadlock", () => new PrismaClientKnownRequestError("Transaction API error: deadlock detected", { code: "P2028", clientVersion })],
  ["driver 40P01", () => Object.assign(new Error("deadlock detected"), { code: "40P01" })],
  ["P2002 unique race", () => new PrismaClientKnownRequestError("Unique constraint failed on the fields: (id)", { code: "P2002", clientVersion })],
];
test("serialization aborts re-run the whole transaction until it commits, in every error shape", async () => {
  for (const [name, abort] of aborts) {
    Object.assign(agents[0], { dispatchEncryptionKey: null, dispatchSigningKey: null, dispatchName: null }); tasks = [];
    transactionFaults = [abort(), abort()]; transactionCalls = 0;
    const enroll = await run("enroll", { name: "Worker", encryptionKey, signingKey });
    assert.equal(enroll.status, 200, name); assert.equal(transactionCalls, 3, name);
    assert.equal(enroll.headers.get("cache-control"), "no-store"); assert.equal(agents[0].dispatchSigningKey, signingKey, name);
    transactionFaults = [abort()]; transactionCalls = 0;
    const submit = await run("submit", input());
    assert.equal(submit.status, 200, name); assert.equal(transactionCalls, 2, name); assert.equal(tasks.length, 1, `${name}: exactly one committed row`);
  }
});
test("retry budget exhausted by any abort shape returns the fixed retryable 503", async () => {
  for (const [name, abort] of aborts) {
    transactionFaults = Array.from({ length: 5 }, abort); transactionCalls = 0;
    const r = await run("submit", input());
    assert.equal(r.status, 503, name); assert.equal(transactionCalls, 5, name); assert.equal(r.headers.get("retry-after"), "1", name);
    assert.deepEqual(await r.json(), { error: "Concurrent operation; retry request", retryable: true }, name); assert.equal(tasks.length, 0, name);
  }
});
test("non-conflict failures are never retried", async () => {
  transactionFaults = [new Error("connection refused")];
  const r = await run("submit", input());
  assert.equal(r.status, 503); assert.deepEqual(await r.json(), { error: "Dispatch unavailable" }); assert.equal(transactionCalls, 1);
  transactionCalls = 0; assert.equal((await run("enroll", { name: "Changed", encryptionKey, signingKey })).status, 409); assert.equal(transactionCalls, 1);
});
test("retry helper: bounded attempts, jittered exponential backoff, strict predicate", async () => {
  const { isSerializationFailure, withSerializableRetry } = await import("@/lib/serializable");
  for (const [name, abort] of aborts.slice(0, 5)) assert.equal(isSerializationFailure(abort()), true, name);
  for (const e of [null, "40001", new Error("boom"), { code: "P2025" }, { code: "P2002" }, { message: "listening on port 40001" }]) assert.equal(isSerializationFailure(e), false, String(e));
  for (const [random, expected] of [[() => 0, [5, 10, 20, 40]], [() => 0.999999, [10, 20, 40, 80]]] as const) {
    const slept: number[] = []; let calls = 0; const abort = aborts[0][1]();
    await assert.rejects(withSerializableRetry(async () => { calls++; throw abort; }, { sleep: async ms => { slept.push(ms); }, random }), (e: unknown) => e === abort);
    assert.equal(calls, 5); assert.deepEqual(slept.map(Math.round), expected);
  }
  let calls = 0; const slept: number[] = [];
  assert.equal(await withSerializableRetry(async () => { if (++calls < 3) throw aborts[0][1](); return "ok"; }, { sleep: async ms => { slept.push(ms); } }), "ok");
  assert.equal(calls, 3); assert.equal(slept.length, 2);
  calls = 0; await assert.rejects(withSerializableRetry(async () => { calls++; throw new Error("boom"); }), /boom/); assert.equal(calls, 1);
});
test("GET paginates oldest-first and reconciles expiry without leaking private fields", async () => {
  await run("submit", input()); const first = tasks[0]; first.expiresAt = new Date(Date.now() - 1);
  for (let i = 1; i < 52; i++) tasks.push({ ...first, id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, "0")}`, createdAt: new Date(first.createdAt.getTime() + i) });
  const { GET } = await import("@/app/api/dispatch/tasks/route");
  const page = await (await GET(req())).json(); assert.equal(page.tasks.length, 50); assert.equal(page.tasks[0].status, "expired");
  assert.equal(page.tasks[0].leaseHash, undefined);
  const next = await (await GET(req(undefined, ids[0], `?cursor=${page.nextCursor}`))).json(); assert.equal(next.tasks.length, 2); assert.equal(next.nextCursor, null);
  assert.equal((await GET(req(undefined, ids[2], `?cursor=${page.nextCursor}`))).status, 400);
});
