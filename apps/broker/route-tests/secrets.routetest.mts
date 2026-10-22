/**
 * Route tests for Secrets Phase 1 (src/lib/secrets.ts, the approve_secret path in src/lib/passkeys.ts;
 * docs/secrets-epic.md §3.1, §3.3, §3.4): the worker's sync, the person's view, approving with a passkey whose
 * challenge is the broker's digest, denying, and the install / update / enrol / lockdown jobs.
 *
 * Real routes and src/lib modules, including the real @/lib/auth, over an in-memory Prisma; WebAuthn is faked at the
 * library boundary (fake-webauthn.mts), which checks the answer's challenge the way the library does.
 */
import { test, before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import { fakeWebAuthn } from "./fake-webauthn.mts";

type Row = Record<string, any>;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ── In-memory Prisma (the passkeys test's, with the filters this module uses) ──
const cmp = (a: any, b: any) => { const x = a instanceof Date ? a.getTime() : a; const y = b instanceof Date ? b.getTime() : b; return x < y ? -1 : x > y ? 1 : 0; };
function matches(row: Row | undefined, where: Row | undefined): boolean {
  if (!row) return false;
  return Object.entries(where ?? {}).every(([k, v]) => {
    if (v === undefined) return true;
    if (k === "OR") return (v as Row[]).some((w) => matches(row, w));
    const val = row[k];
    if (v === null) return val === null || val === undefined;
    if (v instanceof Date) return val instanceof Date && val.getTime() === v.getTime();
    if (typeof v === "object" && !Array.isArray(v)) return Object.entries(v).every(([op, x]: [string, any]) => {
      switch (op) {
        case "gt": return val != null && cmp(val, x) > 0;
        case "lt": return val != null && cmp(val, x) < 0;
        case "lte": return val != null && cmp(val, x) <= 0;
        case "in": return (x as any[]).includes(val);
        case "notIn": return !(x as any[]).includes(val);
        case "not": return x === null ? val !== null && val !== undefined : val !== x;
        default: throw new Error(`in-memory prisma: unsupported filter ${op}`);
      }
    });
    return val === v;
  });
}
const tables: Record<string, Row[]> = {};
const copy = (r: Row | null | undefined) => (r ? { ...r } : null);
function table(name: string, defaults: () => Row = () => ({}), unique: string[][] = []) {
  tables[name] = [];
  const rows = () => tables[name];
  const clash = (r: Row, except?: Row) => unique.some(ks => ks.every(k => r[k] != null) && rows().some(x => x !== except && ks.every(k => x[k] === r[k])));
  const p2002 = () => new PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "5.22.0" });
  return {
    findUnique: async ({ where }: any) => copy(rows().find(r => matches(r, where))),
    findFirst: async ({ where }: any = {}) => copy(rows().find(r => matches(r, where))),
    findMany: async ({ where, take }: any = {}) => rows().filter(r => matches(r, where)).slice(0, take ?? Infinity).map(r => ({ ...r })),
    count: async ({ where }: any = {}) => rows().filter(r => matches(r, where)).length,
    create: async ({ data }: any) => { const r = { ...defaults(), ...data }; if (clash(r)) throw p2002(); rows().push(r); return { ...r }; },
    update: async ({ where, data }: any) => { const r = rows().find(x => matches(x, where)); if (!r) throw new Error("not found"); return { ...Object.assign(r, data) }; },
    updateMany: async ({ where, data }: any) => { const hit = rows().filter(r => matches(r, where)); hit.forEach(r => Object.assign(r, data)); return { count: hit.length }; },
    deleteMany: async ({ where }: any) => { const keep = rows().filter(r => !matches(r, where)); const count = rows().length - keep.length; tables[name] = keep; return { count }; },
  };
}
const db: any = {
  account: table("account"),
  sessionCookie: table("sessionCookie"),
  accountAudit: table("accountAudit", () => ({ ts: new Date() })),
  agentToken: table("agentToken", () => ({ id: crypto.randomUUID(), createdAt: new Date(), revokedAt: null, lastUsedAt: null, scope: "full", secretBroker: null, secretBrokerAt: null }), [["keyHash"]]),
  accountPasskey: table("accountPasskey", () => ({ id: crypto.randomUUID(), createdAt: new Date(), lastUsedAt: null, counter: 0n, transports: [] }), [["credentialId"]]),
  passkeyChallenge: table("passkeyChallenge", () => ({ id: crypto.randomUUID(), createdAt: new Date(), action: null, targetId: null, answeredAt: null, grantHash: null, passkeyId: null, usedAt: null }), [["challenge"], ["grantHash"]]),
  secretRequest: table("secretRequest", () => ({ id: crypto.randomUUID(), status: "open", option: null, assertion: null, decidedBy: null, raisedAt: new Date(), decidedAt: null, deliveredAt: null }), [["agentId", "ref"]]),
  secretJob: table("secretJob", () => ({ id: crypto.randomUUID(), state: "requested", progress: null, failure: null, createdAt: new Date(), updatedAt: new Date(), finishedAt: null })),
  appBridgeDevice: table("appBridgeDevice"),
  appBridgeCredential: table("appBridgeCredential", () => ({ revokedAt: null, replacesKeyHash: null }), [["keyHash"]]),
};
// Joins the real code asks for.
const cookieFind = db.sessionCookie.findUnique;
db.sessionCookie.findUnique = async (args: any) => {
  const c = await cookieFind(args);
  return c && args.include?.account ? { ...c, account: copy(tables.account.find(a => a.id === c.accountId)) } : c;
};
const tokenFind = db.agentToken.findUnique;
db.agentToken.findUnique = async (args: any) => {
  const t = await tokenFind(args);
  return t && args.include?.account ? { ...t, account: copy(tables.account.find(a => a.id === t.accountId)) } : t;
};
const requestFind = db.secretRequest.findFirst;
db.secretRequest.findFirst = async (args: any) => {
  const r = await requestFind(args);
  return r && args.include?.agent ? { ...r, agent: copy(tables.agentToken.find(a => a.id === r.agentId)) } : r;
};

const credFind = db.appBridgeCredential.findUnique;
db.appBridgeCredential.findUnique = async (args: any) => {
  const c = await credFind(args);
  return c && args.include?.device ? { ...c, device: copy(tables.appBridgeDevice.find(d => d.id === c.deviceId)) } : c;
};
const requestMany = db.secretRequest.findMany;
db.secretRequest.findMany = async (args: any = {}) => {
  const rows = await requestMany(args);
  return args.include?.agent ? rows.map((r: Row) => ({ ...r, agent: copy(tables.agentToken.find(a => a.id === r.agentId)) })) : rows;
};

const webauthn = fakeWebAuthn();
before(() => {
  process.env.PUBLIC_APP_URL = "https://back-channel.app";
  mock.module("@simplewebauthn/server", { namedExports: webauthn.lib });
  mock.module("@/lib/db", { namedExports: { prisma: db } });
  mock.module("@/lib/rate-limit", { namedExports: { rateLimit: () => ({ ok: true, retryAfterSec: 0 }), rateLimitPeek: () => ({ ok: true, retryAfterSec: 0 }), clientIp: () => "unknown" } });
});

const COOKIE = { a: ["cs", "accounta"].join("_"), b: ["cs", "accountb"].join("_") };
// Agent keys built at runtime, so no key-shaped literal sits in the file.
const KEY = { pc: ["bc", "pcworker", randomBytes(8).toString("hex")].join("_"), other: ["bc", "otherpc", randomBytes(8).toString("hex")].join("_"),
  connector: ["bco", "hosted", randomBytes(8).toString("hex")].join("_") };
const AGENT = { pc: "11111111-1111-4111-8111-111111111111", other: "22222222-2222-4222-8222-222222222222" };
const digestB64 = () => randomBytes(32).toString("base64url");
const COSE = Buffer.from([165, 1, 2, 3, 38, 32, 1]);

function reset() {
  for (const k of Object.keys(tables)) tables[k] = [];
  webauthn.calls.length = 0;
  process.env.APPROVAL_STEP_UP = "on";
  const now = new Date();
  tables.account.push({ id: "acct-a", handle: "skylar@bc", email: "a@example.invalid" }, { id: "acct-b", handle: "other@bc", email: "b@example.invalid" });
  for (const [accountId, raw] of [["acct-a", COOKIE.a], ["acct-b", COOKIE.b]]) {
    tables.sessionCookie.push({ token: sha(raw), accountId, createdAt: now, expiresAt: new Date(Date.now() + 86_400_000), lastUsedAt: now });
  }
  tables.agentToken.push(
    { id: AGENT.pc, accountId: "acct-a", keyHash: sha(KEY.pc), name: "Desktop worker", scope: "full", revokedAt: null, lastUsedAt: now, secretBroker: null, secretBrokerAt: null },
    { id: AGENT.other, accountId: "acct-b", keyHash: sha(KEY.other), name: "Other PC", scope: "full", revokedAt: null, lastUsedAt: now, secretBroker: null, secretBrokerAt: null },
    { id: crypto.randomUUID(), accountId: "acct-a", keyHash: sha(KEY.connector), name: "claude.ai", scope: "full", revokedAt: null, lastUsedAt: now },
  );
}
beforeEach(reset);

type Res = { status: number; body: any };
type Opts = { cookie?: string | null; csrf?: boolean; stepUp?: string; bearer?: string };
function req(method: string, url: string, body?: unknown, o: Opts = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const cookie = o.cookie === undefined ? COOKIE.a : o.cookie;
  if (cookie) headers.cookie = `bc_session=${cookie}; bc_csrf=tok`;
  if (o.csrf !== false) headers["x-bc-csrf"] = "tok";
  if (o.stepUp) headers["x-bc-step-up"] = o.stepUp;
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  return new NextRequest(`https://back-channel.app${url}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
const read = async (res: Response): Promise<Res> => { const t = await res.text(); return { status: res.status, body: t ? JSON.parse(t) : null }; };
const sync = async (body: unknown, bearer = KEY.pc) => read(await (await import("@/app/api/agents/self/secret-broker/sync/route")).POST(req("POST", "/api/agents/self/secret-broker/sync", body, { cookie: null, bearer })));
const view = async (o: Opts = {}) => read(await (await import("@/app/api/secret-broker/route")).GET(req("GET", "/api/secret-broker", undefined, o)));
const deny = async (id: string, o: Opts = {}) => read(await (await import("@/app/api/secret-broker/requests/[id]/deny/route")).POST(req("POST", `/api/secret-broker/requests/${id}/deny`, {}, o), { params: Promise.resolve({ id }) }));
const machine = async (agentId: string, action: string, body: unknown = {}, o: Opts = {}) =>
  read(await (await import("@/app/api/secret-broker/machines/[agentId]/[action]/route")).POST(req("POST", `/api/secret-broker/machines/${agentId}/${action}`, body, o), { params: Promise.resolve({ agentId, action }) }));
async function pk(path: string, body: unknown, o: Opts = {}): Promise<Res> {
  const mod = await import("@/app/api/account/passkeys/[[...path]]/route");
  return read(await mod.POST(req("POST", `/api/account/passkeys/${path}`, body, o), { params: Promise.resolve({ path: path.split("/").filter(Boolean) }) }));
}
async function fingerprintOf(credentialId: string, cose: Buffer) {
  const { passkeyFingerprint } = await import("@/lib/secrets");
  return passkeyFingerprint(credentialId, new Uint8Array(cose));
}
function passkeyOn(accountId = "acct-a", credentialId = `cred${randomBytes(6).toString("hex")}`) {
  const row = { id: crypto.randomUUID(), accountId, credentialId, publicKey: COSE, counter: 0n, transports: ["hybrid"], label: "Skylar's phone", createdAt: new Date(), lastUsedAt: null };
  tables.accountPasskey.push(row);
  return row;
}
function brokerStatus(over: Row = {}) {
  return { installed: true, commit: "a".repeat(40), tree: "b".repeat(40), healthy: true, names: 36, lockdown: false, approverEnrolled: true,
    approvers: [], checks: [{ label: "broker answering", ok: true }], pin: { commit: "c".repeat(40), tree: "d".repeat(40), subject: "Remote approval" }, ...over };
}
function pendingItem(over: Row = {}) {
  return { ref: randomBytes(18).toString("base64url"), kind: "serve", name: "home/peruse", mode: "inject", tier: 1, target: null, code: "K7Q2MX",
    display: "REQUEST CODE K7Q2MX\nname: home/peruse\nmode: inject\nREQUEST CODE K7Q2MX", digest: digestB64(),
    options: [{ index: 0, label: "1 hour", digest: "" }, { index: 1, label: "just this once", digest: digestB64() }, { index: 2, label: "8 hours", digest: digestB64() }],
    expiresIn: 90, requester: { agent: "claude-code", session: "s1" }, ...over };
}
function withDigests(p: Row) { p.options[0].digest = p.digest; return p; }
/** Keys anywhere in a response that would name a secret value. None may exist. */
function valueShapedKeys(x: unknown, path = ""): string[] {
  if (!x || typeof x !== "object") return [];
  return Object.entries(x as Row).flatMap(([k, v]) => [...(/value|password|plaintext|secret_value/i.test(k) ? [path + k] : []), ...valueShapedKeys(v, `${path}${k}.`)]);
}

// ── Tests ──

test("sync: a full-scope worker key only; it stores the broker status and the requests, once each, and closes what the broker no longer lists", async () => {
  assert.equal((await sync({ v: 1, broker: brokerStatus() }, KEY.connector)).status, 403, "a hosted connector has no PC");
  assert.equal((await read(await (await import("@/app/api/agents/self/secret-broker/sync/route")).POST(req("POST", "/api/agents/self/secret-broker/sync", { v: 1 })))).status, 401, "a cookie is not a worker");
  const p = withDigests(pendingItem());
  const r1 = await sync({ v: 1, broker: brokerStatus(), pending: [p] });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.deepEqual(r1.body, { decisions: [], jobs: [] });
  assert.equal(tables.agentToken.find(a => a.id === AGENT.pc)!.secretBroker.names, 36);
  assert.equal(tables.secretRequest.length, 1);
  await sync({ v: 1, broker: brokerStatus(), pending: [p] });
  assert.equal(tables.secretRequest.length, 1, "the same ref is one request");
  await sync({ v: 1, broker: brokerStatus(), pending: [] });
  assert.equal(tables.secretRequest[0].status, "closed", "answered at the machine, served or expired");
  for (const bad of [{ v: 2 }, { v: 1, broker: brokerStatus({ commit: "zz" }) }, { v: 1, broker: brokerStatus(), pending: [{ ...p, ref: "x" }] },
    { v: 1, broker: brokerStatus(), pending: [{ ...p, digest: "short" }] }, { v: 1, broker: brokerStatus(), pending: [{ ...p, ref: randomBytes(18).toString("base64url"), kind: "steal" }] }]) {
    assert.equal((await sync(bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  }
});

test("approve: only a passkey the PC's broker trusts; the challenge IS the broker's digest for the chosen grant; the worker collects the assertion once", async () => {
  const key = passkeyOn();
  const p = withDigests(pendingItem());
  await sync({ v: 1, broker: brokerStatus(), pending: [p] });
  const id = tables.secretRequest[0].id;
  // Not trusted by that broker yet: refused before any prompt.
  let opt = await pk("step-up/options", { action: "approve_secret", targetId: id, option: 2 });
  assert.equal(opt.status, 409); assert.equal(opt.body.error, "not_trusted");
  await sync({ v: 1, broker: brokerStatus({ approvers: [{ fingerprint: await fingerprintOf(key.credentialId, COSE), label: "Skylar's phone" }] }), pending: [p] });
  assert.equal((await pk("step-up/options", { action: "approve_secret" })).status, 400, "approve_secret names its request");
  assert.equal((await pk("step-up/options", { action: "approve_secret", targetId: id, option: 9 })).status, 400, "an option that isn't offered");
  opt = await pk("step-up/options", { action: "approve_secret", targetId: id, option: 2 });
  assert.equal(opt.status, 200, JSON.stringify(opt.body));
  assert.equal(opt.body.options.challenge, p.options[2].digest, "the WebAuthn challenge is the broker's digest for '8 hours'");
  assert.deepEqual(opt.body.options.allowCredentials.map((c: Row) => c.id), [key.credentialId]);
  // An answer over another challenge is refused; the request stays open.
  const wrong = await pk("step-up/verify", { ceremonyId: opt.body.ceremonyId, response: webauthn.authentication(key.credentialId, p.options[1].digest) });
  assert.equal(wrong.status, 400);
  assert.equal(tables.secretRequest[0].status, "open");
  opt = await pk("step-up/options", { action: "approve_secret", targetId: id, option: 2 });
  const v = await pk("step-up/verify", { ceremonyId: opt.body.ceremonyId, response: webauthn.authentication(key.credentialId, opt.body.options.challenge) });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.deepEqual([v.body.approved, v.body.option], [true, 2]);
  assert.equal(v.body.grant, undefined, "the ceremony is the approval: no grant to spend anywhere");
  assert.equal(tables.secretRequest[0].status, "approved");
  // The worker collects it once, then it's gone from Back Channel.
  const r = await sync({ v: 1, broker: brokerStatus(), pending: [p] });
  assert.equal(r.body.decisions.length, 1);
  const d = r.body.decisions[0];
  assert.deepEqual([d.ref, d.decision, d.option], [p.ref, "approve", 2]);
  assert.deepEqual(Object.keys(d.assertion).sort(), ["authenticatorData", "clientDataJson", "credentialId", "signature"]);
  assert.equal(JSON.parse(Buffer.from(d.assertion.clientDataJson, "base64url").toString()).challenge, p.options[2].digest);
  assert.deepEqual((await sync({ v: 1, broker: brokerStatus(), pending: [p] })).body.decisions, [], "delivered once");
  assert.notEqual(tables.secretRequest[0].deliveredAt, null);
  assert.ok(!tables.secretRequest[0].assertion || typeof tables.secretRequest[0].assertion.signature !== "string", "the assertion left with it");
  // The ceremony can't be answered again, and a closed request can't be approved.
  assert.equal((await pk("step-up/options", { action: "approve_secret", targetId: id, option: 2 })).status, 410);
  assert.deepEqual(tables.accountAudit.map(a => a.eventType).filter(t => t.startsWith("secret.")), ["secret.requested", "secret.approved"]);
});

test("the BC Remote app: its device credential sees and denies; approving takes a trusted passkey answered from the release app", async () => {
  const { androidOrigins } = await import("@/lib/android-app");
  const key = passkeyOn();
  const p = withDigests(pendingItem());
  const q = withDigests(pendingItem({ code: "Z9W8V7" }));
  await sync({ v: 1, broker: brokerStatus({ approvers: [{ fingerprint: await fingerprintOf(key.credentialId, COSE), label: "Skylar's phone" }] }), pending: [p, q] });
  const [idP, idQ] = [p, q].map((x) => tables.secretRequest.find((r) => r.ref === x.ref).id);
  // Built at runtime, so no credential-shaped literal sits in the file.
  const phone = (scopes: string[], accountId = "acct-a", role = "remote") => {
    const deviceId = crypto.randomUUID();
    const raw = ["ab", randomBytes(32).toString("base64url")].join("_");
    tables.appBridgeDevice.push({ id: deviceId, accountId, role, enabled: true, revokedAt: null });
    tables.appBridgeCredential.push({ keyHash: sha(raw), deviceId, accountId, scopes, expiresAt: new Date(Date.now() + 86_400_000), revokedAt: null, replacesKeyHash: null });
    return raw;
  };
  const all = ["appbridge.device", "appbridge.relay.pass", "appbridge.secrets"];
  const mine = phone(all);
  const appView = async (bearer: string | null, o: Opts = {}) =>
    read(await (await import("@/app/api/appbridge/v1/devices/self/secret-broker/route")).GET(req("GET", "/api/appbridge/v1/devices/self/secret-broker", undefined, { cookie: null, ...o, ...(bearer ? { bearer } : {}) })));
  const appPost = async (id: string, action: string, body: unknown, bearer = mine) =>
    read(await (await import("@/app/api/appbridge/v1/devices/self/secret-broker/requests/[id]/[action]/route")).POST(
      req("POST", `/api/appbridge/v1/devices/self/secret-broker/requests/${id}/${action}`, body, { cookie: null, bearer }), { params: Promise.resolve({ id, action }) }));

  assert.equal((await appView(null)).status, 401, "no credential");
  assert.equal((await appView(null, { cookie: COOKIE.a })).status, 401, "the dashboard cookie isn't a device");
  assert.equal((await appView(KEY.pc)).status, 401, "an agent key isn't a device");
  assert.equal((await appView(phone(["appbridge.device", "appbridge.relay.pass"]))).status, 403, "a phone registered before appbridge.secrets");
  assert.equal((await appView(phone(all, "acct-a", "host"))).status, 403, "a PC's credential");
  assert.deepEqual((await appView(phone(all, "acct-b"))).body.requests, [], "another account's phone sees none of these");
  const v = await appView(mine);
  assert.equal(v.status, 200, JSON.stringify(v.body));
  const seen = v.body.requests.find((r: Row) => r.id === idP);
  assert.equal(seen.code, "K7Q2MX");
  assert.deepEqual(seen.options.map((o: Row) => Object.keys(o).sort()), [["index", "label"], ["index", "label"], ["index", "label"]], "labels, not digests");
  assert.equal(seen.digest, undefined);
  assert.deepEqual(valueShapedKeys(v.body), []);

  let opt = await appPost(idP, "approve-options", { option: 2 });
  assert.equal(opt.status, 200, JSON.stringify(opt.body));
  assert.equal(opt.body.options.challenge, p.options[2].digest, "the broker's digest for '8 hours'");
  assert.deepEqual(opt.body.options.allowCredentials.map((c: Row) => c.id), [key.credentialId]);
  // The website's origin isn't the app: refused, and the request stays open.
  const web = await appPost(idP, "approve-verify", { ceremonyId: opt.body.ceremonyId, response: webauthn.authentication(key.credentialId, opt.body.options.challenge) });
  assert.equal(web.status, 400); assert.equal(web.body.error, "not_verified");
  assert.equal(tables.secretRequest.find((r) => r.id === idP).status, "open");
  // A ceremony for one request can't approve another.
  const optQ = await appPost(idQ, "approve-options", {});
  assert.equal((await appPost(idP, "approve-verify", { ceremonyId: optQ.body.ceremonyId,
    response: webauthn.authentication(key.credentialId, optQ.body.options.challenge, { origin: androidOrigins()[0] }) })).status, 404);
  assert.equal(tables.secretRequest.find((r) => r.id === idQ).status, "open");
  // From the release app, over the broker's digest: approved, and the worker collects it as before.
  opt = await appPost(idP, "approve-options", { option: 2 });
  const ok = await appPost(idP, "approve-verify", { ceremonyId: opt.body.ceremonyId,
    response: webauthn.authentication(key.credentialId, opt.body.options.challenge, { origin: androidOrigins()[0] }) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body, { approved: true, option: 2 }, "no grant");
  assert.equal(tables.secretRequest.find((r) => r.id === idP).status, "approved");
  const s = await sync({ v: 1, broker: brokerStatus(), pending: [p, q] });
  assert.deepEqual(s.body.decisions.map((d: Row) => [d.ref, d.decision, d.option]), [[p.ref, "approve", 2]]);
  // Deny needs only the credential, and says which phone did it.
  assert.equal((await appPost(idQ, "deny", {})).status, 200);
  assert.equal((await appPost(idQ, "deny", {})).status, 410, "already answered");
  assert.ok(tables.accountAudit.some((a) => a.eventType === "secret.denied" && a.detail.device_id));
  passkeyOn("acct-b");
  assert.equal((await appPost(idQ, "approve-options", {}, phone(all, "acct-b"))).status, 404, "another account's phone");
});

test("assetlinks: back-channel.app lets only the release-signed apps use its passkeys", async () => {
  const res = await (await import("@/app/.well-known/assetlinks.json/route")).GET();
  const links = await res.json();
  const both = ["delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds"];
  assert.deepEqual(links.map((l: Row) => [l.relation, l.target.package_name]), [[both, "dev.appbridge.android"]]);
  const { androidOrigins } = await import("@/lib/android-app");
  assert.equal(androidOrigins().length, 1, "one release certificate, one origin");
  assert.match(links[0].target.sha256_cert_fingerprints[0], /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
});

test("deny: one click, no passkey; the worker gets the deny; another account can't touch it", async () => {
  await sync({ v: 1, broker: brokerStatus(), pending: [withDigests(pendingItem())] });
  const id = tables.secretRequest[0].id;
  assert.equal((await deny(id, { cookie: COOKIE.b })).status, 410, "not that account's request");
  assert.equal((await deny(id, { csrf: false })).status, 403);
  assert.equal((await deny(id, { bearer: KEY.pc })).status, 403, "people only");
  assert.equal((await deny(id)).status, 200);
  assert.equal((await deny(id)).status, 410, "already answered");
  const r = await sync({ v: 1, broker: brokerStatus(), pending: [] });
  assert.deepEqual(r.body.decisions.map((x: Row) => x.decision), ["deny"]);
});

test("view: the person's PCs, their brokers, which passkeys each trusts, and the requests; nothing that names a value", async () => {
  const key = passkeyOn();
  await sync({ v: 1, broker: brokerStatus({ approvers: [{ fingerprint: await fingerprintOf(key.credentialId, COSE), label: "phone" }] }), pending: [withDigests(pendingItem())] });
  await sync({ v: 1, broker: brokerStatus() }, KEY.other);
  const v = await view();
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.deepEqual(v.body.machines.map((m: Row) => m.name), ["Desktop worker"], "only this account's PCs");
  const m = v.body.machines[0];
  assert.deepEqual([m.current, m.updateAvailable, m.passkeys[0].trusted], [true, true, true]);
  assert.equal(v.body.requests.length, 1);
  assert.deepEqual(v.body.requests[0].options.map((o: Row) => Object.keys(o).sort()), [["index", "label"], ["index", "label"], ["index", "label"]], "digests stay server-side");
  assert.deepEqual(valueShapedKeys(v.body), []);
  assert.equal((await view({ cookie: null })).status, 401);
  assert.equal((await view({ bearer: KEY.pc })).status, 403, "people only");
});

test("jobs: install, update and enrol need the step-up for that PC; lockdown never does; the worker runs them and reports progress", async () => {
  const key = passkeyOn();
  await sync({ v: 1, broker: brokerStatus() });
  let r = await machine(AGENT.pc, "update");
  assert.equal(r.status, 403); assert.equal(r.body.error, "step_up_required");
  assert.equal((await machine(AGENT.pc, "install")).status, 409, "already installed: Update, not Install");
  assert.equal((await machine(AGENT.other, "update")).status, 404, "another account's PC");
  // A step-up for another PC doesn't spend here.
  const su = async (target: string) => {
    const opt = await pk("step-up/options", { action: "secret_broker_admin", targetId: target });
    const v = await pk("step-up/verify", { ceremonyId: opt.body.ceremonyId, response: webauthn.authentication(key.credentialId, opt.body.options.challenge, { counter: Number(tables.accountPasskey[0].counter) + 1 }) });
    assert.equal(v.status, 200, JSON.stringify(v.body));
    return v.body.grant as string;
  };
  assert.equal((await machine(AGENT.pc, "update", {}, { stepUp: await su(AGENT.other) })).status, 403);
  r = await machine(AGENT.pc, "update", {}, { stepUp: await su(AGENT.pc) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await machine(AGENT.pc, "enrol", { passkeyId: key.id }, { stepUp: await su(AGENT.pc) })).status, 409, "one broker job at a time");
  // Lockdown: one click, even with another job in progress.
  assert.equal((await machine(AGENT.pc, "lockdown")).status, 200);
  let s = await sync({ v: 1, broker: brokerStatus() });
  assert.deepEqual(s.body.jobs.map((j: Row) => j.kind), ["update", "lockdown"]);
  assert.deepEqual(s.body.jobs[0].payload, { commit: "c".repeat(40), tree: "d".repeat(40) }, "the commit and tree the broker repo pins");
  const [up, lock] = s.body.jobs;
  s = await sync({ v: 1, broker: brokerStatus(), jobs: [{ id: up.id, state: "running", steps: { installer_started: true } }, { id: lock.id, state: "done", steps: { locked: true } }] });
  assert.deepEqual(s.body.jobs, [], "a job the worker reports running is its own until it reports an end");
  await sync({ v: 1, broker: brokerStatus({ commit: "c".repeat(40) }), jobs: [{ id: up.id, state: "done", steps: { installer_started: true, service_running: true, doctor_healthy: true } }] });
  const v = await view();
  assert.deepEqual([v.body.machines[0].updateAvailable, v.body.machines[0].job.state], [false, "done"]);
  // An older broker that can't report its commit still gets the Update.
  await sync({ v: 1, broker: brokerStatus({ commit: null, tree: null }) });
  assert.equal((await view()).body.machines[0].updateAvailable, true);
  await sync({ v: 1, broker: brokerStatus({ commit: "c".repeat(40) }) });
  // Enrol: the passkey's public key and its fingerprint, for the broker to show at the machine.
  r = await machine(AGENT.pc, "enrol", { passkeyId: key.id }, { stepUp: await su(AGENT.pc) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  s = await sync({ v: 1, broker: brokerStatus({ commit: "c".repeat(40) }) });
  const enrol = s.body.jobs.find((j: Row) => j.kind === "enrol");
  assert.deepEqual(Object.keys(enrol.payload).sort(), ["credentialId", "fingerprint", "label", "passkeyId", "publicKeyCose"]);
  assert.equal(enrol.payload.fingerprint, await fingerprintOf(key.credentialId, COSE));
  assert.deepEqual(valueShapedKeys(s.body), []);
});

test("jobs: one whose worker stopped reporting (reinstalled mid-update) times out instead of blocking the PC for good", async () => {
  const key = passkeyOn();
  await sync({ v: 1, broker: brokerStatus() });
  const su = async () => {
    const opt = await pk("step-up/options", { action: "secret_broker_admin", targetId: AGENT.pc });
    const v = await pk("step-up/verify", { ceremonyId: opt.body.ceremonyId, response: webauthn.authentication(key.credentialId, opt.body.options.challenge, { counter: Number(tables.accountPasskey[0].counter) + 1 }) });
    return v.body.grant as string;
  };
  assert.equal((await machine(AGENT.pc, "update", {}, { stepUp: await su() })).status, 200);
  const [up] = (await sync({ v: 1, broker: brokerStatus() })).body.jobs;
  await sync({ v: 1, broker: brokerStatus(), jobs: [{ id: up.id, state: "running", steps: { fetched: true } }] });
  const row = tables.secretJob.find((j: Row) => j.id === up.id)!;
  row.updatedAt = new Date(Date.now() - 14 * 60_000);
  assert.equal((await machine(AGENT.pc, "update", {}, { stepUp: await su() })).status, 409, "still busy within 15 minutes");
  row.updatedAt = new Date(Date.now() - 16 * 60_000);
  assert.equal((await view()).body.machines[0].job.state, "failed");
  assert.equal(row.failure, "timed_out");
  assert.ok(tables.accountAudit.some((a: Row) => a.eventType === "secret.update_failed" && a.detail.failure === "timed_out"));
  assert.equal((await machine(AGENT.pc, "update", {}, { stepUp: await su() })).status, 200, "a new Update goes through");
});

test("the emergency switch can't skip the passkey for a secret: approving still is a ceremony over the broker's digest", async () => {
  process.env.APPROVAL_STEP_UP = "off";
  const key = passkeyOn();
  const p = withDigests(pendingItem());
  await sync({ v: 1, broker: brokerStatus({ approvers: [{ fingerprint: await fingerprintOf(key.credentialId, COSE), label: "phone" }] }), pending: [p] });
  const id = tables.secretRequest[0].id;
  const opt = await pk("step-up/options", { action: "approve_secret", targetId: id });
  assert.equal(opt.body.options.challenge, p.digest);
  assert.equal(tables.secretRequest[0].status, "open", "nothing approves without the answer");
});

test("fingerprint: the same bytes the broker hashes (credential id, a zero byte, the COSE key)", async () => {
  const fp = await fingerprintOf("Y3JlZA", Buffer.from([1, 2, 3]));
  const want = createHash("sha256").update(Buffer.concat([Buffer.from("cred"), Buffer.from([0]), Buffer.from([1, 2, 3])])).digest("hex").toUpperCase().slice(0, 16).match(/.{4}/g)!.join("-");
  assert.equal(fp, want);
});
