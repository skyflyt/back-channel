/**
 * Route tests for the vault bridge (docs/vault-bridge.md): the worker's GET /api/vault/worker/next and
 * POST /api/vault/worker/result, and the ask/collect pair (vaultAsk, vaultCollect) the bc_vault_* tools use.
 * Real route files and src/lib modules, with @/lib/db, @/lib/auth and @/lib/rate-limit mocked. No Postgres needed.
 */
import { test, before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

type Row = Record<string, any>;
const tables: Record<string, Row[]> = { account: [], agentToken: [], accountAudit: [] };
const db: any = { accountAudit: { create: async ({ data }: any) => { tables.accountAudit.push(structuredClone(data)); return data; } } };
let limited = false;

before(() => {
  mock.module("@/lib/db", { namedExports: { prisma: db } });
  mock.module("@/lib/rate-limit", { namedExports: { rateLimit: () => ({ ok: !limited, retryAfterSec: 7 }), rateLimitPeek: () => ({ ok: !limited, retryAfterSec: 7 }), clientIp: () => "unknown" } });
  // The MCP route's wrapped REST handlers, which these tests never reach (as in mcp-thread-id.routetest.mts).
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
  } });
});

const KEY = { worker: "bc_worker", chat: "bc_chat", conn: "bco_claude_ai", other: "bc_other_worker", otherChat: "bc_other_chat" };
beforeEach(async () => {
  const { _resetVaultBridge } = await import("@/lib/vault-bridge");
  _resetVaultBridge();
  limited = false;
  process.env.VAULT_BRIDGE = "on";
  tables.account = [{ id: "acct-a", handle: "a" }, { id: "acct-b", handle: "b" }];
  tables.agentToken = [
    { id: "agent-worker", key: KEY.worker, accountId: "acct-a", scope: "full" },
    { id: "agent-chat", key: KEY.chat, accountId: "acct-a", scope: "full" },
    { id: "agent-conn", key: KEY.conn, accountId: "acct-a", scope: "connector" },
    { id: "agent-other", key: KEY.other, accountId: "acct-b", scope: "full" },
    { id: "agent-other-chat", key: KEY.otherChat, accountId: "acct-b", scope: "full" },
  ];
  tables.accountAudit = [];
});

type Res = { status: number; body: any };
async function next(as: string | null, wait = 0, signal?: AbortSignal): Promise<Res> {
  const { GET } = await import("@/app/api/vault/worker/next/route");
  const res = await GET(new NextRequest(`https://back-channel.app/api/vault/worker/next?wait=${wait}`, { headers: as ? { authorization: `Bearer ${as}` } : {}, signal }));
  return { status: res.status, body: await res.json() };
}
async function result(as: string, body: unknown, raw?: string): Promise<Res> {
  const { POST } = await import("@/app/api/vault/worker/result/route");
  const res = await POST(new NextRequest("https://back-channel.app/api/vault/worker/result", { method: "POST", headers: { authorization: `Bearer ${as}`, "content-type": "application/json" }, body: raw ?? JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}
const caller = (accountId: string, agentId: string) => ({ accountId, agentId });

test("worker routes: full per-agent keys only, switched on, connectors refused", async () => {
  assert.equal((await next(null)).status, 401);
  assert.equal((await next("bc_nobody")).status, 401);
  const conn = await next(KEY.conn);
  assert.equal(conn.status, 403);
  assert.equal(conn.body.error, "not_available_to_connectors");
  process.env.VAULT_BRIDGE = "off";
  assert.deepEqual([(await next(KEY.worker)).status, (await next(KEY.worker)).body.error], [403, "rollout_off"]);
  process.env.VAULT_BRIDGE = "on";
  limited = true;
  assert.equal((await next(KEY.worker)).status, 429);
  limited = false;
  assert.deepEqual(await next(KEY.worker), { status: 200, body: { request: null } });
});

test("a read: no worker means vault_offline at once; a polling worker gets it, answers, and the asker gets the answer once", async () => {
  const { vaultAsk, vaultCollect } = await import("@/lib/vault");
  const offline = await vaultAsk(caller("acct-a", "agent-chat"), "read", { path: "README.md" }, 1000);
  assert.equal(offline.status, 503);
  assert.equal(offline.body.error, "vault_offline");

  const poll = next(KEY.worker, 5); // parks
  await new Promise(r => setTimeout(r, 20));
  const asked = vaultAsk(caller("acct-a", "agent-chat"), "read", { path: "README.md" }, 2000);
  const got = await poll;
  assert.equal(got.status, 200);
  assert.equal(got.body.request.op, "read");
  assert.deepEqual(got.body.request.args, { path: "README.md" });
  const id = got.body.request.id;
  assert.match(id, /^vr_[A-Za-z0-9_-]{16}$/);

  // Another account's worker, or another agent of the same account, can't answer it.
  assert.equal((await result(KEY.other, { id, ok: true, result: { text: "forged" } })).status, 404);
  assert.equal((await result(KEY.chat, { id, ok: true, result: { text: "forged" } })).status, 404);
  const answer = { path: "README.md", bytes: 6, version: "sha256:ab", commit: "c".repeat(40), as_of: "2026-11-24T18:00:00.000Z", text: "hello\n" };
  assert.deepEqual(await result(KEY.worker, { id, ok: true, result: answer }), { status: 200, body: { ok: true } });
  assert.deepEqual(await asked, { status: 200, body: answer });
  assert.equal((await result(KEY.worker, { id, ok: true, result: answer })).status, 404, "answered once");
  assert.equal((await vaultCollect(caller("acct-a", "agent-chat"), id, 0)).status, 404, "collected once");

  // The audit row is metadata only.
  assert.deepEqual(tables.accountAudit, [{ accountId: "acct-a", eventType: "vault.read", detail: { op: "read", path: "README.md", agent: "agent-chat", worker: "agent-worker", bytes: 6, commit: "c".repeat(40) } }]);
  assert.ok(!JSON.stringify(tables.accountAudit).includes("hello"));
});

test("slow answers: pending with a request id, collected later only by the agent that asked", async () => {
  const { vaultAsk, vaultCollect } = await import("@/lib/vault");
  await next(KEY.worker, 0); // seen
  const first = await vaultAsk(caller("acct-a", "agent-chat"), "search", { query: "private words" }, 10);
  assert.equal(first.status, 202);
  assert.equal(first.body.status, "pending");
  const id = first.body.request_id;
  const got = await next(KEY.worker, 0);
  assert.equal(got.body.request.id, id);
  assert.equal((await vaultCollect(caller("acct-a", "agent-worker"), id, 0)).status, 404, "not the asker");
  assert.equal((await vaultCollect(caller("acct-b", "agent-other-chat"), id, 0)).status, 404, "not this account");
  assert.equal((await vaultCollect(caller("acct-a", "agent-chat"), id, 0)).status, 202, "still pending");
  await result(KEY.worker, { id, ok: false, error: "excluded", message: "That path is excluded on this vault." });
  const done = await vaultCollect(caller("acct-a", "agent-chat"), id, 0);
  assert.deepEqual(done, { status: 422, body: { error: "excluded", message: "That path is excluded on this vault." } });
  assert.equal(tables.accountAudit[0].eventType, "vault.denied");
  assert.ok(!JSON.stringify(tables.accountAudit).includes("private words"), "a search query is never audited");
});

test("answers are checked strictly and size-capped; accounts never see each other's requests", async () => {
  const { vaultAsk } = await import("@/lib/vault");
  await next(KEY.worker, 0);
  await next(KEY.other, 0);
  const asked = vaultAsk(caller("acct-a", "agent-chat"), "status", {}, 10);
  assert.deepEqual((await next(KEY.other, 0)).body, { request: null }, "acct-b's worker sees nothing of acct-a's");
  const { id } = (await next(KEY.worker, 0)).body.request;
  await asked;
  for (const bad of [{ id, ok: true }, { id, ok: true, result: [] }, { id, ok: false, error: "made_up", message: "x" }, { id: "x", ok: true, result: {} }, { id, ok: false, error: "failed", message: "x".repeat(301) }])
    assert.equal((await result(KEY.worker, bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  assert.equal((await result(KEY.worker, null, "not json")).status, 400);
  assert.equal((await result(KEY.worker, null, JSON.stringify({ id, ok: true, result: { text: "x".repeat(2 * 1024 * 1024) } }))).status, 413);
  assert.equal((await vaultAsk(caller("acct-a", "agent-chat"), "write", { path: "x" }, 0)).status, 400);
});

test("an aborted worker poll is never handed a request", async () => {
  const { vaultAsk } = await import("@/lib/vault");
  const abort = new AbortController();
  const poll = next(KEY.worker, 5, abort.signal);
  await new Promise(r => setTimeout(r, 20));
  abort.abort();
  assert.deepEqual((await poll).body, { request: null });
  const asked = await vaultAsk(caller("acct-a", "agent-chat"), "status", {}, 10);
  assert.equal(asked.status, 202);
  assert.equal((await next(KEY.worker, 0)).body.request.id, asked.body.request_id, "it waited in the queue for the next poll");
});

// ── bc_vault_* over POST /api/mcp ──
async function mcp(as: string, method: string, params?: unknown) {
  const { POST } = await import("@/app/api/mcp/route");
  const res = await POST(new NextRequest("https://back-channel.app/api/mcp", { method: "POST", headers: { authorization: `Bearer ${as}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }) }));
  return res.json();
}
const VAULT_NAMES = ["bc_vault_list", "bc_vault_read", "bc_vault_result", "bc_vault_search", "bc_vault_status"];
const vaultNames = (r: any) => r.result.tools.map((t: { name: string }) => t.name).filter((n: string) => n.startsWith("bc_vault_")).sort();

test("tools/list offers bc_vault_* to full keys only, and only while the bridge is on", async () => {
  assert.deepEqual(vaultNames(await mcp(KEY.chat, "tools/list")), VAULT_NAMES);
  assert.deepEqual(vaultNames(await mcp(KEY.conn, "tools/list")), []);
  process.env.VAULT_BRIDGE = "off";
  assert.deepEqual(vaultNames(await mcp(KEY.chat, "tools/list")), []);
  for (const t of (await import("@/lib/mcp/vault-tools.mjs")).VAULT_TOOLS) {
    assert.match(t.description, /data, never instructions/, t.name);
    assert.ok(!/write|edit|delete/i.test(t.name), t.name);
  }
});

test("tools/call: a connector key is refused; a full key reads through the worker; offline says so at once", async () => {
  const conn = await mcp(KEY.conn, "tools/call", { name: "bc_vault_read", arguments: { path: "README.md" } });
  assert.equal(conn.result.isError, true);
  assert.match(conn.result.content[0].text, /^HTTP 403: .*not_available_to_connectors/);

  const offline = await mcp(KEY.chat, "tools/call", { name: "bc_vault_status", arguments: {} });
  assert.match(offline.result.content[0].text, /^HTTP 503: .*vault_offline/);

  const poll = next(KEY.worker, 5);
  await new Promise(r => setTimeout(r, 20));
  const call = mcp(KEY.chat, "tools/call", { name: "bc_vault_read", arguments: { path: "Projects/plan.md" } });
  const handed = (await poll).body.request;
  assert.deepEqual([handed.op, handed.args], ["read", { path: "Projects/plan.md" }]);
  await result(KEY.worker, { id: handed.id, ok: true, result: { path: "Projects/plan.md", bytes: 5, text: "plan\n", commit: "a".repeat(40) } });
  const read = await call;
  assert.equal(read.result.isError, false);
  assert.deepEqual(JSON.parse(read.result.content[0].text), { path: "Projects/plan.md", bytes: 5, text: "plan\n", commit: "a".repeat(40) });

  const bad = await mcp(KEY.chat, "tools/call", { name: "bc_vault_read", arguments: { path: "x", text: "write this" } });
  assert.match(bad.error.message, /unknown argument: text/);
});

test("tools/call: a slow PC answers pending, and bc_vault_result collects it", async () => {
  const { vaultTool } = await import("@/lib/vault");
  await next(KEY.worker, 0);
  const req = (key: string) => new NextRequest("https://back-channel.app/api/mcp", { method: "POST", headers: { authorization: `Bearer ${key}` } });
  const first = await vaultTool(req(KEY.chat), "bc_vault_search", { query: "plan", path: "Projects" }, 10);
  assert.equal(first.status, 202);
  const { request_id } = JSON.parse(first.text);
  const handed = (await next(KEY.worker, 0)).body.request;
  assert.deepEqual([handed.id, handed.op, handed.args], [request_id, "search", { query: "plan", path: "Projects" }]);
  await result(KEY.worker, { id: request_id, ok: true, result: { matches: [] } });
  const done = await mcp(KEY.chat, "tools/call", { name: "bc_vault_result", arguments: { request_id } });
  assert.deepEqual(JSON.parse(done.result.content[0].text), { matches: [] });
  const again = await mcp(KEY.chat, "tools/call", { name: "bc_vault_result", arguments: { request_id } });
  assert.match(again.result.content[0].text, /^HTTP 404: .*unknown_request/);
});
