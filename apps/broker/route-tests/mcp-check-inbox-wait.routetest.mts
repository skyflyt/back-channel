/**
 * Route tests for POST /api/mcp's bc_check_inbox wait_seconds support (design:
 * docs/inbox-doorbell.md + design/mcp-doorbell-wait.md). Runs the actual route
 * handler with @/lib/auth, @/lib/db, @/lib/inbox-pending, and the wrapped
 * sessions/active + inbox/agent-payloads route handlers mocked out - no
 * Postgres needed, but this exercises the REAL /api/mcp route file, not a
 * re-implementation. The remote side calls waitForInbox directly (no self-HTTP
 * back to /api/inbox/check) - these tests prove that wiring end to end.
 *
 * mock.module() can only be called ONCE per specifier for the life of the
 * process (node:test throws ERR_INVALID_STATE on a second call) - so every
 * mocked module is registered exactly once in the top-level before(), and
 * per-test behavior is driven by mutating the closured state below instead
 * of re-mocking.
 *
 * Run with:
 *   node --experimental-strip-types --experimental-test-module-mocks \
 *        --import ./route-tests/register-hooks.mjs --test route-tests/*.routetest.mts
 * (wired into package.json's "test:routes" script - see that file.)
 */
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

const ACCOUNT = { id: "acct-1", handle: "tester@bc", displayName: "Tester" };

let sessionsActiveBody: unknown = { sessions: [], agent_payloads_pending: 0, inbox_check: { enabled: true, minutes: 10 } };

before(() => {
  process.env.PUBLIC_APP_URL = "https://back-channel.app"; // synth() in route.ts needs this since req.nextUrl is unavailable on a plain Request in tests
  mock.module("@/lib/auth", {
    namedExports: {
      getAuthContext: async (header: string | null) =>
        header === "Bearer good" ? { account: ACCOUNT, agentTokenId: null } : null,
    },
  });
  mock.module("@/lib/db", { namedExports: { prisma: {} } });
  // Side-effect-only in the real route (registers the shared pendingCounter);
  // mock it to a no-op so importing the route never touches Postgres. Each
  // test controls the count directly via setPendingCounter (from the real
  // inbox-bus.mjs), same pattern as inbox-check.routetest.mts.
  mock.module("@/lib/inbox-pending", { namedExports: { pendingCount: async () => ({ count: 0, kinds: [] }) } });

  mock.module("@/app/api/sessions/active/route", {
    namedExports: {
      GET: async () => new Response(JSON.stringify(sessionsActiveBody), { status: 200 }),
    },
  });
  mock.module("@/app/api/inbox/agent-payloads/route", {
    namedExports: { GET: async () => new Response(JSON.stringify({ payloads: [] }), { status: 200 }) },
  });
  // Unused by bc_check_inbox but imported at module load by route.ts.
  mock.module("@/app/api/poll/route", { namedExports: { POST: async () => new Response("{}", { status: 200 }) } });
  mock.module("@/app/api/invites/route", { namedExports: { POST: async () => new Response("{}", { status: 200 }) } });
  mock.module("@/app/api/invites/[code]/claim/route", { namedExports: { POST: async () => new Response("{}", { status: 200 }) } });
  mock.module("@/app/api/inbox/request/route", { namedExports: { POST: async () => new Response("{}", { status: 200 }) } });
  mock.module("@/app/api/sessions/[id]/end/route", { namedExports: { POST: async () => new Response("{}", { status: 200 }) } });
  mock.module("@/app/api/scopes/route", { namedExports: { GET: () => new Response("[]", { status: 200 }) } });
  mock.module("@/app/api/account/view-token-self/route", { namedExports: { POST: async () => new Response("{}", { status: 200 }) } });
});

beforeEach(async () => {
  // Fresh bus state per test - inbox-bus is a module-level singleton
  // (globalThis-backed). Import the .mjs directly for _reset (test-only
  // helper; not part of the typed .ts shim production code uses).
  const { _reset, setPendingCounter } = await import("@/lib/inbox-bus.mjs");
  _reset();
  setPendingCounter(async () => ({ count: 0, kinds: [] }));
  sessionsActiveBody = { sessions: [], agent_payloads_pending: 0, inbox_check: { enabled: true, minutes: 10 } };
});

function checkInboxRequest(args?: Record<string, unknown>) {
  return new Request("https://back-channel.app/api/mcp", {
    method: "POST",
    headers: { authorization: "Bearer good", "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "bc_check_inbox", ...(args ? { arguments: args } : {}) },
    }),
  });
}

async function callToolResultBody(res: Response) {
  const json = await res.json();
  assert.equal(json.jsonrpc, "2.0");
  assert.equal(json.error, undefined, `expected a result, got error: ${JSON.stringify(json.error)}`);
  return JSON.parse(json.result.content[0].text);
}

test("wait_seconds absent - zero behavior change: no wait, normal sessions/active passthrough", async () => {
  const { POST } = await import("@/app/api/mcp/route");
  const start = Date.now();
  const res = await POST(checkInboxRequest());
  const elapsed = Date.now() - start;
  assert.equal(res.status, 200);
  const body = await callToolResultBody(res);
  assert.deepEqual(body.sessions, []);
  assert.equal(body.waited_seconds, undefined, "no waited_seconds field when wait was never requested");
  assert.ok(elapsed < 200, `must return immediately (took ${elapsed}ms)`);
});

test("wait_seconds=0 - same as absent, no doorbell wait", async () => {
  const { POST } = await import("@/app/api/mcp/route");
  const res = await POST(checkInboxRequest({ wait_seconds: 0 }));
  const body = await callToolResultBody(res);
  assert.equal(body.waited_seconds, undefined);
});

test("wait_seconds>0, something already pending - returns immediately via the existing full read, unchanged", async () => {
  const { setPendingCounter } = await import("@/lib/inbox-bus.mjs");
  setPendingCounter(async () => ({ count: 1, kinds: ["frame"] }));
  sessionsActiveBody = { sessions: [{ id: "s1" }], agent_payloads_pending: 0, inbox_check: { enabled: true, minutes: 10 } };
  const { POST } = await import("@/app/api/mcp/route");

  const start = Date.now();
  const res = await POST(checkInboxRequest({ wait_seconds: 30 }));
  const elapsed = Date.now() - start;
  const body = await callToolResultBody(res);

  assert.deepEqual(body.sessions, [{ id: "s1" }]);
  assert.equal(body.waited_seconds, undefined, "pending path returns the existing shape verbatim, no wait note");
  assert.ok(elapsed < 200, `must not actually wait when something is already pending (took ${elapsed}ms)`);
});

test("wait_seconds>0, nothing arrives - empty result plus waited_seconds note", async () => {
  const { setPendingCounter } = await import("@/lib/inbox-bus.mjs");
  setPendingCounter(async () => ({ count: 0, kinds: [] }));
  const { POST } = await import("@/app/api/mcp/route");

  const res = await POST(checkInboxRequest({ wait_seconds: 1 }));
  const body = await callToolResultBody(res);
  assert.deepEqual(body.sessions, []);
  assert.ok(typeof body.waited_seconds === "number" && body.waited_seconds >= 0, "waited_seconds present on timeout");
});

test("wait_seconds>0, mail arrives mid-wait - resolves early with the full read (no wait-cap delay)", async () => {
  const { setPendingCounter, fireInboxEvent } = await import("@/lib/inbox-bus.mjs");
  setPendingCounter(async () => ({ count: 1, kinds: ["frame"] }));
  sessionsActiveBody = { sessions: [{ id: "s2" }], agent_payloads_pending: 0, inbox_check: { enabled: true, minutes: 10 } };
  const { POST } = await import("@/app/api/mcp/route");

  const start = Date.now();
  const resPromise = POST(checkInboxRequest({ wait_seconds: 60 }));
  setTimeout(() => fireInboxEvent(ACCOUNT.id, "frame"), 20);
  const res = await resPromise;
  const elapsed = Date.now() - start;

  const body = await callToolResultBody(res);
  assert.deepEqual(body.sessions, [{ id: "s2" }]);
  assert.ok(elapsed < 2000, `must resolve as soon as mail arrives, not wait the full 60s (took ${elapsed}ms)`);
});

test("wait_seconds > 120 - INVALID_PARAMS error, not silently clamped, nothing forwarded", async () => {
  const { POST } = await import("@/app/api/mcp/route");
  const res = await POST(checkInboxRequest({ wait_seconds: 121 }));
  const json = await res.json();
  assert.equal(json.error.code, -32602);
  assert.match(json.error.message, /<= 120/);
});

test("negative wait_seconds - INVALID_PARAMS error", async () => {
  const { POST } = await import("@/app/api/mcp/route");
  const res = await POST(checkInboxRequest({ wait_seconds: -1 }));
  const json = await res.json();
  assert.equal(json.error.code, -32602);
  assert.match(json.error.message, />= 0/);
});

test("non-integer wait_seconds - INVALID_PARAMS error", async () => {
  const { POST } = await import("@/app/api/mcp/route");
  const res = await POST(checkInboxRequest({ wait_seconds: 2.5 }));
  const json = await res.json();
  assert.equal(json.error.code, -32602);
  assert.match(json.error.message, /integer/);
});

test("401 when no/invalid bearer, even with wait_seconds set", async () => {
  const { POST } = await import("@/app/api/mcp/route");
  const req = new Request("https://back-channel.app/api/mcp", {
    method: "POST",
    headers: { authorization: "Bearer bad", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bc_check_inbox", arguments: { wait_seconds: 5 } } }),
  });
  const res = await POST(req);
  assert.equal(res.status, 401);
});
