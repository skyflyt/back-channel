import { test, before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";

// Owner-only admin: every /api/admin/* route and PUT /api/appbridge/v1/admin/entitlements.
// The REAL src/lib/auth.ts and src/lib/admin.ts run here; only Prisma is in memory.

// ── In-memory Prisma: the query surface the admin routes and auth use ──
type Row = Record<string, any>;
const tables: Record<string, Row[]> = {};
const calls: string[] = [];
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function cond(row: Row, k: string, v: any): boolean {
  if (v === undefined) return true;
  if (k === "OR") return (v as Row[]).some(w => matches(row, w));
  if (k === "AND") return (v as Row[]).every(w => matches(row, w));
  if (k === "account") return matches(tables.account.find(a => a.id === row.accountId), v);
  if (k === "accountId_feature") return matches(row, v);
  const x = row[k];
  if (v === null) return x === null || x === undefined;
  if (v instanceof Date) return x?.getTime?.() === v.getTime();
  if (v && typeof v === "object") return Object.entries(v).every(([op, y]: [string, any]) => {
    if (op === "mode") return true;
    if (op === "in") return y.includes(x);
    if (op === "not") return y === null ? x !== null && x !== undefined : x !== y;
    if (op === "gte") return x != null && x >= y;
    if (op === "gt") return x != null && x > y;
    if (op === "lt") return x != null && x < y;
    if (op === "contains") return typeof x === "string" && (v.mode === "insensitive" ? x.toLowerCase().includes(String(y).toLowerCase()) : x.includes(y));
    throw new Error(`mock: unsupported operator ${op}`);
  });
  return x === v;
}
function matches(row: Row | undefined, where: Row | undefined): boolean {
  return !!row && Object.entries(where ?? {}).every(([k, v]) => cond(row, k, v));
}
function pick(row: Row, select?: Row, include?: Row): Row {
  let out: Row = row;
  if (select) { out = {}; for (const k of Object.keys(select)) if (select[k]) out[k] = row[k]; }
  if (include?.account) out = { ...out, account: tables.account.find(a => a.id === row.accountId) };
  return out;
}
function model(name: string) {
  tables[name] ??= [];
  const rows = () => (tables[name] ??= []);
  const log = (op: string) => calls.push(`${name}.${op}`);
  return {
    count: async ({ where }: any = {}) => { log("count"); return rows().filter(r => matches(r, where)).length; },
    findUnique: async ({ where, select, include }: any) => { log("findUnique"); const r = rows().find(x => matches(x, where)); return r ? pick(r, select, include) : null; },
    findFirst: async ({ where, select }: any = {}) => { log("findFirst"); const r = rows().find(x => matches(x, where)); return r ? pick(r, select) : null; },
    findMany: async ({ where, select, include, orderBy, skip, take }: any = {}) => {
      log("findMany");
      let list = rows().filter(r => matches(r, where));
      const order = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
      if (order.length) list = [...list].sort((a, b) => {
        for (const o of order) { const [k, dir] = Object.entries(o)[0] as [string, string]; if (a[k] < b[k]) return dir === "asc" ? -1 : 1; if (a[k] > b[k]) return dir === "asc" ? 1 : -1; }
        return 0;
      });
      return list.slice(skip ?? 0, (skip ?? 0) + (take ?? Infinity)).map(r => pick(r, select, include));
    },
    groupBy: async ({ by, where, _count, _max }: any) => {
      log("groupBy");
      const groups = new Map<string, Row[]>();
      for (const r of rows().filter(x => matches(x, where))) {
        const key = JSON.stringify(by.map((k: string) => r[k]));
        groups.set(key, [...(groups.get(key) ?? []), r]);
      }
      return [...groups.entries()].map(([key, rs]) => {
        const g: Row = Object.fromEntries(by.map((k: string, i: number) => [k, JSON.parse(key)[i]]));
        if (_count) g._count = _count === true ? rs.length : { _all: rs.length };
        if (_max) g._max = Object.fromEntries(Object.keys(_max).map(k => [k, rs.map(r => r[k]).filter(Boolean).sort((a, b) => b - a)[0] ?? null]));
        return g;
      });
    },
    create: async ({ data }: any) => { log("create"); const r = { ...data }; rows().push(r); return r; },
    update: async ({ where, data }: any) => { log("update"); const r = rows().find(x => matches(x, where)); if (!r) throw new Error("not found"); return Object.assign(r, data); },
    updateMany: async ({ where, data }: any) => { log("updateMany"); const hit = rows().filter(r => matches(r, where)); hit.forEach(r => Object.assign(r, data)); return { count: hit.length }; },
    delete: async ({ where }: any) => { log("delete"); tables[name] = rows().filter(r => !matches(r, where)); return {}; },
    upsert: async ({ where, create, update }: any) => { log("upsert"); const r = rows().find(x => matches(x, where)); if (r) return Object.assign(r, update); rows().push({ ...create }); return create; },
  };
}
const models: Record<string, any> = {};
const db: any = new Proxy({}, {
  get(_t, prop: string) {
    if (prop === "$queryRaw") return async (_s: TemplateStringsArray, since: Date) => {
      calls.push("$queryRaw");
      const byDay = new Map<string, number>();
      for (const e of tables.appBridgeConnectionEvent ?? []) if (e.at >= since) { const d = e.at.toISOString().slice(0, 10); byDay.set(d, (byDay.get(d) ?? 0) + 1); }
      return [...byDay].map(([d, n]) => ({ day: new Date(`${d}T00:00:00Z`), n }));
    };
    if (prop === "$transaction") return async (fn: any) => fn(db);
    if (prop === "then") return undefined;
    return (models[prop] ??= model(prop));
  },
});

before(() => {
  mock.module("@/lib/db", { namedExports: { prisma: db } });
  mock.module("@/lib/rate-limit", { namedExports: { rateLimit: () => ({ ok: true, retryAfterSec: 0 }) } });
});

const OWNER = "Owner@Example.com"; // mixed case on purpose: the allowlist match is case-insensitive
const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms);
beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  for (const k of ["account", "sessionCookie", "agentToken", "appBridgeDevice", "appBridgeCredential", "appBridgeEntitlement", "appBridgeConnectionEvent"]) tables[k] = [];
  calls.length = 0;
  process.env.ADMIN_EMAILS = " owner@example.com , ";
  delete process.env.RESEND_API_KEY; delete process.env.RESEND_READ_API_KEY;
  const account = (id: string, handle: string, email: string, extra: Row = {}) =>
    ({ id, handle, email, createdAt: ago(40 * DAY), emailVerifiedAt: ago(40 * DAY), admin: false, reserved: false,
      apiKey: null, apiKeyLastUsedAt: null, recoveryWrap: "SECRET-recovery-wrap", recoveryCodeHash: "SECRET-recovery-hash", mirrorPub: "SECRET-mirror", ...extra });
  tables.account.push(
    account("acct-owner", "skylar@bc", OWNER),
    account("acct-admin", "legacy-admin@bc", "legacy@example.com", { admin: true }),     // admin=true, not allowlisted
    account("acct-user", "user@bc", "user@example.com"),
    account("acct-unverified", "twin@bc", "owner@example.com.evil", { emailVerifiedAt: null }),
    account("acct-idle", "idle@bc", "idle@example.com", { createdAt: ago(2 * DAY) }),
  );
  // Session cookies are stored by hash, exactly as the real auth expects.
  const cookie = (acctId: string, raw: string) => tables.sessionCookie.push({ token: sha(raw), accountId: acctId, createdAt: ago(DAY), expiresAt: new Date(Date.now() + DAY), lastUsedAt: ago(2 * 3600_000) });
  cookie("acct-owner", "cs_owner"); cookie("acct-admin", "cs_admin"); cookie("acct-user", "cs_user");
  // Agent keys: the user's was used 3 days ago; the admin's 45 days ago.
  tables.agentToken.push(
    { id: "tok-user", accountId: "acct-user", keyHash: "SECRET-keyhash-user", name: "Loby", createdAt: ago(20 * DAY), lastUsedAt: ago(3 * DAY), revokedAt: null, dispatchEncryptionKey: "SECRET-dispatch" },
    { id: "tok-user-2", accountId: "acct-user", keyHash: "SECRET-keyhash-user2", name: "Codex", createdAt: ago(10 * DAY), lastUsedAt: null, revokedAt: null },
    { id: "tok-admin", accountId: "acct-admin", keyHash: sha("bc_ownerlookalike"), name: "Old", createdAt: ago(60 * DAY), lastUsedAt: ago(45 * DAY), revokedAt: null },
  );
  // Back Channel Remote: the user has a PC, a phone and a revoked phone, remote access on, 3 relays.
  tables.appBridgeDevice.push(
    { id: "dev-pc", accountId: "acct-user", role: "host", label: "Office PC", connectorSpki: "SECRET-spki-pc", connectorSpkiSha256: "SECRET-fp-pc", enabled: true, relayEnabled: true, createdAt: ago(5 * DAY), revokedAt: null },
    { id: "dev-ph", accountId: "acct-user", role: "remote", label: "Phone", connectorSpki: "SECRET-spki-ph", connectorSpkiSha256: "SECRET-fp-ph", enabled: true, relayEnabled: false, createdAt: ago(5 * DAY), revokedAt: null },
    { id: "dev-old", accountId: "acct-user", role: "remote", label: "Old phone", connectorSpki: "SECRET-spki-old", connectorSpkiSha256: "SECRET-fp-old", enabled: false, relayEnabled: false, createdAt: ago(9 * DAY), revokedAt: ago(6 * DAY) },
  );
  tables.appBridgeCredential.push({ keyHash: "SECRET-ab-cred", deviceId: "dev-pc", accountId: "acct-user", scopes: [], createdAt: ago(5 * DAY), expiresAt: new Date(Date.now() + DAY), revokedAt: null });
  tables.appBridgeEntitlement.push({ accountId: "acct-user", feature: "appbridge.remote_access", active: true, updatedAt: ago(5 * DAY) });
  tables.appBridgeConnectionEvent.push(
    { id: "c1", accountId: "acct-user", hostDeviceId: "dev-pc", remoteDeviceId: "dev-ph", at: ago(3600_000) },
    { id: "c2", accountId: "acct-user", hostDeviceId: "dev-pc", remoteDeviceId: "dev-ph", at: ago(2 * DAY) },
    { id: "c3", accountId: "acct-user", hostDeviceId: "dev-pc", remoteDeviceId: "dev-ph", at: ago(2 * DAY + 3600_000) },
  );
  tables.frame = [{ id: "f1", sessionId: "s1", body: JSON.stringify({ type: "msg", sealed: "SECRET-sealed-body" }), createdAt: ago(10 * DAY) }];
  tables.agentPayload = [{ id: "p1", accountId: "acct-user", body: "SECRET-payload" }];
});

// ── Helpers ──
const routes = {
  analytics: () => import("@/app/api/admin/analytics/route"),
  users: () => import("@/app/api/admin/users/route"),
  grant: () => import("@/app/api/admin/grant/route"),
  revoke: () => import("@/app/api/admin/revoke/route"),
  entitlements: () => import("@/app/api/appbridge/v1/admin/entitlements/route"),
};
type Who = "none" | "owner" | "admin" | "user" | "unverified";
const COOKIES: Record<Who, string | null> = { none: null, owner: "cs_owner", admin: "cs_admin", user: "cs_user", unverified: "cs_unverified" };
function req(method: string, who: Who, o: { csrf?: "ok" | "missing" | "mismatch"; bearer?: string; body?: unknown; query?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const cookies: string[] = [];
  if (COOKIES[who]) cookies.push(`bc_session=${COOKIES[who]}`);
  if (o.csrf !== undefined || method !== "GET") cookies.push("bc_csrf=tok");
  if (cookies.length) headers.cookie = cookies.join("; ");
  const csrf = o.csrf ?? (method === "GET" ? undefined : "ok");
  if (csrf === "ok") headers["x-bc-csrf"] = "tok";
  if (csrf === "mismatch") headers["x-bc-csrf"] = "other";
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  return new NextRequest(`https://back-channel.app/api/admin/x${o.query ?? ""}`, { method, headers, ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }) });
}
const call = {
  analytics: async (r: NextRequest) => (await routes.analytics()).GET(r),
  users: async (r: NextRequest) => (await routes.users()).GET(r),
  grant: async (r: NextRequest) => (await routes.grant()).POST(r),
  revoke: async (r: NextRequest) => (await routes.revoke()).POST(r),
  entitlements: async (r: NextRequest) => (await routes.entitlements()).PUT(r),
};
const reads = [["analytics", "GET"], ["users", "GET"]] as const;
const writes = [["grant", "POST", { handle: "user@bc" }], ["revoke", "POST", { handle: "legacy-admin@bc" }], ["entitlements", "PUT", { handle: "user@bc", active: false }]] as const;
const everyRoute = [...reads.map(([n, m]) => [n, m, undefined] as const), ...writes];

async function expectRefused(res: Response, status: number, error: string, label: string) {
  assert.equal(res.status, status, label);
  assert.deepEqual(await res.json(), { error }, `${label}: nothing in the body beyond {error}`);
  assert.equal(res.headers.get("cache-control"), "no-store", `${label}: no-store`);
}
function keysOf(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach(x => keysOf(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); keysOf(x, out); }
  return out;
}
const SECRET_KEY = /hash|token|secret|password|cookie|credential|spki|fingerprint|api_?key|private|mirror|wrap|recovery|sealed|cipher|payload|body|content|dispatch/i;
/** Nothing that looks like a secret, by key name, and none of the seeded secret values. */
function assertNoSecrets(body: unknown, label: string) {
  const bad = keysOf(body).filter(k => SECRET_KEY.test(k));
  assert.deepEqual(bad, [], `${label}: secret-shaped keys`);
  const text = JSON.stringify(body);
  assert.ok(!text.includes("SECRET-"), `${label}: a seeded secret value leaked`);
  for (const raw of ["cs_owner", "cs_user", sha("cs_owner"), "bc_ownerlookalike"]) assert.ok(!text.includes(raw), `${label}: ${raw} leaked`);
}
const ownerMutation = () => ({ admin: tables.account.map(a => [a.id, a.admin]), ent: JSON.stringify(tables.appBridgeEntitlement) });

// ── Tests ──

test("the owner gets analytics: counts, DAU/WAU/MAU, Remote aggregates, and no secrets", async () => {
  const res = await call.analytics(req("GET", "owner"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assertNoSecrets(body, "analytics");
  assert.equal(body.adoption.accounts_total, 5);
  assert.equal(body.adoption.accounts_verified, 4);
  // Last active = max(existing timestamps). Owner/admin/user signed in 2h ago (cookie), so DAU = 3;
  // user also has agent (3d) and relays (1h). idle and unverified have nothing.
  assert.deepEqual([body.activity.dau, body.activity.wau, body.activity.mau], [3, 3, 3]);
  assert.deepEqual(body.activity.status, { active_7d: 3, active_30d: 0, dormant: 0, never: 2 });
  assert.equal(body.adoption.agents_total, 3);
  assert.deepEqual(body.adoption.agents_per_account, { none: 3, one: 1, two: 1, three_plus: 0 });
  assert.equal(body.remote.accounts_with_devices, 1);
  assert.equal(body.remote.accounts_entitled, 1);
  assert.deepEqual(body.remote.devices, { pcs: 1, phones: 1, revoked: 1 });
  assert.equal(body.remote.connections_7d, 3);
  assert.equal(body.remote.connections_per_day_7d.length, 7);
  assert.equal(body.remote.connections_per_day_7d.reduce((n: number, d: { count: number }) => n + d.count, 0), 3);
  assert.match(body.privacy_note, /Owner-only/);
});

test("the owner gets the users page: identity, status, agents, Remote per user; no secrets; bounded", async () => {
  const res = await call.users(req("GET", "owner", { query: "?limit=5000" }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assertNoSecrets(body, "users");
  assert.equal(body.limit, 200, "limit is capped at 200");
  assert.equal(body.total, 5);
  const user = body.users.find((u: any) => u.handle === "user@bc");
  assert.equal(user.email, "user@example.com");
  assert.equal(user.status, "active_7d");
  assert.equal(user.agents, 2);
  assert.equal(user.plan, null);
  assert.deepEqual(user.active_via.sort(), ["agent", "dashboard", "remote"]);
  assert.deepEqual(user.remote, { pcs: 1, phones: 1, pcs_revoked: 0, phones_revoked: 1, entitled: true, connections_7d: 3, last_connection_at: tables.appBridgeConnectionEvent[0].at.toISOString() });
  const idle = body.users.find((u: any) => u.handle === "idle@bc");
  assert.equal(idle.status, "never"); assert.equal(idle.last_active_at, null);
  // Aggregated, not N+1: the query count does not depend on the number of users.
  // (The session cookie's throttled lastUsedAt touch is auth, not the query plan, so it is left out.)
  const queries = () => calls.filter(c => c !== "sessionCookie.findUnique" && c !== "sessionCookie.update").length;
  const n = queries();
  assert.ok(n > 0 && n <= 15, `a fixed handful of queries (${n})`);
  for (let i = 0; i < 30; i++) tables.account.push({ id: `bulk-${i}`, handle: `bulk${i}@bc`, email: `b${i}@example.com`, createdAt: ago(i * 1000), emailVerifiedAt: null, admin: false, reserved: false, apiKeyLastUsedAt: null });
  calls.length = 0;
  assert.equal((await call.users(req("GET", "owner"))).status, 200);
  assert.equal(queries(), n, "same number of queries for 5 users and 35 users");
});

test("users: search by handle or email, case-insensitive, paginated", async () => {
  const byEmail = await (await call.users(req("GET", "owner", { query: "?q=USER%40EXAMPLE" }))).json();
  assert.deepEqual(byEmail.users.map((u: any) => u.handle), ["user@bc"]);
  const byHandle = await (await call.users(req("GET", "owner", { query: "?q=idle" }))).json();
  assert.deepEqual(byHandle.users.map((u: any) => u.handle), ["idle@bc"]);
  const page2 = await (await call.users(req("GET", "owner", { query: "?limit=2&page=2&sort=handle" }))).json();
  assert.equal(page2.total, 5); assert.equal(page2.users.length, 2);
  // A–Z: idle, legacy-admin | skylar, twin | user
  assert.deepEqual(page2.users.map((u: any) => u.handle), ["skylar@bc", "twin@bc"]);
});

test("signed out → 401 {error} on every admin route", async () => {
  for (const [name, method, body] of everyRoute) {
    const res = await call[name](req(method, "none", { body }));
    await expectRefused(res, 401, "unauthorized", `${name} signed out`);
  }
});

test("a signed-in non-owner → 403 {error}, including an account with admin=true", async () => {
  for (const who of ["user", "admin"] as const) {
    for (const [name, method, body] of everyRoute) {
      const before = ownerMutation();
      const res = await call[name](req(method, who, { body }));
      await expectRefused(res, 403, "forbidden", `${name} as ${who}`);
      assert.deepEqual(ownerMutation(), before, `${name} as ${who} changed nothing`);
    }
  }
});

test("an allowlisted email that is not verified → 403", async () => {
  // Same allowlisted email, but emailVerifiedAt is null.
  tables.account.find(a => a.id === "acct-owner")!.emailVerifiedAt = null;
  for (const [name, method, body] of everyRoute) {
    await expectRefused(await call[name](req(method, "owner", { body })), 403, "forbidden", `${name} unverified owner`);
  }
});

test("the allowlist matches the whole email only (no substring, suffix or lookalike)", async () => {
  tables.account.find(a => a.id === "acct-unverified")!.emailVerifiedAt = new Date();
  tables.sessionCookie.push({ token: sha("cs_unverified"), accountId: "acct-unverified", createdAt: new Date(), expiresAt: new Date(Date.now() + DAY), lastUsedAt: null });
  await expectRefused(await call.analytics(req("GET", "unverified")), 403, "forbidden", "owner@example.com.evil");
});

test("a bc_ bearer key is refused on every admin route, even alongside the owner's cookie, and is never looked up", async () => {
  for (const [name, method, body] of everyRoute) {
    calls.length = 0;
    await expectRefused(await call[name](req(method, "none", { bearer: "bc_ownerlookalike", body })), 403, "forbidden", `${name} bearer only`);
    await expectRefused(await call[name](req(method, "owner", { bearer: "bc_ownerlookalike", body })), 403, "forbidden", `${name} bearer + owner cookie`);
    assert.ok(!calls.includes("agentToken.findUnique"), `${name}: the bearer was never resolved`);
  }
});

test("ADMIN_EMAILS unset or empty → everyone refused (fail closed)", async () => {
  for (const value of [undefined, "", " , ", "not-an-email"]) {
    if (value === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = value;
    for (const [name, method, body] of everyRoute) {
      await expectRefused(await call[name](req(method, "owner", { body })), 403, "forbidden", `${name} with ADMIN_EMAILS=${JSON.stringify(value)}`);
    }
  }
});

test("mutations without a matching CSRF header → 403, even for the owner", async () => {
  for (const [name, method, body] of writes) {
    for (const csrf of ["missing", "mismatch"] as const) {
      const before = ownerMutation();
      await expectRefused(await call[name](req(method, "owner", { csrf, body })), 403, "csrf", `${name} csrf ${csrf}`);
      assert.deepEqual(ownerMutation(), before);
    }
  }
});

test("the entitlement admin route is owner-only, and works for the owner", async () => {
  const set = (who: Who, handle: string, active: boolean) => call.entitlements(req("PUT", who, { body: { handle, active } }));
  assert.equal((await set("admin", "legacy-admin@bc", true)).status, 403, "admin=true cannot grant itself remote access");
  assert.equal(tables.appBridgeEntitlement.length, 1);
  const off = await set("owner", "user@bc", false);
  assert.equal(off.status, 200);
  assert.deepEqual(await off.json(), { handle: "user@bc", active: false });
  assert.equal(tables.appBridgeEntitlement[0].active, false);
  assert.equal((await set("owner", "idle@bc", true)).status, 200);
  assert.deepEqual(tables.appBridgeEntitlement.map(e => [e.accountId, e.active]), [["acct-user", false], ["acct-idle", true]]);
  assert.equal((await set("owner", "nobody@bc", true)).status, 404, "unknown handle: only the owner ever gets this far");
});

test("grant/revoke can no longer widen (or change) admin, even for the owner", async () => {
  const before = ownerMutation();
  for (const [name, handle] of [["grant", "user@bc"], ["revoke", "legacy-admin@bc"]] as const) {
    calls.length = 0;
    const res = await call[name](req("POST", "owner", { body: { handle } }));
    assert.equal(res.status, 410, `${name} is retired`);
    assert.deepEqual(await res.json(), { error: "gone" });
    assert.ok(!calls.some(c => c.startsWith("account.update")), `${name} wrote nothing`);
  }
  assert.deepEqual(ownerMutation(), before);
  // And the admin column itself grants nothing: flip it on for a normal user and they are still refused.
  tables.account.find(a => a.id === "acct-user")!.admin = true;
  await expectRefused(await call.users(req("GET", "user")), 403, "forbidden", "admin=true user");
});
