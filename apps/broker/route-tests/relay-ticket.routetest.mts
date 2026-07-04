/**
 * Route tests for POST /api/sessions/:id/relay-ticket (C1 — session-hijack
 * fix). Runs the REAL route handler with @/lib/auth, @/lib/db, and @/lib/relay
 * mocked out — no Postgres needed. Follows the same node:test module-mock
 * pattern as inbox-check.routetest.mts.
 *
 * What this endpoint must guarantee (see apps/broker/src/lib/relay.mjs's
 * handleRelayUpgrade + mintRelayTicket for the consuming side):
 *   - bearer-authed only (401 without)
 *   - caller must be a participant on the session (403 otherwise)
 *   - role is DERIVED from the invite's hostAccountId/visitorAccountId --
 *     never accepted as a request parameter (there isn't one to send)
 *   - ended sessions are rejected (410)
 *
 * Run with:
 *   node --experimental-strip-types --experimental-test-module-mocks \
 *        --import ./route-tests/register-hooks.mjs --test route-tests/*.routetest.mts
 * (wired into package.json's "test:routes" script.)
 */
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

const ACCOUNT_HOST = { id: "acct-host" };
const ACCOUNT_VISITOR = { id: "acct-visitor" };
const ACCOUNT_STRANGER = { id: "acct-stranger" };

let sessionRow: any = null;
let mintCalls: Array<{ sessionId: string; role: string; accountId: string }> = [];

before(() => {
  mock.module("@/lib/auth", {
    namedExports: {
      getAccountFromAuth: async (header: string | null) => {
        if (header === "Bearer host-token") return ACCOUNT_HOST;
        if (header === "Bearer visitor-token") return ACCOUNT_VISITOR;
        if (header === "Bearer stranger-token") return ACCOUNT_STRANGER;
        return null;
      },
    },
  });
  mock.module("@/lib/db", {
    namedExports: {
      prisma: {
        session: {
          findUnique: async ({ where }: any) => (where.id === sessionRow?.id ? sessionRow : null),
        },
      },
    },
  });
  mock.module("@/lib/relay", {
    namedExports: {
      mintRelayTicket: (args: { sessionId: string; role: string; accountId: string }) => {
        mintCalls.push(args);
        return { ticket: `fake-ticket-for-${args.role}`, expiresAt: new Date(Date.now() + 60_000) };
      },
    },
  });
});

beforeEach(() => {
  mintCalls = [];
  sessionRow = {
    id: "session-1",
    endedAt: null,
    invite: { hostAccountId: ACCOUNT_HOST.id, visitorAccountId: ACCOUNT_VISITOR.id },
  };
});

function makeReq(id: string, authHeader?: string) {
  return new Request(`https://back-channel.app/api/sessions/${id}/relay-ticket`, {
    method: "POST",
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

test("401 when no/invalid bearer", async () => {
  const { POST } = await import("@/app/api/sessions/[id]/relay-ticket/route");
  const res = await POST(makeReq("session-1", "Bearer bad") as any, { params: Promise.resolve({ id: "session-1" }) });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "unauthorized");
  assert.equal(mintCalls.length, 0, "no ticket minted for an unauthed caller");
});

test("404 when the session doesn't exist", async () => {
  const { POST } = await import("@/app/api/sessions/[id]/relay-ticket/route");
  const res = await POST(makeReq("no-such-session", "Bearer host-token") as any, { params: Promise.resolve({ id: "no-such-session" }) });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, "session_not_found");
});

test("403 when the caller is not a participant on the session", async () => {
  const { POST } = await import("@/app/api/sessions/[id]/relay-ticket/route");
  const res = await POST(makeReq("session-1", "Bearer stranger-token") as any, { params: Promise.resolve({ id: "session-1" }) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "forbidden");
  assert.equal(mintCalls.length, 0, "no ticket minted for a non-participant");
});

test("410 when the session has already ended", async () => {
  sessionRow.endedAt = new Date();
  const { POST } = await import("@/app/api/sessions/[id]/relay-ticket/route");
  const res = await POST(makeReq("session-1", "Bearer host-token") as any, { params: Promise.resolve({ id: "session-1" }) });
  assert.equal(res.status, 410);
  assert.equal((await res.json()).error, "session_ended");
});

test("host caller mints a ticket with role='host' -- derived from the invite, not a request param", async () => {
  const { POST } = await import("@/app/api/sessions/[id]/relay-ticket/route");
  const res = await POST(makeReq("session-1", "Bearer host-token") as any, { params: Promise.resolve({ id: "session-1" }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.role, "host");
  assert.equal(body.session_id, "session-1");
  assert.ok(body.ticket);
  assert.ok(body.expires_at);
  assert.equal(mintCalls.length, 1);
  assert.deepEqual(mintCalls[0], { sessionId: "session-1", role: "host", accountId: ACCOUNT_HOST.id });
});

test("visitor caller mints a ticket with role='visitor' -- derived from the invite, not a request param", async () => {
  const { POST } = await import("@/app/api/sessions/[id]/relay-ticket/route");
  const res = await POST(makeReq("session-1", "Bearer visitor-token") as any, { params: Promise.resolve({ id: "session-1" }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.role, "visitor");
  assert.equal(mintCalls.length, 1);
  assert.deepEqual(mintCalls[0], { sessionId: "session-1", role: "visitor", accountId: ACCOUNT_VISITOR.id });
});

test("the response never exposes a client-settable role -- there is no role field to send in the request", async () => {
  // Documents intent: the route reads no `role` from body/query at all. A
  // caller cannot influence which role they're issued a ticket for -- only
  // which ACCOUNT's bearer token they present, which the route resolves to
  // exactly one of host/visitor/forbidden via the invite.
  const { POST } = await import("@/app/api/sessions/[id]/relay-ticket/route");
  const reqWithSpoofedRole = new Request("https://back-channel.app/api/sessions/session-1/relay-ticket", {
    method: "POST",
    headers: { authorization: "Bearer visitor-token" },
    body: JSON.stringify({ role: "host" }), // attempted spoof via body
  });
  const res = await POST(reqWithSpoofedRole as any, { params: Promise.resolve({ id: "session-1" }) });
  const body = await res.json();
  assert.equal(body.role, "visitor", "role is still derived from the invite, ignoring the spoofed body field");
});
