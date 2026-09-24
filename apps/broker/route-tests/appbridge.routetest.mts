import { test, before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { NextRequest } from "next/server";

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
};
const credentialFind = db.appBridgeCredential.findUnique;
db.appBridgeCredential.findUnique = async (args: any) => {
  const c = await credentialFind(args);
  return c && args.include?.device ? { ...c, device: tables.device.find(d => d.id === c.deviceId) } : c;
};
db.$transaction = async (fn: any, options: any) => {
  assert.equal(options?.isolationLevel, "Serializable");
  const snapshot = structuredClone(tables);
  try { return await fn(db); } catch (e) { Object.assign(tables, snapshot); throw e; }
};

let limited = false;
before(() => {
  mock.module("@/lib/db", { namedExports: { prisma: db } });
  mock.module("@/lib/rate-limit", { namedExports: { rateLimit: () => ({ ok: !limited, retryAfterSec: 7 }) } });
  mock.module("@/lib/auth", { namedExports: {
    SESSION_COOKIE_NAME: "bc_session", CSRF_COOKIE_NAME: "bc_csrf", CSRF_HEADER: "x-bc-csrf",
    csrfValid: (h: string | null, c: string | null) => !!h && !!c && h === c,
    getAccountFromCookie: async (v: string | undefined) => tables.account.find(a => a.cookie === v) ?? null,
  } });
});
beforeEach(() => {
  for (const k of Object.keys(tables)) tables[k] = [];
  limited = false;
  process.env.APPBRIDGE_REMOTE_ACCESS = "on";
  process.env.APPBRIDGE_RELAY_PUBLIC_KEY = RELAY_PUBLIC_KEY;
  delete process.env.APPBRIDGE_RELAY_URL;
  process.env.ADMIN_EMAILS = "owner@example.com";
  tables.account.push(
    { id: "acct-a", handle: "skylar", email: "owner@example.com", admin: false, emailVerifiedAt: new Date(), cookie: "cs_a" },
    { id: "acct-b", handle: "other", email: "other@example.com", admin: true, emailVerifiedAt: new Date(), cookie: "cs_b" },
  );
});

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

test("cost guard: at most 3 phones per account relayed at once, each with at most 4 connections", async () => {
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
  for (let k = 0; k < 3; k++) assert.equal((await connect(remotes[0], 0)).res.status, 200, "one phone may hold up to 4 connections");
  assert.equal((await connect(remotes[0], 0)).res.status, 409, "a fifth connection from one phone is over the cap");
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
  assert.equal((await renew(grant.leaseId)).status, 403);
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

test("credential rotation replaces the calling credential", async () => {
  const host = await register("host");
  const r = await (await routes.credential()).POST(req("POST", undefined, bearer(host.credential)));
  assert.equal(r.status, 200);
  const { credential } = await r.json();
  assert.equal((await (await routes.self()).GET(req("GET", undefined, bearer(host.credential)))).status, 401);
  const self = await (await (await routes.self()).GET(req("GET", undefined, bearer(credential)))).json();
  assert.equal(self.deviceId, host.deviceId); assert.equal(self.remoteAccess, "not_entitled");
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
