/**
 * Route tests for SEC H1 (plaintext Account.apiKey at rest).
 *
 * Proves, against the REAL route handlers:
 *   (a) /api/account/key/rotate, /api/auth/recover-key, and /api/auth/verify
 *       never write Account.apiKey — only an AgentToken.keyHash row changes —
 *       and the raw key is still returned exactly once in the response body.
 *   (b) the freshly-minted raw key authenticates via getAuthContext's
 *       canonical AgentToken.keyHash lookup (the hash path), not the legacy
 *       plaintext-compare fallback.
 *   (c) the legacy plaintext-compare fallback still works for pre-H1 accounts
 *       (needed until the H1 backfill migration runs in prod), but the hash
 *       path always wins when both exist.
 *
 * Mocks only @/lib/db (an in-memory fake covering Account/AgentToken/MagicLink/
 * SessionCookie/AccountAudit/Invite) so the REAL @/lib/auth code — including
 * upsertOriginalAgentToken, hashToken, and getAuthContext — runs for real.
 * Follows the same node:test module-mock pattern as
 * link-artifact-lifecycle.routetest.mts.
 *
 * Run with:
 *   node --experimental-strip-types --experimental-test-module-mocks \
 *        --import ./route-tests/register-hooks.mjs --test route-tests/*.routetest.mts
 */
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";

// Local mirror of @/lib/auth's hashToken (bare sha256 hex) -- used only to key
// this test's in-memory fakes the same way the real prisma tables are keyed
// (by hash, never by raw value). Kept independent of @/lib/auth's module load
// so table setup in reset() never depends on import order.
function sha256hex(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

const ACCOUNT_ID = "acct-h1";
const RAW_COOKIE = "cs_good";

let accounts: Record<string, any> = {};
let agentTokens: Record<string, any> = {};
let magicLinks: Record<string, any> = {};
let sessionCookies: Record<string, any> = {};
let audits: any[] = [];
let nextTokenId = 1;

function reset() {
  accounts = {
    [ACCOUNT_ID]: {
      id: ACCOUNT_ID,
      handle: "h1tester@bc",
      email: "h1tester@example.com",
      apiKey: null, // SEC H1: pending/verified accounts never carry a plaintext key
      apiKeyLastUsedAt: null,
      emailVerifiedAt: new Date(),
    },
  };
  agentTokens = {};
  magicLinks = {};
  // Keyed by HASH, exactly like the real SessionCookie table (token = hashToken(raw)).
  sessionCookies = { [sha256hex(RAW_COOKIE)]: { token: sha256hex(RAW_COOKIE), accountId: ACCOUNT_ID, expiresAt: new Date(Date.now() + 3600_000), lastUsedAt: null } };
  audits = [];
  nextTokenId = 1;
}

const prismaMock = {
  account: {
    findUnique: async ({ where }: any) => {
      if (where.id) return accounts[where.id] ?? null;
      if (where.email) return Object.values(accounts).find((a: any) => a.email === where.email) ?? null;
      if (where.apiKey) return Object.values(accounts).find((a: any) => a.apiKey === where.apiKey) ?? null;
      return null;
    },
    update: async ({ where, data }: any) => {
      const row = accounts[where.id];
      if (!row) throw new Error("account not found");
      Object.assign(row, data);
      return row;
    },
  },
  agentToken: {
    create: async ({ data }: any) => {
      const id = `agt_${nextTokenId++}`;
      const row = { id, accountId: data.accountId, keyHash: data.keyHash, name: data.name, runtimeType: data.runtimeType ?? "other", createdAt: new Date(), lastUsedAt: null, revokedAt: null };
      agentTokens[id] = row;
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const row of Object.values(agentTokens) as any[]) {
        if (row.accountId === where.accountId && row.name === where.name && (where.revokedAt === undefined || row.revokedAt === where.revokedAt)) {
          Object.assign(row, data);
          count++;
        }
      }
      return { count };
    },
    findUnique: async ({ where, include }: any) => {
      const row = Object.values(agentTokens).find((t: any) => t.keyHash === where.keyHash) as any;
      if (!row) return null;
      if (include?.account) return { ...row, account: accounts[row.accountId] ?? null };
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = agentTokens[where.id];
      if (!row) throw new Error("agent token not found");
      Object.assign(row, data);
      return row;
    },
  },
  magicLink: {
    findUnique: async ({ where }: any) => magicLinks[where.token] ?? null,
    updateMany: async ({ where, data }: any) => {
      const row = magicLinks[where.token];
      if (!row || row.consumedAt !== where.consumedAt) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  },
  sessionCookie: {
    findUnique: async ({ where }: any) => {
      const row = sessionCookies[where.token];
      if (!row) return null;
      return { ...row, account: accounts[row.accountId] ?? null };
    },
    create: async ({ data }: any) => {
      sessionCookies[data.token] = { token: data.token, accountId: data.accountId, expiresAt: data.expiresAt, lastUsedAt: null };
      return sessionCookies[data.token];
    },
    update: async () => ({}),
    delete: async () => ({}),
  },
  invite: {
    findUnique: async () => null,
  },
  accountAudit: {
    create: async ({ data }: any) => {
      audits.push(data);
      return data;
    },
  },
};

before(() => {
  mock.module("@/lib/db", { namedExports: { prisma: prismaMock } });
  // NOTE: @/lib/auth is intentionally NOT mocked here -- the whole point of
  // this test file is to exercise the real hashToken/upsertOriginalAgentToken/
  // getAuthContext code paths against the mocked prisma above.
});

beforeEach(() => {
  reset();
});

function cookieReq(url: string, opts: { cookie?: string; body?: any } = {}) {
  const headers = new Headers();
  if (opts.cookie) headers.set("cookie", `bc_session=${opts.cookie}; bc_csrf=csrf1`);
  headers.set("x-bc-csrf", "csrf1");
  if (opts.body) headers.set("content-type", "application/json");
  return new NextRequest(url, {
    method: "POST",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

test("rotate: never writes Account.apiKey -- the column stays null after rotation", async () => {
  const { POST } = await import("@/app/api/account/key/rotate/route");
  const res = await POST(cookieReq("https://back-channel.app/api/account/key/rotate", { cookie: RAW_COOKIE }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "rotated");
  assert.ok(body.api_key?.startsWith("bc_"), "raw key is still returned once in the response");

  // The persisted Account row must never carry the plaintext key.
  assert.equal(accounts[ACCOUNT_ID].apiKey, null, "Account.apiKey must stay null -- nothing should write it");

  // Exactly one live AgentToken named "Original" now exists, and it stores a HASH, not the raw key.
  const live = Object.values(agentTokens).filter((t: any) => t.accountId === ACCOUNT_ID && t.name === "Original" && !t.revokedAt);
  assert.equal(live.length, 1, "exactly one live Original AgentToken");
  assert.notEqual((live[0] as any).keyHash, body.api_key, "stored value must be a hash, not the raw key");
  assert.equal((live[0] as any).keyHash.length, 64, "sha256 hex digest is 64 chars");
  assert.equal((live[0] as any).keyHash, sha256hex(body.api_key), "the stored hash must be sha256(rawKey)");
});

test("rotate: the freshly rotated key authenticates via the AgentToken.keyHash (hash) path", async () => {
  const { POST } = await import("@/app/api/account/key/rotate/route");
  const res = await POST(cookieReq("https://back-channel.app/api/account/key/rotate", { cookie: RAW_COOKIE }));
  const { api_key: newKey } = await res.json();

  const { getAuthContext } = await import("@/lib/auth");
  const ctx = await getAuthContext(`Bearer ${newKey}`);
  assert.ok(ctx, "the rotated raw key must authenticate");
  assert.equal(ctx!.account.id, ACCOUNT_ID);
  assert.ok(ctx!.agentTokenId, "auth must resolve via the AgentToken (hash) path, not the legacy plaintext fallback -- agentTokenId is non-null only on that path");
});

test("rotate twice: the OLD key stops authenticating (revoked), only the newest key works", async () => {
  const { POST } = await import("@/app/api/account/key/rotate/route");
  const first = await (await POST(cookieReq("https://back-channel.app/api/account/key/rotate", { cookie: RAW_COOKIE }))).json();
  const second = await (await POST(cookieReq("https://back-channel.app/api/account/key/rotate", { cookie: RAW_COOKIE }))).json();
  assert.notEqual(first.api_key, second.api_key);

  const { getAuthContext } = await import("@/lib/auth");
  const oldCtx = await getAuthContext(`Bearer ${first.api_key}`);
  const newCtx = await getAuthContext(`Bearer ${second.api_key}`);
  assert.equal(oldCtx, null, "the previous key must stop authenticating once rotated");
  assert.ok(newCtx, "the newest key must authenticate");

  const live = Object.values(agentTokens).filter((t: any) => t.accountId === ACCOUNT_ID && t.name === "Original" && !t.revokedAt);
  assert.equal(live.length, 1, "never more than one live Original token");
});

test("recover-key: never writes Account.apiKey and returns a working key once", async () => {
  const rawToken = "rec_test-token";
  magicLinks[sha256hex(rawToken)] = { token: sha256hex(rawToken), email: accounts[ACCOUNT_ID].email, consumedAt: null, expiresAt: new Date(Date.now() + 900_000), claimCode: null };

  const { POST } = await import("@/app/api/auth/recover-key/route");
  const res = await POST(cookieReq("https://back-channel.app/api/auth/recover-key", { body: { token: rawToken } }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "key_rotated");
  assert.ok(body.api_key?.startsWith("bc_"));
  assert.equal(accounts[ACCOUNT_ID].apiKey, null, "Account.apiKey must stay null after recovery");

  const { getAuthContext } = await import("@/lib/auth");
  const ctx = await getAuthContext(`Bearer ${body.api_key}`);
  assert.ok(ctx, "the recovered key must authenticate via the hash path");
  assert.equal(ctx!.account.id, ACCOUNT_ID);
});

test("verify: a freshly verified account gets a working key and Account.apiKey stays null", async () => {
  accounts[ACCOUNT_ID].emailVerifiedAt = null; // simulate a pending account
  const rawToken = "verify-test-token";
  magicLinks[sha256hex(rawToken)] = { token: sha256hex(rawToken), email: accounts[ACCOUNT_ID].email, consumedAt: null, expiresAt: new Date(Date.now() + 3600_000), claimCode: null };

  const { POST } = await import("@/app/api/auth/verify/route");
  const res = await POST(cookieReq("https://back-channel.app/api/auth/verify", { body: { token: rawToken } }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "verified");
  assert.ok(body.api_key?.startsWith("bc_"));
  assert.ok(body.bootstrap_prompt?.includes(body.api_key), "bootstrap_prompt embeds the raw key returned in the same response");
  assert.equal(accounts[ACCOUNT_ID].apiKey, null, "Account.apiKey must stay null after verify");
  assert.ok(accounts[ACCOUNT_ID].emailVerifiedAt, "verification still marks the account verified");

  const { getAuthContext } = await import("@/lib/auth");
  const ctx = await getAuthContext(`Bearer ${body.api_key}`);
  assert.ok(ctx, "the freshly minted key must authenticate via the hash path");
});

test("getAuthContext: legacy plaintext Account.apiKey still authenticates (pre-H1 / not-yet-backfilled accounts) via the fallback path only", async () => {
  // Simulate an account that predates this fix and hasn't been touched by the
  // backfill migration yet: apiKey is set in plaintext, no AgentToken exists.
  accounts[ACCOUNT_ID].apiKey = "bc_legacy-plaintext-key-1234567890";

  const { getAuthContext } = await import("@/lib/auth");
  const ctx = await getAuthContext(`Bearer ${accounts[ACCOUNT_ID].apiKey}`);
  assert.ok(ctx, "the legacy fallback must still authenticate un-backfilled accounts");
  assert.equal(ctx!.account.id, ACCOUNT_ID);
  assert.equal(ctx!.agentTokenId, null, "the fallback path carries no agentTokenId -- distinguishes it from the hash path");
});

test("getAuthContext: once an AgentToken hash exists for a key, the hash path wins over any stale plaintext match", async () => {
  const raw = "bc_both-paths-key-abcdef";
  accounts[ACCOUNT_ID].apiKey = raw; // stale plaintext (pretend pre-backfill state)
  agentTokens["agt_manual"] = { id: "agt_manual", accountId: ACCOUNT_ID, keyHash: sha256hex(raw), name: "Original", runtimeType: "other", createdAt: new Date(), lastUsedAt: null, revokedAt: null };

  const { getAuthContext } = await import("@/lib/auth");
  const ctx = await getAuthContext(`Bearer ${raw}`);
  assert.ok(ctx);
  assert.equal(ctx!.agentTokenId, "agt_manual", "hash lookup must be tried first and win");
});
