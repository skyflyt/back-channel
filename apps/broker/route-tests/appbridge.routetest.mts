import { test, before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { NextRequest } from "next/server";
import { PrismaClientKnownRequestError, PrismaClientUnknownRequestError } from "@prisma/client/runtime/library";

// ── In-memory Prisma: enough of the query surface for src/lib/appbridge.ts ──
// $transaction snapshots every table and restores it if the callback throws,
// like a real rollback, so "refusals are values, consumption commits" is tested.
type Row = Record<string, any>;
function matches(row: Row | undefined, where: Row | undefined): boolean {
  if (!row) return false;
  return Object.entries(where ?? {}).every(([k, v]) => {
    if (v === undefined) return true;
    if (k === "OR") return (v as Row[]).some(w => matches(row, w));
    if (k === "hostDeviceId_enrollmentId" || k === "accountId_feature") return matches(row, v);
    if (v instanceof Date) return row[k]?.getTime() === v.getTime();
    if (v && typeof v === "object") return Object.entries(v).every(([op, x]: [string, any]) =>
      op === "gt" ? row[k] > x : op === "gte" ? row[k] >= x : op === "lt" ? row[k] < x : op === "not" ? row[k] !== x : false);
    return row[k] === v;
  });
}
const tables: Record<string, Row[]> = {};
function table(name: string, defaults: () => Row = () => ({})) {
  tables[name] = [];
  const rows = () => tables[name];
  return {
    findUnique: async ({ where }: any) => rows().find(r => matches(r, where)) ?? null,
    findFirst: async ({ where }: any) => rows().find(r => matches(r, where)) ?? null,
    findMany: async ({ where, take }: any) => rows().filter(r => matches(r, where)).slice(0, take ?? Infinity),
    create: async ({ data }: any) => { const r = { ...defaults(), ...data }; rows().push(r); return r; },
    update: async ({ where, data }: any) => { const r = rows().find(x => matches(x, where)); if (!r) throw new Error("not found"); return Object.assign(r, data); },
    updateMany: async ({ where, data }: any) => { const hit = rows().filter(r => matches(r, where)); hit.forEach(r => Object.assign(r, data)); return { count: hit.length }; },
    deleteMany: async ({ where }: any) => { const keep = rows().filter(r => !matches(r, where)); const count = rows().length - keep.length; tables[name] = keep; return { count }; },
    upsert: async ({ where, create, update }: any) => { const r = rows().find(x => matches(x, where)); if (r) return Object.assign(r, update); const n = { ...defaults(), ...create }; rows().push(n); return n; },
  };
}
const db: any = {
  account: table("account"),
  accountAudit: table("accountAudit", () => ({ createdAt: new Date() })),
  appBridgeDevice: table("device", () => ({ label: null, enabled: true, relayEnabled: false, createdAt: new Date(), revokedAt: null })),
  appBridgeCredential: table("credential", () => ({ createdAt: new Date(), revokedAt: null })),
  appBridgeDeviceCode: table("code", () => ({ createdAt: new Date(), usedAt: null })),
  appBridgePairing: table("pairing", () => ({ attestedAt: new Date(), withdrawnAt: null })),
  appBridgeEntitlement: table("entitlement", () => ({ updatedAt: new Date() })),
  appBridgePass: table("pass", () => ({ createdAt: new Date(), consumedAt: null, remoteDeviceId: null, enrollmentId: null })),
  appBridgeLease: table("lease", () => ({ createdAt: new Date() })),
  appBridgeConnectionEvent: table("connection", () => ({ id: crypto.randomUUID(), at: new Date() })),
  // The gate also reads Remote subscriptions (remote-entitlement.ts); billing.routetest.mts covers them.
  remoteSubscription: table("remoteSubscription"),
};
const credentialFind = db.appBridgeCredential.findUnique;
db.appBridgeCredential.findUnique = async (args: any) => {
  const c = await credentialFind(args);
  return c && args.include?.device ? { ...c, device: tables.device.find(d => d.id === c.deviceId) } : c;
};
// transactionFaults: one per attempt, raised at COMMIT after the callback ran, with its writes
// rolled back, the way Postgres aborts a serializable transaction. A fault's `winner` then runs as
// the concurrent transaction that won the conflict and committed.
let transactionFaults: unknown[] = []; let transactionCalls = 0;
db.$transaction = async (fn: any, options: any) => {
  transactionCalls++;
  assert.equal(options?.isolationLevel, "Serializable");
  const snapshot = structuredClone(tables);
  let result: unknown;
  try { result = await fn(db); } catch (e) { Object.assign(tables, snapshot); throw e; }
  const fault = transactionFaults.shift();
  if (!fault) return result;
  Object.assign(tables, snapshot);
  if (typeof fault === "object" && "winner" in fault) { (fault as { winner: () => void }).winner(); throw (fault as { abort: unknown }).abort; }
  throw fault;
};

// A real counter (one window per test), so budgets and their separation are exercised, not assumed.
// `limited` still forces every bucket shut.
let limited = false;
const hits = new Map<string, number>();
before(() => {
  mock.module("@/lib/db", { namedExports: { prisma: db } });
  mock.module("@/lib/rate-limit", { namedExports: {
    rateLimit: (bucket: string, key: string, max: number) => { const k = `${bucket}:${key}`; const n = (hits.get(k) ?? 0) + 1; hits.set(k, n); return { ok: !limited && n <= max, retryAfterSec: 7 }; },
    rateLimitPeek: (bucket: string, key: string, max: number) => ({ ok: !limited && (hits.get(`${bucket}:${key}`) ?? 0) < max, retryAfterSec: 7 }),
  } });
  mock.module("@/lib/auth", { namedExports: {
    SESSION_COOKIE_NAME: "bc_session", CSRF_COOKIE_NAME: "bc_csrf", CSRF_HEADER: "x-bc-csrf",
    csrfValid: (h: string | null, c: string | null) => !!h && !!c && h === c,
    getAccountFromCookie: async (v: string | undefined) => tables.account.find(a => a.cookie === v) ?? null,
  } });
});
function reset() {
  for (const k of Object.keys(tables)) tables[k] = [];
  limited = false; hits.clear(); transactionFaults = []; transactionCalls = 0;
  process.env.APPBRIDGE_REMOTE_ACCESS = "on";
  process.env.APPBRIDGE_RELAY_PUBLIC_KEY = RELAY_PUBLIC_KEY;
  delete process.env.APPBRIDGE_RELAY_URL;
  process.env.ADMIN_EMAILS = "owner@example.com";
  tables.account.push(
    { id: "acct-a", handle: "skylar", email: "owner@example.com", admin: false, emailVerifiedAt: new Date(), cookie: "cs_a" },
    { id: "acct-b", handle: "other", email: "other@example.com", admin: true, emailVerifiedAt: new Date(), cookie: "cs_b" },
  );
}
beforeEach(reset);

// ── Helpers ──
const routes = {
  exchange: () => import("@/app/api/appbridge/v1/devices/exchange/route"),
  self: () => import("@/app/api/appbridge/v1/devices/self/route"),
  credential: () => import("@/app/api/appbridge/v1/devices/self/credential/route"),
  connector: () => import("@/app/api/appbridge/v1/devices/self/connector/route"),
  relaySwitch: () => import("@/app/api/appbridge/v1/hosts/self/relay/route"),
  pairing: () => import("@/app/api/appbridge/v1/hosts/self/pairings/[enrollmentId]/route"),
  presence: () => import("@/app/api/appbridge/v1/relay/presence-passes/route"),
  passes: () => import("@/app/api/appbridge/v1/relay/passes/route"),
  redeem: () => import("@/app/api/appbridge/v1/relay/redeem/route"),
  renew: () => import("@/app/api/appbridge/v1/relay/renew/route"),
  release: () => import("@/app/api/appbridge/v1/relay/release/route"),
  codes: () => import("@/app/api/appbridge/v1/account/device-codes/route"),
  devices: () => import("@/app/api/appbridge/v1/account/devices/route"),
  device: () => import("@/app/api/appbridge/v1/account/devices/[id]/route"),
  connections: () => import("@/app/api/appbridge/v1/account/connections/route"),
  entitlements: () => import("@/app/api/appbridge/v1/admin/entitlements/route"),
};
function req(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("https://back-channel.app/api/appbridge/v1/x", { method, headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
}
const bearer = (credential: string) => ({ authorization: `Bearer ${credential}` });
// The relay's Ed25519 identity: it signs, the broker verifies with the public half.
const relayKeys = generateKeyPairSync("ed25519");
const RELAY_PUBLIC_KEY = relayKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const relayMarkers = { "x-forwarded-for": "203.0.113.77", "user-agent": "relay-ua-marker" };
type SignOpts = { seconds?: number; nonce?: string; key?: KeyObject; signedBody?: string };
function relaySignature(path: string, raw: string, o: SignOpts = {}) {
  const seconds = String(o.seconds ?? Math.floor(Date.now() / 1000));
  const nonce = o.nonce ?? randomBytes(16).toString("base64url");
  const hash = createHash("sha256").update(o.signedBody ?? raw).digest("hex");
  const sig = sign(null, Buffer.from(`appbridge-relay-broker-v1\nPOST\n${path}\n${seconds}\n${nonce}\n${hash}`), o.key ?? relayKeys.privateKey).toString("base64url");
  return `AppBridge-Relay v1.${seconds}.${nonce}.${sig}`;
}
function relayReq(route: "redeem" | "renew" | "release", body: unknown, o: SignOpts = {}, headers?: Record<string, string>) {
  const path = `/api/appbridge/v1/relay/${route}`;
  const raw = JSON.stringify(body);
  return new NextRequest(`https://back-channel.app${path}`, { method: "POST", body: raw,
    headers: { "content-type": "application/json", ...relayMarkers, ...(headers ?? { authorization: relaySignature(path, raw, o) }) } });
}
const cookie = (acct = "a", csrf = true) => ({ cookie: `bc_session=cs_${acct}; bc_csrf=tok`, ...(csrf ? { "x-bc-csrf": "tok" } : {}) });
const params = <T,>(p: T) => ({ params: Promise.resolve(p) });
function newKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const der = publicKey.export({ type: "spki", format: "der" });
  return { spki: der.toString("base64"), fp: createHash("sha256").update(der).digest("hex").toUpperCase(),
    sign: (m: string) => sign("sha256", Buffer.from(m), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
}
async function mint(role: "host" | "remote", acct = "a", label?: string) {
  const r = await (await routes.codes()).POST(req("POST", { role, ...(label ? { label } : {}) }, cookie(acct)));
  assert.equal(r.status, 200); return (await r.json()).code as string;
}
async function register(role: "host" | "remote", acct = "a") {
  const key = newKey(); const code = await mint(role, acct);
  const r = await (await routes.exchange()).POST(req("POST", { code, role, connectorSpki: key.spki, proof: key.sign(`appbridge-device-exchange-v1:${code}`) }));
  assert.equal(r.status, 200);
  const body = await r.json();
  return { ...body, key } as { deviceId: string; credential: string; scopes: string[]; expiresAt: string; key: ReturnType<typeof newKey> };
}
async function entitle(handle = "skylar", active = true) {
  const r = await (await routes.entitlements()).PUT(req("PUT", { handle, active }, cookie("a"))); assert.equal(r.status, 200);
}
async function setRelay(host: { credential: string }, enabled: boolean) {
  const r = await (await routes.relaySwitch()).PUT(req("PUT", { enabled }, bearer(host.credential))); assert.equal(r.status, 200);
}
async function attest(host: { credential: string }, remoteDeviceId: string, enrollmentId = "enr-1") {
  return (await routes.pairing()).PUT(req("PUT", { remoteDeviceId }, bearer(host.credential)), params({ enrollmentId }));
}
async function ready() {
  const host = await register("host"); const remote = await register("remote");
  await entitle(); await setRelay(host, true);
  assert.equal((await attest(host, remote.deviceId)).status, 204);
  return { host, remote };
}
async function sessionPass(remote: { credential: string }, hostDeviceId: string, enrollmentId = "enr-1") {
  return (await routes.passes()).POST(req("POST", { hostDeviceId, enrollmentId }, bearer(remote.credential)));
}
async function redeem(pass: string, purpose: string, connectorSpkiSha256: string, headers?: Record<string, string>) {
  return (await routes.redeem()).POST(relayReq("redeem", { pass, purpose, connectorSpkiSha256 }, {}, headers));
}
async function renew(leaseId: string, o: SignOpts = {}) { return (await routes.renew()).POST(relayReq("renew", { leaseId }, o)); }
async function release(leaseId: string) { return (await routes.release()).POST(relayReq("release", { leaseId })); }

// ── Tests ──
test("device routes accept only an ab_ credential: bc_ keys, cookies, garbage and revoked credentials are 401", async () => {
  const host = await register("host");
  const self = await routes.self();
  for (const headers of [{}, bearer("bc_" + "x".repeat(32)), cookie("a"), bearer("ab_short"), { authorization: `Basic ${host.credential}` }]) {
    const r = await self.GET(req("GET", undefined, headers));
    assert.equal(r.status, 401); assert.equal(r.headers.get("cache-control"), "no-store");
  }
  assert.equal((await self.GET(req("GET", undefined, bearer(host.credential)))).status, 200);
  // Even a credential row whose raw value is not ab_-shaped is refused: the prefix is enforced, not incidental.
  const agentKey = "bc_" + "A".repeat(43);
  tables.credential.push({ ...tables.credential[0], keyHash: createHash("sha256").update(agentKey).digest("hex") });
  assert.equal((await self.GET(req("GET", undefined, bearer(agentKey)))).status, 401);
  tables.credential[0].revokedAt = new Date();
  assert.equal((await self.GET(req("GET", undefined, bearer(host.credential)))).status, 401);
});

test("scopes follow the role: a remote cannot ask for presence passes or flip a relay switch; a host cannot ask for session passes", async () => {
  const { host, remote } = await ready();
  assert.deepEqual(host.scopes, ["appbridge.device", "appbridge.host.relay", "appbridge.relay.presence"]);
  assert.deepEqual(remote.scopes, ["appbridge.device", "appbridge.relay.pass"]);
  assert.equal((await (await routes.presence()).POST(req("POST", {}, bearer(remote.credential)))).status, 403);
  assert.equal((await (await routes.relaySwitch()).PUT(req("PUT", { enabled: true }, bearer(remote.credential)))).status, 403);
  assert.equal((await sessionPass(host, host.deviceId)).status, 403);
});

test("exchange: the code is one-use, role-bound, 10 minutes, and needs a P-256 proof over the code", async () => {
  const key = newKey(); const code = await mint("host");
  const exchange = (await routes.exchange()).POST;
  const bodyFor = (over: Record<string, unknown> = {}) => ({ code, role: "host", connectorSpki: key.spki, proof: key.sign(`appbridge-device-exchange-v1:${code}`), ...over });
  assert.equal((await exchange(req("POST", bodyFor({ proof: newKey().sign(`appbridge-device-exchange-v1:${code}`) })))).status, 400, "proof by another key");
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
  assert.equal((await exchange(req("POST", bodyFor({ connectorSpki: rsa })))).status, 400, "not P-256");
  const wrongRole = await exchange(req("POST", bodyFor({ role: "remote" })));
  assert.equal(wrongRole.status, 409); assert.equal(tables.code[0].usedAt, null, "a role mismatch does not burn the code");
  assert.equal((await exchange(req("POST", bodyFor({ extra: 1 })))).status, 400, "exact members");
  const ok = await exchange(req("POST", bodyFor()));
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.match(body.credential, /^ab_[A-Za-z0-9_-]{43}$/); assert.match(body.deviceId, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(tables.credential[0].keyHash, createHash("sha256").update(body.credential).digest("hex"), "only the hash is stored");
  assert.ok(!JSON.stringify(tables).includes(body.credential) && !JSON.stringify(tables).includes(code), "raw credential and code never stored");
  assert.equal((await exchange(req("POST", bodyFor()))).status, 410, "one use");
  const late = await mint("remote"); tables.code.find(c => c.role === "remote")!.expiresAt = new Date(Date.now() - 1);
  const k2 = newKey();
  assert.equal((await exchange(req("POST", { code: late, role: "remote", connectorSpki: k2.spki, proof: k2.sign(`appbridge-device-exchange-v1:${late}`) }))).status, 410, "expired");
  const again = await mint("remote");
  assert.equal((await exchange(req("POST", { code: again, role: "remote", connectorSpki: key.spki, proof: key.sign(`appbridge-device-exchange-v1:${again}`) }))).status, 409, "a live device's key cannot be registered twice");
});

test("account routes: dashboard cookie only, CSRF on mutations, verified email to mint codes", async () => {
  const codes = (await routes.codes()).POST;
  assert.equal((await codes(req("POST", { role: "host" }))).status, 401);
  assert.equal((await codes(req("POST", { role: "host" }, bearer("bc_" + "x".repeat(32))))).status, 401, "an agent key cannot mint device codes");
  assert.equal((await codes(req("POST", { role: "host" }, cookie("a", false)))).status, 403, "csrf");
  assert.equal((await codes(req("POST", { role: "admin" }, cookie("a")))).status, 400);
  tables.account[0].emailVerifiedAt = null;
  assert.equal((await codes(req("POST", { role: "host" }, cookie("a")))).status, 409);
  tables.account[0].emailVerifiedAt = new Date();
  const r = await codes(req("POST", { role: "host", label: "  Workstation  " }, cookie("a")));
  assert.equal(r.status, 200); assert.match((await r.json()).code, /^ABD-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(tables.code[0].label, "Workstation");
  limited = true;
  const rl = await codes(req("POST", { role: "host" }, cookie("a")));
  assert.equal(rl.status, 429); assert.equal(rl.headers.get("retry-after"), "7");
});

test("entitlements: owner only (ADMIN_EMAILS, verified), cookie only", async () => {
  const put = (await routes.entitlements()).PUT;
  assert.equal((await put(req("PUT", { handle: "other", active: true }, cookie("b")))).status, 403, "admin=true but not the owner");
  assert.equal((await put(req("PUT", { handle: "other", active: true }, cookie("a", false)))).status, 403, "csrf");
  assert.equal((await put(req("PUT", { handle: "other", active: true }, { ...cookie("a"), ...bearer("bc_anything") }))).status, 403, "a bearer key is refused");
  assert.equal((await put(req("PUT", { handle: "other", active: true }, bearer("bc_anything")))).status, 403, "bearer alone");
  delete process.env.ADMIN_EMAILS;
  assert.equal((await put(req("PUT", { handle: "other", active: true }, cookie("a")))).status, 403, "ADMIN_EMAILS unset: closed");
  process.env.ADMIN_EMAILS = "owner@example.com";
  tables.account[0].emailVerifiedAt = null;
  assert.equal((await put(req("PUT", { handle: "other", active: true }, cookie("a")))).status, 403, "owner email not verified");
  tables.account[0].emailVerifiedAt = new Date();
  assert.equal(tables.entitlement.length, 0);
  assert.equal((await put(req("PUT", { handle: "nobody", active: true }, cookie("a")))).status, 404);
  assert.equal((await put(req("PUT", { handle: "other", active: true }, cookie("a")))).status, 200);
  assert.deepEqual(tables.entitlement.map(e => [e.accountId, e.feature, e.active]), [["acct-b", "appbridge.remote_access", true]]);
});

test("the whole path: pass, redeem, 7-day log, renew; every refusal is read fresh", async () => {
  const { host, remote } = await ready();
  const issued = await sessionPass(remote, host.deviceId);
  assert.equal(issued.status, 200);
  const { pass, expiresAt, relay: relayUrl } = await issued.json();
  assert.match(pass, /^[0-9A-F]{64}$/); assert.equal(relayUrl, "wss://relay.back-channel.app/v1/connect");
  assert.ok(Math.abs(new Date(expiresAt).getTime() - Date.now() - 60_000) < 2000);
  const r = await redeem(pass, "session", remote.key.fp);
  assert.equal(r.status, 200);
  const grant = await r.json();
  assert.deepEqual(Object.keys(grant).sort(), ["accountId", "clientConnectorSpkiSha256", "clientDeviceId", "enrollmentId", "hostConnectorSpkiSha256", "hostDeviceId", "leaseId"]);
  assert.deepEqual({ ...grant, leaseId: undefined }, { leaseId: undefined, accountId: "acct-a", hostDeviceId: host.deviceId, clientDeviceId: remote.deviceId, enrollmentId: "enr-1",
    hostConnectorSpkiSha256: host.key.fp, clientConnectorSpkiSha256: remote.key.fp });
  assert.equal((await redeem(pass, "session", remote.key.fp)).status, 403, "a pass is redeemable once");
  const log = await (await (await routes.connections()).GET(req("GET", undefined, cookie("a")))).json();
  assert.deepEqual(log.connections.map((c: any) => [c.hostDeviceId, c.remoteDeviceId]), [[host.deviceId, remote.deviceId]]);
  const renewed = await renew(grant.leaseId);
  assert.equal(renewed.status, 200);
  assert.deepEqual(await renewed.json(), { hostConnectorSpkiSha256: host.key.fp, clientConnectorSpkiSha256: remote.key.fp });
  // Turning the host's relay switch off ends the lease at its next renewal; pairings survive.
  await setRelay(host, false);
  assert.equal((await renew(grant.leaseId)).status, 403);
  assert.equal(tables.lease.length, 0, "a refused renewal deletes the lease");
  assert.equal(tables.pairing[0].withdrawnAt, null);
  assert.deepEqual(await (await sessionPass(remote, host.deviceId)).json(), { error: "relay_off" });
});

test("gate refusals, each read fresh", async () => {
  const { host, remote } = await ready();
  process.env.APPBRIDGE_REMOTE_ACCESS = "off";
  assert.deepEqual(await (await sessionPass(remote, host.deviceId)).json(), { error: "rollout_off" });
  process.env.APPBRIDGE_REMOTE_ACCESS = "on";
  await entitle("skylar", false);
  assert.deepEqual(await (await sessionPass(remote, host.deviceId)).json(), { error: "not_entitled" });
  await entitle("skylar", true);
  assert.deepEqual(await (await sessionPass(remote, host.deviceId, "enr-other")).json(), { error: "not_paired" });
  const foreign = await register("host", "b");
  const r = await sessionPass(remote, foreign.deviceId);
  assert.equal(r.status, 404, "a PC in another account does not exist to this remote");
  // The pass was issued while allowed; the gate is checked again at redemption.
  const { pass } = await (await sessionPass(remote, host.deviceId)).json();
  const del = await (await routes.pairing()).DELETE(req("DELETE", undefined, bearer(host.credential)), params({ enrollmentId: "enr-1" }));
  assert.equal(del.status, 204);
  assert.equal((await redeem(pass, "session", remote.key.fp)).status, 403);
  assert.deepEqual(await (await sessionPass(remote, host.deviceId)).json(), { error: "not_paired" });
  assert.equal((await attest(host, remote.deviceId)).status, 409, "a withdrawn enrollment is never revived");
});

test("redeem consumes the pass even when it is refused, and checks purpose and the presenter's key", async () => {
  const { host, remote } = await ready();
  const { pass } = await (await sessionPass(remote, host.deviceId)).json();
  assert.equal((await redeem(pass, "session", host.key.fp)).status, 403, "the host's key presented for a session pass");
  assert.equal((await redeem(pass, "session", remote.key.fp)).status, 403, "already consumed by the refused attempt");
  assert.equal(tables.lease.length, 0);
  const second = (await (await sessionPass(remote, host.deviceId)).json()).pass;
  assert.equal((await redeem(second, "presence", remote.key.fp)).status, 403, "purpose mismatch");
  const third = (await (await sessionPass(remote, host.deviceId)).json()).pass;
  tables.pass.find(p => p.consumedAt === null)!.expiresAt = new Date(Date.now() - 1);
  assert.equal((await redeem(third, "session", remote.key.fp)).status, 403, "expired");
  assert.equal(tables.connection.length, 0, "no connection is logged for a refusal");
});

test("presence: a host's pass redeems with the host key, and the client members are null", async () => {
  const { host } = await ready();
  const r = await (await routes.presence()).POST(req("POST", {}, bearer(host.credential)));
  assert.equal(r.status, 200);
  const grant = await (await redeem((await r.json()).pass, "presence", host.key.fp)).json();
  assert.equal(grant.clientDeviceId, null); assert.equal(grant.enrollmentId, null); assert.equal(grant.clientConnectorSpkiSha256, null);
  assert.equal(grant.hostConnectorSpkiSha256, host.key.fp);
  assert.deepEqual(await (await renew(grant.leaseId)).json(), { hostConnectorSpkiSha256: host.key.fp, clientConnectorSpkiSha256: null });
  assert.equal(tables.connection.length, 0, "presence is not a connection");
});

test("relay routes accept only a request signed with the relay's Ed25519 key", async () => {
  const { host, remote } = await ready();
  const { pass } = await (await sessionPass(remote, host.deviceId)).json();
  for (const headers of [{}, bearer(remote.credential), bearer("bc_" + "x".repeat(32)), cookie("a"), { authorization: "Bearer someone-elses-token" }]) {
    assert.equal((await redeem(pass, "session", remote.key.fp, headers)).status, 401);
  }
  const body = { pass, purpose: "session", connectorSpkiSha256: remote.key.fp };
  const redeemWith = async (o: SignOpts) => (await routes.redeem()).POST(relayReq("redeem", body, o));
  assert.equal((await redeemWith({ key: generateKeyPairSync("ed25519").privateKey })).status, 401, "another key");
  assert.equal((await redeemWith({ signedBody: JSON.stringify({ ...body, pass: "0".repeat(64) }) })).status, 401, "a signature over a different body");
  assert.equal((await redeemWith({ seconds: Math.floor(Date.now() / 1000) - 120 })).status, 401, "stale");
  assert.equal((await redeemWith({ seconds: Math.floor(Date.now() / 1000) + 120 })).status, 401, "future");
  assert.equal(tables.pass[0].consumedAt, null, "an unauthenticated call never touches a pass");
  delete process.env.APPBRIDGE_RELAY_PUBLIC_KEY;
  assert.equal((await redeem(pass, "session", remote.key.fp)).status, 503, "unconfigured is an outage, never an open door");
  process.env.APPBRIDGE_RELAY_PUBLIC_KEY = generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
  assert.equal((await redeem(pass, "session", remote.key.fp)).status, 503, "a non-Ed25519 key is refused as configuration");
  process.env.APPBRIDGE_RELAY_PUBLIC_KEY = RELAY_PUBLIC_KEY;
  assert.equal((await (await routes.redeem()).POST(relayReq("redeem", { ...body, extra: true }))).status, 400, "exact members");
  assert.equal((await redeem(pass, "session", remote.key.fp.toLowerCase())).status, 400, "uppercase hex only");
});

test("a replayed relay request is refused", async () => {
  const { host, remote } = await ready();
  const grant = await (await redeem((await (await sessionPass(remote, host.deviceId)).json()).pass, "session", remote.key.fp)).json();
  const nonce = randomBytes(16).toString("base64url");
  assert.equal((await renew(grant.leaseId, { nonce })).status, 200);
  assert.equal((await renew(grant.leaseId, { nonce })).status, 401, "same nonce");
  assert.equal((await renew(grant.leaseId)).status, 200, "a fresh nonce works");
});

test("release frees a lease at once and is idempotent", async () => {
  const { host, remote } = await ready();
  const grant = await (await redeem((await (await sessionPass(remote, host.deviceId)).json()).pass, "session", remote.key.fp)).json();
  assert.equal((await release(grant.leaseId)).status, 204);
  assert.equal(tables.lease.length, 0);
  assert.equal((await release(grant.leaseId)).status, 204);
  assert.equal((await renew(grant.leaseId)).status, 404);
  assert.equal((await (await routes.release()).POST(relayReq("release", { leaseId: grant.leaseId }, {}, bearer(remote.credential)))).status, 401, "devices cannot release");
});

test("cost guard: at most 3 remotes per account relayed at once, each with at most 4 connections to one PC", async () => {
  const { host } = await ready();
  const remotes = [];
  for (let i = 0; i < 4; i++) {
    const r = await register("remote");
    assert.equal((await attest(host, r.deviceId, `enr-cap-${i}`)).status, 204);
    remotes.push(r);
  }
  const connect = async (r: typeof remotes[number], i: number) => {
    const { pass } = await (await sessionPass(r, host.deviceId, `enr-cap-${i}`)).json();
    return { pass, res: await redeem(pass, "session", r.key.fp) };
  };
  const leases: string[] = [];
  for (let i = 0; i < 3; i++) { const { res } = await connect(remotes[i], i); assert.equal(res.status, 200); leases.push((await res.json()).leaseId); }
  const fourth = await connect(remotes[3], 3);
  assert.equal(fourth.res.status, 409, "a fourth phone is over the cap");
  assert.equal((await redeem(fourth.pass, "session", remotes[3].key.fp)).status, 403, "the refused pass was still consumed");
  for (let k = 0; k < 3; k++) assert.equal((await connect(remotes[0], 0)).res.status, 200, "one remote may hold up to 4 connections to one PC");
  assert.equal((await connect(remotes[0], 0)).res.status, 409, "a fifth connection from one remote to the same PC is over the cap");
  assert.equal((await release(leases[1])).status, 204);
  assert.equal((await connect(remotes[3], 3)).res.status, 200, "a released slot is free at once");
});

test("revoking a device from the dashboard ends its credentials, pairings and live leases", async () => {
  const { host, remote } = await ready();
  const grant = await (await redeem((await (await sessionPass(remote, host.deviceId)).json()).pass, "session", remote.key.fp)).json();
  const revoke = (await routes.device()).DELETE;
  assert.equal((await revoke(req("DELETE", undefined, cookie("b")), params({ id: remote.deviceId }))).status, 404, "another account's device");
  assert.equal((await revoke(req("DELETE", undefined, cookie("a", false)), params({ id: remote.deviceId }))).status, 403, "csrf");
  assert.equal((await revoke(req("DELETE", undefined, cookie("a")), params({ id: remote.deviceId }))).status, 204);
  assert.equal(tables.lease.length, 0, "its live leases are deleted in the revoking transaction");
  assert.equal((await renew(grant.leaseId)).status, 404, "so the relay's next renewal fails");
  assert.equal((await (await routes.self()).GET(req("GET", undefined, bearer(remote.credential)))).status, 401);
  assert.ok(tables.pairing[0].withdrawnAt);
  const list = await (await (await routes.devices()).GET(req("GET", undefined, cookie("a")))).json();
  assert.equal(list.rollout, true); assert.equal(list.entitled, true);
  assert.deepEqual(list.devices.map((d: any) => [d.role, !!d.revokedAt]), [["host", false], ["remote", true]]);
});

test("connector rotation needs proofs from both keys; the relay sees the new key at the next renewal", async () => {
  const { host, remote } = await ready();
  const grant = await (await redeem((await (await sessionPass(remote, host.deviceId)).json()).pass, "session", remote.key.fp)).json();
  const next = newKey();
  const msg = `appbridge-connector-rotate-v1:${remote.deviceId}:${next.fp}`;
  const put = (await routes.connector()).PUT;
  assert.equal((await put(req("PUT", { connectorSpki: next.spki, proofOld: next.sign(msg), proofNew: next.sign(msg) }, bearer(remote.credential)))).status, 400, "the old key must sign");
  assert.equal((await put(req("PUT", { connectorSpki: next.spki, proofOld: remote.key.sign(msg), proofNew: remote.key.sign(msg) }, bearer(remote.credential)))).status, 400, "the new key must sign");
  const ok = await put(req("PUT", { connectorSpki: next.spki, proofOld: remote.key.sign(msg), proofNew: next.sign(msg) }, bearer(remote.credential)));
  assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { connectorSpkiSha256: next.fp });
  assert.equal((await (await renew(grant.leaseId)).json()).clientConnectorSpkiSha256, next.fp);
});

test("credential rotation replaces the calling credential once the new one is used", async () => {
  const host = await register("host");
  const r = await (await routes.credential()).POST(req("POST", undefined, bearer(host.credential)));
  assert.equal(r.status, 200);
  const { credential } = await r.json();
  const self = await (await (await routes.self()).GET(req("GET", undefined, bearer(credential)))).json();
  assert.equal(self.deviceId, host.deviceId); assert.equal(self.remoteAccess, "not_entitled");
  assert.equal((await (await routes.self()).GET(req("GET", undefined, bearer(host.credential)))).status, 401);
});

test("leases expire; the connection log shows only the last 7 days", async () => {
  const { host, remote } = await ready();
  const grant = await (await redeem((await (await sessionPass(remote, host.deviceId)).json()).pass, "session", remote.key.fp)).json();
  tables.lease[0].expiresAt = new Date(Date.now() - 1);
  assert.equal((await renew(grant.leaseId)).status, 410);
  assert.equal((await renew("no-such-lease")).status, 404);
  tables.connection.push({ id: "old", accountId: "acct-a", hostDeviceId: host.deviceId, remoteDeviceId: remote.deviceId, at: new Date(Date.now() - 8 * 86_400_000) });
  const log = await (await (await routes.connections()).GET(req("GET", undefined, cookie("a")))).json();
  assert.equal(log.connections.length, 1);
  const other = await (await (await routes.connections()).GET(req("GET", undefined, cookie("b")))).json();
  assert.equal(other.connections.length, 0, "another account sees none");
});

test("privacy: nothing stored carries the caller's IP or user agent", async () => {
  const { host, remote } = await ready();
  const headers = { ...bearer(remote.credential), "x-forwarded-for": "198.51.100.23", "user-agent": "phone-ua-marker" };
  const { pass } = await (await (await routes.passes()).POST(req("POST", { hostDeviceId: host.deviceId, enrollmentId: "enr-1" }, headers))).json();
  await redeem(pass, "session", remote.key.fp);
  const everything = JSON.stringify(tables);
  for (const marker of ["198.51.100.23", "203.0.113.77", "phone-ua-marker", "relay-ua-marker", pass]) assert.ok(!everything.includes(marker), marker);
});

test("bodies are bounded and must be JSON objects", async () => {
  const host = await register("host");
  const put = (await routes.relaySwitch()).PUT;
  assert.equal((await put(req("PUT", JSON.stringify({ enabled: true, pad: "x".repeat(5000) }), bearer(host.credential)))).status, 413);
  assert.equal((await put(req("PUT", "[true]", bearer(host.credential)))).status, 400);
  assert.equal((await put(req("PUT", "{not json", bearer(host.credential)))).status, 400);
  assert.equal((await put(req("PUT", { enabled: "yes" }, bearer(host.credential)))).status, 400);
});

// ── Hardening (security review, 2026-09-24) ──
const junkHex = () => randomBytes(32).toString("hex").toUpperCase();
const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const noContent = (r: Response) => { assert.equal(r.status, 204); assert.equal(r.headers.get("cache-control"), "no-store"); };

test("H1: a flood of fake client connects never starves renew or release, and registered devices still redeem", async () => {
  const { host, remote } = await ready();
  const grant = await (await redeem((await (await sessionPass(remote, host.deviceId)).json()).pass, "session", remote.key.fp)).json();
  // The flood: junk passes under throwaway keys, each redeem signed by the relay as a fake connect would be.
  for (let i = 0; i < 600; i++) assert.equal((await redeem(junkHex(), "session", junkHex())).status, 403);
  assert.equal(hits.get("appbridge:redeem-failed:all"), 600);
  const shed = await redeem(junkHex(), "session", junkHex());
  assert.equal(shed.status, 429, "the global failure budget is spent: unknown keys are shed before the transaction");
  assert.equal(shed.headers.get("retry-after"), "7");
  // Renewals and releases have their own per-lease budget, which the flood never touched.
  assert.equal((await renew(grant.leaseId)).status, 200);
  assert.equal(hits.get("appbridge:redeem-failed:all"), 600, "a shed request spends nothing more");
  // A key registered to a live device gets through the shed and redeems.
  const again = await redeem((await (await sessionPass(remote, host.deviceId)).json()).pass, "session", remote.key.fp);
  assert.equal(again.status, 200);
  assert.equal(hits.get("appbridge:redeem-failed:all"), 600, "a successful redemption spends no failure budget");
  noContent(await release(grant.leaseId));
  // Even with every redeem bucket shut for this key, the other lease still renews.
  hits.set(`appbridge:redeem:${remote.key.fp}`, 60); hits.set(`appbridge:redeem-failed:${remote.key.fp}`, 10);
  assert.equal((await renew((await again.json()).leaseId)).status, 200);
  assert.ok(![...hits.keys()].some(k => k.startsWith("appbridge:relay:")), "no shared relay bucket remains");
});

test("H1: redeem budgets per presented key; renew and release are bounded per lease only", async () => {
  const { host, remote } = await ready();
  // Refusals under one key spend that key's failure budget (only its holder can present it: the relay checks a proof).
  for (let i = 0; i < 10; i++) assert.equal((await redeem(junkHex(), "session", remote.key.fp)).status, 403);
  const { pass } = await (await sessionPass(remote, host.deviceId)).json();
  assert.equal((await redeem(pass, "session", remote.key.fp)).status, 429, "that key is paused");
  assert.equal(tables.pass.find(p => p.passHash === sha(pass))!.consumedAt, null, "checked before any database work");
  const presence = await (await routes.presence()).POST(req("POST", {}, bearer(host.credential)));
  const hostGrant = await redeem((await presence.json()).pass, "presence", host.key.fp);
  assert.equal(hostGrant.status, 200, "another key is unaffected");
  // Every attempt, refused or not, counts against the key's own ceiling.
  hits.delete(`appbridge:redeem-failed:${remote.key.fp}`); hits.set(`appbridge:redeem:${remote.key.fp}`, 60);
  assert.equal((await redeem(pass, "session", remote.key.fp)).status, 429);
  // A malformed body spends the global failure budget.
  const before = hits.get("appbridge:redeem-failed:all") ?? 0;
  assert.equal((await (await routes.redeem()).POST(relayReq("redeem", { pass, purpose: "session" }))).status, 400);
  assert.equal(hits.get("appbridge:redeem-failed:all"), before + 1);
  // The lease ceiling is per lease.
  const leaseId = (await hostGrant.json()).leaseId;
  hits.set(`appbridge:lease:${leaseId}`, 30);
  assert.equal((await renew(leaseId)).status, 429);
  assert.equal((await renew("another-lease")).status, 404, "other leases are unaffected");
});

test("presence cap: at most 4 live presence leases per account, refused with 409 like the other caps", async () => {
  const { host, remote } = await ready();
  const presencePass = async (h: { credential: string }) => (await (await (await routes.presence()).POST(req("POST", {}, bearer(h.credential)))).json()).pass as string;
  const leases: string[] = [];
  for (let i = 0; i < 4; i++) { const r = await redeem(await presencePass(host), "presence", host.key.fp); assert.equal(r.status, 200); leases.push((await r.json()).leaseId); }
  const fifth = await presencePass(host);
  const over = await redeem(fifth, "presence", host.key.fp);
  assert.equal(over.status, 409); assert.deepEqual(await over.json(), { error: "refused" });
  assert.equal((await redeem(fifth, "presence", host.key.fp)).status, 403, "the refused pass was still consumed");
  const host2 = await register("host"); await setRelay(host2, true);
  assert.equal((await redeem(await presencePass(host2), "presence", host2.key.fp)).status, 409, "the cap is per account, not per PC");
  assert.equal((await redeem((await (await sessionPass(remote, host.deviceId)).json()).pass, "session", remote.key.fp)).status, 200, "sessions have their own caps");
  noContent(await release(leases[0]));
  assert.equal((await redeem(await presencePass(host2), "presence", host2.key.fp)).status, 200, "a released slot is free at once");
  tables.lease.find(l => l.id === leases[1])!.expiresAt = new Date(Date.now() - 1);
  assert.equal((await redeem(await presencePass(host), "presence", host.key.fp)).status, 200, "an expired lease does not count");
  const other = await register("host", "b"); await entitle("other"); await setRelay(other, true);
  assert.equal((await redeem(await presencePass(other), "presence", other.key.fp)).status, 200, "another account has its own cap");
});

test("M1: only failed exchanges spend the registration budget; successes are never blocked short of it", async () => {
  const exchange = (await routes.exchange()).POST;
  for (let i = 0; i < 40; i++) assert.equal((await exchange(req("POST", { junk: i }))).status, 400);
  const key = newKey(); const wrong = await mint("host");
  assert.equal((await exchange(req("POST", { code: "ABD-2222-2222", role: "host", connectorSpki: key.spki, proof: key.sign("appbridge-device-exchange-v1:ABD-2222-2222") }))).status, 410);
  assert.equal((await exchange(req("POST", { code: wrong, role: "remote", connectorSpki: key.spki, proof: key.sign(`appbridge-device-exchange-v1:${wrong}`) }))).status, 409);
  assert.equal(hits.get("appbridge:exchange-failed:all"), 42, "every refusal counts");
  await register("remote"); // 42 failures would have closed the old 30/min global bucket
  assert.equal(hits.get("appbridge:exchange-failed:all"), 42, "a success spends nothing");
  assert.ok(![...hits.keys()].some(k => k.startsWith("appbridge:exchange:")), "no all-requests bucket remains");
  hits.set("appbridge:exchange-failed:all", 1000);
  const code = await mint("remote"); const k2 = newKey();
  const shut = await exchange(req("POST", { code, role: "remote", connectorSpki: k2.spki, proof: k2.sign(`appbridge-device-exchange-v1:${code}`) }));
  assert.equal(shut.status, 429); assert.equal(shut.headers.get("retry-after"), "7");
  assert.equal(tables.code.find(c => c.codeHash === sha(code))!.usedAt, null, "a shed exchange never burns the code");
  assert.equal(hits.get("appbridge:exchange-failed:all"), 1000, "and does not spend more");
});

test("revoking a PC ends its presence lease and every session lease to it in the same transaction", async () => {
  const { host, remote } = await ready();
  const p = await (await routes.presence()).POST(req("POST", {}, bearer(host.credential)));
  const presence = await (await redeem((await p.json()).pass, "presence", host.key.fp)).json();
  const session = await (await redeem((await (await sessionPass(remote, host.deviceId)).json()).pass, "session", remote.key.fp)).json();
  const other = await register("host"); await setRelay(other, true);
  assert.equal((await attest(other, remote.deviceId, "enr-2")).status, 204);
  const unrelated = await (await redeem((await (await sessionPass(remote, other.deviceId, "enr-2")).json()).pass, "session", remote.key.fp)).json();
  noContent(await (await routes.device()).DELETE(req("DELETE", undefined, cookie("a")), params({ id: host.deviceId })));
  assert.deepEqual(tables.lease.map(l => l.id), [unrelated.leaseId], "only the revoked PC's leases are gone");
  assert.equal((await renew(presence.leaseId)).status, 404);
  assert.equal((await renew(session.leaseId)).status, 404);
  assert.equal((await renew(unrelated.leaseId)).status, 200);
});

test("pairing attest and withdraw require a host device, whatever scopes a credential carries", async () => {
  const { host, remote } = await ready();
  // A remote's credential row that somehow carries the host scope (a bad row, a future bug): the role still decides.
  tables.credential.find(c => c.deviceId === remote.deviceId)!.scopes.push("appbridge.host.relay");
  const put = await attest(remote, remote.deviceId, "enr-by-remote");
  assert.equal(put.status, 403); assert.deepEqual(await put.json(), { error: "scope" });
  const del = await (await routes.pairing()).DELETE(req("DELETE", undefined, bearer(remote.credential)), params({ enrollmentId: "enr-1" }));
  assert.equal(del.status, 403); assert.equal(del.headers.get("cache-control"), "no-store");
  assert.deepEqual(tables.pairing.map(x => [x.enrollmentId, x.withdrawnAt]), [["enr-1", null]], "nothing created or withdrawn");
  assert.equal((await attest(host, remote.deviceId, "enr-by-host")).status, 204, "the host still can");
});

test("DELETE /devices/self: a device unregisters itself — device, credentials, pairings and leases — idempotently", async () => {
  const { host, remote } = await ready();
  const p = await (await routes.presence()).POST(req("POST", {}, bearer(host.credential)));
  const presence = await (await redeem((await p.json()).pass, "presence", host.key.fp)).json();
  const session = await (await redeem((await (await sessionPass(remote, host.deviceId)).json()).pass, "session", remote.key.fp)).json();
  const del = (await routes.self()).DELETE;
  for (const headers of [{}, bearer("bc_" + "x".repeat(32)), cookie("a"), bearer("ab_" + "A".repeat(43)), { authorization: `Basic ${host.credential}` }]) {
    const r = await del(req("DELETE", undefined, headers));
    assert.equal(r.status, 401); assert.equal(r.headers.get("cache-control"), "no-store"); assert.deepEqual(await r.json(), { error: "unauthorized" });
  }
  const r = await del(req("DELETE", undefined, bearer(host.credential)));
  noContent(r); assert.equal(await r.text(), "");
  const device = tables.device.find(d => d.id === host.deviceId)!;
  assert.ok(device.revokedAt); assert.equal(device.enabled, false); assert.equal(device.relayEnabled, false);
  assert.ok(tables.credential.filter(c => c.deviceId === host.deviceId).every(c => c.revokedAt));
  assert.ok(tables.pairing[0].withdrawnAt);
  assert.equal(tables.lease.length, 0);
  assert.equal((await renew(presence.leaseId)).status, 404); assert.equal((await renew(session.leaseId)).status, 404);
  noContent(await del(req("DELETE", undefined, bearer(host.credential)))); // a retry after a lost reply
  assert.equal((await (await routes.self()).GET(req("GET", undefined, bearer(host.credential)))).status, 401, "the credential is dead for everything else");
  assert.equal(tables.device.find(d => d.id === remote.deviceId)!.revokedAt, null, "the other device is untouched");
  const audit = tables.accountAudit.filter(a => a.eventType === "appbridge.device_unregistered");
  assert.deepEqual(audit.map(a => a.detail), [{ deviceId: host.deviceId, role: "host" }]);
  assert.ok(!JSON.stringify(tables.accountAudit).includes(host.credential));
  noContent(await del(req("DELETE", undefined, bearer(remote.credential))));
  assert.ok(tables.device.find(d => d.id === remote.deviceId)!.revokedAt, "a phone may unregister too");
});

test("DELETE /devices/self: a rotated-away credential can never unregister a live device", async () => {
  const host = await register("host");
  const next = (await (await (await routes.credential()).POST(req("POST", undefined, bearer(host.credential)))).json()).credential as string;
  assert.equal((await (await routes.self()).GET(req("GET", undefined, bearer(next)))).status, 200); // first use ends the old one
  const old = tables.credential.find(k => k.keyHash === sha(host.credential))!;
  assert.ok(old.revokedAt); old.revokedAt = new Date(old.revokedAt.getTime() - 1000); // (keep the two revocations apart in time)
  const del = (await routes.self()).DELETE;
  assert.equal((await del(req("DELETE", undefined, bearer(host.credential)))).status, 401);
  assert.equal(tables.device[0].revokedAt, null);
  noContent(await del(req("DELETE", undefined, bearer(next))));
  assert.equal((await del(req("DELETE", undefined, bearer(host.credential)))).status, 401, "revoked before the device was: still 401");
  noContent(await del(req("DELETE", undefined, bearer(next))));
});

test("credential rotation is crash-safe: the old credential lives until the new one is used, 24 h at most", async () => {
  const host = await register("host");
  const rotate = async (c: string) => { const r = await (await routes.credential()).POST(req("POST", undefined, bearer(c))); assert.equal(r.status, 200); return (await r.json()).credential as string; };
  const self = async (c: string) => (await (await routes.self()).GET(req("GET", undefined, bearer(c)))).status;
  const row = (c: string) => tables.credential.find(k => k.keyHash === sha(c))!;
  const b = await rotate(host.credential);
  assert.ok(row(host.credential).expiresAt.getTime() <= Date.now() + 86_400_000, "the old credential's grace is at most 24 h");
  assert.equal(row(b).replacesKeyHash, sha(host.credential));
  assert.equal(await self(host.credential), 200, "the PC crashed before saving the new one: the old one still works");
  const graceEnd = row(host.credential).expiresAt.getTime();
  const c = await rotate(host.credential); // a second try with the old credential
  assert.equal(row(host.credential).expiresAt.getTime(), graceEnd, "a repeat never extends the grace");
  assert.equal(await self(b), 401, "the successor whose reply was lost ends");
  assert.equal(await self(host.credential), 200);
  assert.equal(await self(c), 200);
  assert.equal(row(c).replacesKeyHash, null, "first use recorded once");
  assert.equal(await self(host.credential), 401, "the old one ends at the new one's first use");
  const d = await rotate(c);
  row(c).expiresAt = new Date(Date.now() - 1); // 24 h later, the new one never used
  assert.equal(await self(c), 401, "the grace is bounded");
  assert.equal(await self(d), 200);
  const stored = JSON.stringify(tables);
  for (const raw of [host.credential, b, c, d]) assert.ok(!stored.includes(raw), "only hashes are stored");
  noContent(await (await routes.device()).DELETE(req("DELETE", undefined, cookie("a")), params({ id: host.deviceId })));
  assert.ok(tables.credential.every(k => k.revokedAt), "revoking the device ends every credential, grace or not");
});

// ── Serializable retry (the dispatch fix of #47, applied to every AppBridge transaction) ──
// Every shape Prisma 5 uses for a Postgres serialization abort (40001) or deadlock victim (40P01),
// plus a unique race (P2002). Same fixtures as dispatch.routetest.mts.
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
const audits = (eventType: string) => tables.accountAudit.filter(a => a.eventType === eventType).length;
const failureBudgets = () => [...hits].filter(([k]) => k.includes("-failed:"));

// One entry per serializable transaction in src/lib/appbridge.ts: arrange (outside any fault), the one
// request under test, its status once committed, and what exactly-once commit looks like.
type Ctx = Record<string, any>;
type Case = { name: string; arrange: () => Promise<Ctx>; act: (c: Ctx) => Promise<Response>; status: number; committed: (c: Ctx, r: Response) => Promise<void> };
const cases: Case[] = [
  { name: "device exchange", status: 200,
    arrange: async () => { const key = newKey(); return { key, code: await mint("host") }; },
    act: async ({ key, code }) => (await routes.exchange()).POST(req("POST", { code, role: "host", connectorSpki: key.spki, proof: key.sign(`appbridge-device-exchange-v1:${code}`) })),
    committed: async (_, r) => {
      const { credential } = await r.json();
      assert.ok(tables.code[0].usedAt, "the code is consumed"); assert.equal(tables.device.length, 1); assert.equal(tables.credential.length, 1);
      assert.equal(tables.credential[0].keyHash, sha(credential), "the stored credential is the one returned");
      assert.equal(audits("appbridge.device_registered"), 1);
    } },
  { name: "session pass issue", status: 200, arrange: ready,
    act: ({ host, remote }) => sessionPass(remote, host.deviceId),
    committed: async (_, r) => { assert.deepEqual(tables.pass.map(p => [p.passHash, p.purpose]), [[sha((await r.json()).pass), "session"]]); } },
  { name: "presence pass issue", status: 200, arrange: ready,
    act: async ({ host }) => (await routes.presence()).POST(req("POST", {}, bearer(host.credential))),
    committed: async (_, r) => { assert.deepEqual(tables.pass.map(p => [p.passHash, p.purpose]), [[sha((await r.json()).pass), "presence"]]); } },
  { name: "session redeem", status: 200,
    arrange: async () => { const c = await ready(); return { ...c, pass: (await (await sessionPass(c.remote, c.host.deviceId)).json()).pass }; },
    act: ({ remote, pass }) => redeem(pass, "session", remote.key.fp),
    committed: async ({ pass }, r) => {
      assert.ok(tables.pass.find(p => p.passHash === sha(pass))!.consumedAt, "consumed");
      assert.deepEqual(tables.lease.map(l => l.id), [(await r.json()).leaseId], "exactly one lease");
      assert.equal(tables.connection.length, 1, "exactly one connection logged");
    } },
  { name: "presence redeem", status: 200,
    arrange: async () => { const c = await ready(); return { ...c, pass: (await (await (await routes.presence()).POST(req("POST", {}, bearer(c.host.credential)))).json()).pass }; },
    act: ({ host, pass }) => redeem(pass, "presence", host.key.fp),
    committed: async ({ pass }, r) => {
      assert.ok(tables.pass.find(p => p.passHash === sha(pass))!.consumedAt);
      assert.deepEqual(tables.lease.map(l => l.id), [(await r.json()).leaseId]); assert.equal(tables.connection.length, 0);
    } },
  { name: "lease renewal", status: 200,
    arrange: async () => {
      const c = await ready();
      const { leaseId } = await (await redeem((await (await sessionPass(c.remote, c.host.deviceId)).json()).pass, "session", c.remote.key.fp)).json();
      tables.lease[0].expiresAt = new Date(Date.now() + 5_000); return { ...c, leaseId };
    },
    act: ({ leaseId }) => renew(leaseId),
    committed: async () => { assert.equal(tables.lease.length, 1); assert.ok(tables.lease[0].expiresAt.getTime() > Date.now() + 100_000, "extended"); } },
  { name: "credential rotation", status: 200, arrange: () => register("host"),
    act: async ({ credential }) => (await routes.credential()).POST(req("POST", undefined, bearer(credential))),
    committed: async ({ credential }, r) => {
      const next = (await r.json()).credential;
      assert.deepEqual(tables.credential.filter(k => k.replacesKeyHash).map(k => [k.keyHash, k.replacesKeyHash]), [[sha(next), sha(credential)]], "exactly one successor");
      assert.equal(tables.credential.length, 2);
    } },
  { name: "rotated credential's first use", status: 200,
    arrange: async () => { const host = await register("host"); return { host, next: (await (await (await routes.credential()).POST(req("POST", undefined, bearer(host.credential)))).json()).credential }; },
    act: async ({ next }) => (await routes.self()).GET(req("GET", undefined, bearer(next))),
    committed: async ({ host, next }) => {
      assert.ok(tables.credential.find(k => k.keyHash === sha(host.credential))!.revokedAt, "the predecessor ends");
      assert.equal(tables.credential.find(k => k.keyHash === sha(next))!.replacesKeyHash, null);
    } },
  { name: "connector rotation", status: 200,
    arrange: async () => ({ ...(await ready()), next: newKey() }),
    act: async ({ remote, next }) => { const msg = `appbridge-connector-rotate-v1:${remote.deviceId}:${next.fp}`;
      return (await routes.connector()).PUT(req("PUT", { connectorSpki: next.spki, proofOld: remote.key.sign(msg), proofNew: next.sign(msg) }, bearer(remote.credential))); },
    committed: async ({ remote, next }) => { assert.equal(tables.device.find(d => d.id === remote.deviceId)!.connectorSpkiSha256, next.fp); } },
  { name: "pairing attestation", status: 204,
    arrange: async () => ({ host: await register("host"), remote: await register("remote") }),
    act: ({ host, remote }) => attest(host, remote.deviceId),
    committed: async ({ remote }) => { assert.deepEqual(tables.pairing.map(p => [p.enrollmentId, p.remoteDeviceId]), [["enr-1", remote.deviceId]]); } },
  { name: "self-unregister", status: 204,
    arrange: async () => { const c = await ready(); await redeem((await (await (await routes.presence()).POST(req("POST", {}, bearer(c.host.credential)))).json()).pass, "presence", c.host.key.fp); return c; },
    act: async ({ host }) => (await routes.self()).DELETE(req("DELETE", undefined, bearer(host.credential))),
    committed: async ({ host }) => {
      assert.ok(tables.device.find(d => d.id === host.deviceId)!.revokedAt); assert.equal(tables.lease.length, 0);
      assert.equal(audits("appbridge.device_unregistered"), 1);
    } },
  { name: "dashboard revoke", status: 204, arrange: ready,
    act: async ({ remote }) => (await routes.device()).DELETE(req("DELETE", undefined, cookie("a")), params({ id: remote.deviceId })),
    committed: async ({ remote }) => { assert.ok(tables.device.find(d => d.id === remote.deviceId)!.revokedAt); assert.equal(audits("appbridge.device_revoked"), 1); } },
];

test("every AppBridge transaction re-runs whole on a conflict, in every abort shape, and commits exactly once", async () => {
  for (const c of cases) for (const [shape, abort] of aborts) {
    const name = `${c.name} / ${shape}`;
    reset(); const ctx = await c.arrange();
    const before = new Map(hits);
    transactionFaults = [abort(), abort()]; transactionCalls = 0;
    const r = await c.act(ctx);
    assert.equal(r.status, c.status, name); assert.equal(transactionCalls, 3, `${name}: two rolled-back attempts, then the commit`);
    assert.equal(r.headers.get("cache-control"), "no-store", name);
    await c.committed(ctx, r);
    // Rate limits are counted per request, outside the retried transaction: never once per attempt.
    for (const [k, n] of hits) assert.ok(n - (before.get(k) ?? 0) <= 1, `${name}: ${k} counted once`);
    assert.deepEqual(failureBudgets(), [...before].filter(([k]) => k.includes("-failed:")), `${name}: a success spends no failure budget`);
  }
});

test("retry budget exhausted: the fixed retryable 503 after exactly five attempts, with nothing written", async () => {
  for (const c of cases) for (const [shape, abort] of aborts) {
    const name = `${c.name} / ${shape}`;
    reset(); const ctx = await c.arrange();
    const tablesBefore = structuredClone(tables); const before = new Map(hits);
    transactionFaults = Array.from({ length: 5 }, abort); transactionCalls = 0;
    const started = Date.now();
    const r = await c.act(ctx);
    assert.equal(r.status, 503, name); assert.equal(transactionCalls, 5, `${name}: bounded`);
    assert.deepEqual(await r.json(), { error: "retry" }, name);
    assert.equal(r.headers.get("retry-after"), "1", name); assert.equal(r.headers.get("cache-control"), "no-store", name);
    assert.ok(Date.now() - started < 1000, `${name}: bounded latency`);
    assert.deepEqual(tables, tablesBefore, `${name}: every attempt rolled back, no audit row, no consumed pass or code`);
    for (const [k, n] of hits) assert.ok(n - (before.get(k) ?? 0) <= 1, `${name}: ${k} counted once`);
    assert.deepEqual(failureBudgets(), [...before].filter(([k]) => k.includes("-failed:")), `${name}: an outage is not a refusal`);
  }
});

test("one-use pass: consumed by exactly the attempt that commits, never twice, never by a rolled-back attempt", async () => {
  const { host, remote } = await ready();
  const issue = async () => (await (await sessionPass(remote, host.deviceId)).json()).pass as string;
  const pass = await issue();
  // Aborted at commit twice: each attempt's consumption rolled back with it; the third commits it.
  transactionFaults = [aborts[0][1](), aborts[2][1]()]; transactionCalls = 0;
  const ok = await redeem(pass, "session", remote.key.fp);
  assert.equal(ok.status, 200); assert.equal(transactionCalls, 3);
  assert.equal(tables.lease.length, 1); assert.equal(tables.connection.length, 1);
  assert.equal((await redeem(pass, "session", remote.key.fp)).status, 403, "and it is spent");
  assert.equal(tables.lease.length, 1); assert.equal(tables.connection.length, 1);
  // A concurrent redeem of the same pass wins the conflict: the loser's re-run finds it consumed and is
  // refused, once: no second lease, and the failure budgets are spent once, after the commit.
  hits.clear();
  const raced = await issue(); const leasesBefore = tables.lease.length;
  transactionFaults = [{ abort: aborts[0][1](), winner: () => {
    tables.pass.find(p => p.passHash === sha(raced))!.consumedAt = new Date();
    tables.lease.push({ id: "winner", purpose: "session", accountId: "acct-a", hostDeviceId: host.deviceId, remoteDeviceId: remote.deviceId, enrollmentId: "enr-1", createdAt: new Date(), expiresAt: new Date(Date.now() + 120_000) });
  } }]; transactionCalls = 0;
  const lost = await redeem(raced, "session", remote.key.fp);
  assert.equal(lost.status, 403); assert.deepEqual(await lost.json(), { error: "refused" }); assert.equal(transactionCalls, 2);
  assert.equal(tables.lease.length, leasesBefore + 1, "only the winner's lease");
  assert.equal(hits.get("appbridge:redeem-failed:all"), 1); assert.equal(hits.get(`appbridge:redeem-failed:${remote.key.fp}`), 1);
  assert.equal(hits.get(`appbridge:redeem:${remote.key.fp}`), 1);
  // Retries exhausted: nothing committed, so the pass is still unconsumed and the relay's retry redeems it once.
  const outage = await issue();
  transactionFaults = Array.from({ length: 5 }, aborts[0][1]);
  assert.equal((await redeem(outage, "session", remote.key.fp)).status, 503);
  assert.equal(tables.pass.find(p => p.passHash === sha(outage))!.consumedAt, null);
  assert.equal((await redeem(outage, "session", remote.key.fp)).status, 200);
  assert.equal((await redeem(outage, "session", remote.key.fp)).status, 403);
});

test("caps are counted again by every attempt: a slot the conflict's winner took is refused 409 on the re-run", async () => {
  const { host } = await ready();
  const presencePass = async () => (await (await (await routes.presence()).POST(req("POST", {}, bearer(host.credential)))).json()).pass as string;
  for (let i = 0; i < 3; i++) assert.equal((await redeem(await presencePass(), "presence", host.key.fp)).status, 200);
  const pass = await presencePass();
  // The first attempt saw 3 of 4 slots used and admitted; it aborts because a PC reconnecting took the 4th.
  transactionFaults = [{ abort: aborts[0][1](), winner: () => {
    tables.lease.push({ id: "winner", purpose: "presence", accountId: "acct-a", hostDeviceId: host.deviceId, remoteDeviceId: null, enrollmentId: null, createdAt: new Date(), expiresAt: new Date(Date.now() + 120_000) });
  } }]; transactionCalls = 0;
  const r = await redeem(pass, "presence", host.key.fp);
  assert.equal(r.status, 409); assert.deepEqual(await r.json(), { error: "refused" }); assert.equal(transactionCalls, 2);
  assert.equal(tables.lease.length, 4, "the cap holds: the rolled-back admission left nothing behind");
  assert.ok(tables.pass.find(p => p.passHash === sha(pass))!.consumedAt, "the refusal consumed the pass");
});

test("non-conflict failures are never retried", async () => {
  const { host, remote } = await ready();
  const pass = (await (await sessionPass(remote, host.deviceId)).json()).pass;
  for (const e of [new Error("connection refused"), new PrismaClientKnownRequestError("Record not found", { code: "P2025", clientVersion }), { message: "listening on port 40001" }]) {
    transactionFaults = [e]; transactionCalls = 0;
    const r = await redeem(pass, "session", remote.key.fp);
    assert.equal(r.status, 503); assert.deepEqual(await r.json(), { error: "unavailable" }); assert.equal(r.headers.get("retry-after"), null);
    assert.equal(transactionCalls, 1); assert.equal(tables.pass.find(p => p.passHash === sha(pass))!.consumedAt, null);
  }
  // A refusal thrown inside the transaction is an answer, not a conflict.
  const other = await register("host"); const next = newKey();
  tables.device.find(d => d.id === other.deviceId)!.connectorSpkiSha256 = next.fp;
  const msg = `appbridge-connector-rotate-v1:${remote.deviceId}:${next.fp}`;
  transactionCalls = 0;
  const inUse = await (await routes.connector()).PUT(req("PUT", { connectorSpki: next.spki, proofOld: remote.key.sign(msg), proofNew: next.sign(msg) }, bearer(remote.credential)));
  assert.equal(inUse.status, 409); assert.equal(transactionCalls, 1);
  // Refusals returned from a transaction that conflicted first spend each failure budget once.
  hits.clear(); transactionFaults = [aborts[1][1](), aborts[4][1]()]; transactionCalls = 0;
  const junk = randomBytes(32).toString("hex").toUpperCase();
  assert.equal((await redeem(junk, "session", remote.key.fp)).status, 403); assert.equal(transactionCalls, 3);
  assert.equal(hits.get("appbridge:redeem-failed:all"), 1); assert.equal(hits.get(`appbridge:redeem-failed:${remote.key.fp}`), 1);
  const code = await mint("host"); const key = newKey();
  hits.clear(); transactionFaults = [aborts[3][1]()]; transactionCalls = 0;
  assert.equal((await (await routes.exchange()).POST(req("POST", { code, role: "remote", connectorSpki: key.spki, proof: key.sign(`appbridge-device-exchange-v1:${code}`) }))).status, 409);
  assert.equal(transactionCalls, 2); assert.equal(hits.get("appbridge:exchange-failed:all"), 1);
  assert.equal(tables.code.find(c => c.codeHash === sha(code))!.usedAt, null, "a wrong role still never burns the code");
});
// ── Per-PC connection caps (2026-09-24): 4 per (remote, PC), 8 per remote across PCs ──
/** One remote (a laptop) paired with three PCs, each with its relay switch on. */
async function laptopAndPcs() {
  const laptop = await register("remote"); const pcs = [];
  for (let i = 0; i < 3; i++) {
    const pc = await register("host"); await setRelay(pc, true);
    assert.equal((await attest(pc, laptop.deviceId, `enr-pc-${i}`)).status, 204);
    pcs.push(pc);
  }
  await entitle();
  const connect = async (pc: number) => {
    const { pass } = await (await sessionPass(laptop, pcs[pc].deviceId, `enr-pc-${pc}`)).json();
    return { pass, res: await redeem(pass, "session", laptop.key.fp) };
  };
  return { laptop, pcs, connect };
}
const leaseTo = (remoteDeviceId: string, hostDeviceId: string, id = randomBytes(8).toString("hex")) =>
  ({ id, purpose: "session", accountId: "acct-a", hostDeviceId, remoteDeviceId, enrollmentId: "enr-x", createdAt: new Date(), expiresAt: new Date(Date.now() + 120_000) });

test("connection caps: 4 to one PC, 8 across PCs; a released lease frees its slot at once", async () => {
  const { laptop, pcs, connect } = await laptopAndPcs();
  const leases: string[][] = [[], [], []];
  for (let k = 0; k < 4; k++) { const { res } = await connect(0); assert.equal(res.status, 200); leases[0].push((await res.json()).leaseId); }
  const fifth = await connect(0);
  assert.equal(fifth.res.status, 409, "a 5th connection to the same PC is refused");
  assert.deepEqual(await fifth.res.json(), { error: "refused" });
  assert.equal((await redeem(fifth.pass, "session", laptop.key.fp)).status, 403, "the refused pass was still consumed");
  for (let k = 0; k < 4; k++) { const { res } = await connect(1); assert.equal(res.status, 200, "4 + 4 across two PCs"); leases[1].push((await res.json()).leaseId); }
  const ninth = await connect(2);
  assert.equal(ninth.res.status, 409, "a 9th connection, to a third PC, is over the 8 per remote");
  assert.equal(tables.lease.length, 8);
  assert.equal(tables.connection.length, 8, "refusals are not logged");
  noContent(await release(leases[1][0]));
  assert.equal((await connect(2)).res.status, 200, "a released lease frees a slot at once, for any PC");
  assert.equal((await connect(2)).res.status, 409, "and only that one");
  noContent(await release(leases[0][0]));
  assert.equal((await connect(0)).res.status, 200, "a slot freed on the PC at its own limit is usable there");
  // Expired leases hold no slot; other remotes of the account are unaffected (up to 3 remotes).
  for (const l of tables.lease) if (l.remoteDeviceId === laptop.deviceId && l.hostDeviceId === pcs[1].deviceId) l.expiresAt = new Date(Date.now() - 1);
  assert.equal((await connect(1)).res.status, 200, "an expired lease does not count");
  const phone = await register("remote");
  assert.equal((await attest(pcs[0], phone.deviceId, "enr-phone")).status, 204);
  const { pass } = await (await sessionPass(phone, pcs[0].deviceId, "enr-phone")).json();
  assert.equal((await redeem(pass, "session", phone.key.fp)).status, 200, "another remote has its own limits, even on a PC this laptop has filled");
});

test("connection caps under contention: a slot taken by the conflict's winner is refused on the re-run", async () => {
  const { laptop, pcs } = await laptopAndPcs();
  // Issue the pass first, then inject the conflict into the redeem's transaction alone.
  const passFor = async (pc: number) => (await (await sessionPass(laptop, pcs[pc].deviceId, `enr-pc-${pc}`)).json()).pass as string;
  const connect = async (pc: number) => { const pass = await passFor(pc); transactionFaults = pending; transactionCalls = 0; return { res: await redeem(pass, "session", laptop.key.fp) }; };
  let pending: unknown[] = [];
  // Per PC: 3 live to PC 0; this attempt would be the 4th, but the winner of the conflict took it.
  for (let k = 0; k < 3; k++) tables.lease.push(leaseTo(laptop.deviceId, pcs[0].deviceId));
  pending = [{ abort: aborts[0][1](), winner: () => { tables.lease.push(leaseTo(laptop.deviceId, pcs[0].deviceId, "winner-0")); } }];
  const perPc = await connect(0);
  assert.equal(perPc.res.status, 409); assert.equal(transactionCalls, 2);
  assert.equal(tables.lease.filter(l => l.hostDeviceId === pcs[0].deviceId).length, 4, "never 5 to one PC");
  // Across PCs: 4 + 3 live; an attempt to PC 2 would be the 8th, but the winner took it on PC 1.
  for (let k = 0; k < 3; k++) tables.lease.push(leaseTo(laptop.deviceId, pcs[1].deviceId));
  pending = [{ abort: aborts[4][1](), winner: () => { tables.lease.push(leaseTo(laptop.deviceId, pcs[1].deviceId, "winner-1")); } }];
  const total = await connect(2);
  assert.equal(total.res.status, 409); assert.equal(transactionCalls, 2);
  assert.equal(tables.lease.length, 8, "never 9 across PCs");
  assert.equal(tables.lease.filter(l => l.hostDeviceId === pcs[2].deviceId).length, 0, "the rolled-back admission left nothing");
  // And a conflict without a winner taking the slot still admits once, on the re-run.
  tables.lease = tables.lease.filter(l => l.id !== "winner-1");
  pending = [aborts[2][1](), aborts[3][1]()];
  const admitted = await connect(2);
  assert.equal(admitted.res.status, 200); assert.equal(transactionCalls, 3); assert.equal(tables.lease.length, 8);
});
