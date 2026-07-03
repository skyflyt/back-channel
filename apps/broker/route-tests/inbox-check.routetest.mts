/**
 * Route tests for GET /api/inbox/check (long-poll doorbell). Runs the actual
 * route handler with @/lib/auth and @/lib/inbox-pending's DB-touching bits
 * mocked out (node:test's experimental module mocks) - no real Postgres
 * needed, but this exercises the REAL route file, not a re-implementation.
 *
 * Run with:
 *   node --experimental-strip-types --experimental-test-module-mocks \
 *        --import ./route-tests/register-hooks.mjs --test route-tests/*.routetest.mts
 * (wired into package.json's "test:routes" script - see that file.)
 */
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

const ACCOUNT = { id: "acct-1", handle: "tester@bc" };

before(() => {
  mock.module("@/lib/auth", {
    namedExports: {
      getAccountFromAuth: async (header) => (header === "Bearer good" ? ACCOUNT : null),
    },
  });
  // The route imports this only for its side effect (registering the shared
  // pendingCounter). Mock it to a no-op so importing the route never touches
  // Postgres; each test controls the count directly via setPendingCounter.
  mock.module("@/lib/inbox-pending", { namedExports: { pendingCount: async () => ({ count: 0, kinds: [] }) } });
});

beforeEach(async () => {
  // Fresh bus state per test - inbox-bus is a module-level singleton
  // (globalThis-backed), same as relay.mjs's session map. Import the .mjs
  // directly for _reset (test-only helper; not part of the typed .ts shim
  // that production code uses).
  const { _reset, setPendingCounter } = await import("@/lib/inbox-bus.mjs");
  _reset();
  setPendingCounter(async () => ({ count: 0, kinds: [] }));
});

test("401 when no/invalid bearer", async () => {
  const { GET } = await import("@/app/api/inbox/check/route");
  const req = new Request("https://back-channel.app/api/inbox/check", { headers: { authorization: "Bearer bad" } });
  const res = await GET(req);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error, "unauthorized");
});

test("400 when wait exceeds the 300s cap", async () => {
  const { GET } = await import("@/app/api/inbox/check/route");
  const req = new Request("https://back-channel.app/api/inbox/check?wait=301", { headers: { authorization: "Bearer good" } });
  const res = await GET(req);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "wait_too_large");
});

test("400 on a negative/non-numeric wait", async () => {
  const { GET } = await import("@/app/api/inbox/check/route");
  const req = new Request("https://back-channel.app/api/inbox/check?wait=-5", { headers: { authorization: "Bearer good" } });
  const res = await GET(req);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_wait");
});
test("immediate return with the current snapshot when something is already pending", async () => {
  const { setPendingCounter } = await import("@/lib/inbox-bus.mjs");
  setPendingCounter(async () => ({ count: 2, kinds: ["frame"] }));
  const { GET } = await import("@/app/api/inbox/check/route");

  const start = Date.now();
  const req = new Request("https://back-channel.app/api/inbox/check?wait=300", { headers: { authorization: "Bearer good" } });
  const res = await GET(req);
  const elapsed = Date.now() - start;

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.pending_count, 2);
  assert.deepEqual(body.kinds, ["frame"]);
  assert.equal(body.waited_seconds, 0);
  assert.ok(body.since && body.timestamp);
  assert.ok(elapsed < 200, `returned immediately (took ${elapsed}ms), not after a real 300s wait`);
});

test("empty-doorbell timeout shape when nothing arrives within `wait`", async () => {
  const { setPendingCounter } = await import("@/lib/inbox-bus.mjs");
  setPendingCounter(async () => ({ count: 0, kinds: [] }));
  const { GET } = await import("@/app/api/inbox/check/route");

  const req = new Request("https://back-channel.app/api/inbox/check?wait=0.1", { headers: { authorization: "Bearer good" } });
  const res = await GET(req);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.pending_count, 0);
  assert.equal(body.kinds, undefined, "kinds omitted, not an empty array, when nothing pending");
  assert.ok(body.waited_seconds >= 0);
});

test("wait defaults to 0 (immediate) when omitted", async () => {
  const { setPendingCounter } = await import("@/lib/inbox-bus.mjs");
  setPendingCounter(async () => ({ count: 0, kinds: [] }));
  const { GET } = await import("@/app/api/inbox/check/route");

  const start = Date.now();
  const req = new Request("https://back-channel.app/api/inbox/check", { headers: { authorization: "Bearer good" } });
  const res = await GET(req);
  const elapsed = Date.now() - start;
  assert.equal(res.status, 200);
  assert.ok(elapsed < 100, `no wait param = immediate return (took ${elapsed}ms)`);
});