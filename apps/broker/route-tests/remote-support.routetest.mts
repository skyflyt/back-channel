/**
 * Route tests for remote support (docs/remote-support.md): /api/support/*, the bc_support_* MCP tools, the landing
 * page's lookup, and the helper's "support" relay lease (/api/appbridge/v1/relay/support-passes, redeem, renew).
 * The real route files and src/lib modules run against an in-memory Prisma (enough of the query surface for
 * remote-support.ts, remote-app.ts, appbridge.ts and lists.ts), with @/lib/auth and @/lib/rate-limit mocked. No
 * Postgres needed (scripts/appbridge-integration.mts races redemptions on a real one). mock.module() is called once
 * per specifier, in before(); tests drive the closured state.
 */
import { test, before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { NextRequest } from "next/server";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";

type Row = Record<string, any>;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ── In-memory Prisma ──
const cmp = (a: any, b: any) => { const x = a instanceof Date ? a.getTime() : a; const y = b instanceof Date ? b.getTime() : b; return x < y ? -1 : x > y ? 1 : 0; };
function matches(row: Row | undefined, where: Row | undefined): boolean {
  if (!row) return false;
  return Object.entries(where ?? {}).every(([k, v]) => {
    if (v === undefined) return true;
    if (k === "OR") return (v as Row[]).some(w => matches(row, w));
    if (k === "AND") return (v as Row[]).every(w => matches(row, w));
    if (k === "accountId_feature" || k === "hostDeviceId_enrollmentId") return matches(row, v);
    const val = row[k];
    if (v === null) return val === null || val === undefined;
    if (v instanceof Date) return val instanceof Date && val.getTime() === v.getTime();
    if (typeof v === "object" && !Array.isArray(v)) return Object.entries(v).every(([op, x]: [string, any]) => {
      switch (op) {
        case "gt": return val != null && cmp(val, x) > 0;
        case "gte": return val != null && cmp(val, x) >= 0;
        case "lt": return val != null && cmp(val, x) < 0;
        case "lte": return val != null && cmp(val, x) <= 0;
        case "in": return (x as unknown[]).includes(val);
        case "not": return x === null ? val !== null && val !== undefined : val !== x;
        case "contains": return typeof val === "string" && val.toLowerCase().includes(String(x).toLowerCase());
        case "mode": return true;
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
const copy = (r: Row | null | undefined) => (r ? { ...r } : null);
// unique: columns a real database would refuse to duplicate (P2002), so a clash re-runs the transaction.
function table(name: string, defaults: () => Row = () => ({}), unique: string[] = []) {
  tables[name] = [];
  const rows = () => tables[name];
  const clash = (r: Row, except?: Row) => unique.some(k => r[k] != null && rows().some(x => x !== except && x[k] === r[k]));
  const p2002 = () => new PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "5.22.0" });
  return {
    findUnique: async ({ where }: any) => copy(rows().find(r => matches(r, where))),
    findFirst: async ({ where, orderBy }: any = {}) => copy(order(rows().filter(r => matches(r, where)), orderBy)[0]),
    findMany: async ({ where, orderBy, take }: any = {}) => order(rows().filter(r => matches(r, where)), orderBy).slice(0, take ?? Infinity).map(r => ({ ...r })),
    count: async ({ where }: any = {}) => rows().filter(r => matches(r, where)).length,
    create: async ({ data }: any) => { const r = { ...defaults(), ...data }; if (clash(r)) throw p2002(); rows().push(r); return { ...r }; },
    update: async ({ where, data }: any) => { const r = rows().find(x => matches(x, where)); if (!r) throw new Error("not found"); if (clash({ ...r, ...data }, r)) throw p2002(); return { ...Object.assign(r, data) }; },
    updateMany: async ({ where, data }: any) => { const hit = rows().filter(r => matches(r, where)); hit.forEach(r => Object.assign(r, data)); return { count: hit.length }; },
    deleteMany: async ({ where }: any) => { const keep = rows().filter(r => !matches(r, where)); const count = rows().length - keep.length; tables[name] = keep; return { count }; },
  };
}
let logSeq = 0n;
const SESSION_DEFAULTS = () => ({ id: crypto.randomUUID(), createdAt: new Date(), executorAgentId: null, listTaskId: null, consentBy: null, consentVia: null, startedAt: null,
  expiresAt: null, endedAt: null, endReason: null, summary: null, evidenceRef: null, helperLabel: null, supportKeySha256: null, supportKeySpki: null, supportCredentialHash: null,
  supportCredentialExpiresAt: null, removal: null, removalAt: null });
const db: any = {
  account: table("account"),
  accountAudit: table("accountAudit", () => ({ createdAt: new Date() })),
  agentToken: table("agentToken"),
  viewToken: table("viewToken", () => ({ createdAt: new Date(), usedAt: null })),
  appBridgeDevice: table("device"),
  appBridgeCredential: table("credential"),
  appBridgeEntitlement: table("entitlement"),
  appBridgePairing: table("pairing"),
  appBridgePass: table("pass", () => ({ createdAt: new Date(), consumedAt: null, remoteDeviceId: null, enrollmentId: null, remoteAppSessionId: null })),
  appBridgeLease: table("lease", () => ({ createdAt: new Date() })),
  appBridgeConnectionEvent: table("connection", () => ({ id: crypto.randomUUID(), at: new Date() })),
  remoteSubscription: table("remoteSubscription"),
  remoteAppSession: table("remoteAppSession", SESSION_DEFAULTS, ["supportCredentialHash"]),
  remoteAppActionLog: table("actionLog", () => ({ id: ++logSeq, at: new Date(), target: null, evidenceRef: null })),
  supportInvite: table("supportInvite", () => ({ id: crypto.randomUUID(), createdAt: new Date(), listTaskId: null, status: "requested", codeHash: null, mintedAt: null,
    codeExpiresAt: null, redeemedAt: null, sessionId: null, closedAt: null }), ["codeHash", "sessionId"]),
  supportReport: table("supportReport", () => ({ id: crypto.randomUUID(), createdAt: new Date(), sessionId: null })),
  taskList: table("taskList"),
  taskListMember: table("taskListMember"),
  taskListAgentGrant: table("taskListAgentGrant"),
  taskItem: table("taskItem"),
  taskEntry: table("taskEntry", () => ({ id: crypto.randomUUID(), createdAt: new Date(), eventType: null, authorAgentId: null })),
};
const credentialFind = db.appBridgeCredential.findUnique;
db.appBridgeCredential.findUnique = async (args: any) => {
  const c = await credentialFind(args);
  return c && args.include?.device ? { ...c, device: { ...tables.device.find(d => d.id === c.deviceId) } } : c;
};
// transactionFaults: one per attempt, raised at COMMIT after the callback ran, with its writes rolled back.
let transactionFaults: unknown[] = []; let transactionCalls = 0;
db.$transaction = async (fn: any, options: any) => {
  transactionCalls++;
  assert.equal(options?.isolationLevel, "Serializable");
  const snapshot = structuredClone(tables);
  let result: unknown;
  try { result = await fn(db); } catch (e) { Object.assign(tables, snapshot); throw e; }
  const fault = transactionFaults.shift();
  if (fault) { Object.assign(tables, snapshot); throw fault; }
  return result;
};
const abort = () => new PrismaClientKnownRequestError("Transaction failed due to a write conflict or a deadlock. Please retry your transaction", { code: "P2034", clientVersion: "5.22.0" });

let limited = false;
const hits = new Map<string, number>();
before(() => {
  process.env.PUBLIC_APP_URL = "https://back-channel.app";
  mock.module("@/lib/db", { namedExports: { prisma: db } });
  mock.module("@/lib/rate-limit", { namedExports: {
    rateLimit: (bucket: string, key: string, max: number) => { const k = `${bucket}:${key}`; const n = (hits.get(k) ?? 0) + 1; hits.set(k, n); return { ok: !limited && n <= max, retryAfterSec: 7 }; },
    rateLimitPeek: (bucket: string, key: string, max: number) => ({ ok: !limited && (hits.get(`${bucket}:${key}`) ?? 0) < max, retryAfterSec: 7 }),
    clientIp: () => "unknown",
  } });
  mock.module("@/lib/auth", { namedExports: {
    SESSION_COOKIE_NAME: "bc_session", CSRF_COOKIE_NAME: "bc_csrf", CSRF_HEADER: "x-bc-csrf",
    csrfValid: (h: string | null, c: string | null) => !!h && !!c && h === c,
    getAccountFromCookie: async (v: string | undefined) => tables.account.find(a => a.cookie === v) ?? null,
    getAuthContext: async (header: string | null) => {
      const m = /^Bearer (\S+)$/.exec(header ?? "");
      const a = m ? tables.agentToken.find(x => x.key === m[1] && !x.revokedAt) : null;
      return a ? { account: tables.account.find(x => x.id === a.accountId), agentTokenId: a.id, scope: a.scope } : null;
    },
    generateViewToken: () => "vt_" + randomBytes(32).toString("base64url"),
    viewTokenExpiry: () => new Date(Date.now() + 15 * 60_000),
    hashToken: (raw: string) => sha(raw),
  } });
  // The MCP route's other wrapped routes, unused here, mocked so importing it never touches their modules.
  mock.module("@/lib/inbox-pending", { namedExports: { pendingCount: async () => ({ count: 0, kinds: [] }) } });
  const ok = async () => new Response("{}", { status: 200 });
  for (const path of ["@/app/api/sessions/active/route", "@/app/api/inbox/agent-payloads/route", "@/app/api/scopes/route"]) mock.module(path, { namedExports: { GET: ok } });
  for (const path of ["@/app/api/poll/route", "@/app/api/invites/route", "@/app/api/invites/[code]/claim/route", "@/app/api/inbox/request/route", "@/app/api/sessions/[id]/end/route", "@/app/api/account/view-token-self/route"]) {
    mock.module(path, { namedExports: { POST: ok } });
  }
});

// ── Fixtures ──
const A = { starter: "a0000000-0000-4000-8000-000000000001", plain: "a0000000-0000-4000-8000-000000000003", conn: "a0000000-0000-4000-8000-000000000004",
  other: "a0000000-0000-4000-8000-000000000005" };
const KEY = { starter: "bc_starter", plain: "bc_plain", conn: "bco_conn", other: "bc_other" };
const OWNER_EMAIL = "owner@example.invalid";
const PC1 = "pcShop000000000000000A";
const CRED1 = "ab_" + "A".repeat(43);
const FP1 = "A1".repeat(32);
const LIST = "b0000000-0000-4000-8000-000000000001", TASK = "c0000000-0000-4000-8000-000000000001";
const relayKeys = generateKeyPairSync("ed25519");
const RELAY_PUBLIC_KEY = relayKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const HOST_SCOPES = ["appbridge.device", "appbridge.host.relay", "appbridge.relay.presence"];

function reset() {
  for (const k of Object.keys(tables)) tables[k] = [];
  limited = false; hits.clear(); transactionFaults = []; transactionCalls = 0;
  process.env.APPBRIDGE_REMOTE_ACCESS = "on";
  process.env.APPBRIDGE_RELAY_PUBLIC_KEY = RELAY_PUBLIC_KEY;
  process.env.ADMIN_EMAILS = OWNER_EMAIL;
  const now = new Date();
  tables.account.push(
    { id: "acct-a", handle: "skylar@bc", displayName: "Skylar", email: OWNER_EMAIL, emailVerifiedAt: now, reserved: false, cookie: "cs_a" },
    { id: "acct-b", handle: "other@bc", displayName: "Microsoft Support", email: "other@example.invalid", emailVerifiedAt: now, reserved: false, cookie: "cs_b" },
  );
  const agent = (id: string, key: string, accountId: string, name: string, over: Row = {}) =>
    ({ id, key, accountId, name, scope: "full", revokedAt: null, runtimeType: "other", dispatchName: null, dispatchEncryptionKey: null, dispatchSigningKey: null, createdAt: now, ...over });
  tables.agentToken.push(
    agent(A.starter, KEY.starter, "acct-a", "Claude Code"),
    agent(A.plain, KEY.plain, "acct-a", "Laptop Codex"),
    agent(A.conn, KEY.conn, "acct-a", "claude.ai", { scope: "connector" }),
    agent(A.other, KEY.other, "acct-b", "Other's agent"),
  );
  for (const accountId of ["acct-a", "acct-b"]) tables.entitlement.push({ accountId, feature: "appbridge.remote_access", active: true, updatedAt: now });
  tables.device.push({ id: PC1, accountId: "acct-a", role: "host", label: "Shop-PC", connectorSpki: "", connectorSpkiSha256: FP1, enabled: true, relayEnabled: true, createdAt: now, revokedAt: null });
  tables.credential.push({ keyHash: sha(CRED1), deviceId: PC1, accountId: "acct-a", scopes: [...HOST_SCOPES], createdAt: now, expiresAt: new Date(Date.now() + 86_400_000), revokedAt: null, replacesKeyHash: null });
  tables.taskList.push({ id: LIST, ownerAccountId: "acct-a", name: "Family", emoji: null, archivedAt: null, createdAt: now, updatedAt: now });
  tables.taskListMember.push({ listId: LIST, accountId: "acct-a", role: "owner", agentsTakeFrom: "me", addedByAccountId: "acct-a", joinedAt: now });
  tables.taskListAgentGrant.push({ listId: LIST, agentTokenId: A.starter, accountId: "acct-a", access: "work", createdAt: now });
  tables.taskItem.push({ id: TASK, listId: LIST, title: "Fix Mom's printer", notes: "", version: 1, status: "in_progress", position: 1024, dueAt: null,
    createdByAccountId: "acct-a", createdByAgentId: null, assigneeAccountId: null, assigneeAgents: false, assigneeAgentId: null, agentSeenAt: null,
    claimAccountId: "acct-a", claimAgentId: A.starter, claimedAt: now, claimExpiresAt: new Date(Date.now() + 10 * 60_000),
    reviewerAccountId: null, completedAt: null, completedByAccountId: null, completedByAgentId: null, summary: null, createdAt: now, updatedAt: now });
}
beforeEach(reset);

// ── Helpers ──
type Res = { status: number; body: any; headers: Headers };
async function api(method: "GET" | "POST", path: string, o: { as?: string; cookie?: string; csrf?: boolean; body?: unknown } = {}): Promise<Res> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (o.as) headers.authorization = `Bearer ${o.as}`;
  if (o.cookie) { headers.cookie = `bc_session=${o.cookie}; bc_csrf=tok`; if (o.csrf !== false) headers["x-bc-csrf"] = "tok"; }
  const req = new NextRequest(`https://back-channel.app/api/support/${path}`, { method, headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
  const mod = await import("@/app/api/support/[[...path]]/route");
  const res = await mod[method](req, { params: Promise.resolve({ path: path.split("/").filter(Boolean) }) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
type Key = { spki: string; fp: string; sign: (m: string) => string };
function p256(): Key {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const der = publicKey.export({ type: "spki", format: "der" });
  return { spki: der.toString("base64"), fp: createHash("sha256").update(der).digest("hex").toUpperCase(), sign: m => sign("sha256", Buffer.from(m), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
}
const person = (path: string, o: { cookie?: string; csrf?: boolean } = {}) => api("POST", path, { cookie: "cs_a", ...o });
const client = (method: "GET" | "POST", path: string, cred: string, body?: unknown) => api(method, `client/${path}`, { as: cred, body });
const inviteBody = (over: Row = {}) => ({ for: "Mom", task: "Get the printer working again", minutes: 30, ...over });
const request = (over: Row = {}, as = KEY.starter) => api("POST", "invites", { as, body: inviteBody(over) });
const redeem = (code: string, key: Key = p256(), body: Row = {}) => api("POST", "redeem", { body: { code, keySpki: key.spki, proof: key.sign(`bc-support-redeem-v1:${code}`), ...body } });
const allow = (x: { cred: string; key: Key; sessionId: string }) => client("POST", "allow", x.cred, { proof: x.key.sign(`bc-support-allow-v1:${x.sessionId}`) });
async function minted(over: Row = {}) {
  const r = await request(over); assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = await person(`invites/${r.body.support.id}/approve`); assert.equal(a.status, 200, JSON.stringify(a.body));
  return { id: r.body.support.id as string, code: a.body.code as string, url: a.body.url as string };
}
async function redeemed(over: Row = {}) {
  const m = await minted(over); const key = p256();
  const r = await redeem(m.code, key); assert.equal(r.status, 200, JSON.stringify(r.body));
  return { ...m, key, sessionId: r.body.sessionId as string, cred: r.body.credential as string, reply: r.body };
}
async function allowed(over: Row = {}) {
  const x = await redeemed(over);
  const r = await allow(x); assert.equal(r.status, 200, JSON.stringify(r.body));
  return x;
}
const inviteRow = (id: string) => tables.supportInvite.find(i => i.id === id)!;
const sessionRow = (id: string) => tables.remoteAppSession.find(s => s.id === id)!;
const entries = () => tables.taskEntry.filter(e => e.taskId === TASK);
const everything = () => JSON.stringify(tables, (_, v) => typeof v === "bigint" ? String(v) : v);
function relayReq(route: "redeem" | "renew", body: unknown) {
  const path = `/api/appbridge/v1/relay/${route}`; const raw = JSON.stringify(body);
  const seconds = String(Math.floor(Date.now() / 1000)); const nonce = randomBytes(16).toString("base64url");
  const sig = sign(null, Buffer.from(`appbridge-relay-broker-v1\nPOST\n${path}\n${seconds}\n${nonce}\n${sha(raw)}`), relayKeys.privateKey).toString("base64url");
  return new NextRequest(`https://back-channel.app${path}`, { method: "POST", body: raw, headers: { "content-type": "application/json", authorization: `AppBridge-Relay v1.${seconds}.${nonce}.${sig}` } });
}
async function supportPass(cred: string): Promise<Res> {
  const req = new NextRequest("https://back-channel.app/api/appbridge/v1/relay/support-passes", { method: "POST", headers: { authorization: `Bearer ${cred}`, "content-type": "application/json" }, body: "{}" });
  const r = await (await import("@/app/api/appbridge/v1/relay/support-passes/route")).POST(req);
  return { status: r.status, body: await r.json(), headers: r.headers };
}
async function supportLease(cred: string, fp: string): Promise<Res> {
  const issued = await supportPass(cred);
  if (issued.status !== 200) return issued;
  const r = await (await import("@/app/api/appbridge/v1/relay/redeem/route")).POST(relayReq("redeem", { pass: issued.body.pass, purpose: "support", connectorSpkiSha256: fp }));
  return { status: r.status, body: await r.json(), headers: r.headers };
}
async function renew(leaseId: string) { return (await (await import("@/app/api/appbridge/v1/relay/renew/route")).POST(relayReq("renew", { leaseId }))).status; }
async function mcp(key: string, method: string, params?: unknown) {
  const { POST } = await import("@/app/api/mcp/route");
  const res = await POST(new NextRequest("https://back-channel.app/api/mcp", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }) }));
  return res.json();
}
async function tool(key: string, name: string, args: Row) {
  const j = await mcp(key, "tools/call", { name, arguments: args });
  assert.equal(j.error, undefined, JSON.stringify(j.error));
  const text: string = j.result.content[0].text;
  return { isError: j.result.isError as boolean, text, json: (() => { try { return JSON.parse(text.replace(/^HTTP \d+: /, "")); } catch { return null; } })() };
}
const SUPPORT_TOOLS = ["bc_support_invite", "bc_support_status", "bc_support_end"];

// ── Tests ──

test("the agent asks, the person approves in the dashboard, and the code is shown to the person only", async () => {
  const r = await request({ taskId: TASK });
  assert.equal(r.status, 200); assert.equal(r.headers.get("cache-control"), "no-store");
  const id = r.body.support.id;
  assert.equal(r.body.support.status, "requested");
  assert.deepEqual(r.body.support.listTask, { id: TASK, title: "Fix Mom's printer" });
  const url = new URL(r.body.approvalUrl);
  assert.equal(`${url.origin}${url.pathname}`, "https://back-channel.app/account/remote");
  assert.equal(url.searchParams.get("support"), id);
  assert.match(r.body.next, /you never see it/); assert.match(r.body.next, /don't open it yourself/);
  assert.deepEqual(tables.viewToken.map(v => v.token), [sha(url.searchParams.get("vt")!)], "a single-use sign-in, stored hashed");
  // An agent never approves, with or without a cookie riding along; the dashboard needs CSRF; another account sees nothing.
  for (const o of [{ as: KEY.starter }, { as: KEY.starter, cookie: "cs_a" }]) {
    const no = await api("POST", `invites/${id}/approve`, o);
    assert.equal(no.status, 403); assert.equal(no.body.error, "people_only");
  }
  assert.equal((await person(`invites/${id}/approve`, { csrf: false })).body.error, "csrf");
  assert.equal((await person(`invites/${id}/approve`, { cookie: "cs_b" })).status, 404);
  assert.equal(inviteRow(id).status, "requested");
  const ok = await person(`invites/${id}/approve`);
  assert.equal(ok.status, 200);
  const code: string = ok.body.code;
  assert.match(code, /^BCS-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(ok.body.url, `https://back-channel.app/support/${code}`);
  assert.match(ok.body.note, /Shown once/);
  assert.equal(ok.body.support.status, "minted");
  // Only its hash is stored, and the code is nowhere else: not in audit, not on the task, not in any agent's view.
  assert.equal(inviteRow(id).codeHash, sha(code));
  assert.ok(!everything().includes(code), "the code itself is never stored");
  const seen = await api("GET", `invites/${id}`, { as: KEY.starter });
  assert.equal(seen.body.support.status, "minted"); assert.ok(!JSON.stringify(seen.body).includes(code) && !JSON.stringify(seen.body).includes(sha(code)));
  assert.match(seen.body.next, /you never see it/);
  const listed = await api("GET", "invites", { as: KEY.starter });
  assert.ok(!JSON.stringify(listed.body).includes(code));
  const status = await tool(KEY.starter, "bc_support_status", { support_id: id });
  assert.equal(status.isError, false); assert.ok(!status.text.includes(code));
  const dashboard = await api("GET", "invites", { cookie: "cs_a" });
  assert.deepEqual(dashboard.body.codes.map((c: any) => c.id), [id]); assert.ok(!JSON.stringify(dashboard.body).includes(code), "and not again, even to the person");
  assert.equal((await person(`invites/${id}/approve`)).body.error, "already_decided", "minted once");
  assert.deepEqual(tables.accountAudit.map(a => a.eventType), ["support.requested", "support.minted"]);
  assert.deepEqual(entries().map(e => [e.authorAgentId, e.body]), [
    [A.starter, "Asked for a one-time support code to help Mom, for up to 30 minutes. Waiting for approval."],
    [null, "Approved a one-time support code for Mom, for up to 30 minutes. The code is shown only in the dashboard and is sent by hand."],
  ]);
});

test("owner-only, verified, and part of Back Channel Remote: checked at the request, the mint, the redemption and the Allow", async () => {
  // A non-owner account can't ask, and its dashboard shows nothing.
  const other = await request({}, KEY.other);
  assert.equal(other.status, 403); assert.equal(other.body.error, "owner_only");
  assert.deepEqual((await api("GET", "invites", { cookie: "cs_b" })).body, { available: false, reason: "owner_only" });
  // Nor can it mint one that somehow exists in its account.
  tables.supportInvite.push({ id: crypto.randomUUID(), accountId: "acct-b", agentTokenId: A.other, forName: "x", task: "t", minutes: 5, listTaskId: null, status: "requested",
    codeHash: null, mintedAt: null, codeExpiresAt: null, redeemedAt: null, sessionId: null, closedAt: null, createdAt: new Date() });
  assert.equal((await person(`invites/${tables.supportInvite[0].id}/approve`, { cookie: "cs_b" })).body.error, "owner_only");
  assert.equal(tables.supportInvite[0].codeHash, null);
  // An unverified owner email is not the owner.
  tables.account[0].emailVerifiedAt = null;
  assert.equal((await request()).body.error, "owner_only");
  tables.account[0].emailVerifiedAt = new Date();
  // No Remote: no support.
  tables.entitlement[0].active = false;
  assert.equal((await request()).body.error, "not_entitled");
  tables.entitlement[0].active = true;
  process.env.APPBRIDGE_REMOTE_ACCESS = "off";
  assert.equal((await request()).body.error, "rollout_off");
  process.env.APPBRIDGE_REMOTE_ACCESS = "on";
  // Entitlement lost between the request and the mint: no code.
  const asked = (await request()).body.support.id;
  tables.entitlement[0].active = false;
  assert.equal((await person(`invites/${asked}/approve`)).body.error, "not_entitled");
  assert.equal(inviteRow(asked).status, "requested");
  tables.entitlement[0].active = true;
  // Lost between the mint and the redemption: the helped side is told only that help isn't available, and the code isn't spent.
  const m = await minted();
  tables.entitlement[0].active = false;
  const r = await redeem(m.code);
  assert.equal(r.status, 403); assert.equal(r.body.error, "unavailable"); assert.doesNotMatch(r.body.message, /subscri|entitle|owner/i);
  assert.equal(inviteRow(m.id).status, "minted");
  tables.entitlement[0].active = true;
  const x = await redeemed();
  tables.entitlement[0].active = false;
  assert.equal((await allow(x)).body.error, "unavailable", "and at Allow");
  assert.equal(sessionRow(x.sessionId).status, "awaiting_consent");
});

test("connector keys are refused everywhere, and tools/list never offers them the bc_support_* tools", async () => {
  const id = crypto.randomUUID();
  for (const [m, path, body] of [["POST", "invites", inviteBody()], ["GET", "invites"], ["GET", `invites/${id}`], ["POST", `invites/${id}/end`, {}]] as Array<["GET" | "POST", string, unknown?]>) {
    const r = await api(m, path, { as: KEY.conn, body });
    assert.equal(r.status, 403, `${m} ${path}`); assert.equal(r.body.error, "not_available_to_connectors");
  }
  assert.equal(tables.supportInvite.length, 0);
  const names = async (key: string) => (await mcp(key, "tools/list")).result.tools.map((t: { name: string }) => t.name) as string[];
  assert.deepEqual((await names(KEY.conn)).filter(n => n.startsWith("bc_support_")), [], "a connector key is never offered a support tool");
  assert.deepEqual((await names(KEY.starter)).filter(n => n.startsWith("bc_support_")), SUPPORT_TOOLS, "a full key gets all three");
  const called = await tool(KEY.conn, "bc_support_invite", inviteBody());
  assert.equal(called.isError, true); assert.match(called.text, /HTTP 403/); assert.equal(called.json.error, "not_available_to_connectors");
  assert.equal(tables.supportInvite.length, 0);
  // Honest descriptions: the person approves and sends the code; the agent never sees it.
  const catalog = (await mcp(KEY.starter, "tools/list")).result.tools as Array<{ name: string; description: string }>;
  assert.match(catalog.find(t => t.name === "bc_support_invite")!.description, /Your person approves it and sends the code; you never see it/);
  for (const t of catalog.filter(t => t.name.startsWith("bc_support_"))) assert.doesNotMatch(t.description, /—/, `${t.name}: plain punctuation`);
});

test("redemption: single use, pinned to the first key, inside the 15-minute window; a second key is refused", async () => {
  const m = await minted({ taskId: TASK });
  const first = p256();
  const r = await redeem(m.code.toLowerCase(), first);
  assert.equal(r.status, 400, "the proof signs the canonical code (BCS-XXXX-XXXX), whatever was typed");
  const ok = await redeem(m.code, first);
  assert.equal(ok.status, 200);
  // Only what the temporary client needs: the session, who is asking (as the broker asserts it), the task, the cap, a credential.
  assert.deepEqual(Object.keys(ok.body).sort(), ["allowBy", "credential", "credentialExpiresAt", "issuer", "minutes", "sessionId", "task"]);
  assert.deepEqual(ok.body.issuer, { name: "Skylar", handle: "skylar@bc" });
  assert.equal(ok.body.task, "Get the printer working again"); assert.equal(ok.body.minutes, 30);
  assert.match(ok.body.credential, /^abs_[A-Za-z0-9_-]{43}$/);
  assert.ok(!JSON.stringify(ok.body).includes("Mom") && !JSON.stringify(ok.body).includes("Claude Code"), "never who it's 'for' in the agent's words, or the agent");
  const s = sessionRow(ok.body.sessionId);
  assert.deepEqual([s.kind, s.status, s.supportKeySha256, s.supportCredentialHash, s.appAllowList.length], ["support", "awaiting_consent", first.fp, sha(ok.body.credential), 0]);
  assert.match(s.hostDeviceId, /^support_[A-Za-z0-9_-]{22}$/, "a relay identity, never a device");
  assert.ok(!everything().includes(ok.body.credential), "the credential itself is never stored");
  assert.equal(inviteRow(m.id).status, "redeemed"); assert.equal(inviteRow(m.id).sessionId, s.id);
  // A second key: the uniform answer. The code is used.
  const second = await redeem(m.code, p256());
  assert.equal(second.status, 410); assert.equal(second.body.error, "code_invalid");
  assert.equal(tables.remoteAppSession.length, 1);
  // The same key again, inside the window (its reply was lost): a fresh credential, and the first stops working.
  const again = await redeem(m.code, first);
  assert.equal(again.status, 200); assert.equal(again.body.sessionId, s.id); assert.notEqual(again.body.credential, ok.body.credential);
  assert.equal((await client("GET", "session", ok.body.credential)).status, 401);
  assert.equal((await client("GET", "session", again.body.credential)).status, 200);
  // After the window, not even the first key.
  inviteRow(m.id).codeExpiresAt = new Date(Date.now() - 1);
  assert.equal((await redeem(m.code, first)).status, 410);
  // A key is used for one code only.
  await person(`invites/${m.id}/stop`);
  const other = await minted();
  assert.equal((await redeem(other.code, first)).body.error, "key_in_use");
  // TTL: a code unused for 15 minutes expires, for good.
  inviteRow(other.id).codeExpiresAt = new Date(Date.now() - 1);
  assert.equal((await redeem(other.code)).status, 410);
  assert.equal(inviteRow(other.id).status, "expired", "written, not just reported");
  assert.ok(entries().some(e => e.body === "Mom opened the support code. Waiting for them to press Allow on their own screen."));
  assert.ok(!entries().some(e => e.body.includes(m.code)), "the code never reaches the task");
});

test("invalid, used, cancelled, reported and expired codes all get the same answer, from the API and the landing page", async () => {
  const { supportCodeForPage } = await import("@/lib/remote-support");
  const used = await redeemed(); const voided = await minted(); const expired = await minted();
  await person(`invites/${voided.id}/void`);
  inviteRow(expired.id).codeExpiresAt = new Date(Date.now() - 1);
  const live = await minted();
  const reported = live.code;
  // A valid code shows who and what on the landing page...
  const page = await supportCodeForPage(live.code);
  assert.deepEqual({ ...page, expiresAt: undefined }, { code: live.code, issuer: { name: "Skylar", handle: "skylar@bc" }, task: "Get the printer working again", minutes: 30, expiresAt: undefined });
  assert.equal((await supportCodeForPage(live.code.toLowerCase().replace(/-/g, " ")))?.code, live.code, "as typed");
  assert.equal((await api("POST", "report", { body: { code: reported } })).status, 200);
  const answers = new Set<string>();
  for (const code of ["BCS-AAAA-AAAA", "BCS-1234", "not a code", used.code, voided.code, expired.code, reported]) {
    const r = await redeem(code);
    answers.add(JSON.stringify([r.status, r.body]));
    const rep = await api("POST", "report", { body: { code } });
    answers.add(JSON.stringify([rep.status, rep.body]));
    assert.equal(await supportCodeForPage(code), null, `the page shows nothing for ${code}`);
  }
  assert.equal(answers.size, 1, `one answer for every code that can't be used: ${[...answers].join(" | ")}`);
  const [status, body] = JSON.parse([...answers][0]);
  assert.equal(status, 410); assert.equal(body.error, "code_invalid"); assert.match(body.message, /nothing has happened on your computer/);
  assert.ok((hits.get("support:public-failed:all") ?? 0) >= 14, "every miss spends the public failure budget");
});

test("consent: nothing can act before the helped person's signed Allow, and Allow must come within 10 minutes", async () => {
  const x = await redeemed({ taskId: TASK });
  // Before Allow: no steps, no relay pass.
  assert.equal((await client("POST", "actions", x.cred, { action: "observe", outcome: "ok" })).body.error, "not_allowed_yet");
  assert.deepEqual((await supportPass(x.cred)).body, { error: "session_inactive" });
  // Allow is signed with the pinned key, over this session's id.
  assert.equal((await client("POST", "allow", x.cred, { proof: p256().sign(`bc-support-allow-v1:${x.sessionId}`) })).body.error, "invalid_proof");
  assert.equal((await client("POST", "allow", x.cred, { proof: x.key.sign(`bc-support-allow-v1:${crypto.randomUUID()}`) })).body.error, "invalid_proof");
  assert.equal((await client("POST", "allow", x.cred, {})).body.error, "invalid_proof");
  // Nobody but the client can allow: not the agent, not the person, not a device.
  for (const as of [KEY.starter, CRED1]) assert.equal((await client("POST", "allow", as, { proof: x.key.sign(`bc-support-allow-v1:${x.sessionId}`) })).status, 401);
  assert.equal((await api("POST", "client/allow", { cookie: "cs_a", body: {} })).status, 401);
  assert.equal(sessionRow(x.sessionId).status, "awaiting_consent");
  const ok = await allow(x);
  assert.equal(ok.status, 200); assert.equal(ok.body.session.status, "active");
  const row = sessionRow(x.sessionId);
  assert.deepEqual([row.consentVia, row.consentBy], ["helper", null]);
  assert.equal(row.expiresAt.getTime() - row.startedAt.getTime(), 30 * 60_000);
  assert.equal((await allow(x)).status, 200, "Allow is idempotent");
  assert.equal((await client("POST", "actions", x.cred, { action: "observe", outcome: "ok" })).status, 200);
  assert.equal((await supportPass(x.cred)).status, 200);
  assert.equal(entries().at(-1)!.body, "Mom pressed Allow on their computer: the support session runs for up to 30 minutes.");
  // Ten minutes with no Allow: cancelled, nothing happened.
  await person(`invites/${x.id}/stop`);
  const late = await redeemed();
  sessionRow(late.sessionId).createdAt = new Date(Date.now() - 10 * 60_000 - 1);
  const refused = await allow(late);
  assert.equal(refused.status, 410); assert.equal(refused.body.error, "too_late");
  assert.equal(sessionRow(late.sessionId).status, "lapsed");
  const t = await client("GET", "transcript", late.cred);
  assert.ok(t.body.transcript.lines.includes("Nobody pressed Allow within 10 minutes, so nothing happened."));
  // Stop before Allow is a no.
  const no = await redeemed();
  assert.equal((await client("POST", "stop", no.cred)).body.session.status, "denied");
  assert.equal((await allow(no)).body.error, "session_over");
});

test("one support session per account at a time: a second code waits, unspent, until the first is over", async () => {
  const first = await allowed();
  const second = await minted();
  const busy = await redeem(second.code);
  assert.equal(busy.status, 409); assert.equal(busy.body.error, "issuer_busy");
  assert.equal(inviteRow(second.id).status, "minted", "the code still works");
  await person(`invites/${first.id}/stop`);
  assert.equal((await redeem(second.code)).status, 200, "free once the first is over");
});

test("\"I didn't ask for this\": from the landing page it cancels the code; from the helper it ends the session; both file a report the owner sees", async () => {
  const m = await minted({ taskId: TASK });
  const page = await api("POST", "report", { body: { code: m.code } });
  assert.equal(page.status, 200); assert.equal(page.body.reported, true); assert.match(page.body.message, /Skylar can see that you reported it/);
  assert.equal(inviteRow(m.id).status, "reported");
  assert.equal((await redeem(m.code)).status, 410, "the code no longer works");
  assert.deepEqual(tables.supportReport.map(r => [r.via, r.inviteId, r.accountId]), [["page", m.id, "acct-a"]]);
  // From the helper, after Allow: the session ends, the lease goes, the code is marked reported.
  const x = await allowed({ taskId: TASK });
  const lease = await supportLease(x.cred, x.key.fp);
  assert.equal(lease.status, 200);
  const r = await client("POST", "report", x.cred);
  assert.equal(r.status, 200); assert.equal(r.body.session.status, "ended"); assert.equal(r.body.session.endReason, "reported");
  assert.equal(tables.lease.length, 0); assert.equal(await renew(lease.body.leaseId), 404);
  assert.equal(inviteRow(x.id).status, "reported");
  assert.equal((await client("POST", "report", x.cred)).status, 200, "idempotent");
  assert.equal(tables.supportReport.length, 2, "one report per session");
  const dashboard = await api("GET", "invites", { cookie: "cs_a" });
  assert.deepEqual(dashboard.body.reports.map((rep: any) => [rep.via, rep.for, rep.task]), [["helper", "Mom", "Get the printer working again"], ["page", "Mom", "Get the printer working again"]]);
  assert.equal(dashboard.body.recent.find((i: any) => i.id === x.id).reported, true);
  assert.ok(tables.accountAudit.filter(a => a.eventType === "support.reported").length === 2);
  assert.ok(entries().some(e => e.body.includes("They said they didn't ask for this, so it was cancelled and a report was filed.")));
});

test("the 45-minute cap: never asked for, never run past; the helper's lease ends with it", async () => {
  assert.equal((await request({ minutes: 46 })).body.error, "invalid_minutes");
  assert.match((await mcp(KEY.starter, "tools/call", { name: "bc_support_invite", arguments: { ...inviteBody(), minutes: 60 } })).error.message, /minutes must be <= 45/, "the schema says so too");
  const x = await allowed({ minutes: 45 });
  const row = sessionRow(x.sessionId);
  assert.equal(row.expiresAt.getTime() - row.startedAt.getTime(), 45 * 60_000);
  const lease = await supportLease(x.cred, x.key.fp);
  assert.equal(lease.status, 200);
  assert.ok(tables.lease[0].expiresAt.getTime() <= row.expiresAt.getTime(), "a lease never outlives its session");
  assert.equal(await renew(lease.body.leaseId), 200);
  row.startedAt = new Date(Date.now() - 45 * 60_000 - 1); row.expiresAt = new Date(Date.now() - 1);
  assert.equal(await renew(lease.body.leaseId), 403, "out of time: the renewal is refused and the lease deleted");
  assert.equal(tables.lease.length, 0);
  assert.equal((await client("POST", "actions", x.cred, { action: "observe", outcome: "ok" })).body.error, "session_over");
  assert.deepEqual([sessionRow(x.sessionId).status, sessionRow(x.sessionId).endReason], ["ended", "lapsed"]);
  assert.deepEqual((await supportPass(x.cred)).body, { error: "session_inactive" });
});

test("stop and revoke: the person's dashboard Stop, the helped person's Stop, cancelling an unused code; final, and the lease goes in the same transaction", async () => {
  const cases: Array<[string, (x: Awaited<ReturnType<typeof allowed>>) => Promise<number>, string]> = [
    ["issuer", async x => (await person(`invites/${x.id}/stop`)).status, "user_stop"],
    ["helped", async x => (await client("POST", "stop", x.cred)).status, "host_stop"],
    ["agent", async x => (await api("POST", `invites/${x.id}/end`, { as: KEY.starter, body: { finished: false } })).status, "agent_stop"],
  ];
  for (const [who, stop, reason] of cases) {
    const x = await allowed();
    const lease = await supportLease(x.cred, x.key.fp); assert.equal(lease.status, 200, who);
    assert.equal(await stop(x), 200, who);
    assert.deepEqual([sessionRow(x.sessionId).status, sessionRow(x.sessionId).endReason], ["ended", reason], who);
    assert.equal(tables.lease.length, 0, `${who}: the lease went with the stop`);
    assert.equal(await renew(lease.body.leaseId), 404, `${who}: the relay's next renewal ends it`);
    assert.deepEqual((await supportPass(x.cred)).body, { error: "session_inactive" }, `${who}: a stopped session never reopens`);
    assert.equal((await allow(x)).body.error, "session_over", who);
  }
  // Stop is the person's, in the dashboard: never an agent's bearer, never without CSRF, never another account.
  const x = await allowed();
  assert.equal((await api("POST", `invites/${x.id}/stop`, { as: KEY.starter })).body.error, "people_only");
  assert.equal((await person(`invites/${x.id}/stop`, { csrf: false })).body.error, "csrf");
  assert.equal((await person(`invites/${x.id}/stop`, { cookie: "cs_b" })).status, 404);
  // Stop is atomic: an outage changes neither the session nor its lease; a conflict re-runs it whole.
  const lease = await supportLease(x.cred, x.key.fp);
  transactionFaults = Array.from({ length: 5 }, abort); transactionCalls = 0;
  assert.equal((await person(`invites/${x.id}/stop`)).status, 503); assert.equal(transactionCalls, 5);
  assert.equal(sessionRow(x.sessionId).status, "active"); assert.equal(tables.lease.length, 1, "nothing half-done");
  transactionFaults = [abort()];
  assert.equal((await person(`invites/${x.id}/stop`)).status, 200);
  assert.equal(tables.lease.length, 0); assert.equal(await renew(lease.body.leaseId), 404);
  assert.equal((await person(`invites/${x.id}/stop`)).status, 200, "stopping again is a no-op");
  // Cancelling an unused code (void); Stop on it says so.
  const m = await minted();
  assert.equal((await person(`invites/${m.id}/stop`)).body.error, "not_running");
  assert.equal((await api("POST", `invites/${m.id}/void`, { as: KEY.starter })).body.error, "people_only");
  assert.equal((await person(`invites/${m.id}/void`)).body.support.status, "voided");
  assert.equal((await redeem(m.code)).status, 410);
  assert.equal((await person(`invites/${m.id}/void`)).body.error, "not_voidable");
  // Denying a request.
  const asked = (await request()).body.support.id;
  assert.equal((await person(`invites/${asked}/deny`)).body.support.status, "denied");
  assert.equal((await person(`invites/${asked}/approve`)).body.error, "already_decided");
});

test("steps are view-first and metadata only; the transcript is built from fixed phrases for both sides", async () => {
  const x = await allowed({ taskId: TASK });
  for (const bad of [{ action: "set_value", target: "Printer name", outcome: "ok", confirmed: true, value: "hunter2" }, { action: "invoke", target: "Remove device", outcome: "ok" },
    { action: "screenshot", outcome: "ok" }, { action: "type", target: "x", outcome: "ok" }, { action: "key", target: "VK_LWIN", outcome: "ok", confirmed: true }]) {
    assert.equal((await client("POST", "actions", x.cred, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await client("POST", "actions", x.cred, { action: "invoke", target: "Remove device", outcome: "ok" })).body.error, "confirm_required");
  assert.equal(tables.actionLog.length, 0, "nothing invalid is recorded");
  const steps = [
    { action: "open", target: "Printers & scanners", outcome: "ok", confirmed: true },
    { action: "observe", outcome: "ok" },
    { action: "invoke", target: "Remove device", outcome: "declined", confirmed: false },
    { action: "invoke", target: "Print a test page", outcome: "ok", confirmed: true },
    { action: "set_value", target: "Password", outcome: "credential_field" },
  ];
  for (const s of steps) assert.equal((await client("POST", "actions", x.cred, s)).status, 200, JSON.stringify(s));
  // The agent can't record steps for the helped computer, and nothing goes through Phase A's endpoints.
  assert.equal((await client("POST", "actions", KEY.starter, steps[1])).status, 401);
  assert.equal((await (await import("@/app/api/remote-app/[[...path]]/route")).GET(new NextRequest(`https://back-channel.app/api/remote-app/sessions/${x.sessionId}`,
    { headers: { cookie: "bc_session=cs_a" } }), { params: Promise.resolve({ path: ["sessions", x.sessionId] }) })).status, 404, "a support session is not a remote app session");
  const live = await api("GET", "invites", { cookie: "cs_a" });
  assert.deepEqual(live.body.live[0].steps.map((s: any) => s.text), [
    "Opened Printers & scanners (they allowed it).", "Looked at the screen.", "Asked to click 'Remove device', and they said no.",
    "Clicked 'Print a test page' (they allowed it).", "Tried to fill in 'Password', and stopped: that's a password field, and the helper never types passwords.",
  ]);
  assert.equal(sessionRow(x.sessionId).status, "active", "a refusal on their screen doesn't pause: they are there, and in control");
  // The agent finishes: the Lists task is done with the issuer's transcript.
  const done = await tool(KEY.starter, "bc_support_end", { support_id: x.id });
  assert.equal(done.isError, false); assert.equal(done.json.support.session.endReason, "done");
  assert.deepEqual(done.json.task, { done: true, status: "done" });
  const issuerLines: string[] = done.json.transcript.lines;
  assert.equal(issuerLines[0], "Support for Mom, through Back Channel.");
  assert.equal(issuerLines[1], "Task: Get the printer working again.");
  assert.match(issuerLines[2], /^Connected on \d{4}-\d{2}-\d{2}, \d{2}:\d{2} to \d{2}:\d{2} UTC \(1 minute\)\.$/);
  assert.deepEqual(issuerLines.slice(-2), ["Finished.", "Couldn't confirm the helper removed itself."]);
  assert.equal(tables.taskItem[0].summary, done.json.transcript.text);
  // The helped person's copyable summary: who helped as the broker asserts it, "you", never the agent's words for them.
  const theirs = await client("GET", "transcript", x.cred);
  assert.equal(theirs.body.transcript.lines[0], "Help from Skylar (skylar@bc), through Back Channel.");
  assert.ok(theirs.body.transcript.lines.includes("Asked to click 'Remove device', and you said no."));
  assert.ok(!theirs.body.transcript.text.includes("Mom") && !theirs.body.transcript.text.includes("Claude Code"));
  assert.ok(!everything().includes("hunter2"), "no value is ever stored");
  const seen = await client("GET", "session", x.cred);
  assert.equal(seen.body.session.status, "ended"); assert.equal(seen.body.steps.length, 5);
});

test("the removal receipt is signed with the pinned key, recorded once, and an unconfirmed removal is said honestly", async () => {
  const x = await allowed({ taskId: TASK });
  const receipt = (removal: string, key: Key = x.key, id = x.sessionId) => client("POST", "receipt", x.cred, { removal, proof: key.sign(`bc-support-receipt-v1:${id}:${removal}`) });
  assert.equal((await receipt("removed", p256())).body.error, "invalid_proof", "another key");
  assert.equal((await receipt("removed", x.key, crypto.randomUUID())).body.error, "invalid_proof", "another session");
  assert.equal((await receipt("deleted")).body.error, "invalid_removal");
  assert.equal(sessionRow(x.sessionId).removal, null);
  // A receipt while it runs means the helper is gone: the session ends with it.
  const lease = await supportLease(x.cred, x.key.fp);
  const ok = await receipt("removed");
  assert.equal(ok.status, 200); assert.deepEqual([ok.body.removal.kind, ok.body.removal.text], ["removed", "The helper removed itself."]);
  assert.deepEqual([sessionRow(x.sessionId).status, sessionRow(x.sessionId).endReason, sessionRow(x.sessionId).removal], ["ended", "host_stop", "removed"]);
  assert.equal(await renew(lease.body.leaseId), 404);
  assert.equal(ok.body.transcript.lines.at(-1), "The helper removed itself.");
  assert.equal((await receipt("removed")).status, 200, "the same receipt again is a no-op");
  assert.equal((await receipt("in_memory")).body.error, "receipt_recorded");
  const card = await api("GET", "invites", { cookie: "cs_a" });
  assert.equal(card.body.recent.find((i: any) => i.id === x.id).session.removalText, "The helper removed itself.");
  // Ran in memory only.
  const y = await allowed();
  await client("POST", "stop", y.cred);
  const mem = await client("POST", "receipt", y.cred, { removal: "in_memory", proof: y.key.sign(`bc-support-receipt-v1:${y.sessionId}:in_memory`) });
  assert.equal(mem.body.removal.text, "The helper ran in memory only, so there was nothing to remove.");
  // No receipt: the issuer is told it couldn't be confirmed, never that it worked; and the client may say it couldn't confirm.
  const z = await allowed();
  await person(`invites/${z.id}/stop`);
  const unconfirmed = await api("GET", `invites/${z.id}`, { cookie: "cs_a" });
  assert.equal(unconfirmed.body.support.session.removalText, "Couldn't confirm the helper removed itself.");
  const said = await client("POST", "receipt", z.cred, { removal: "unconfirmed", proof: z.key.sign(`bc-support-receipt-v1:${z.sessionId}:unconfirmed`) });
  assert.match(said.body.removal.text, /couldn't confirm it removed itself\. If you still have the file you downloaded, you can delete it\./);
  // The credential outlives the session for this, and no longer.
  sessionRow(z.sessionId).supportCredentialExpiresAt = new Date(Date.now() - 1);
  assert.equal((await client("GET", "transcript", z.cred)).status, 401);
});

test("limits: at most 3 codes outstanding, 5 minted a day, 10 requests an hour per agent; the public failure budget sheds guessing", async () => {
  for (let i = 0; i < 3; i++) assert.equal((await request()).status, 200);
  const fourth = await request();
  assert.equal(fourth.status, 409); assert.equal(fourth.body.error, "too_many_outstanding");
  // A lapsed request no longer counts.
  tables.supportInvite[0].createdAt = new Date(Date.now() - 61 * 60_000);
  assert.equal((await request()).status, 200);
  assert.equal(tables.supportInvite[0].status, "lapsed");
  // Clear them, then mint (and cancel) five codes in a day: the sixth approval is refused.
  for (const i of tables.supportInvite.filter(r => r.status === "requested")) await person(`invites/${i.id}/deny`);
  hits.clear();
  for (let i = 0; i < 5; i++) { const m = await minted(); await person(`invites/${m.id}/void`); }
  const sixth = (await request()).body.support.id;
  const refused = await person(`invites/${sixth}/approve`);
  assert.equal(refused.status, 429); assert.equal(refused.body.error, "daily_limit");
  assert.equal(inviteRow(sixth).codeHash, null);
  for (const i of tables.supportInvite) if (i.mintedAt) i.mintedAt = new Date(Date.now() - 25 * 60 * 60_000);
  assert.equal((await person(`invites/${sixth}/approve`)).status, 200, "a rolling 24 hours");
  // Requests per agent per hour: only one that created a request counts.
  hits.clear();
  for (const i of tables.supportInvite.filter(r => ["requested", "minted"].includes(r.status))) await api("POST", `invites/${i.id}/end`, { as: KEY.starter, body: { finished: false } });
  for (let i = 0; i < 10; i++) {
    if (i === 9) assert.equal((await request({ minutes: 0 })).status, 400, "a refused request doesn't spend it");
    const r = await request(); assert.equal(r.status, 200, `request ${i + 1}`);
    await api("POST", `invites/${r.body.support.id}/end`, { as: KEY.starter, body: { finished: false } });
  }
  const limitedReq = await request();
  assert.equal(limitedReq.status, 429); assert.equal(limitedReq.headers.get("retry-after"), "7");
  assert.equal((await request({}, KEY.plain)).status, 200, "per agent");
  // The public failure budget: once spent, redeem and report are shed before any database work.
  hits.set("support:public-failed:all", 300);
  const shed = await redeem("BCS-AAAA-AAAA");
  assert.equal(shed.status, 429);
});

test("a conflict re-runs the whole redemption: one session, one credential, the code consumed once", async () => {
  const m = await minted();
  transactionFaults = [abort(), abort()]; transactionCalls = 0;
  const key = p256();
  const r = await redeem(m.code, key);
  assert.equal(r.status, 200); assert.equal(transactionCalls, 3);
  assert.equal(tables.remoteAppSession.length, 1); assert.equal(sessionRow(r.body.sessionId).supportCredentialHash, sha(r.body.credential));
  assert.equal(tables.accountAudit.filter(a => a.eventType === "support.redeemed").length, 1);
  assert.equal((await redeem(m.code, p256())).status, 410);
});

test("the helper's relay lease: its own credential and pinned key only, its own budget, never a device", async () => {
  const x = await allowed();
  // Device credentials, agent keys and malformed credentials never get a support pass; a support credential is never a device credential.
  for (const cred of [CRED1, KEY.starter, "abs_short"]) assert.equal((await supportPass(cred)).status, 401, cred);
  const hostRoute = await (await import("@/app/api/appbridge/v1/hosts/self/agent-sessions/route")).GET(new NextRequest("https://back-channel.app/api/appbridge/v1/hosts/self/agent-sessions",
    { headers: { authorization: `Bearer ${x.cred}` } }));
  assert.equal(hostRoute.status, 401, "an abs_ credential is not a device");
  // Presented with another key: refused, the pass consumed.
  const issued = await supportPass(x.cred);
  const wrongKey = await (await import("@/app/api/appbridge/v1/relay/redeem/route")).POST(relayReq("redeem", { pass: issued.body.pass, purpose: "support", connectorSpkiSha256: p256().fp }));
  assert.equal(wrongKey.status, 403);
  const asAgent = await (await import("@/app/api/appbridge/v1/relay/redeem/route")).POST(relayReq("redeem", { pass: (await supportPass(x.cred)).body.pass, purpose: "agent", connectorSpkiSha256: x.key.fp }));
  assert.equal(asAgent.status, 403, "a support pass is never redeemed for another purpose");
  // With its pinned key: admitted, naming its session and its relay identity; no device anywhere in the grant.
  const lease = await supportLease(x.cred, x.key.fp);
  assert.equal(lease.status, 200);
  assert.deepEqual({ ...lease.body, leaseId: undefined }, { leaseId: undefined, accountId: "acct-a", hostDeviceId: sessionRow(x.sessionId).hostDeviceId, clientDeviceId: null, enrollmentId: null,
    hostConnectorSpkiSha256: x.key.fp, clientConnectorSpkiSha256: null, remoteAppSessionId: x.sessionId });
  assert.equal(tables.connection.length, 0, "not a device connecting: no connection-log row");
  // Its own budget: a spare for a reconnect, then refused; three phones relayed are never touched.
  const phones = ["phoneA0000000000000000", "phoneB0000000000000000", "phoneC0000000000000000"];
  for (const p of phones) tables.lease.push({ id: `lease-${p}`, purpose: "session", accountId: "acct-a", hostDeviceId: PC1, remoteDeviceId: p, enrollmentId: "enr", createdAt: new Date(), expiresAt: new Date(Date.now() + 120_000) });
  assert.equal((await supportLease(x.cred, x.key.fp)).status, 200);
  assert.equal((await supportLease(x.cred, x.key.fp)).status, 409);
  assert.equal(tables.lease.filter(l => l.purpose === "session").length, 3);
  assert.equal(await renew(lease.body.leaseId), 200);
  // The relay-wide switch and the issuer's entitlement end it at the next renewal.
  process.env.APPBRIDGE_REMOTE_ACCESS = "off";
  assert.equal(await renew(lease.body.leaseId), 403);
  process.env.APPBRIDGE_REMOTE_ACCESS = "on";
  const again = await supportLease(x.cred, x.key.fp);
  tables.entitlement[0].active = false;
  assert.equal(await renew(again.body.leaseId), 403);
});

test("MCP: invite, status and end through the tools; the agent withdraws a request or an unused code", async () => {
  const asked = await tool(KEY.starter, "bc_support_invite", { for: "Dad", task: "Set up the new scanner", minutes: 20, task_id: TASK });
  assert.equal(asked.isError, false); assert.equal(asked.json.support.status, "requested"); assert.match(asked.json.approvalUrl, /\/account\/remote\?vt=.*&support=/);
  assert.ok(!("code" in asked.json));
  const id = asked.json.support.id;
  assert.equal((await tool(KEY.other, "bc_support_status", { support_id: id })).json.error, "not_found");
  assert.equal((await tool(KEY.plain, "bc_support_status", { support_id: id })).json.error, "not_found", "only the agent that asked follows it");
  const contact = await tool(KEY.starter, "bc_support_invite", { for: "Dad", task: "Call 1-800-555-0199 to renew", minutes: 5 });
  assert.equal(contact.json.error, "no_contact_details");
  await person(`invites/${id}/approve`);
  const status = await tool(KEY.starter, "bc_support_status", { support_id: id });
  assert.equal(status.json.support.status, "minted"); assert.match(status.json.next, /sends it to Dad themselves; you never see it/);
  const withdrawn = await tool(KEY.starter, "bc_support_end", { support_id: id, finished: false });
  assert.equal(withdrawn.json.support.status, "withdrawn"); assert.deepEqual(withdrawn.json.task, { done: false, updated: true });
  assert.equal(entries().at(-1)!.body, "Withdrew the request for a support code for Dad.");
  assert.equal((await tool(KEY.starter, "bc_support_end", { support_id: id })).json.error, "already_over");
  // A request on a task the agent isn't on is refused.
  tables.taskItem[0].claimAgentId = A.plain;
  assert.equal((await tool(KEY.starter, "bc_support_invite", { for: "Dad", task: "t", minutes: 5, task_id: TASK })).json.error, "claim_first");
});

test("the dashboard card: pending requests, unused codes with their deadline, live sessions with their steps, recent ones with transcripts", async () => {
  const asked = (await request()).body.support.id;
  const unused = await minted();
  const done = await allowed();
  await api("POST", `invites/${done.id}/end`, { as: KEY.starter, body: {} });
  const live = await allowed();
  await client("POST", "actions", live.cred, { action: "observe", outcome: "ok" });
  const card = await api("GET", "invites", { cookie: "cs_a" });
  assert.equal(card.status, 200);
  assert.deepEqual(card.body.pending.map((i: any) => i.id), [asked]);
  assert.deepEqual(card.body.codes.map((i: any) => [i.id, !!i.codeExpiresAt]), [[unused.id, true]]);
  assert.deepEqual(card.body.live.map((i: any) => [i.id, i.session.status, i.steps.map((s: any) => s.text)]), [[live.id, "active", ["Looked at the screen."]]]);
  assert.deepEqual(card.body.recent.map((i: any) => [i.id, i.session.endReason, i.transcript.lines.at(-2)]), [[done.id, "done", "Finished."]]);
  assert.deepEqual(card.body.limits, { outstanding: 2, maxOutstanding: 3, mintedToday: 3, mintsPerDay: 5, maxMinutes: 45 });
  assert.equal(card.body.remoteAccess, "available");
  assert.deepEqual((await api("GET", "invites")).status, 401);
});
