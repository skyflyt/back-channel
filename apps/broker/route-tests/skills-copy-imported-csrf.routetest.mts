/**
 * L4 (security-pass-2026-07-03.md): CSRF guard tests for POST
 * /api/skills/:id/copy and DELETE /api/skills/imported — both accept bearer
 * OR cookie auth but were missing the csrfValid() guard sibling routes
 * enforce on the cookie path (mitigated by SameSite=Lax, but inconsistent).
 *
 * @/lib/auth's csrfValid is mocked to a REAL-ish check (header must equal the
 * cookie value) rather than a blanket true/false, so both the "valid token"
 * and "missing/mismatched token" paths exercise the actual route logic engaging
 * with csrfValid's return value, not just a stub.
 *
 * Run with:
 *   node --experimental-strip-types --experimental-test-module-mocks \
 *        --import ./route-tests/register-hooks.mjs --test route-tests/*.routetest.mts
 */
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

const ACCOUNT = { id: "acct-1", handle: "tester@bc" };

let skillRows: Record<string, any> = {};
let shareRows: Record<string, any> = {};
let importRows: Record<string, any> = {};

const prismaMock = {
  userSkill: {
    findUnique: async ({ where }: any) => {
      const row = skillRows[where.id];
      if (!row) return null;
      return { ...row, account: { handle: "owner@bc" } };
    },
  },
  skillShare: {
    findUnique: async ({ where }: any) => {
      const key = where.skillId_sharedWithAccountId;
      return shareRows[`${key.skillId}:${key.sharedWithAccountId}`] ?? null;
    },
  },
  skillImport: {
    upsert: async ({ where, create }: any) => {
      const key = `${where.skillId_importedByAccountId.skillId}:${where.skillId_importedByAccountId.importedByAccountId}`;
      importRows[key] = { ...create, id: key };
      return importRows[key];
    },
    findMany: async ({ where }: any) => Object.values(importRows).filter((r: any) => r.importedByAccountId === where.importedByAccountId),
    deleteMany: async ({ where }: any) => {
      const before = Object.keys(importRows).length;
      importRows = Object.fromEntries(Object.entries(importRows).filter(([, r]: [string, any]) => !(r.id === where.id && r.importedByAccountId === where.importedByAccountId)));
      return { count: before - Object.keys(importRows).length };
    },
  },
  accountAudit: { create: async () => ({}) },
};

before(() => {
  mock.module("@/lib/db", { namedExports: { prisma: prismaMock } });
  mock.module("@/lib/auth", {
    namedExports: {
      getAccountFromAuth: async (header: string | null) => (header === "Bearer good" ? ACCOUNT : null),
      getAccountFromCookie: async (cookieValue: string | null | undefined) => (cookieValue === "cs_x" ? ACCOUNT : null),
      SESSION_COOKIE_NAME: "bc_session",
      CSRF_COOKIE_NAME: "bc_csrf",
      CSRF_HEADER: "x-bc-csrf",
      // Real-ish check: valid only if the header matches the cookie's token exactly.
      csrfValid: (headerVal: string | null, cookieVal: string | undefined) => !!headerVal && !!cookieVal && headerVal === cookieVal,
    },
  });
});

beforeEach(() => {
  skillRows = {
    skill_1: { id: "skill_1", accountId: "owner-1", kind: "template", signature: "sig", name: "Cool template", body: "do the thing", paramSchema: null, version: 1 },
  };
  shareRows = { "skill_1:acct-1": { skillId: "skill_1", sharedWithAccountId: "acct-1" } };
  importRows = {};
});

const BEARER_AUTH = { authorization: "Bearer good" };
const COOKIE_AUTH_VALID = { "x-bc-csrf": "tok123", cookie: "bc_session=cs_x; bc_csrf=tok123" };
const COOKIE_AUTH_MISSING_CSRF = { cookie: "bc_session=cs_x" }; // no x-bc-csrf header at all
const COOKIE_AUTH_MISMATCHED_CSRF = { "x-bc-csrf": "wrong", cookie: "bc_session=cs_x; bc_csrf=tok123" };

// --- POST /api/skills/:id/copy ----------------------------------------------------------

test("copy: bearer auth needs no CSRF token and succeeds", async () => {
  const { POST } = await import("@/app/api/skills/[id]/copy/route");
  const req = new NextRequest("https://back-channel.app/api/skills/skill_1/copy", { method: "POST", headers: BEARER_AUTH });
  const res = await POST(req, { params: Promise.resolve({ id: "skill_1" }) });
  assert.equal(res.status, 200, JSON.stringify(await res.json()));
});

test("copy: cookie auth WITH a matching CSRF token succeeds", async () => {
  const { POST } = await import("@/app/api/skills/[id]/copy/route");
  const req = new NextRequest("https://back-channel.app/api/skills/skill_1/copy", { method: "POST", headers: COOKIE_AUTH_VALID });
  const res = await POST(req, { params: Promise.resolve({ id: "skill_1" }) });
  assert.equal(res.status, 200, JSON.stringify(await res.json()));
});

test("copy: cookie auth with NO CSRF header is rejected with 403, not processed", async () => {
  const { POST } = await import("@/app/api/skills/[id]/copy/route");
  const req = new NextRequest("https://back-channel.app/api/skills/skill_1/copy", { method: "POST", headers: COOKIE_AUTH_MISSING_CSRF });
  const res = await POST(req, { params: Promise.resolve({ id: "skill_1" }) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "csrf");
  assert.equal(Object.keys(importRows).length, 0, "must not have recorded an import for a rejected request");
});

test("copy: cookie auth with a MISMATCHED CSRF token is rejected with 403", async () => {
  const { POST } = await import("@/app/api/skills/[id]/copy/route");
  const req = new NextRequest("https://back-channel.app/api/skills/skill_1/copy", { method: "POST", headers: COOKIE_AUTH_MISMATCHED_CSRF });
  const res = await POST(req, { params: Promise.resolve({ id: "skill_1" }) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "csrf");
});

// --- DELETE /api/skills/imported ---------------------------------------------------------

test("imported DELETE: bearer auth needs no CSRF token and succeeds", async () => {
  importRows["skill_1:acct-1"] = { id: "imp_1", skillId: "skill_1", importedByAccountId: "acct-1" };
  const { DELETE } = await import("@/app/api/skills/imported/route");
  const req = new NextRequest("https://back-channel.app/api/skills/imported?id=imp_1", { method: "DELETE", headers: BEARER_AUTH });
  const res = await DELETE(req);
  assert.equal(res.status, 200, JSON.stringify(await res.json()));
});

test("imported DELETE: cookie auth WITH a matching CSRF token succeeds", async () => {
  importRows["skill_1:acct-1"] = { id: "imp_1", skillId: "skill_1", importedByAccountId: "acct-1" };
  const { DELETE } = await import("@/app/api/skills/imported/route");
  const req = new NextRequest("https://back-channel.app/api/skills/imported?id=imp_1", { method: "DELETE", headers: COOKIE_AUTH_VALID });
  const res = await DELETE(req);
  assert.equal(res.status, 200, JSON.stringify(await res.json()));
});

test("imported DELETE: cookie auth with NO CSRF header is rejected with 403, and the import row survives untouched", async () => {
  importRows["skill_1:acct-1"] = { id: "imp_1", skillId: "skill_1", importedByAccountId: "acct-1" };
  const { DELETE } = await import("@/app/api/skills/imported/route");
  const req = new NextRequest("https://back-channel.app/api/skills/imported?id=imp_1", { method: "DELETE", headers: COOKIE_AUTH_MISSING_CSRF });
  const res = await DELETE(req);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "csrf");
  assert.ok(importRows["skill_1:acct-1"], "the import row must NOT have been deleted by a CSRF-rejected request");
});

test("imported DELETE: cookie auth with a MISMATCHED CSRF token is rejected with 403", async () => {
  importRows["skill_1:acct-1"] = { id: "imp_1", skillId: "skill_1", importedByAccountId: "acct-1" };
  const { DELETE } = await import("@/app/api/skills/imported/route");
  const req = new NextRequest("https://back-channel.app/api/skills/imported?id=imp_1", { method: "DELETE", headers: COOKIE_AUTH_MISMATCHED_CSRF });
  const res = await DELETE(req);
  assert.equal(res.status, 403);
  assert.ok(importRows["skill_1:acct-1"], "the import row must NOT have been deleted by a CSRF-rejected request");
});