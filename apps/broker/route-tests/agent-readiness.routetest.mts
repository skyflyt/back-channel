/**
 * Route tests for PC readiness for agents (vault design pc-agent-readiness.md; docs/remote-app-sessions.md, "Setting up
 * a PC"): the worker's PUT /api/agents/self/readiness, the owner's GET /api/remote-app/readiness ("Agents on your PCs")
 * and the readiness bc_remote_machines / GET /api/remote-app/machines gives agents. The real route files and src/lib
 * modules run against an in-memory Prisma, with @/lib/auth and @/lib/rate-limit mocked. No Postgres needed.
 */
import { test, before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { NextRequest } from "next/server";

type Row = Record<string, any>;

// ── In-memory Prisma (the query surface these routes use) ──
const cmp = (a: any, b: any) => { const x = a instanceof Date ? a.getTime() : a; const y = b instanceof Date ? b.getTime() : b; return x < y ? -1 : x > y ? 1 : 0; };
function matches(row: Row | undefined, where: Row | undefined): boolean {
  if (!row) return false;
  return Object.entries(where ?? {}).every(([k, v]) => {
    if (v === undefined) return true;
    if (k === "OR") return (v as Row[]).some(w => matches(row, w));
    if (k === "AND") return (v as Row[]).every(w => matches(row, w));
    if (k === "accountId_feature") return matches(row, v);
    const val = row[k];
    if (v === null) return val === null || val === undefined;
    if (v instanceof Date) return val instanceof Date && val.getTime() === v.getTime();
    if (typeof v === "object" && !Array.isArray(v)) return Object.entries(v).every(([op, x]: [string, any]) => {
      switch (op) {
        case "gt": return val != null && cmp(val, x) > 0;
        case "in": return (x as unknown[]).includes(val);
        case "not": return x === null ? val !== null && val !== undefined : val !== x;
        default: throw new Error(`in-memory prisma: unsupported filter ${op}`);
      }
    });
    return val === v;
  });
}
function order(rows: Row[], orderBy: any): Row[] {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).flatMap((o: Row) => Object.entries(o));
  return [...rows].sort((a, b) => { for (const [k, dir] of keys) { const c = cmp(a[k], b[k]); if (c) return dir === "desc" ? -c : c; } return 0; });
}
const tables: Record<string, Row[]> = {};
function table(name: string) {
  tables[name] = [];
  const rows = () => tables[name];
  return {
    findUnique: async ({ where }: any) => { const r = rows().find(x => matches(x, where)); return r ? { ...r } : null; },
    findFirst: async ({ where, orderBy }: any = {}) => { const r = order(rows().filter(x => matches(x, where)), orderBy)[0]; return r ? { ...r } : null; },
    findMany: async ({ where, orderBy, take }: any = {}) => order(rows().filter(r => matches(r, where)), orderBy).slice(0, take ?? Infinity).map(r => ({ ...r })),
    updateMany: async ({ where, data }: any) => { const hit = rows().filter(r => matches(r, where)); hit.forEach(r => Object.assign(r, structuredClone(data))); return { count: hit.length }; },
  };
}
const db: any = {
  account: table("account"), agentToken: table("agentToken"), appBridgeDevice: table("device"), appBridgeLease: table("lease"),
  appBridgeEntitlement: table("entitlement"), remoteSubscription: table("remoteSubscription"),
};
db.$transaction = async (fn: any, options: any) => {
  assert.equal(options?.isolationLevel, "Serializable");
  const snapshot = structuredClone(tables);
  try { return await fn(db); } catch (e) { Object.assign(tables, snapshot); throw e; }
};

let limited = false;
const hits = new Map<string, number>();
before(() => {
  process.env.PUBLIC_APP_URL = "https://back-channel.app";
  mock.module("@/lib/db", { namedExports: { prisma: db } });
  mock.module("@/lib/rate-limit", { namedExports: {
    rateLimit: (bucket: string, key: string, max: number) => { const k = `${bucket}:${key}`; const n = (hits.get(k) ?? 0) + 1; hits.set(k, n); return { ok: !limited && n <= max, retryAfterSec: 7 }; },
    rateLimitPeek: () => ({ ok: !limited, retryAfterSec: 7 }),
    clientIp: () => "unknown",
  } });
  mock.module("@/lib/auth", { namedExports: {
    SESSION_COOKIE_NAME: "bc_session", CSRF_COOKIE_NAME: "bc_csrf", CSRF_HEADER: "x-bc-csrf",
    csrfValid: (h: string | null, c: string | null) => !!h && !!c && h === c,
    getAccountFromCookie: async (v: string | undefined) => tables.account.find(a => a.cookie === v) ?? null,
    // Like the real one: a live AgentToken by its key, with its scope.
    getAuthContext: async (header: string | null) => {
      const m = /^Bearer (\S+)$/.exec(header ?? "");
      const a = m ? tables.agentToken.find(x => x.key === m[1] && !x.revokedAt) : null;
      return a ? { account: tables.account.find(x => x.id === a.accountId), agentTokenId: a.id, scope: a.scope } : null;
    },
  } });
});

// ── Fixtures ──
const A = { shop: "a0000000-0000-4000-8000-000000000001", laptop: "a0000000-0000-4000-8000-000000000002", office: "a0000000-0000-4000-8000-000000000003",
  plain: "a0000000-0000-4000-8000-000000000004", conn: "a0000000-0000-4000-8000-000000000005", other: "a0000000-0000-4000-8000-000000000006",
  gone: "a0000000-0000-4000-8000-000000000007" };
const KEY = { shop: "bc_shop", laptop: "bc_laptop", office: "bc_office", plain: "bc_plain", conn: "bco_conn", other: "bc_other", gone: "bc_gone" };
const PC1 = "pcShop000000000000000A", PC2 = "pcOffice00000000000000", PC3 = "pcTwinA000000000000000", PC4 = "pcTwinB000000000000000", PC5 = "pcOther000000000000000";
const keys = () => ({
  dispatchEncryptionKey: generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "pem" }).toString(),
  dispatchSigningKey: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString(),
});
// The contract's formula, written out here: the broker must agree with it (and with the worker's).
const fp = (a: Row) => { const h = createHash("sha256").update(`${a.dispatchSigningKey}\n${a.dispatchEncryptionKey}`).digest("hex").toUpperCase(); return `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}`; };

function reset() {
  for (const k of Object.keys(tables)) tables[k] = [];
  limited = false; hits.clear();
  process.env.APPBRIDGE_REMOTE_ACCESS = "on";
  const now = new Date();
  tables.account.push({ id: "acct-a", cookie: "cs_a" }, { id: "acct-b", cookie: "cs_b" });
  const agent = (id: string, key: string, accountId: string, name: string, over: Row = {}) =>
    ({ id, key, accountId, name, scope: "full", revokedAt: null, dispatchName: null, dispatchEncryptionKey: null, dispatchSigningKey: null, readiness: null, readinessAt: null,
      createdAt: new Date(now.getTime() + tables.agentToken.length), ...over });
  tables.agentToken.push(
    agent(A.shop, KEY.shop, "acct-a", "Shop agent", { dispatchName: "shop-pc", ...keys() }),
    agent(A.laptop, KEY.laptop, "acct-a", "Laptop Claude", { dispatchName: "laptop", ...keys() }),
    agent(A.office, KEY.office, "acct-a", "Office agent", { dispatchName: "office", ...keys() }),
    agent(A.plain, KEY.plain, "acct-a", "Chat agent"),
    agent(A.conn, KEY.conn, "acct-a", "claude.ai", { scope: "connector" }),
    agent(A.other, KEY.other, "acct-b", "Their agent", { ...keys() }),
    agent(A.gone, KEY.gone, "acct-a", "Old agent", { ...keys(), revokedAt: now }),
  );
  tables.entitlement.push({ accountId: "acct-a", feature: "appbridge.remote_access", active: true });
  const pc = (id: string, accountId: string, label: string | null, over: Row = {}) =>
    tables.device.push({ id, accountId, role: "host", label, enabled: true, relayEnabled: true, createdAt: new Date(now.getTime() + tables.device.length), revokedAt: null, ...over });
  pc(PC1, "acct-a", "Shop-PC"); pc(PC2, "acct-a", "Office PC"); pc(PC3, "acct-a", "Twin"); pc(PC4, "acct-a", "twin");
  pc(PC5, "acct-b", "Their PC");
  pc("pcRevoked0000000000000", "acct-a", "Old PC", { revokedAt: now });
  tables.device.push({ id: "phone00000000000000000", accountId: "acct-a", role: "remote", label: "Phone", enabled: true, relayEnabled: false, createdAt: now, revokedAt: null });
}
beforeEach(reset);

const row = (id: string) => tables.agentToken.find(a => a.id === id)!;
const report = (agentId: string | null, over: Row = {}) => ({
  v: 1, agentId, name: "shop-pc", enrolled: agentId !== null, fingerprint: agentId ? fp(row(agentId)) : null, workerVersion: "0.1.0",
  appbridge: { pipe: "listening", hostName: "SHOP-PC", reason: null },
  runtime: { adapter: "claude", path: null, installed: true, signedIn: true },
  profiles: { remoteApp: { present: true, senders: [{ agentId: A.laptop, name: null, pinned: true }] } },
  checkedAt: new Date().toISOString(),
  ...over,
});
type Res = { status: number; body: any; headers: Headers };
async function put(body: unknown, o: { as?: string; cookie?: string; raw?: string; length?: boolean } = {}): Promise<Res> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (o.as) headers.authorization = `Bearer ${o.as}`;
  if (o.cookie) headers.cookie = `bc_session=${o.cookie}; bc_csrf=tok`;
  const text = o.raw ?? JSON.stringify(body);
  if (o.length) headers["content-length"] = String(Buffer.byteLength(text));
  const { PUT } = await import("@/app/api/agents/self/readiness/route");
  const res = await PUT(new NextRequest("https://back-channel.app/api/agents/self/readiness", { method: "PUT", headers, body: text }));
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null, headers: res.headers };
}
async function get(path: string, o: { as?: string; cookie?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  if (o.as) headers.authorization = `Bearer ${o.as}`;
  if (o.cookie) headers.cookie = `bc_session=${o.cookie}; bc_csrf=tok`;
  const mod = await import("@/app/api/remote-app/[[...path]]/route");
  const res = await mod.GET(new NextRequest(`https://back-channel.app/api/remote-app/${path}`, { method: "GET", headers }), { params: Promise.resolve({ path: path.split("/") }) });
  const t = await res.text();
  return { status: res.status, body: t ? JSON.parse(t) : null, headers: res.headers };
}
const stateOf = (r: Row) => Object.fromEntries(r.steps.map((s: Row) => [s.key, s.state]));

// ── PUT /api/agents/self/readiness ──

test("report: a full agent key stores its own report (local-only text dropped) with the server's time", async () => {
  const sent = report(A.shop, { appbridge: { pipe: "listening", hostName: "SHOP-PC", reason: "fine" },
    runtime: { adapter: "claude", path: "C:\\Users\\someone\\claude.exe", installed: true, signedIn: true },
    profiles: { remoteApp: { present: true, senders: [{ agentId: A.laptop, name: "Laptop Claude", pinned: true }] } } });
  const before = Date.now();
  const r = await put(sent, { as: KEY.shop });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.body.recorded, true);
  const stored = row(A.shop);
  assert.ok(stored.readinessAt instanceof Date && stored.readinessAt.getTime() >= before);
  assert.equal(r.body.readinessAt, stored.readinessAt.toISOString());
  assert.deepEqual(stored.readiness, { ...report(A.shop), checkedAt: sent.checkedAt });
  assert.equal(stored.readiness.runtime.path, null);
  assert.equal(stored.readiness.appbridge.reason, null);
  assert.equal(stored.readiness.profiles.remoteApp.senders[0].name, null);
  assert.equal(row(A.laptop).readiness, null, "only its own row");
  // A worker not enrolled for Dispatch reports too.
  assert.equal((await put(report(null, { name: "chat" }), { as: KEY.plain })).status, 200);
  assert.equal(row(A.plain).readiness.enrolled, false);
});

test("report: who may send it. No key 401, a connector key 403, the dashboard cookie alone 401, a revoked key 401", async () => {
  assert.equal((await put(report(A.shop))).status, 401);
  assert.equal((await put(report(A.shop), { as: "bc_nobody" })).status, 401);
  const conn = await put(report(A.conn), { as: KEY.conn });
  assert.equal(conn.status, 403);
  assert.equal(conn.body.error, "not_available_to_connectors");
  assert.equal((await put(report(A.shop), { cookie: "cs_a" })).status, 401);
  assert.equal((await put(report(A.gone), { as: KEY.gone })).status, 401);
  assert.ok(tables.agentToken.every(a => a.readiness === null), "nothing written");
});

test("report: strict shape, about itself, at most 8 KiB, rate-limited", async () => {
  const refused = async (body: unknown, status: number, error: string, o: Row = {}) => {
    const r = await put(body, { as: KEY.shop, ...o });
    assert.equal(r.status, status, JSON.stringify(r.body)); assert.equal(r.body.error, error); assert.ok(r.body.message);
  };
  await refused({ ...report(A.shop), extra: true }, 400, "unknown_field");
  await refused({ ...report(A.shop), runtime: { adapter: "claude", path: null, installed: true, signedIn: true, account: "x" } }, 400, "unknown_field");
  await refused(report(A.laptop), 400, "agent_mismatch");
  await refused(report(A.shop, { name: "x".repeat(81) }), 400, "invalid_readiness");
  await refused(report(A.shop, { appbridge: { pipe: "listening", hostName: "Shop\u0000PC", reason: null } }), 400, "invalid_readiness");
  await refused(report(A.shop, { fingerprint: "not-a-fingerprint" }), 400, "invalid_fingerprint");
  await refused(null, 400, "invalid_json", { raw: "{not json" });
  await refused(null, 400, "invalid_readiness", { raw: "[]" });
  // Over 8 KiB: refused by its declared length, and by what actually arrives.
  const big = report(A.shop, { workerVersion: "0.1.0", name: "x", pad: "y".repeat(9000) });
  await refused(big, 413, "too_large", { length: true });
  await refused(big, 413, "too_large");
  assert.equal(row(A.shop).readiness, null, "nothing written by any refusal");
  // Exactly at the bound is fine; one byte over is not.
  const fits = JSON.stringify(report(A.shop));
  const padded = fits.slice(0, -1) + " ".repeat(8192 - Buffer.byteLength(fits)) + "}";
  assert.equal(Buffer.byteLength(padded), 8192);
  assert.equal((await put(null, { as: KEY.shop, raw: padded })).status, 200);
  await refused(null, 413, "too_large", { raw: padded.slice(0, -1) + " }" });
  limited = true;
  const r = await put(report(A.shop), { as: KEY.shop });
  assert.equal(r.status, 429); assert.equal(r.headers.get("retry-after"), "7");
});

// ── GET /api/remote-app/readiness: the owner's "Agents on your PCs" ──

test("owner view: the person only; each Dispatch agent with its fingerprint, last report, matched PC and checklist; PCs with no agent", async () => {
  assert.equal((await get("readiness")).status, 401);
  const agentTry = await get("readiness", { as: KEY.shop });
  assert.equal(agentTry.status, 403); assert.equal(agentTry.body.error, "people_only"); assert.match(agentTry.body.message, /bc_remote_machines/);
  assert.equal((await put(report(A.shop), { as: KEY.shop })).status, 200);

  const r = await get("readiness", { cookie: "cs_a" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.body.staleAfterMinutes, 30);
  assert.deepEqual(r.body.agents.map((a: Row) => a.agentId), [A.shop, A.laptop, A.office], "live full-scope Dispatch agents of this account only");
  const shop = r.body.agents[0];
  assert.deepEqual([shop.name, shop.fingerprint, shop.reporting, shop.ready, shop.missing], ["Shop agent", fp(row(A.shop)), true, true, []]);
  assert.deepEqual(shop.pc, { hostDeviceId: PC1, name: "Shop-PC" }, "SHOP-PC matches Shop-PC, ignoring case");
  assert.equal(shop.reportsFrom, "SHOP-PC");
  assert.equal(shop.readinessAt, row(A.shop).readinessAt.toISOString());
  assert.deepEqual(shop.readiness.profiles.remoteApp.senders, [{ agentId: A.laptop, name: "Laptop Claude", pinned: true }], "senders by the names given here");
  assert.equal(shop.steps.length, 6);
  const laptop = r.body.agents[1];
  assert.deepEqual([laptop.fingerprint, laptop.readiness, laptop.readinessAt, laptop.reporting, laptop.pc], [fp(row(A.laptop)), null, null, false, null]);
  assert.equal(stateOf(laptop).worker, "needed");
  assert.match(laptop.steps.find((s: Row) => s.key === "worker").howTo, /never reported/);
  // Every registered PC no worker reports from: not the matched one, not a revoked one, not a phone, not another account's.
  assert.deepEqual(r.body.pcs.map((p: Row) => [p.hostDeviceId, p.name, p.note]), [[PC2, "Office PC", "No agent set up on this PC yet."], [PC3, "Twin", "No agent set up on this PC yet."], [PC4, "twin", "No agent set up on this PC yet."]]);
  assert.deepEqual(stateOf(r.body.pcs[0]), { appbridge: "unknown", registered: "done", agent_control: "unknown", worker: "needed", senders: "unknown", claude: "unknown" });
  assert.ok(!JSON.stringify(r.body).includes("Their"), "nothing from another account");
});

test("owner view: stale, missing and matching", async () => {
  await put(report(A.shop), { as: KEY.shop });
  await put(report(A.office, { name: "office", appbridge: { pipe: "absent", hostName: null, reason: null }, runtime: { adapter: "claude", path: null, installed: true, signedIn: false },
    profiles: { remoteApp: { present: false, senders: [] } } }), { as: KEY.office });
  await put(report(A.laptop, { name: "laptop", appbridge: { pipe: "listening", hostName: "TWIN", reason: null } }), { as: KEY.laptop });
  // The shop worker last reported 31 minutes ago: not reporting.
  row(A.shop).readinessAt = new Date(Date.now() - 31 * 60_000);
  const r = await get("readiness", { cookie: "cs_a" });
  const [shop, laptop, office] = r.body.agents;
  assert.deepEqual([shop.reporting, shop.ready, stateOf(shop).worker, stateOf(shop).claude], [false, false, "needed", "unknown"]);
  assert.match(shop.steps.find((s: Row) => s.key === "worker").howTo, /^Not reporting: the worker isn't running on that PC/);
  assert.deepEqual(shop.pc, { hostDeviceId: PC1, name: "Shop-PC" }, "still where it last reported from");
  assert.deepEqual(office.missing, ["appbridge", "registered", "agent_control", "senders", "claude"]);
  assert.deepEqual(stateOf(office), { appbridge: "unknown", registered: "unknown", agent_control: "needed", worker: "done", senders: "needed", claude: "needed" });
  assert.equal(office.steps.find((s: Row) => s.key === "claude").howTo, "On that PC, open AppBridge → Agents → Sign in to Claude.");
  // Two PCs are called "Twin" (any case): no match, so both stay listed with no agent.
  assert.equal(laptop.pc, null);
  assert.equal(stateOf(laptop).registered, "unknown");
  assert.deepEqual(r.body.pcs.map((p: Row) => p.hostDeviceId), [PC2, PC3, PC4]);
  // A stored row that no longer fits the contract is ignored, never shown.
  row(A.office).readiness = { v: 1, junk: true };
  const again = await get("readiness", { cookie: "cs_a" });
  assert.deepEqual([again.body.agents[2].readiness, again.body.agents[2].reporting], [null, false]);
});

// ── bc_remote_machines: what agents see ──

test("machines: each PC lists the agents reporting from it; executors says who is ready and what's missing; howToFix says how", async () => {
  await put(report(A.shop), { as: KEY.shop });
  await put(report(A.office, { name: "office", appbridge: { pipe: "listening", hostName: "office pc", reason: null }, runtime: { adapter: "claude", path: null, installed: true, signedIn: false } }), { as: KEY.office });
  const r = await get("machines", { as: KEY.laptop });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const byId = Object.fromEntries(r.body.machines.map((m: Row) => [m.hostDeviceId, m]));
  assert.deepEqual(byId[PC1].agents, [{ agentId: A.shop, name: "Shop agent", ready: true, missing: [] }]);
  assert.deepEqual(byId[PC2].agents, [{ agentId: A.office, name: "Office agent", ready: false, missing: ["claude"] }]);
  assert.deepEqual(byId[PC3].agents, []);
  assert.deepEqual(r.body.executors, [
    { agentId: A.shop, name: "Shop agent", ready: true, missing: [], hostDeviceId: PC1, pc: "Shop-PC", reporting: true },
    { agentId: A.laptop, name: "Laptop Claude", ready: false, missing: ["appbridge", "registered", "agent_control", "worker", "senders", "claude"], hostDeviceId: null, pc: null, reporting: false },
    { agentId: A.office, name: "Office agent", ready: false, missing: ["claude"], hostDeviceId: PC2, pc: "Office PC", reporting: true },
  ]);
  assert.equal(r.body.howToFix.claude, "On that PC, open AppBridge → Agents → Sign in to Claude.");
  assert.match(r.body.note, /name a ready one as executor/);
  assert.ok(!JSON.stringify(r.body).includes("BEGIN PUBLIC KEY"), "no keys, only names and states");
  assert.equal((await get("machines", { as: KEY.conn })).status, 403, "still full-scope keys only");
});
