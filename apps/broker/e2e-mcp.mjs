// Verify the MCP connector end-to-end against a running dev server:
// dashboard token mint (cookie+CSRF), then the full JSON-RPC surface at
// POST /api/mcp — initialize / ping / notifications / tools/list — and a real
// two-account thread driven ENTIRELY through MCP tools/call:
// create invite → claim → send → check inbox → read (mark_read) → end.
//   node e2e-mcp.mjs          (BC_BASE defaults to http://localhost:3300)
import { PrismaClient } from "@prisma/client";
import { randomBytes, createHash } from "node:crypto";

const prisma = new PrismaClient();
const BASE = process.env.BC_BASE || "http://localhost:3300";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const tag = randomBytes(3).toString("hex");
let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}: ${m}`); };

async function seed(h) {
  const a = await prisma.account.create({ data: { email: `${h}-${tag}@bc`, handle: `${h}-${tag}@bc`, emailVerifiedAt: new Date() } });
  const raw = "cs_" + randomBytes(24).toString("base64url");
  const csrf = randomBytes(8).toString("hex");
  await prisma.sessionCookie.create({ data: { token: hash(raw), accountId: a.id, expiresAt: new Date(Date.now() + 36e5) } });
  return { ...a, cookie: `bc_session=${raw}; bc_csrf=${csrf}`, csrf };
}

let rpcId = 0;
const rpc = (key, method, params) =>
  fetch(`${BASE}/api/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, ...(params ? { params } : {}) }),
  });

async function call(key, name, args) {
  const r = await rpc(key, "tools/call", { name, arguments: args ?? {} });
  const j = await r.json();
  const text = j.result?.content?.[0]?.text ?? "";
  let data = null;
  try { data = JSON.parse(text.replace(/^HTTP \d+: /, "")); } catch { /* non-JSON text */ }
  return { http: r.status, isError: j.result?.isError, text, data, raw: j };
}

async function main() {
  const vis = await seed("mcp-vis"), host = await seed("mcp-host");
  const ids = [vis.id, host.id];
  console.log(`BASE=${BASE}  ${vis.handle} <-> ${host.handle}\n`);

  // ── Dashboard token mint ────────────────────────────────────────────────
  let r = await fetch(`${BASE}/api/account/agents`, { method: "POST", headers: { cookie: vis.cookie, "x-bc-csrf": vis.csrf, "content-type": "application/json" }, body: JSON.stringify({ agent_name: "MCP e2e (visitor)", runtime_type: "cowork" }) });
  let j = await r.json();
  ok(r.status === 200 && j.api_key?.startsWith("bc_"), "mint: returns raw bc_ key once");
  const visKey = j.api_key;
  const stored = await prisma.agentToken.findUnique({ where: { keyHash: hash(visKey) } });
  ok(stored && stored.name === "MCP e2e (visitor)" && stored.runtimeType === "cowork", "mint: AgentToken row stored by hash w/ name+runtime");

  r = await fetch(`${BASE}/api/account/agents`, { method: "POST", headers: { cookie: vis.cookie, "content-type": "application/json" }, body: "{}" });
  ok(r.status === 403, "mint: missing CSRF header -> 403");

  r = await fetch(`${BASE}/api/account/agents`, { method: "POST", headers: { cookie: host.cookie, "x-bc-csrf": host.csrf, "content-type": "application/json" }, body: JSON.stringify({ agent_name: "MCP e2e (host)" }) });
  const hostKey = (await r.json()).api_key;
  ok(!!hostKey, "mint: second account minted");

  // ── Protocol surface ────────────────────────────────────────────────────
  r = await rpc("bc_bogus_key_000", "initialize", {});
  ok(r.status === 401, "mcp: bad bearer -> HTTP 401");

  r = await rpc(visKey, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  j = await r.json();
  ok(r.status === 200 && j.result?.protocolVersion === "2025-06-18" && j.result?.serverInfo?.name === "back-channel", "mcp: initialize negotiates version + serverInfo");

  r = await fetch(`${BASE}/api/mcp`, { method: "POST", headers: { authorization: `Bearer ${visKey}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  ok(r.status === 202, "mcp: notification -> 202 empty");

  r = await rpc(visKey, "ping");
  j = await r.json();
  ok(r.status === 200 && JSON.stringify(j.result) === "{}", "mcp: ping is a REQUEST -> empty result (not 202)");

  r = await rpc(visKey, "resources/list");
  j = await r.json();
  ok(j.error?.code === -32601, "mcp: unsupported method -> -32601");

  r = await rpc(visKey, "tools/list");
  j = await r.json();
  const tools = j.result?.tools ?? [];
  ok(tools.length === 10 && tools.every((t) => t.name.startsWith("bc_")), `mcp: tools/list -> 10 bc_ tools (got ${tools.length})`);

  let c = await call(visKey, "bc_nope", {});
  ok(c.raw.error?.code === -32602, "mcp: unknown tool -> -32602");
  c = await call(visKey, "bc_read_messages", { session_id: "x" });
  ok(c.raw.error?.code === -32602, "mcp: missing required arg -> -32602");

  r = await fetch(`${BASE}/api/mcp`, { headers: { authorization: `Bearer ${visKey}` } });
  ok(r.status === 405, "mcp: GET -> 405");

  // ── Real thread, driven entirely through tools/call ────────────────────
  c = await call(visKey, "bc_whoami");
  ok(!c.isError && c.data?.handle === vis.handle && c.data?.agent_name === "MCP e2e (visitor)", "tool: bc_whoami sees handle + own agent identity");

  c = await call(visKey, "bc_list_scopes");
  ok(!c.isError && Array.isArray(c.data?.scopes) && c.data.scopes.length > 0, "tool: bc_list_scopes");

  c = await call(visKey, "bc_create_invite", { host_handle: host.handle, scopes: ["config.read"], message: "e2e hello", ttl_minutes: 30 });
  ok(!c.isError && c.data?.code?.startsWith("BC-") && c.data?.session_id, "tool: bc_create_invite -> code + session");
  const code = c.data.code, sessionId = c.data.session_id;

  c = await call(hostKey, "bc_claim_invite", { code: code.toLowerCase() });
  ok(!c.isError && c.data?.session_id === sessionId && c.data?.visitor_handle === vis.handle, "tool: bc_claim_invite (case-normalized) -> same session");

  c = await call(visKey, "bc_send_message", { session_id: sessionId, role: "visitor", frame: { type: "msg", text: "hello from MCP e2e" } });
  ok(!c.isError && typeof c.data?.sent_seq === "number" && !("frames" in (c.data ?? {})), "tool: bc_send_message -> sent_seq, backlog stripped");

  c = await call(hostKey, "bc_check_inbox");
  let ses = c.data?.sessions?.find((s) => s.id === sessionId);
  ok(!c.isError && ses?.role === "host" && ses?.unread_count === 1 && !("frames" in (ses ?? {})), "tool: bc_check_inbox -> unread 1, metadata only");

  c = await call(hostKey, "bc_read_messages", { session_id: sessionId, role: "host" });
  const frame = c.data?.frames?.map((f) => { try { return JSON.parse(f); } catch { return null; } }).find((f) => f?.type === "msg");
  ok(!c.isError && frame?.text === "hello from MCP e2e", "tool: bc_read_messages -> plaintext frame readable");

  c = await call(hostKey, "bc_check_inbox");
  ses = c.data?.sessions?.find((s) => s.id === sessionId);
  ok(ses?.unread_count === 0, "tool: read with mark_read acks -> unread back to 0");

  c = await call(hostKey, "bc_dashboard_link", {});
  ok(!c.isError && c.data?.view_url?.includes("/account?vt="), "tool: bc_dashboard_link -> view_url");

  c = await call(visKey, "bc_end_session", { session_id: sessionId });
  ok(!c.isError && c.data?.ok === true, "tool: bc_end_session");

  c = await call(hostKey, "bc_check_inbox");
  ok(!(c.data?.sessions ?? []).some((s) => s.id === sessionId), "tool: ended session gone from inbox");

  // wrapped-route error surfaces as isError, not protocol error
  c = await call(visKey, "bc_request_session", { peer_handle: "nobody-" + tag + "@bc", scopes: ["config.read"] });
  ok(c.isError && c.text.includes("not_available") && !c.raw.error, "tool: opaque route errors surface as isError result");

  // ── Cleanup ─────────────────────────────────────────────────────────────
  await prisma.frame.deleteMany({ where: { sessionId } }).catch(() => {});
  await prisma.session.deleteMany({ where: { invite: { visitorAccountId: { in: ids } } } });
  await prisma.invite.deleteMany({ where: { visitorAccountId: { in: ids } } });
  await prisma.account.deleteMany({ where: { id: { in: ids } } });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
