/**
 * Route tests for remote app sessions (docs/remote-app-sessions.md): /api/remote-app/*, the bc_remote_* MCP
 * tools, the PC's own routes under /api/appbridge/v1/hosts/self/agent-sessions, and the "agent" relay lease
 * they gate. The real route files and src/lib modules run against an in-memory Prisma (enough of the query
 * surface for remote-app.ts, appbridge.ts and lists.ts), with @/lib/auth and @/lib/rate-limit mocked. No
 * Postgres needed. mock.module() is called once per specifier, in before(); tests drive the closured state.
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
        case "not": return x === null ? val !== null && val !== undefined : x instanceof Date ? !(val instanceof Date && val.getTime() === x.getTime()) : val !== x;
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
function table(name: string, defaults: () => Row = () => ({})) {
  tables[name] = [];
  const rows = () => tables[name];
  return {
    findUnique: async ({ where }: any) => copy(rows().find(r => matches(r, where))),
    findFirst: async ({ where, orderBy }: any = {}) => copy(order(rows().filter(r => matches(r, where)), orderBy)[0]),
    findMany: async ({ where, orderBy, take }: any = {}) => order(rows().filter(r => matches(r, where)), orderBy).slice(0, take ?? Infinity).map(r => ({ ...r })),
    count: async ({ where }: any = {}) => rows().filter(r => matches(r, where)).length,
    create: async ({ data }: any) => { const r = { ...defaults(), ...data }; rows().push(r); return { ...r }; },
    update: async ({ where, data }: any) => { const r = rows().find(x => matches(x, where)); if (!r) throw new Error("not found"); return { ...Object.assign(r, data) }; },
    updateMany: async ({ where, data }: any) => { const hit = rows().filter(r => matches(r, where)); hit.forEach(r => Object.assign(r, data)); return { count: hit.length }; },
    deleteMany: async ({ where }: any) => { const keep = rows().filter(r => !matches(r, where)); const count = rows().length - keep.length; tables[name] = keep; return { count }; },
  };
}
let logSeq = 0n;
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
  remoteAppSession: table("remoteAppSession", () => ({ id: crypto.randomUUID(), createdAt: new Date(), executorAgentId: null, listTaskId: null, consentBy: null, consentVia: null,
    startedAt: null, expiresAt: null, endedAt: null, endReason: null, summary: null, evidenceRef: null })),
  remoteAppActionLog: table("actionLog", () => ({ id: ++logSeq, at: new Date(), target: null, evidenceRef: null })),
  taskList: table("taskList"),
  taskListMember: table("taskListMember"),
  taskListAgentGrant: table("taskListAgentGrant"),
  taskItem: table("taskItem"),
  taskEntry: table("taskEntry", () => ({ id: crypto.randomUUID(), createdAt: new Date(), eventType: null, authorAgentId: null })),
  // Lists Phase 2 (sharing): every Lists operation now checks friendship, OKs, mentions and reactions.
  trustedPeer: table("trustedPeer"),
  taskAgentOk: table("taskAgentOk", () => ({ createdAt: new Date(), viaAgentId: null })),
  taskMention: table("taskMention", () => ({ id: crypto.randomUUID(), createdAt: new Date(), agentId: null, seenAt: null })),
  taskReaction: table("taskReaction", () => ({ createdAt: new Date(), agentId: null })),
  taskListEvent: table("taskListEvent", () => ({ id: crypto.randomUUID(), createdAt: new Date() })),
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
    // Like the real one: a live AgentToken by its key, with its scope.
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
const A = { starter: "a0000000-0000-4000-8000-000000000001", exec: "a0000000-0000-4000-8000-000000000002", plain: "a0000000-0000-4000-8000-000000000003",
  conn: "a0000000-0000-4000-8000-000000000004", other: "a0000000-0000-4000-8000-000000000005" };
const KEY = { starter: "bc_starter", exec: "bc_exec", plain: "bc_plain", conn: "bco_conn", other: "bc_other" };
const PC1 = "pcShop000000000000000A", PC2 = "pcOffice00000000000000", PC3 = "pcOther000000000000000";
const CRED1 = "ab_" + "A".repeat(43), CRED2 = "ab_" + "B".repeat(43), CRED3 = "ab_" + "C".repeat(43);
const FP1 = "A1".repeat(32), FP2 = "B2".repeat(32), FP3 = "C3".repeat(32);
const LIST = "b0000000-0000-4000-8000-000000000001", TASK = "c0000000-0000-4000-8000-000000000001";
const relayKeys = generateKeyPairSync("ed25519");
const RELAY_PUBLIC_KEY = relayKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const HOST_SCOPES = ["appbridge.device", "appbridge.host.relay", "appbridge.relay.presence"];

function reset() {
  for (const k of Object.keys(tables)) tables[k] = [];
  limited = false; hits.clear(); transactionFaults = []; transactionCalls = 0;
  process.env.APPBRIDGE_REMOTE_ACCESS = "on";
  process.env.APPBRIDGE_RELAY_PUBLIC_KEY = RELAY_PUBLIC_KEY;
  const now = new Date();
  tables.account.push(
    { id: "acct-a", handle: "skylar@bc", displayName: "Skylar", cookie: "cs_a", emailVerifiedAt: now },
    { id: "acct-b", handle: "other@bc", displayName: "Other", cookie: "cs_b", emailVerifiedAt: now },
  );
  const agent = (id: string, key: string, accountId: string, name: string, over: Row = {}) =>
    ({ id, key, accountId, name, scope: "full", revokedAt: null, runtimeType: "other", dispatchName: null, dispatchEncryptionKey: null, dispatchSigningKey: null, createdAt: now, ...over });
  tables.agentToken.push(
    agent(A.starter, KEY.starter, "acct-a", "Claude Code"),
    agent(A.exec, KEY.exec, "acct-a", "Shop agent", { dispatchName: "shop-pc", dispatchEncryptionKey: "x25519-pem", dispatchSigningKey: "ed25519-pem" }),
    agent(A.plain, KEY.plain, "acct-a", "Laptop Codex"),
    agent(A.conn, KEY.conn, "acct-a", "claude.ai", { scope: "connector" }),
    agent(A.other, KEY.other, "acct-b", "Other's agent"),
  );
  for (const accountId of ["acct-a", "acct-b"]) tables.entitlement.push({ accountId, feature: "appbridge.remote_access", active: true, updatedAt: now });
  const pc = (id: string, accountId: string, label: string, fp: string, cred: string) => {
    tables.device.push({ id, accountId, role: "host", label, connectorSpki: "", connectorSpkiSha256: fp, enabled: true, relayEnabled: true, createdAt: now, revokedAt: null });
    tables.credential.push({ keyHash: sha(cred), deviceId: id, accountId, scopes: [...HOST_SCOPES], createdAt: now, expiresAt: new Date(Date.now() + 86_400_000), revokedAt: null, replacesKeyHash: null });
  };
  pc(PC1, "acct-a", "Shop-PC", FP1, CRED1); pc(PC2, "acct-a", "Office PC", FP2, CRED2); pc(PC3, "acct-b", "Their PC", FP3, CRED3);
  tables.taskList.push({ id: LIST, ownerAccountId: "acct-a", name: "Work", emoji: null, archivedAt: null, createdAt: now, updatedAt: now });
  tables.taskListMember.push({ listId: LIST, accountId: "acct-a", role: "owner", agentsTakeFrom: "me", addedByAccountId: "acct-a", joinedAt: now });
  tables.taskListAgentGrant.push({ listId: LIST, agentTokenId: A.starter, accountId: "acct-a", access: "work", createdAt: now });
  tables.taskItem.push({ id: TASK, listId: LIST, title: "Enter this week's supplier invoices", notes: "", version: 1, status: "in_progress", position: 1024, dueAt: null,
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
  const req = new NextRequest(`https://back-channel.app/api/remote-app/${path}`, { method, headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
  const mod = await import("@/app/api/remote-app/[[...path]]/route");
  const res = await mod[method](req, { params: Promise.resolve({ path: path.split("/").filter(Boolean) }) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
const person = (path: string, o: { cookie?: string; csrf?: boolean } = {}) => api("POST", path, { cookie: "cs_a", ...o });
const startBody = (over: Row = {}) => ({ host: "Shop-PC", apps: ["QuickBooks"], minutes: 30, goal: "Enter this week's supplier invoices", taskId: TASK, ...over });
async function start(over: Row = {}, as = KEY.starter): Promise<Res> { return api("POST", "sessions", { as, body: startBody(over) }); }
async function startApproved(over: Row = {}): Promise<string> {
  const r = await start(over); assert.equal(r.status, 200, JSON.stringify(r.body));
  const ok = await person(`sessions/${r.body.session.id}/approve`); assert.equal(ok.status, 200, JSON.stringify(ok.body));
  return r.body.session.id;
}
const step = (id: string, body: Row, as = KEY.exec) => api("POST", `sessions/${id}/actions`, { as, body });
const sessionRow = (id: string) => tables.remoteAppSession.find(s => s.id === id)!;
const entries = () => tables.taskEntry.filter(e => e.taskId === TASK);
// The PC (ab_ credential) and the relay (Ed25519-signed).
function deviceReq(path: string, cred: string, body?: unknown, method = "POST") {
  return new NextRequest(`https://back-channel.app/api/appbridge/v1/${path}`, { method, headers: { authorization: `Bearer ${cred}`, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
function relayReq(route: "redeem" | "renew", body: unknown) {
  const path = `/api/appbridge/v1/relay/${route}`; const raw = JSON.stringify(body);
  const seconds = String(Math.floor(Date.now() / 1000)); const nonce = randomBytes(16).toString("base64url");
  const sig = sign(null, Buffer.from(`appbridge-relay-broker-v1\nPOST\n${path}\n${seconds}\n${nonce}\n${sha(raw)}`), relayKeys.privateKey).toString("base64url");
  return new NextRequest(`https://back-channel.app${path}`, { method: "POST", body: raw, headers: { "content-type": "application/json", authorization: `AppBridge-Relay v1.${seconds}.${nonce}.${sig}` } });
}
async function agentLease(sessionId: string, cred = CRED1, fp = FP1): Promise<Res> {
  const issued = await (await import("@/app/api/appbridge/v1/relay/agent-passes/route")).POST(deviceReq("relay/agent-passes", cred, { sessionId }));
  if (issued.status !== 200) return { status: issued.status, body: await issued.json(), headers: issued.headers };
  const r = await (await import("@/app/api/appbridge/v1/relay/redeem/route")).POST(relayReq("redeem", { pass: (await issued.json()).pass, purpose: "agent", connectorSpkiSha256: fp }));
  return { status: r.status, body: await r.json(), headers: r.headers };
}
async function renew(leaseId: string) { return (await (await import("@/app/api/appbridge/v1/relay/renew/route")).POST(relayReq("renew", { leaseId }))).status; }
async function hostSessions(cred = CRED1) {
  const r = await (await import("@/app/api/appbridge/v1/hosts/self/agent-sessions/route")).GET(deviceReq("hosts/self/agent-sessions", cred, undefined, "GET"));
  return { status: r.status, body: await r.json() };
}
async function hostStop(id: string, cred = CRED1) {
  const r = await (await import("@/app/api/appbridge/v1/hosts/self/agent-sessions/[id]/stop/route")).POST(deviceReq(`hosts/self/agent-sessions/${id}/stop`, cred), { params: Promise.resolve({ id }) });
  return r.status;
}
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
const SECRET = /^abx_[A-Za-z0-9_-]{43}$/;
const REMOTE_TOOLS = ["bc_remote_machines", "bc_remote_session_start", "bc_remote_session_status", "bc_remote_app_open", "bc_remote_observe", "bc_remote_act", "bc_remote_session_end"];

// ── Tests ──

test("full-scope agent keys only: a connector key is refused everywhere, and tools/list never offers it the bc_remote_* tools", async () => {
  const id = crypto.randomUUID();
  const calls: Array<[("GET" | "POST"), string, unknown?]> = [["GET", "machines"], ["GET", "sessions"], ["POST", "sessions", startBody()], ["GET", `sessions/${id}`],
    ["POST", `sessions/${id}/actions`, { action: "invoke", target: "Save", outcome: "ok" }], ["POST", `sessions/${id}/end`, { summary: "x" }], ["POST", `sessions/${id}/stop`]];
  for (const [m, path, body] of calls) {
    const r = await api(m, path, { as: KEY.conn, body });
    assert.equal(r.status, 403, `${m} ${path}`); assert.equal(r.body.error, "not_available_to_connectors"); assert.equal(r.headers.get("cache-control"), "no-store");
  }
  assert.equal((await api("GET", "machines", { as: "bc_nobody" })).status, 401);
  assert.equal(tables.remoteAppSession.length, 0);
  const names = async (key: string) => (await mcp(key, "tools/list")).result.tools.map((t: { name: string }) => t.name) as string[];
  const hosted = await names(KEY.conn);
  assert.deepEqual(hosted.filter(n => n.startsWith("bc_remote_")), [], "a connector key is never offered a remote tool");
  assert.ok(hosted.includes("bc_tasks") && !hosted.includes("bc_dashboard_link"));
  assert.deepEqual((await names(KEY.starter)).filter(n => n.startsWith("bc_remote_")), REMOTE_TOOLS, "a full key gets all of them");
  const called = await tool(KEY.conn, "bc_remote_session_start", { host: "Shop-PC", apps: ["QuickBooks"], minutes: 5, goal: "g" });
  assert.equal(called.isError, true); assert.match(called.text, /HTTP 403/); assert.equal(called.json.error, "not_available_to_connectors");
  assert.equal(tables.remoteAppSession.length, 0);
});

test("consent: start returns awaiting_consent and a one-tap approval link; only the person, in the dashboard with CSRF, approves", async () => {
  const r = await start();
  assert.equal(r.status, 200); assert.equal(r.headers.get("cache-control"), "no-store");
  const id = r.body.session.id;
  assert.equal(r.body.session.status, "awaiting_consent");
  assert.deepEqual(r.body.session.pc, { hostDeviceId: PC1, label: "Shop-PC" });
  assert.deepEqual(r.body.session.task, { id: TASK, title: "Enter this week's supplier invoices" });
  const url = new URL(r.body.approvalUrl);
  assert.equal(`${url.origin}${url.pathname}`, "https://back-channel.app/account/remote");
  assert.equal(url.searchParams.get("approve"), id);
  const vt = url.searchParams.get("vt")!;
  assert.deepEqual(tables.viewToken.map(v => [v.token, v.accountId, v.usedAt]), [[sha(vt), "acct-a", null]], "a single-use sign-in, stored hashed");
  assert.ok(!JSON.stringify(tables, (_, v) => typeof v === "bigint" ? String(v) : v).includes(vt), "the raw link token is never stored");
  assert.match(r.body.next, /approvalUrl/); assert.match(r.body.next, /don't open it yourself/);
  assert.deepEqual(Object.fromEntries(Object.entries(sessionRow(id)).filter(([k]) => ["status", "consentVia", "startedAt", "expiresAt", "listTaskId", "executorAgentId"].includes(k))),
    { status: "awaiting_consent", consentVia: null, startedAt: null, expiresAt: null, listTaskId: TASK, executorAgentId: null });
  // Nothing happens before approval: no steps, no relay lease.
  assert.equal((await step(id, { action: "invoke", target: "Save", outcome: "ok" }, KEY.starter)).body.error, "not_approved");
  assert.deepEqual((await agentLease(id)).body, { error: "session_inactive" });
  // An agent never approves, with or without a cookie riding along; the dashboard needs CSRF; another account sees nothing.
  for (const o of [{ as: KEY.starter }, { as: KEY.exec }, { as: KEY.starter, cookie: "cs_a" }]) {
    const no = await api("POST", `sessions/${id}/approve`, o);
    assert.equal(no.status, 403); assert.equal(no.body.error, "people_only");
  }
  assert.equal((await person(`sessions/${id}/approve`, { csrf: false })).body.error, "csrf");
  assert.equal((await person(`sessions/${id}/approve`, { cookie: "cs_b" })).status, 404);
  assert.equal((await api("POST", `sessions/${id}/approve`)).status, 401);
  assert.equal(sessionRow(id).status, "awaiting_consent");
  const ok = await person(`sessions/${id}/approve`);
  assert.equal(ok.status, 200); assert.equal(ok.body.session.status, "active");
  const row = sessionRow(id);
  assert.equal(row.consentBy, "acct-a"); assert.equal(row.consentVia, "web");
  assert.equal(row.expiresAt.getTime() - row.startedAt.getTime(), 30 * 60_000, "exactly the minutes approved");
  assert.equal((await person(`sessions/${id}/approve`)).body.error, "already_decided");
  assert.deepEqual(entries().map(e => [e.kind, e.authorAgentId, e.body]), [
    ["progress", A.starter, "Asked to use QuickBooks on Shop-PC for 30 minutes. Waiting for approval."],
    ["progress", null, "Approved Claude Code to use QuickBooks on Shop-PC for 30 minutes."],
  ]);
  assert.deepEqual(tables.accountAudit.map(a => a.eventType), ["remote_app.requested", "remote_app.approved"]);
});

test("denial and expiry are final: a denied or lapsed request never starts", async () => {
  const first = (await start()).body.session.id;
  const denied = await person(`sessions/${first}/deny`);
  assert.equal(denied.status, 200); assert.equal(denied.body.session.status, "denied");
  assert.equal((await person(`sessions/${first}/approve`)).body.error, "already_decided");
  const seen = await api("GET", `sessions/${first}`, { as: KEY.starter });
  assert.equal(seen.body.session.status, "denied"); assert.match(seen.body.next, /new approval/);
  assert.equal((await step(first, { action: "invoke", target: "Save", outcome: "ok" }, KEY.starter)).body.error, "session_over");
  assert.ok(entries().some(e => e.authorAgentId === null && e.body === "Said no to using QuickBooks on Shop-PC."));
  // Ten minutes with no answer: the request lapses, for good.
  const second = (await start()).body.session.id;
  sessionRow(second).createdAt = new Date(Date.now() - 10 * 60_000 - 1);
  const late = await person(`sessions/${second}/approve`);
  assert.equal(late.status, 410); assert.equal(late.body.error, "request_expired");
  assert.equal(sessionRow(second).status, "lapsed", "written, not just reported");
  assert.equal((await person(`sessions/${second}/deny`)).status, 410);
  assert.equal((await api("GET", `sessions/${second}`, { cookie: "cs_a" })).body.session.status, "lapsed");
});

test("one agent session per account at a time, waiting or running; another account has its own", async () => {
  const first = (await start()).body.session.id;
  const busy = await start({ host: "Office PC", taskId: undefined }, KEY.plain);
  assert.equal(busy.status, 409); assert.equal(busy.body.error, "session_in_progress");
  await person(`sessions/${first}/approve`);
  assert.equal((await start({ taskId: undefined }, KEY.plain)).body.error, "session_in_progress", "running counts too");
  assert.equal((await api("POST", "sessions", { as: KEY.other, body: startBody({ host: "Their PC", taskId: undefined }) })).status, 200, "another account is unaffected");
  assert.equal((await person(`sessions/${first}/stop`)).body.session.status, "ended");
  assert.equal((await start({ host: "Office PC", taskId: undefined }, KEY.plain)).status, 200, "free again once it ended");
  assert.equal(tables.remoteAppSession.filter(s => s.accountId === "acct-a" && ["awaiting_consent", "active", "blocked"].includes(s.status)).length, 1);
});

test("scope at start: minutes cap, app allow-list shape, the PC, the task claim and the driving agent", async () => {
  const refusal = async (over: Row, as = KEY.starter) => { const r = await start(over, as); return [r.status, r.body.error]; };
  assert.deepEqual(await refusal({ minutes: 61 }), [400, "invalid_minutes"]);
  assert.deepEqual(await refusal({ minutes: 0 }), [400, "invalid_minutes"]);
  assert.deepEqual(await refusal({ minutes: 12.5 }), [400, "invalid_minutes"]);
  assert.deepEqual(await refusal({ apps: ["*"] }), [400, "invalid_apps"]);
  assert.deepEqual(await refusal({ apps: ["C:\\Windows\\regedit.exe"] }), [400, "invalid_apps"]);
  assert.deepEqual(await refusal({ apps: Array.from({ length: 9 }, (_, i) => `App ${i}`) }), [400, "invalid_apps"]);
  assert.deepEqual(await refusal({ goal: "" }), [400, "invalid_goal"]);
  assert.deepEqual(await refusal({ host: "Nope" }), [404, "no_such_pc"]);
  assert.deepEqual(await refusal({ host: PC3 }), [404, "no_such_pc"], "another account's PC does not exist here");
  tables.device.find(d => d.id === PC2)!.relayEnabled = false;
  assert.deepEqual(await refusal({ host: "Office PC" }), [409, "internet_access_off"]);
  process.env.APPBRIDGE_REMOTE_ACCESS = "off";
  assert.deepEqual(await refusal({}), [403, "rollout_off"]);
  process.env.APPBRIDGE_REMOTE_ACCESS = "on";
  tables.entitlement.find(e => e.accountId === "acct-a")!.active = false;
  assert.deepEqual(await refusal({}), [403, "not_entitled"]);
  tables.entitlement.find(e => e.accountId === "acct-a")!.active = true;
  assert.deepEqual(await refusal({ taskId: crypto.randomUUID() }), [404, "not_available"]);
  assert.deepEqual(await refusal({}, KEY.plain), [404, "not_available"], "a task on a list this agent can't see");
  tables.taskListAgentGrant.push({ listId: LIST, agentTokenId: A.plain, accountId: "acct-a", access: "work", createdAt: new Date() });
  assert.deepEqual(await refusal({}, KEY.plain), [409, "claim_first"], "it can see it, but isn't on it");
  assert.deepEqual(await refusal({ executor: "Laptop Codex", taskId: undefined }), [400, "executor_not_reachable"], "not a Dispatch worker");
  assert.deepEqual(await refusal({ executor: A.conn, taskId: undefined }), [400, "executor_not_allowed"], "a hosted connector never drives a PC");
  assert.deepEqual(await refusal({ executor: A.other, taskId: undefined }), [404, "no_such_executor"], "another account's agent");
  assert.equal(tables.remoteAppSession.length, 0, "nothing was created by any refusal");
  const ok = await start({ executor: "shop agent", apps: ["QuickBooks", "quickbooks", "Excel"] });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.session.apps, ["QuickBooks", "Excel"]);
  assert.deepEqual(ok.body.session.drivenBy, { agentId: A.exec, name: "Shop agent" });
});

test("an app off the allow-list is not_in_scope: recorded, the session pauses, and the PC's lease ends in the same transaction", async () => {
  const id = await startApproved({ executor: A.exec });
  const lease = await agentLease(id);
  assert.equal(lease.status, 200);
  const r = await step(id, { action: "open", target: "Outlook", outcome: "ok" });
  assert.equal(r.status, 409); assert.equal(r.body.error, "not_in_scope"); assert.equal(r.body.recorded, true);
  assert.equal(r.body.session.status, "blocked"); assert.equal(r.body.session.pausedBecause, "that's outside the apps you approved");
  assert.deepEqual(tables.actionLog.map(l => [l.action, l.target, l.outcome]), [["open", "Outlook", "not_in_scope"]]);
  assert.equal(tables.lease.length, 0, "paused: the agent lease is gone");
  assert.equal(await renew(lease.body.leaseId), 404);
  assert.equal(entries().at(-1)!.body, "Shop agent: Tried to open Outlook on Shop-PC, and stopped: that's outside the apps you approved.");
  assert.equal((await step(id, { action: "invoke", target: "Save", outcome: "ok" })).body.error, "paused", "no more steps until the person says go on");
  assert.equal((await api("POST", `sessions/${id}/resume`, { as: KEY.starter })).body.error, "people_only");
  const resumed = await person(`sessions/${id}/resume`);
  assert.equal(resumed.body.session.status, "active");
  assert.equal((await agentLease(id)).status, 200, "the PC may hold a lease again");
  assert.equal((await step(id, { action: "open", target: "quickbooks", outcome: "ok" })).status, 200, "on the list (case doesn't matter)");
});

test("stop from the dashboard, the agent that asked, the agent driving or the PC: final, and the leases go in the same transaction", async () => {
  const cases: Array<[string, (id: string) => Promise<number>, string]> = [
    ["person", async id => (await person(`sessions/${id}/stop`)).status, "user_stop"],
    ["starter", async id => (await api("POST", `sessions/${id}/stop`, { as: KEY.starter })).status, "agent_stop"],
    ["driver", async id => (await api("POST", `sessions/${id}/stop`, { as: KEY.exec })).status, "agent_stop"],
    ["host", async id => hostStop(id), "host_stop"],
  ];
  for (const [who, stop, reason] of cases) {
    const id = await startApproved({ executor: A.exec });
    const lease = await agentLease(id); assert.equal(lease.status, 200, who);
    const status = await stop(id);
    assert.equal(status, who === "host" ? 204 : 200, who);
    assert.deepEqual([sessionRow(id).status, sessionRow(id).endReason], ["ended", reason], who);
    assert.equal(tables.lease.filter(l => l.remoteAppSessionId === id).length, 0, `${who}: leases deleted with the stop`);
    assert.equal(await renew(lease.body.leaseId), 404, `${who}: the relay's next renewal ends it`);
    assert.equal(await stop(id), who === "host" ? 204 : 200, `${who}: stopping again is a no-op`);
    assert.equal(sessionRow(id).endReason, reason, `${who}: and changes nothing`);
    assert.deepEqual((await agentLease(id)).body, { error: "session_inactive" }, `${who}: a stopped session never reopens`);
  }
  // Stop is atomic: a conflict re-runs it whole, and an outage changes neither the session nor its lease.
  const id = await startApproved();
  const lease = await agentLease(id);
  transactionFaults = Array.from({ length: 5 }, abort); transactionCalls = 0;
  const outage = await person(`sessions/${id}/stop`);
  assert.equal(outage.status, 503); assert.equal(outage.body.error, "busy"); assert.equal(transactionCalls, 5);
  assert.equal(sessionRow(id).status, "active"); assert.equal(tables.lease.length, 1, "nothing half-done");
  transactionFaults = [abort()]; transactionCalls = 0;
  assert.equal((await person(`sessions/${id}/stop`)).status, 200); assert.equal(transactionCalls, 2);
  assert.equal(sessionRow(id).status, "ended"); assert.equal(tables.lease.length, 0);
  assert.equal(await renew(lease.body.leaseId), 404);
  // Only this account's people and this session's agents can stop it; only its own PC can, from the PC.
  const next = await startApproved();
  assert.equal((await api("POST", `sessions/${next}/stop`, { as: KEY.plain })).status, 404);
  assert.equal((await api("POST", `sessions/${next}/stop`, { as: KEY.other })).status, 404);
  assert.equal((await person(`sessions/${next}/stop`, { cookie: "cs_b" })).status, 404);
  assert.equal(await hostStop(next, CRED2), 404, "another PC");
  assert.equal(await hostStop(next, "ab_" + "Z".repeat(43)), 401);
  assert.equal(sessionRow(next).status, "active");
});

test("lease renewal is refused once the session's time is up, and the session ends on its own", async () => {
  const id = await startApproved();
  const lease = await agentLease(id);
  assert.equal(await renew(lease.body.leaseId), 200);
  sessionRow(id).expiresAt = new Date(Date.now() - 1);
  assert.equal(await renew(lease.body.leaseId), 403);
  assert.equal(tables.lease.length, 0);
  const seen = await api("GET", `sessions/${id}`, { as: KEY.starter });
  assert.deepEqual([seen.body.session.status, seen.body.session.endReason], ["ended", "lapsed"]);
  assert.deepEqual([sessionRow(id).status, sessionRow(id).endReason], ["ended", "lapsed"], "settled in the database");
  assert.equal((await start({ taskId: undefined })).status, 200, "and the account is free for the next one");
});

test("the agent budget never evicts a device: three phones relayed, and the PC's agent lease is admitted beside them", async () => {
  const id = await startApproved();
  const phones = ["phoneA0000000000000000", "phoneB0000000000000000", "phoneC0000000000000000"];
  for (const p of phones) tables.lease.push({ id: `lease-${p}`, purpose: "session", accountId: "acct-a", hostDeviceId: PC1, remoteDeviceId: p, enrollmentId: "enr", createdAt: new Date(), expiresAt: new Date(Date.now() + 120_000) });
  const lease = await agentLease(id);
  assert.equal(lease.status, 200);
  assert.deepEqual(tables.lease.filter(l => l.purpose === "session").map(l => l.remoteDeviceId), phones, "every phone keeps its connection");
  assert.equal((await person(`sessions/${id}/stop`)).status, 200);
  assert.deepEqual(tables.lease.map(l => l.purpose), ["session", "session", "session"], "and stopping the session takes only its own lease");
});

test("steps are bounded, only the driving agent records them, and each is mirrored into the Lists task as a fixed phrase", async () => {
  const id = await startApproved({ executor: A.exec });
  assert.equal((await step(id, { action: "invoke", target: "Save", outcome: "ok" }, KEY.starter)).body.error, "not_driver");
  assert.equal((await step(id, { action: "invoke", target: "Save", outcome: "ok" }, KEY.plain)).status, 404);
  assert.equal((await step(id, { action: "invoke", target: "Save", outcome: "ok" }, KEY.other)).status, 404);
  for (const bad of [{ action: "set_value", target: "Amount", outcome: "ok", value: "1,200.00" }, { action: "type", target: "Amount", outcome: "ok" },
    { action: "invoke", outcome: "ok" }, { action: "key", target: "VK_LWIN", outcome: "ok" }, { action: "screenshot", outcome: "ok" }, { action: "invoke", target: "Save", outcome: "great" }]) {
    assert.equal((await step(id, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(tables.actionLog.length, 0, "nothing invalid is recorded");
  const claimBefore = tables.taskItem[0].claimExpiresAt.getTime();
  const before = entries().length;
  const ok = await step(id, { action: "invoke", target: "Save", outcome: "ok" });
  assert.equal(ok.status, 200); assert.equal(ok.body.step.text, "Clicked 'Save' on Shop-PC."); assert.deepEqual(ok.body.task, { updated: true });
  const mirrored = entries().at(-1)!;
  assert.deepEqual([mirrored.kind, mirrored.authorAccountId, mirrored.authorAgentId, mirrored.body], ["progress", "acct-a", A.starter, "Shop agent: Clicked 'Save' on Shop-PC."]);
  assert.equal(entries().length, before + 1);
  assert.ok(tables.taskItem[0].claimExpiresAt.getTime() > claimBefore, "each step keeps the claim alive");
  const long = await step(id, { action: "invoke", target: "x".repeat(300), outcome: "ok" });
  assert.equal(long.status, 200); assert.equal([...tables.actionLog.at(-1)!.target].length, 120, "a control name is bounded to 120 characters");
  const pw = await step(id, { action: "set_value", target: "Password", outcome: "credential_field" });
  assert.equal(pw.status, 200); assert.equal(pw.body.session.status, "blocked"); assert.match(pw.body.next, /Don't work around it/);
  assert.equal(entries().at(-1)!.body, "Shop agent: Tried to fill in 'Password' on Shop-PC, and stopped: that's a password field, and agents never type passwords.");
  const seen = await api("GET", `sessions/${id}`, { as: KEY.starter });
  assert.equal(seen.body.session.pausedBecause, "that's a password field, and agents never type passwords");
  assert.deepEqual(seen.body.actions.map((a: any) => a.outcome), ["ok", "ok", "credential_field"]);
  const stored = JSON.stringify(tables, (_, v) => typeof v === "bigint" ? String(v) : v);
  assert.ok(!stored.includes("1,200.00"), "no value is ever stored");
});

test("bc_remote_app_open, bc_remote_observe and bc_remote_act say not_available_yet and never pretend", async () => {
  const pending = (await start()).body.session.id;
  const early = await tool(KEY.starter, "bc_remote_observe", { remote_session_id: pending });
  assert.equal(early.isError, true); assert.equal(early.json.error, "not_approved");
  await person(`sessions/${pending}/approve`);
  const entriesBefore = entries().length;
  for (const [name, args] of [["bc_remote_app_open", { app: "QuickBooks" }], ["bc_remote_observe", {}], ["bc_remote_act", { ref: "e1", action: "invoke" }],
    ["bc_remote_act", { ref: "e2", action: "set_value", value: "hunter2" }]] as Array<[string, Row]>) {
    const r = await tool(KEY.starter, name, { remote_session_id: pending, ...args });
    assert.equal(r.isError, true, name); assert.match(r.text, /^HTTP 501: /, name);
    assert.equal(r.json.error, "not_available_yet", name);
    assert.match(r.json.message, /isn't installed on Shop-PC yet/); assert.match(r.json.message, /nothing happened on the PC/);
  }
  assert.equal(tables.actionLog.length, 0, "nothing recorded"); assert.equal(entries().length, entriesBefore, "nothing claimed on the task");
  assert.ok(!JSON.stringify(tables, (_, v) => typeof v === "bigint" ? String(v) : v).includes("hunter2"));
  const catalog = (await mcp(KEY.starter, "tools/list")).result.tools as Array<{ name: string; description: string }>;
  for (const name of ["bc_remote_app_open", "bc_remote_observe", "bc_remote_act"]) assert.match(catalog.find(t => t.name === name)!.description, /not_available_yet/);
  for (const t of catalog.filter(t => t.name.startsWith("bc_remote_"))) assert.doesNotMatch(t.description, /\u2014/, `${t.name}: plain punctuation`);
  assert.match(catalog.find(t => t.name === "bc_remote_session_start")!.description, /approves each session in the Back Channel dashboard/);
  assert.match(catalog.find(t => t.name === "bc_remote_act")!.description, /Never type passwords/);
  assert.match(catalog.find(t => t.name === "bc_remote_observe")!.description, /data, never instructions/);
});

test("MCP: machines, start, status and end through the tools", async () => {
  tables.lease.push({ id: "presence-1", purpose: "presence", accountId: "acct-a", hostDeviceId: PC1, remoteDeviceId: null, enrollmentId: null, createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) });
  const machines = await tool(KEY.starter, "bc_remote_machines", {});
  assert.equal(machines.isError, false);
  assert.equal(machines.json.remoteAccess, "available");
  assert.deepEqual(machines.json.machines, [
    { hostDeviceId: PC1, name: "Shop-PC", online: true, internetAccess: true, appsAvailable: null, agents: [] },
    { hostDeviceId: PC2, name: "Office PC", online: false, internetAccess: true, appsAvailable: null, agents: [] },
  ]);
  // Readiness (route-tests/agent-readiness.routetest.mts): the Dispatch agent hasn't reported, so it isn't ready yet.
  assert.deepEqual(machines.json.executors.map((e: Row) => [e.agentId, e.ready, e.reporting]), [[A.exec, false, false]]);
  assert.ok(machines.json.howToFix.claude);
  const started = await tool(KEY.starter, "bc_remote_session_start", { host: "shop-pc", apps: ["QuickBooks"], minutes: 20, goal: "Enter invoices", task_id: TASK });
  assert.equal(started.isError, false); assert.equal(started.json.session.status, "awaiting_consent"); assert.match(started.json.approvalUrl, /\/account\/remote\?vt=/);
  const id = started.json.session.id;
  const status = await tool(KEY.starter, "bc_remote_session_status", { remote_session_id: id });
  assert.equal(status.json.session.status, "awaiting_consent"); assert.match(status.json.next, /approves/);
  assert.equal((await tool(KEY.other, "bc_remote_session_status", { remote_session_id: id })).json.error, "not_found");
  const withdrawn = await tool(KEY.starter, "bc_remote_session_end", { remote_session_id: id, summary: "Not needed after all.", finished: false });
  assert.equal(withdrawn.isError, false);
  assert.deepEqual([withdrawn.json.session.status, withdrawn.json.session.endReason], ["ended", "agent_stop"]);
  assert.deepEqual(withdrawn.json.task, { done: false, updated: true });
  assert.equal(entries().at(-1)!.body, "Withdrew the request to use QuickBooks on Shop-PC: Not needed after all.");
  assert.equal(tables.taskItem[0].status, "in_progress", "not finished, so the task stays open");
});

test("the whole Phase A loop with a fake executor: start, approve, Dispatch hand-off, the PC's lease, steps, a pause, go on, end, Lists done", async () => {
  // 1. The agent that asked names the agent on the PC as the driver.
  const started = await start({ executor: A.exec, minutes: 15 });
  assert.equal(started.status, 200);
  const id = started.body.session.id;
  assert.deepEqual(started.body.session.startedBy, { agentId: A.starter, name: "Claude Code" });
  // The PC shows nothing until the person approves.
  assert.deepEqual((await hostSessions()).body, { sessions: [] });
  // 2. The person approves in the dashboard.
  assert.equal((await person(`sessions/${id}/approve`)).status, 200);
  // 3. The starter is told exactly how to hand the session over with Dispatch.
  const handOff = await api("GET", `sessions/${id}`, { as: KEY.starter });
  assert.match(handOff.body.next, /Dispatch/); assert.match(handOff.body.next, new RegExp(`targetAgentId ${A.exec}`));
  assert.match(handOff.body.next, new RegExp(`remoteAppSessionId "${id}"`)); assert.match(handOff.body.next, /profile "remote-app"/);
  assert.ok(!("executorSecret" in handOff.body.session), "the agent that asked never gets the executor's secret");
  // (Here the starter submits the sealed Dispatch task: dispatch.routetest.mts covers that path. The broker
  // can't seal for agents, so the payload's reference to this session is the starter's to write.)
  // 4. The fake executor reads its session, as the driver.
  const mine = await api("GET", `sessions/${id}`, { as: KEY.exec });
  assert.equal(mine.status, 200); assert.deepEqual(mine.body.session.apps, ["QuickBooks"]); assert.match(mine.body.next, /Work only in QuickBooks on Shop-PC/);
  // v1.1: its first read hands it the executor secret, once, for the hello on the PC's agent-control pipe.
  const secret: string = mine.body.session.executorSecret;
  assert.match(secret, SECRET); assert.match(mine.body.next, /shown this once/);
  assert.deepEqual((await api("GET", "sessions", { as: KEY.exec })).body.sessions.map((s: any) => s.id), [id]);
  // 5. The PC sees the running session for its banner, and holds an agent lease for it.
  const banner = await hostSessions();
  assert.equal(banner.status, 200);
  assert.deepEqual(Object.keys(banner.body.sessions[0]).sort(), ["apps", "drivenBy", "executorSecretSha256", "expiresAt", "goal", "id", "startedAt", "startedBy", "status", "task"]);
  assert.equal(banner.body.sessions[0].executorSecretSha256, sha(secret), "the PC checks the executor's hello against its hash");
  assert.deepEqual([banner.body.sessions[0].id, banner.body.sessions[0].task, banner.body.sessions[0].drivenBy], [id, "Enter this week's supplier invoices", "Shop agent"]);
  assert.deepEqual((await hostSessions(CRED2)).body, { sessions: [] }, "another PC sees nothing");
  const bcKey = await (await import("@/app/api/appbridge/v1/hosts/self/agent-sessions/route")).GET(deviceReq("hosts/self/agent-sessions", KEY.exec, undefined, "GET"));
  assert.equal(bcKey.status, 401, "an agent key is never a device credential");
  const first = await agentLease(id);
  assert.equal(first.status, 200); assert.equal(first.body.remoteAppSessionId, id);
  // 6. It works, step by step.
  assert.equal((await step(id, { action: "open", target: "QuickBooks", outcome: "ok" })).status, 200);
  assert.equal((await step(id, { action: "invoke", target: "Enter Bills", outcome: "ok" })).status, 200);
  assert.equal((await step(id, { action: "set_value", target: "Amount due", outcome: "ok" })).status, 200);
  // 7. A sign-in appears: it fails closed and asks; the lease ends with the pause.
  const asked = await step(id, { action: "blocked", outcome: "needs_user" });
  assert.equal(asked.body.session.status, "blocked");
  assert.equal(await renew(first.body.leaseId), 404);
  assert.deepEqual((await hostSessions()).body.sessions.map((s: any) => [s.status, s.pausedBecause]), [["blocked", "it needs you at the PC"]]);
  // 8. The person signs in at the PC and says go on; the PC takes a new lease.
  assert.equal((await person(`sessions/${id}/resume`)).body.session.status, "active");
  const second = await agentLease(id);
  assert.equal(second.status, 200); assert.equal(await renew(second.body.leaseId), 200);
  assert.equal((await step(id, { action: "invoke", target: "Save & Close", outcome: "ok" })).status, 200);
  assert.equal((await step(id, { action: "screenshot", outcome: "ok", evidenceRef: "audit:2026-10-09:0042" })).status, 200);
  // 9. The executor ends it with a summary and the pointer to the evidence the PC kept.
  const ended = await api("POST", `sessions/${id}/end`, { as: KEY.exec, body: { summary: "Entered 3 supplier bills in QuickBooks and saved them; the totals match the invoices.", evidenceRef: "audit:2026-10-09:0042" } });
  assert.equal(ended.status, 200);
  assert.deepEqual([ended.body.session.status, ended.body.session.endReason, ended.body.session.evidenceRef], ["ended", "done", "audit:2026-10-09:0042"]);
  assert.deepEqual(ended.body.task, { done: true, status: "done" });
  assert.equal(tables.lease.length, 0); assert.equal(await renew(second.body.leaseId), 404);
  // The task is done, by the agent that held it, with the summary and the evidence pointer (never the evidence).
  const task = tables.taskItem[0];
  assert.deepEqual([task.status, task.completedByAgentId], ["done", A.starter]);
  assert.equal(task.summary, "Entered 3 supplier bills in QuickBooks and saved them; the totals match the invoices.\n\nEvidence: kept on Shop-PC: audit:2026-10-09:0042");
  assert.deepEqual(entries().filter(e => e.kind === "progress").map(e => e.body), [
    "Asked to use QuickBooks on Shop-PC for 15 minutes. Waiting for approval.",
    "Approved Claude Code to use QuickBooks on Shop-PC for 15 minutes.",
    "Shop agent: Opened QuickBooks on Shop-PC.",
    "Shop agent: Clicked 'Enter Bills' on Shop-PC.",
    "Shop agent: Filled in 'Amount due' on Shop-PC.",
    "Shop agent: Stopped and asked on Shop-PC: it needs you at the PC.",
    "Said the remote session can go on.",
    "Shop agent: Clicked 'Save & Close' on Shop-PC.",
    "Shop agent: Saved a screenshot on Shop-PC (kept on the PC).",
  ]);
  // 10. The dashboard shows it among the recent sessions, with every step as a fixed phrase.
  const card = await api("GET", "sessions", { cookie: "cs_a" });
  assert.deepEqual([card.body.pending.length, card.body.live.length], [0, 0]);
  assert.equal(card.body.recent[0].id, id); assert.equal(card.body.recent[0].statusText, "finished");
  assert.deepEqual(card.body.recent[0].actions.map((a: any) => a.text), [
    "Opened QuickBooks.", "Clicked 'Enter Bills'.", "Filled in 'Amount due'.", "Stopped and asked: it needs you at the PC.", "Clicked 'Save & Close'.", "Saved a screenshot (kept on the PC).",
  ]);
  // It's over for everyone: no more steps, no ending twice, no lease.
  assert.equal((await step(id, { action: "invoke", target: "Save", outcome: "ok" })).body.error, "session_over");
  assert.equal((await api("POST", `sessions/${id}/end`, { as: KEY.exec, body: { summary: "again" } })).body.error, "session_over");
  assert.deepEqual((await agentLease(id)).body, { error: "session_inactive" });
  assert.deepEqual(tables.accountAudit.map(a => a.eventType), ["remote_app.requested", "remote_app.approved", "remote_app.paused", "remote_app.resumed", "remote_app.ended"]);
});

test("ending without finishing: agent_stop while running, fail_closed after it stopped to ask; a Lists refusal never undoes the end", async () => {
  const first = await startApproved();
  assert.equal((await api("POST", `sessions/${first}/end`, { cookie: "cs_a", body: { summary: "x" } })).body.error, "agent_key_required", "the person stops, the agent ends");
  assert.equal((await api("POST", `sessions/${first}/end`, { as: KEY.starter, body: {} })).body.error, "invalid_summary");
  assert.equal((await api("POST", `sessions/${first}/end`, { as: KEY.starter, body: { summary: "x", finished: "no" } })).body.error, "invalid_finished");
  const early = await api("POST", `sessions/${first}/end`, { as: KEY.starter, body: { summary: "The vendor portal was down, so I stopped.", finished: false } });
  assert.deepEqual([early.body.session.status, early.body.session.endReason, early.body.task], ["ended", "agent_stop", { done: false, updated: true }]);
  assert.equal(entries().at(-1)!.body, "Ended the remote session on Shop-PC without finishing: The vendor portal was down, so I stopped.");
  assert.equal(tables.taskItem[0].status, "in_progress", "the task stays with the agent, open");
  const second = await startApproved();
  assert.equal((await step(second, { action: "blocked", outcome: "fail_closed" }, KEY.starter)).body.session.status, "blocked");
  const gaveUp = await api("POST", `sessions/${second}/end`, { as: KEY.starter, body: { summary: "An update dialog I didn't expect; stopping.", finished: false } });
  assert.equal(gaveUp.body.session.endReason, "fail_closed");
  // Finished, but the task's claim moved to someone else meanwhile: the session still ends; the task says why it wasn't marked done.
  const third = await startApproved();
  Object.assign(tables.taskItem[0], { claimAgentId: A.plain });
  const done = await api("POST", `sessions/${third}/end`, { as: KEY.starter, body: { summary: "Entered the invoices." } });
  assert.equal(done.status, 200); assert.equal(done.body.session.endReason, "done");
  assert.equal(done.body.task.done, false); assert.match(done.body.task.why, /already on this/);
  assert.equal(tables.taskItem[0].status, "in_progress");
});

test("the dashboard card lists waiting, running and recent sessions; Stop all ends every one", async () => {
  const waiting = (await start({ taskId: undefined })).body.session.id;
  let card = await api("GET", "sessions", { cookie: "cs_a" });
  assert.deepEqual(card.body.pending.map((s: any) => [s.id, s.status, s.goal, s.minutes, s.startedBy.name, s.pc.label]), [[waiting, "awaiting_consent", "Enter this week's supplier invoices", 30, "Claude Code", "Shop-PC"]]);
  assert.ok(card.body.pending[0].approvalExpiresAt);
  assert.equal((await api("GET", "sessions", { cookie: "cs_b" })).body.pending.length, 0, "another account sees none");
  await person(`sessions/${waiting}/approve`);
  await step(waiting, { action: "open", target: "QuickBooks", outcome: "ok" }, KEY.starter);
  card = await api("GET", "sessions", { cookie: "cs_a" });
  assert.deepEqual(card.body.live.map((s: any) => [s.id, s.actions.map((a: any) => a.text)]), [[waiting, ["Opened QuickBooks."]]]);
  const lease = await agentLease(waiting);
  assert.equal((await api("POST", "stop-all", { as: KEY.starter })).body.error, "people_only");
  assert.equal((await person("stop-all", { csrf: false })).body.error, "csrf");
  const all = await person("stop-all");
  assert.deepEqual(all.body, { stopped: 1 });
  assert.equal(await renew(lease.body.leaseId), 404);
  card = await api("GET", "sessions", { cookie: "cs_a" });
  assert.deepEqual([card.body.live.length, card.body.recent[0].statusText], [0, "stopped by you"]);
  assert.deepEqual((await person("stop-all")).body, { stopped: 0 }, "nothing left to stop");
});

test("revoking an agent: its waiting request can't be approved, and a running session's PC lease ends at the next renewal", async () => {
  const waiting = (await start({ executor: A.exec })).body.session.id;
  tables.agentToken.find(a => a.id === A.exec)!.revokedAt = new Date();
  const refused = await person(`sessions/${waiting}/approve`);
  assert.equal(refused.status, 409); assert.equal(refused.body.error, "agent_unavailable");
  assert.equal((await person(`sessions/${waiting}/deny`)).status, 200);
  tables.agentToken.find(a => a.id === A.exec)!.revokedAt = null;
  const id = await startApproved({ executor: A.exec });
  const lease = await agentLease(id);
  tables.agentToken.find(a => a.id === A.starter)!.revokedAt = new Date();
  assert.equal(await renew(lease.body.leaseId), 403, "the agent that asked is gone");
  assert.equal(tables.lease.length, 0);
  assert.equal((await step(id, { action: "invoke", target: "Save", outcome: "ok" }, KEY.starter)).status, 401);
});

test("a conflict re-runs the whole start once: one session, one approval link, one audit row; rate limits count once", async () => {
  transactionFaults = [abort(), abort()]; transactionCalls = 0;
  const r = await start();
  assert.equal(r.status, 200); assert.equal(transactionCalls, 3);
  assert.equal(tables.remoteAppSession.length, 1); assert.equal(tables.viewToken.length, 1);
  assert.equal(tables.accountAudit.length, 1); assert.equal(entries().length, 1);
  assert.equal(hits.get(`remote-app:start:${A.starter}`), 1); assert.equal(hits.get(`remote-app:write:${A.starter}`), 1);
  limited = true;
  const shut = await api("GET", "machines", { as: KEY.starter });
  assert.equal(shut.status, 429); assert.equal(shut.headers.get("retry-after"), "7");
});

// ── v1.1: the executor secret (vault design/support-relay-contract.md §2.3 and §5) ──

test("v1.1 executor secret: born as a hash, handed out once to the executor while the session runs; the PC's list carries the hash; rotation recovers a lost reply", async () => {
  const started = await start({ executor: A.exec });
  const id = started.body.session.id;
  const born = sessionRow(id).executorSecretHash;
  assert.match(born, /^[0-9a-f]{64}$/); assert.equal(sessionRow(id).executorSecretIssuedAt ?? null, null);
  assert.ok(!JSON.stringify(started.body).includes("abx_"), "never at start");
  assert.ok(!("executorSecret" in (await api("GET", `sessions/${id}`, { as: KEY.exec })).body.session), "nothing before approval");
  await person(`sessions/${id}/approve`);
  // The agent that asked (another drives) and the person never get it, and their reads never spend it.
  for (const o of [{ as: KEY.starter }, { cookie: "cs_a" }]) {
    const r = await api("GET", `sessions/${id}`, o);
    assert.equal(r.status, 200); assert.ok(!JSON.stringify(r.body).includes("abx_"));
  }
  assert.ok(!JSON.stringify((await api("GET", "sessions", { cookie: "cs_a" })).body).includes("abx_"));
  assert.equal(sessionRow(id).executorSecretIssuedAt ?? null, null);
  // The PC sees the hash the session was born with (no hello can match it) until the executor is handed its own.
  assert.equal((await hostSessions()).body.sessions[0].executorSecretSha256, born);
  const first = await api("GET", `sessions/${id}`, { as: KEY.exec });
  const secret: string = first.body.session.executorSecret;
  assert.match(secret, SECRET);
  assert.equal(sessionRow(id).executorSecretHash, sha(secret)); assert.notEqual(sha(secret), born);
  assert.ok(sessionRow(id).executorSecretIssuedAt instanceof Date);
  assert.equal((await hostSessions()).body.sessions[0].executorSecretSha256, sha(secret));
  // Once means once: the same read, the MCP tool and the executor's list never show it again.
  assert.ok(!("executorSecret" in (await api("GET", `sessions/${id}`, { as: KEY.exec })).body.session));
  const viaTool = await tool(KEY.exec, "bc_remote_session_status", { remote_session_id: id });
  assert.equal(viaTool.isError, false); assert.ok(!viaTool.text.includes("abx_"));
  assert.ok(!JSON.stringify((await api("GET", "sessions", { as: KEY.exec })).body).includes("abx_"));
  assert.ok(!JSON.stringify(tables, (_, v) => typeof v === "bigint" ? String(v) : v).includes(secret), "never stored");
  // A lost reply: only the executor rotates it.
  assert.equal((await api("POST", `sessions/${id}/executor-secret`, { as: KEY.starter })).body.error, "not_driver");
  assert.equal((await person(`sessions/${id}/executor-secret`)).body.error, "agent_key_required");
  assert.equal((await api("POST", `sessions/${id}/executor-secret`, { as: KEY.plain })).status, 404);
  assert.equal((await api("POST", `sessions/${id}/executor-secret`, { as: KEY.conn })).body.error, "not_available_to_connectors");
  assert.equal(sessionRow(id).executorSecretHash, sha(secret), "no refusal changed it");
  const rotated = await api("POST", `sessions/${id}/executor-secret`, { as: KEY.exec });
  assert.equal(rotated.status, 200); assert.equal(rotated.headers.get("cache-control"), "no-store");
  const fresh: string = rotated.body.session.executorSecret;
  assert.match(fresh, SECRET); assert.notEqual(fresh, secret);
  assert.match(rotated.body.next, /shown this once/);
  assert.equal((await hostSessions()).body.sessions[0].executorSecretSha256, sha(fresh), "the old one stops working at the PC's next read");
  assert.deepEqual(tables.accountAudit.filter(a => a.eventType === "remote_app.executor_secret_rotated").map(a => a.detail), [{ sessionId: id }]);
  assert.ok(!("executorSecret" in (await api("GET", `sessions/${id}`, { as: KEY.exec })).body.session));
  // Paused is still running; over is over; a request not approved yet has nothing to rotate.
  assert.equal((await step(id, { action: "blocked", outcome: "needs_user" })).body.session.status, "blocked");
  assert.equal((await api("POST", `sessions/${id}/executor-secret`, { as: KEY.exec })).status, 200);
  await person(`sessions/${id}/stop`);
  assert.equal((await api("POST", `sessions/${id}/executor-secret`, { as: KEY.exec })).body.error, "session_over");
  const waiting = (await start({ taskId: undefined })).body.session.id;
  assert.equal((await api("POST", `sessions/${waiting}/executor-secret`, { as: KEY.starter })).body.error, "not_approved");
});

test("v1.1: an agent driving its own session is its executor; a v1 session (no hash) never gets a secret, and its PC asks for none", async () => {
  const own = await startApproved({ taskId: undefined });
  // Its chat side (the MCP tool) never gets the secret and never spends it: only its worker's own read does.
  const chat = await tool(KEY.starter, "bc_remote_session_status", { remote_session_id: own });
  assert.equal(chat.isError, false); assert.ok(!chat.text.includes("abx_"));
  assert.equal(sessionRow(own).executorSecretIssuedAt ?? null, null);
  const read = await api("GET", `sessions/${own}`, { as: KEY.starter });
  assert.match(read.body.session.executorSecret, SECRET);
  assert.equal(sessionRow(own).executorSecretHash, sha(read.body.session.executorSecret));
  await person(`sessions/${own}/stop`);
  // A session created before the migration: no hash. Reads never upgrade it; the PC's list says null (v1: no secret).
  const v1 = await startApproved({ executor: A.exec, taskId: undefined });
  Object.assign(sessionRow(v1), { executorSecretHash: null, executorSecretIssuedAt: null });
  const old = await api("GET", `sessions/${v1}`, { as: KEY.exec });
  assert.equal(old.status, 200); assert.ok(!("executorSecret" in old.body.session)); assert.doesNotMatch(old.body.next, /executor-secret/);
  assert.equal(sessionRow(v1).executorSecretHash, null);
  assert.equal((await hostSessions()).body.sessions[0].executorSecretSha256, null);
  assert.equal((await api("POST", `sessions/${v1}/executor-secret`, { as: KEY.exec })).body.error, "no_executor_secret");
  assert.equal(sessionRow(v1).executorSecretHash, null);
});

test("v1.1: a conflict re-runs the hand-out whole: handed out once, and the reply carries the value that committed", async () => {
  const id = await startApproved({ executor: A.exec });
  transactionFaults = [abort()]; transactionCalls = 0;
  const r = await api("GET", `sessions/${id}`, { as: KEY.exec });
  assert.equal(r.status, 200); assert.equal(transactionCalls, 2);
  assert.equal(sessionRow(id).executorSecretHash, sha(r.body.session.executorSecret));
  assert.equal((await hostSessions()).body.sessions[0].executorSecretSha256, sha(r.body.session.executorSecret));
});
