/**
 * Route tests for POST /api/mcp's thread-id handling on the per-thread tools
 * (bc_read_messages / bc_send_message / bc_end_session) and the session_id
 * label on bc_check_inbox.
 *
 * Field report, 2026-10-05: an agent's bc_read_messages failed "session_id
 * missing" on every call while it believed it was sending one, so it never
 * received the peer's handshake and could not send either. Nothing between the
 * bridge and this route drops arguments, so the id was lost or renamed before
 * the call got here. These tests pin the three things that make that
 * recoverable: aliases are accepted, the canonical name reaches /api/poll, and
 * a call with no id gets an error that names the spelling to retry with.
 *
 * Same harness as mcp-check-inbox-wait.routetest.mts: the REAL route file,
 * with auth/db and the wrapped route handlers mocked (each mock.module
 * specifier registered exactly once, in before()).
 */
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

const ACCOUNT = { id: "acct-1", handle: "tester@bc", displayName: "Tester" };

let pollBodies: Record<string, unknown>[] = [];
let endedIds: string[] = [];
let sessionsActiveBody: unknown;

before(() => {
  process.env.PUBLIC_APP_URL = "https://back-channel.app";
  mock.module("@/lib/auth", {
    namedExports: {
      getAuthContext: async (header: string | null) =>
        header === "Bearer good" ? { account: ACCOUNT, agentTokenId: null } : null,
    },
  });
  mock.module("@/lib/db", { namedExports: { prisma: {} } });
  mock.module("@/lib/inbox-pending", { namedExports: { pendingCount: async () => ({ count: 0, kinds: [] }) } });
  mock.module("@/app/api/sessions/active/route", {
    namedExports: { GET: async () => new Response(JSON.stringify(sessionsActiveBody), { status: 200 }) },
  });
  mock.module("@/app/api/inbox/agent-payloads/route", {
    namedExports: { GET: async () => new Response(JSON.stringify({ payloads: [] }), { status: 200 }) },
  });
  // Stand-in for the real /api/poll: records what it was asked and enforces the
  // same session_id_required rule the real handler does.
  mock.module("@/app/api/poll/route", {
    namedExports: {
      POST: async (req: Request) => {
        const body = (await req.json()) as Record<string, unknown>;
        pollBodies.push(body);
        if (!body.session_id) return new Response(JSON.stringify({ error: "session_id_required" }), { status: 400 });
        return new Response(JSON.stringify({ frames: ['{"type":"msg","text":"hi"}'], next_cursor: 3, sent_seq: 4, peer_status: "idle" }), { status: 200 });
      },
    },
  });
  mock.module("@/app/api/sessions/[id]/end/route", {
    namedExports: {
      POST: async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
        endedIds.push((await ctx.params).id);
        return new Response(JSON.stringify({ ended: true }), { status: 200 });
      },
    },
  });
  mock.module("@/app/api/invites/route", { namedExports: { POST: async () => new Response("{}", { status: 200 }) } });
  mock.module("@/app/api/invites/[code]/claim/route", { namedExports: { POST: async () => new Response("{}", { status: 200 }) } });
  mock.module("@/app/api/inbox/request/route", { namedExports: { POST: async () => new Response("{}", { status: 200 }) } });
  mock.module("@/app/api/scopes/route", { namedExports: { GET: () => new Response("[]", { status: 200 }) } });
  mock.module("@/app/api/account/view-token-self/route", { namedExports: { POST: async () => new Response("{}", { status: 200 }) } });
});

beforeEach(() => {
  pollBodies = [];
  endedIds = [];
  sessionsActiveBody = {
    sessions: [{ id: "sess-1", role: "visitor", peer_handle: "peer@bc", unread_count: 3, next_cursor: 0 }],
    agent_payloads_pending: 0,
    inbox_check: { enabled: true, minutes: 10 },
  };
});

async function call(name: string, args?: Record<string, unknown>) {
  const { POST } = await import("@/app/api/mcp/route");
  const res = await POST(
    new Request("https://back-channel.app/api/mcp", {
      method: "POST",
      headers: { authorization: "Bearer good", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, ...(args ? { arguments: args } : {}) } }),
    }) as never,
  );
  return res.json();
}

test("bc_check_inbox labels every thread with session_id (the name the per-thread tools take), keeping id", async () => {
  const json = await call("bc_check_inbox");
  const body = JSON.parse(json.result.content[0].text);
  assert.equal(body.sessions[0].session_id, "sess-1");
  assert.equal(body.sessions[0].id, "sess-1");
  assert.equal(body.sessions[0].peer_handle, "peer@bc");
});

test("bc_read_messages: session_id works exactly as before (read poll + ack poll)", async () => {
  const json = await call("bc_read_messages", { session_id: "sess-1", role: "visitor" });
  assert.equal(json.result.isError, false);
  assert.deepEqual(pollBodies.map((b) => [b.session_id, b.cursor]), [["sess-1", 0], ["sess-1", 3]]);
});

test("bc_read_messages: thread_id (and the silent spellings) reach /api/poll as session_id", async () => {
  for (const alias of ["thread_id", "conversation_id", "sessionId", "id"]) {
    pollBodies = [];
    const json = await call("bc_read_messages", { [alias]: "sess-1", role: "visitor", mark_read: false });
    assert.equal(json.error, undefined, `${alias}: ${JSON.stringify(json.error)}`);
    assert.equal(json.result.isError, false, alias);
    assert.equal(pollBodies.length, 1, alias);
    assert.equal(pollBodies[0].session_id, "sess-1", alias);
    assert.deepEqual(JSON.parse(json.result.content[0].text).frames, ['{"type":"msg","text":"hi"}'], alias);
  }
});

test("bc_send_message and bc_end_session accept thread_id too", async () => {
  const sent = await call("bc_send_message", { thread_id: "sess-1", role: "visitor", frame: { type: "msg", text: "handover" } });
  assert.equal(sent.result.isError, false);
  assert.equal(pollBodies[0].session_id, "sess-1");
  assert.deepEqual(pollBodies[0].send, { type: "msg", text: "handover" });

  const ended = await call("bc_end_session", { thread_id: "sess-1" });
  assert.equal(ended.result.isError, false);
  assert.deepEqual(endedIds, ["sess-1"]);
});

test("no thread id at all: one actionable INVALID_PARAMS error naming thread_id — the wrapped route is never reached", async () => {
  for (const [name, args] of [
    ["bc_read_messages", { role: "visitor" }],
    ["bc_read_messages", { session_id: "", role: "visitor" }],
    ["bc_send_message", { role: "visitor", frame: "x" }],
    ["bc_end_session", {}],
    ["bc_end_session", undefined],
  ] as const) {
    const json = await call(name, args as Record<string, unknown> | undefined);
    assert.equal(json.error?.code, -32602, `${name} ${JSON.stringify(args)}`);
    assert.match(json.error.message, /missing thread id/);
    assert.match(json.error.message, /thread_id/);
  }
  assert.deepEqual(pollBodies, []);
  assert.deepEqual(endedIds, [], 'bc_end_session must never be dispatched with the literal id "undefined"');
});

test("unauthenticated: 401 carries WWW-Authenticate pointing at the OAuth protected-resource metadata, and keeps the bc_ key hint", async () => {
  const { POST } = await import("@/app/api/mcp/route");
  const res = await POST(
    new Request("https://back-channel.app/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }) as never,
  );
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("www-authenticate"), 'Bearer resource_metadata="https://back-channel.app/.well-known/oauth-protected-resource"');
  const json = await res.json();
  assert.equal(json.error.code, -32001);
  assert.match(json.error.message, /Bearer <bc_ token>/);
});
