/**
 * Route tests for the per-connector vault grant (docs/vault-bridge.md, step 4; src/lib/vault-grant.ts):
 * POST/DELETE /api/account/agents/:id/vault with the real passkey step-up (src/lib/step-up.ts), and what a grant opens
 * on the asking side (bc_vault_* over /api/mcp) while the worker side stays full keys only.
 * Real route files and src/lib modules, with @/lib/db, @/lib/auth and @/lib/rate-limit mocked. No Postgres needed.
 */
import { test, before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";

type Row = Record<string, any>;
const tables: Record<string, Row[]> = { account: [], agentToken: [], accountAudit: [], vaultGrant: [], accountPasskey: [], passkeyChallenge: [] };
const pick = (row: Row | undefined, select?: Record<string, boolean>) => (row && select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : row ?? null);
let vaultGrantBroken = false;
const grantTable = () => { if (vaultGrantBroken) throw new Error('relation "VaultGrant" does not exist'); return tables.vaultGrant; };
const db: any = {
  accountAudit: { create: async ({ data }: any) => { tables.accountAudit.push(structuredClone(data)); return data; } },
  agentToken: { findUnique: async ({ where, select }: any) => pick(tables.agentToken.find((a) => a.id === where.id), select) },
  accountPasskey: { count: async ({ where }: any) => tables.accountPasskey.filter((p) => p.accountId === where.accountId).length },
  passkeyChallenge: {
    updateMany: async ({ where, data }: any) => {
      const rows = tables.passkeyChallenge.filter((c) => c.grantHash === where.grantHash && c.accountId === where.accountId && c.kind === where.kind
        && c.action === where.action && c.targetId === where.targetId && c.usedAt === null && c.expiresAt > where.expiresAt.gt);
      for (const c of rows) Object.assign(c, data);
      return { count: rows.length };
    },
    findUnique: async ({ where, select }: any) => pick(tables.passkeyChallenge.find((c) => c.grantHash === where.grantHash), select),
  },
  vaultGrant: {
    findUnique: async ({ where, select }: any) => pick(grantTable().find((g) => g.agentTokenId === where.agentTokenId), select),
    findMany: async ({ where }: any) => grantTable().filter((g) => g.accountId === where.accountId),
    upsert: async ({ where, create }: any) => {
      const t = grantTable();
      const found = t.find((g) => g.agentTokenId === where.agentTokenId);
      if (found) return found;
      t.push({ ...create });
      return create;
    },
    deleteMany: async ({ where }: any) => {
      const before = grantTable().length;
      tables.vaultGrant = grantTable().filter((g) => !(g.agentTokenId === where.agentTokenId && g.accountId === where.accountId));
      return { count: before - tables.vaultGrant.length };
    },
  },
};
let limited = false;

before(() => {
  mock.module("@/lib/db", { namedExports: { prisma: db } });
  mock.module("@/lib/rate-limit", { namedExports: { rateLimit: () => ({ ok: !limited, retryAfterSec: 7 }), rateLimitPeek: () => ({ ok: !limited, retryAfterSec: 7 }), clientIp: () => "unknown" } });
  // The MCP route's wrapped REST handlers, which these tests never reach (as in vault.routetest.mts).
  const stub = { namedExports: { GET: async () => new Response("{}", { status: 200 }), POST: async () => new Response("{}", { status: 200 }) } };
  for (const m of ["@/app/api/sessions/active/route", "@/app/api/poll/route", "@/app/api/invites/route", "@/app/api/invites/[code]/claim/route", "@/app/api/inbox/request/route",
    "@/app/api/sessions/[id]/end/route", "@/app/api/scopes/route", "@/app/api/account/view-token-self/route", "@/app/api/inbox/agent-payloads/route"]) mock.module(m, stub);
  mock.module("@/lib/inbox-pending", { namedExports: { pendingCount: async () => ({ count: 0, kinds: [] }) } });
  mock.module("@/lib/auth", { namedExports: {
    getAuthContext: async (header: string | null) => {
      const m = /^Bearer (\S+)$/.exec(header ?? "");
      const a = m ? tables.agentToken.find(x => x.key === m[1] && !x.revokedAt) : null;
      return a ? { account: tables.account.find(x => x.id === a.accountId), agentTokenId: a.id, scope: a.scope } : null;
    },
    getAccountFromCookie: async (v: string | undefined) => tables.account.find((a) => v && a.cookie === v) ?? null,
    SESSION_COOKIE_NAME: "bc_session", CSRF_COOKIE_NAME: "bc_csrf", CSRF_HEADER: "x-bc-csrf",
    csrfValid: (h: string | null | undefined, c: string | null | undefined) => !!h && h === c,
    generateApiKey: () => "bc_new", hashToken: (raw: string) => createHash("sha256").update(raw).digest("hex"),
  } });
  mock.module("@/lib/onboarding", { namedExports: { seedWelcomeIfFirstConnect: async () => {} } });
});

const ID = { worker: "11111111-1111-4111-8111-111111111111", chat: "22222222-2222-4222-8222-222222222222", conn: "33333333-3333-4333-8333-333333333333",
  conn2: "44444444-4444-4444-8444-444444444444", otherConn: "55555555-5555-4555-8555-555555555555" };
const KEY = { worker: "bc_worker", chat: "bc_chat", conn: "bco_claude_ai", conn2: "bco_chatgpt", otherConn: "bco_other" };
beforeEach(async () => {
  const { _resetVaultBridge } = await import("@/lib/vault-bridge");
  _resetVaultBridge();
  limited = false;
  vaultGrantBroken = false;
  process.env.VAULT_BRIDGE = "on";
  delete process.env.APPROVAL_STEP_UP;
  tables.account = [{ id: "acct-a", handle: "a", cookie: "sess-a" }, { id: "acct-b", handle: "b", cookie: "sess-b" }];
  tables.agentToken = [
    { id: ID.worker, key: KEY.worker, accountId: "acct-a", scope: "full", name: "Home PC" },
    { id: ID.chat, key: KEY.chat, accountId: "acct-a", scope: "full", name: "Claude Code" },
    { id: ID.conn, key: KEY.conn, accountId: "acct-a", scope: "connector", name: "claude.ai" },
    { id: ID.conn2, key: KEY.conn2, accountId: "acct-a", scope: "connector", name: "ChatGPT" },
    { id: ID.otherConn, key: KEY.otherConn, accountId: "acct-b", scope: "connector", name: "claude.ai" },
  ].map((a) => ({ ...a, revokedAt: null, createdAt: new Date("2026-11-01T00:00:00Z"), lastUsedAt: null, runtimeType: "other" }));
  tables.accountAudit = [];
  tables.vaultGrant = [];
  tables.accountPasskey = [{ id: "pk-1", accountId: "acct-a" }];
  tables.passkeyChallenge = [];
});

/** A verified step-up, as POST /api/account/passkeys/step-up/verify leaves it: the grant's hash on its ceremony row. */
function stepUpGrant(action: string, targetId: string | null, accountId = "acct-a") {
  const raw = "bcsu_" + "A".repeat(38) + String(tables.passkeyChallenge.length).padStart(5, "0");
  tables.passkeyChallenge.push({ accountId, kind: "step_up", action, targetId, grantHash: createHash("sha256").update(raw).digest("hex"), passkeyId: "pk-1", usedAt: null, expiresAt: new Date(Date.now() + 60_000) });
  return raw;
}

type Res = { status: number; body: any };
async function grant(method: "POST" | "DELETE", agentId: string, o: { cookie?: string; csrf?: boolean; stepUp?: string } = {}): Promise<Res> {
  const mod = await import("@/app/api/account/agents/[id]/vault/route");
  const headers: Record<string, string> = { cookie: `bc_session=${o.cookie ?? "sess-a"}; bc_csrf=tok` };
  if (o.csrf !== false) headers["x-bc-csrf"] = "tok";
  if (o.stepUp) headers["x-bc-step-up"] = o.stepUp;
  const res = await mod[method](new NextRequest(`https://back-channel.app/api/account/agents/${agentId}/vault`, { method, headers }), { params: Promise.resolve({ id: agentId }) });
  return { status: res.status, body: await res.json() };
}
async function next(as: string, wait = 0): Promise<Res> {
  const { GET } = await import("@/app/api/vault/worker/next/route");
  const res = await GET(new NextRequest(`https://back-channel.app/api/vault/worker/next?wait=${wait}`, { headers: { authorization: `Bearer ${as}` } }));
  return { status: res.status, body: await res.json() };
}
async function result(as: string, body: unknown): Promise<Res> {
  const { POST } = await import("@/app/api/vault/worker/result/route");
  const res = await POST(new NextRequest("https://back-channel.app/api/vault/worker/result", { method: "POST", headers: { authorization: `Bearer ${as}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}
async function mcp(as: string, method: string, params?: unknown) {
  const { POST } = await import("@/app/api/mcp/route");
  const res = await POST(new NextRequest("https://back-channel.app/api/mcp", { method: "POST", headers: { authorization: `Bearer ${as}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }) }));
  return res.json();
}
const vaultNames = (r: any) => r.result.tools.map((t: { name: string }) => t.name).filter((n: string) => n.startsWith("bc_vault_")).sort();
const VAULT_NAMES = ["bc_vault_list", "bc_vault_read", "bc_vault_result", "bc_vault_search", "bc_vault_status"];

test("without a grant a connector sees no vault tools and is refused; with one it reads through the PC", async () => {
  assert.deepEqual(vaultNames(await mcp(KEY.conn, "tools/list")), []);
  const refused = await mcp(KEY.conn, "tools/call", { name: "bc_vault_status", arguments: {} });
  assert.match(refused.result.content[0].text, /^HTTP 403: .*not_available_to_connectors/);

  const on = await grant("POST", ID.conn, { stepUp: stepUpGrant("grant_vault", ID.conn) });
  assert.equal(on.status, 200);
  assert.equal(on.body.ok, true);
  assert.equal(typeof on.body.vault_grant_at, "string");
  assert.deepEqual(tables.vaultGrant.map((g) => [g.agentTokenId, g.accountId, g.passkeyId]), [[ID.conn, "acct-a", "pk-1"]]);

  assert.deepEqual(vaultNames(await mcp(KEY.conn, "tools/list")), VAULT_NAMES);
  assert.deepEqual(vaultNames(await mcp(KEY.conn2, "tools/list")), [], "a grant is for one connector only");
  const poll = next(KEY.worker, 5);
  await new Promise(r => setTimeout(r, 20));
  const call = mcp(KEY.conn, "tools/call", { name: "bc_vault_read", arguments: { path: "Projects/plan.md" } });
  const handed = (await poll).body.request;
  assert.deepEqual([handed.op, handed.args], ["read", { path: "Projects/plan.md" }]);
  await result(KEY.worker, { id: handed.id, ok: true, result: { path: "Projects/plan.md", bytes: 5, text: "plan\n" } });
  assert.deepEqual(JSON.parse((await call).result.content[0].text), { path: "Projects/plan.md", bytes: 5, text: "plan\n" });
  const read = tables.accountAudit.find((r) => r.eventType === "vault.read");
  assert.equal(read?.detail.agent, ID.conn, "the read is audited to the connector");

  // A grant never makes a connector the PC that answers.
  const asWorker = await next(KEY.conn, 0);
  assert.deepEqual([asWorker.status, asWorker.body.error], [403, "not_available_to_connectors"]);
  // The bridge switched off still closes everything.
  process.env.VAULT_BRIDGE = "off";
  assert.deepEqual(vaultNames(await mcp(KEY.conn, "tools/list")), []);
});

test("turning a grant on needs a fresh passkey step-up for exactly that connector", async () => {
  const none = await grant("POST", ID.conn);
  assert.deepEqual([none.status, none.body.error], [403, "step_up_required"]);
  assert.equal((await grant("POST", ID.conn, { stepUp: "bcsu_not-a-real-grant" })).body.error, "step_up_required");
  assert.equal((await grant("POST", ID.conn, { stepUp: stepUpGrant("grant_vault", ID.conn2) })).body.error, "step_up_required", "a grant for another connector");
  assert.equal((await grant("POST", ID.conn, { stepUp: stepUpGrant("connect_agent", null) })).body.error, "step_up_required", "a grant for another action");
  const once = stepUpGrant("grant_vault", ID.conn);
  assert.equal((await grant("POST", ID.conn, { stepUp: once })).status, 200);
  await grant("DELETE", ID.conn);
  assert.equal((await grant("POST", ID.conn, { stepUp: once })).body.error, "step_up_required", "a step-up is spent once");
  assert.equal(tables.vaultGrant.length, 0);

  tables.accountPasskey = [];
  assert.equal((await grant("POST", ID.conn, { stepUp: stepUpGrant("grant_vault", ID.conn) })).body.error, "passkey_required");
  tables.accountPasskey = [{ id: "pk-1", accountId: "acct-a" }];
  process.env.APPROVAL_STEP_UP = "off";
  const off = await grant("POST", ID.conn, { stepUp: stepUpGrant("grant_vault", ID.conn) });
  assert.deepEqual([off.status, off.body.error], [403, "step_up_off"], "never waved through with approvals off");
  assert.equal(tables.vaultGrant.length, 0);
});

test("only the account's own live connectors can be granted, signed in with CSRF", async () => {
  assert.equal((await grant("POST", ID.conn, { cookie: "nobody", stepUp: stepUpGrant("grant_vault", ID.conn) })).status, 401);
  assert.equal((await grant("POST", ID.conn, { csrf: false, stepUp: stepUpGrant("grant_vault", ID.conn) })).status, 403);
  const full = await grant("POST", ID.chat, { stepUp: stepUpGrant("grant_vault", ID.chat) });
  assert.deepEqual([full.status, full.body.error], [409, "not_a_connector"]);
  assert.equal((await grant("POST", ID.otherConn, { stepUp: stepUpGrant("grant_vault", ID.otherConn) })).status, 404, "another account's connector");
  tables.agentToken.find((a) => a.id === ID.conn2)!.revokedAt = new Date();
  assert.equal((await grant("POST", ID.conn2, { stepUp: stepUpGrant("grant_vault", ID.conn2) })).status, 404, "a revoked key");
  assert.equal(tables.vaultGrant.length, 0);
  // Account B can't turn off account A's grant either.
  await grant("POST", ID.conn, { stepUp: stepUpGrant("grant_vault", ID.conn) });
  await grant("DELETE", ID.conn, { cookie: "sess-b" });
  assert.equal(tables.vaultGrant.length, 1);
});

test("turning it off is one click, closes the vault again, and both ends are audited", async () => {
  await grant("POST", ID.conn, { stepUp: stepUpGrant("grant_vault", ID.conn) });
  const off = await grant("DELETE", ID.conn);
  assert.deepEqual(off, { status: 200, body: { ok: true, vault_grant_at: null } });
  assert.deepEqual((await grant("DELETE", ID.conn)).status, 200, "idempotent");
  assert.deepEqual(vaultNames(await mcp(KEY.conn, "tools/list")), []);
  assert.match((await mcp(KEY.conn, "tools/call", { name: "bc_vault_status", arguments: {} })).result.content[0].text, /not_available_to_connectors/);
  assert.deepEqual(tables.accountAudit.map((r) => [r.eventType, r.detail.agent_token_id]), [["vault.grant.on", ID.conn], ["vault.grant.off", ID.conn]]);
});

test("a grant table that can't be read means no grant, never an open vault", async () => {
  await grant("POST", ID.conn, { stepUp: stepUpGrant("grant_vault", ID.conn) });
  vaultGrantBroken = true;
  assert.deepEqual(vaultNames(await mcp(KEY.conn, "tools/list")), []);
  assert.match((await mcp(KEY.conn, "tools/call", { name: "bc_vault_status", arguments: {} })).result.content[0].text, /not_available_to_connectors/);
  assert.deepEqual(vaultNames(await mcp(KEY.chat, "tools/list")), VAULT_NAMES, "full keys are unaffected");
});

test("the agents list says which connectors can read the vault, and whether the bridge is on", async () => {
  db.agentToken.findMany = async ({ where }: any) => tables.agentToken.filter((a) => a.accountId === where.accountId && (where.revokedAt === undefined || a.revokedAt === where.revokedAt));
  await grant("POST", ID.conn, { stepUp: stepUpGrant("grant_vault", ID.conn) });
  const { GET } = await import("@/app/api/account/agents/route");
  const res = await GET(new NextRequest("https://back-channel.app/api/account/agents", { headers: { cookie: "bc_session=sess-a" } }));
  const body = await res.json();
  assert.equal(body.vault_bridge, "on");
  const byId = Object.fromEntries(body.agents.map((a: any) => [a.id, a]));
  assert.equal(typeof byId[ID.conn].vault_grant_at, "string");
  assert.equal(byId[ID.conn2].vault_grant_at, null);
  assert.equal(byId[ID.chat].vault_grant_at, null);
});
