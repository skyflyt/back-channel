/**
 * Tests for POST /api/inbox/agent-payload — the bearer-authed generic self-inbox
 * write backing the Web Clipper self-drop (backchannel-web-clipper INTEGRATION.md §1).
 *
 * Covers the security invariants the endpoint must hold (and that the Fable
 * review called out as gaps elsewhere in the codebase):
 *   - authentication (bad/missing bearer → 401, no write)
 *   - own-inbox-only authorization (a recipient injected in the body is IGNORED;
 *     the row is always written to the caller's OWN account)
 *   - payload_kind allowlist ("skill"/"welcome"/unknown → 400, no write)
 *   - payload validation + size cap
 *   - rate limiting (429)
 *   - happy path (200 with the documented response shape)
 *
 * Run with:
 *   node --experimental-strip-types --experimental-test-module-mocks \
 *        --import ./route-tests/register-hooks.mjs --test route-tests/*.routetest.mts
 */
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

const ACCOUNT = { id: "acct-self", handle: "me@bc" };
const AGENT_TOKEN_ID = "agttok-1";

// Captured writes so tests can assert exactly what landed (and to WHICH account).
let createdPayloads: any[] = [];
let createdAudits: any[] = [];
let doorbellRings: Array<{ accountId: string; kind: string }> = [];
let rlOk = true;
let idCounter = 0;

const prismaMock = {
  agentPayload: {
    create: async ({ data }: any) => {
      const row = { id: `ap_${++idCounter}`, createdAt: new Date("2026-07-06T23:10:00.000Z"), ...data };
      createdPayloads.push(row);
      return row;
    },
  },
  accountAudit: {
    create: async ({ data }: any) => {
      createdAudits.push(data);
      return {};
    },
  },
};

before(() => {
  mock.module("@/lib/db", { namedExports: { prisma: prismaMock } });
  mock.module("@/lib/auth", {
    namedExports: {
      // Bearer "good" resolves to our account WITH an agent-token id, mirroring getAuthContext.
      getAuthContext: async (header: string | null) =>
        header === "Bearer good" ? { account: ACCOUNT, agentTokenId: AGENT_TOKEN_ID } : null,
    },
  });
  mock.module("@/lib/rate-limit", {
    namedExports: {
      rateLimit: () => (rlOk ? { ok: true, remaining: 119, retryAfterSec: 0 } : { ok: false, remaining: 0, retryAfterSec: 42 }),
    },
  });
  mock.module("@/lib/inbox-bus", {
    namedExports: {
      fireInboxEvent: (accountId: string, kind: string) => {
        doorbellRings.push({ accountId, kind });
      },
    },
  });
});

beforeEach(() => {
  createdPayloads = [];
  createdAudits = [];
  doorbellRings = [];
  rlOk = true;
  idCounter = 0;
});

const GOOD = { authorization: "Bearer good", "content-type": "application/json" };

function post(body: unknown, headers: Record<string, string> = GOOD) {
  return new NextRequest("https://back-channel.app/api/inbox/agent-payload", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// --- Happy path -------------------------------------------------------------

test("happy path: valid web-drop → 200, documented response shape, self-addressed write", async () => {
  const { POST } = await import("@/app/api/inbox/agent-payload/route");
  const res = await POST(post({ type: "agent.payload", payload_kind: "web-drop", payload: { url: "https://example.com", title: "Ex" } }));
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const json = await res.json();
  assert.equal(json.delivered, true);
  assert.equal(typeof json.id, "string");
  assert.equal(json.created_at, "2026-07-06T23:10:00.000Z");

  assert.equal(createdPayloads.length, 1);
  const row = createdPayloads[0];
  assert.equal(row.accountId, ACCOUNT.id, "must write to the caller's OWN account");
  assert.equal(row.kind, "web-drop");
  assert.deepEqual(row.ref, { url: "https://example.com", title: "Ex" });
  // Doorbell rung for the caller's own account.
  assert.deepEqual(doorbellRings, [{ accountId: ACCOUNT.id, kind: "payload" }]);
  // Audit is metadata-only, on the caller's own account.
  assert.equal(createdAudits.length, 1);
  assert.equal(createdAudits[0].accountId, ACCOUNT.id);
  assert.equal(createdAudits[0].eventType, "agent_payload.self_dropped");
  assert.equal(createdAudits[0].detail.payload_kind, "web-drop");
});

test("happy path: web-drop-manifest and web-drop-result kinds are accepted", async () => {
  const { POST } = await import("@/app/api/inbox/agent-payload/route");
  for (const kind of ["web-drop-manifest", "web-drop-result"]) {
    const res = await POST(post({ payload_kind: kind, payload: { ok: true } }));
    assert.equal(res.status, 200, `${kind} should be accepted`);
  }
  assert.equal(createdPayloads.length, 2);
});

// --- Authentication ---------------------------------------------------------

test("auth: missing bearer → 401 and NO write", async () => {
  const { POST } = await import("@/app/api/inbox/agent-payload/route");
  const res = await POST(post({ payload_kind: "web-drop", payload: { url: "x" } }, { "content-type": "application/json" }));
  assert.equal(res.status, 401);
  assert.equal(createdPayloads.length, 0);
  assert.equal(doorbellRings.length, 0);
});

test("auth: bad bearer → 401 and NO write", async () => {
  const { POST } = await import("@/app/api/inbox/agent-payload/route");
  const res = await POST(post({ payload_kind: "web-drop", payload: { url: "x" } }, { authorization: "Bearer nope", "content-type": "application/json" }));
  assert.equal(res.status, 401);
  assert.equal(createdPayloads.length, 0);
});

// --- Own-inbox-only authorization ------------------------------------------

test("authz: a recipient injected in the body is IGNORED — write still goes to the caller", async () => {
  const { POST } = await import("@/app/api/inbox/agent-payload/route");
  // Attacker holding a valid token for ACCOUNT tries every recipient-ish field.
  const res = await POST(
    post({
      payload_kind: "web-drop",
      payload: { url: "x" },
      to: "victim@bc",
      handle: "victim@bc",
      account_id: "acct-victim",
      accountId: "acct-victim",
      recipient: "acct-victim",
    }),
  );
  assert.equal(res.status, 200);
  assert.equal(createdPayloads.length, 1);
  assert.equal(createdPayloads[0].accountId, ACCOUNT.id, "recipient fields in the body must NOT redirect the write");
  assert.notEqual(createdPayloads[0].accountId, "acct-victim");
});

// --- payload_kind allowlist -------------------------------------------------

test('authz: payload_kind "skill" is rejected here (only writable via the share-gated send-to-me) → 400, no write', async () => {
  const { POST } = await import("@/app/api/inbox/agent-payload/route");
  const res = await POST(post({ payload_kind: "skill", payload: { skillId: "s1", name: "Totally legit" } }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_payload_kind");
  assert.equal(createdPayloads.length, 0);
});

test('authz: payload_kind "welcome" (broker-authored) is rejected → 400, no write', async () => {
  const { POST } = await import("@/app/api/inbox/agent-payload/route");
  const res = await POST(post({ payload_kind: "welcome", payload: { text: "hi" } }));
  assert.equal(res.status, 400);
  assert.equal(createdPayloads.length, 0);
});

test("validation: unknown payload_kind → 400, no write", async () => {
  const { POST } = await import("@/app/api/inbox/agent-payload/route");
  const res = await POST(post({ payload_kind: "evil-kind", payload: {} }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_payload_kind");
  assert.equal(createdPayloads.length, 0);
});

// --- payload / envelope validation -----------------------------------------

test("validation: wrong envelope type → 400", async () => {
  const { POST } = await import("@/app/api/inbox/agent-payload/route");
  const res = await POST(post({ type: "not.agent.payload", payload_kind: "web-drop", payload: {} }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_type");
});

test("validation: non-object payload → 400", async () => {
  const { POST } = await import("@/app/api/inbox/agent-payload/route");
  for (const bad of [undefined, null, "a string", 42, [1, 2, 3]]) {
    const res = await POST(post({ payload_kind: "web-drop", payload: bad }));
    assert.equal(res.status, 400, `payload=${JSON.stringify(bad)} should be rejected`);
  }
  assert.equal(createdPayloads.length, 0);
});

test("validation: invalid JSON body → 400", async () => {
  const { POST } = await import("@/app/api/inbox/agent-payload/route");
  const res = await POST(post("{ not json", GOOD));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "invalid_json");
});

test("validation: payload over the size cap → 413, no write", async () => {
  const { POST } = await import("@/app/api/inbox/agent-payload/route");
  const huge = { blob: "x".repeat(65 * 1024) };
  const res = await POST(post({ payload_kind: "web-drop", payload: huge }));
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, "payload_too_large");
  assert.equal(createdPayloads.length, 0);
});

// --- Rate limiting ----------------------------------------------------------

test("rate limit: over the cap → 429 with Retry-After, no write", async () => {
  const { POST } = await import("@/app/api/inbox/agent-payload/route");
  rlOk = false;
  const res = await POST(post({ payload_kind: "web-drop", payload: { url: "x" } }));
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("Retry-After"), "42");
  assert.equal(createdPayloads.length, 0);
});
