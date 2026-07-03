/**
 * Route tests for the link-lesson artifact lifecycle (Link Lessons epic, WS-A):
 * create via POST /api/skills, share/revoke via the public-share routes, and
 * the /a/<token> envelope. Runs the REAL route handlers with @/lib/db (prisma)
 * and @/lib/auth mocked out — no Postgres needed. Follows the same
 * node:test module-mock pattern as inbox-check.routetest.mts /
 * mcp-check-inbox-wait.routetest.mts.
 *
 * Uses NextRequest (not a plain Request) for any call that needs cookie
 * parsing (public-share / revoke / the /a/<token> signedIn check) — a plain
 * Request has no `.cookies` property, only NextRequest does.
 *
 * Run with:
 *   node --experimental-strip-types --experimental-test-module-mocks \
 *        --import ./route-tests/register-hooks.mjs --test route-tests/*.routetest.mts
 */
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

const ACCOUNT = { id: "acct-1", handle: "tester@bc", agentPubkey: null, reserved: false };

// In-memory fake "table" for UserSkill, keyed by id. Reset per-test via beforeEach.
let rows: Record<string, any> = {};
let nextId = 1;

function fakeSkillCreate({ data }: { data: any }) {
  const id = `skill_${nextId++}`;
  const row = {
    id, accountId: data.accountId, name: data.name, description: data.description ?? null,
    type: data.type ?? "skill", kind: data.kind ?? "rpc", body: data.body, signature: data.signature ?? null,
    manifest: data.manifest ?? null, paramSchema: data.paramSchema ?? null, revision: data.revision ?? null,
    discoverable: true, version: 1, publicToken: data.publicToken ?? null, publicExpiresAt: data.publicExpiresAt ?? null,
    publicRevokedAt: null, createdAt: new Date(), updatedAt: new Date(),
  };
  rows[id] = row;
  return row;
}

const prismaMock = {
  userSkill: {
    create: async (args: any) => fakeSkillCreate(args),
    findUnique: async ({ where }: any) => {
      if (where.id) return rows[where.id] ?? null;
      if (where.publicToken) return Object.values(rows).find((r: any) => r.publicToken === where.publicToken) ?? null;
      return null;
    },
    findMany: async ({ where }: any) => Object.values(rows).filter((r: any) => r.accountId === where.accountId),
    update: async ({ where, data }: any) => {
      const row = rows[where.id];
      if (!row) throw new Error("not found");
      Object.assign(row, data);
      return row;
    },
  },
  account: {
    findUnique: async ({ where }: any) => (where.id === ACCOUNT.id ? ACCOUNT : null),
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
      csrfValid: () => true,
    },
  });
});

beforeEach(() => {
  rows = {};
  nextId = 1;
});

const AUTH = { authorization: "Bearer good" };
const COOKIE_AUTH = { "x-bc-csrf": "t", cookie: "bc_session=cs_x; bc_csrf=t" };

test("create: POST /api/skills with type=link and a valid url succeeds, storing url/title/notes/source in manifest", async () => {
  const { POST } = await import("@/app/api/skills/route");
  const req = new NextRequest("https://back-channel.app/api/skills", {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ type: "link", name: "Cool link", manifest: { url: "https://github.com/foo/bar", title: "Cool link", notes: "worth reading" } }),
  });
  const res = await POST(req);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.equal(body.type, "link");

  const stored = rows[body.id];
  assert.ok(stored, "row was persisted");
  assert.equal(stored.manifest.url, "https://github.com/foo/bar");
  assert.equal(stored.manifest.title, "Cool link");
  assert.equal(stored.manifest.notes, "worth reading");
  assert.equal(stored.manifest.source, "github", "source is server-derived from the github.com host");
  assert.ok(stored.body && stored.body.length > 0, "body is non-empty (broker requires it)");
});

test("create: a client-supplied `source` in the manifest is ignored — the broker always re-derives it", async () => {
  const { POST } = await import("@/app/api/skills/route");
  const req = new NextRequest("https://back-channel.app/api/skills", {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ type: "link", name: "Spoofed source", manifest: { url: "https://example.com/x", source: "backchannel" } }),
  });
  const res = await POST(req);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(rows[body.id].manifest.source, "web", "example.com is not the app's own host, so source must be 'web' regardless of client input");
});

test("create: rejects javascript: scheme with 400 and a clear error", async () => {
  const { POST } = await import("@/app/api/skills/route");
  const req = new NextRequest("https://back-channel.app/api/skills", {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ type: "link", name: "Bad", manifest: { url: "javascript:alert(1)" } }),
  });
  const res = await POST(req);
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error, "url_scheme_not_allowed");
  assert.match(body.message, /http/);
});

test("create: rejects data: scheme with 400", async () => {
  const { POST } = await import("@/app/api/skills/route");
  const req = new NextRequest("https://back-channel.app/api/skills", {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ type: "link", name: "Bad", manifest: { url: "data:text/html,evil" } }),
  });
  const res = await POST(req);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "url_scheme_not_allowed");
});

test("create: rejects file: scheme with 400", async () => {
  const { POST } = await import("@/app/api/skills/route");
  const req = new NextRequest("https://back-channel.app/api/skills", {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ type: "link", name: "Bad", manifest: { url: "file:///etc/passwd" } }),
  });
  const res = await POST(req);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "url_scheme_not_allowed");
});

test("full lifecycle: create (signed) -> public-share -> /a/<token> envelope has warning + full url -> revoke -> /a/<token> is gone", async () => {
  const { POST: createSkill } = await import("@/app/api/skills/route");
  const createReq = new NextRequest("https://back-channel.app/api/skills", {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({
      type: "link", name: "Lifecycle link", signature: "sig_abc",
      manifest: { url: "https://example.com/deep/path?x=1", title: "Lifecycle link", notes: "read before installing" },
    }),
  });
  const createRes = await createSkill(createReq);
  const created = await createRes.json();
  assert.equal(createRes.status, 200, JSON.stringify(created));
  const id = created.id;

  // Share publicly (owner action; cookie+CSRF path in the real route).
  const { POST: publicShare } = await import("@/app/api/artifacts/[id]/public-share/route");
  const shareReq = new NextRequest("https://back-channel.app/api/artifacts/x/public-share", { method: "POST", headers: COOKIE_AUTH });
  const shareRes = await publicShare(shareReq, { params: Promise.resolve({ id }) });
  const shareBody = await shareRes.json();
  assert.equal(shareRes.status, 200, JSON.stringify(shareBody));
  assert.ok(shareBody.token);
  const token = shareBody.token;

  // Fetch the envelope (agent-facing JSON) via the real /a/<token> route.
  const { GET: getShared } = await import("@/app/a/[token]/route");
  const envReq = new NextRequest(`https://back-channel.app/a/${token}`, { headers: { accept: "application/json" } });
  const envRes = await getShared(envReq, { params: Promise.resolve({ token }) });
  assert.equal(envRes.status, 200);
  const envelope = await envRes.json();
  assert.equal(envelope.artifact.type, "link");
  assert.equal(envelope.artifact.manifest.url, "https://example.com/deep/path?x=1", "the FULL url must appear, not truncated");
  assert.match(envelope.install_instructions.human_readable_md, /Back Channel has not scanned or reviewed it/, "canonical agent warning present");
  assert.equal(envelope.install_instructions.install_verb, "review");

  // Also fetch the HTML landing page and check the full warning + full url render there too.
  // esc() HTML-escapes apostrophes to &#39;, so match against the escaped form.
  const htmlReq = new NextRequest(`https://back-channel.app/a/${token}`, { headers: {} });
  const htmlRes = await getShared(htmlReq, { params: Promise.resolve({ token }) });
  const html = await htmlRes.text();
  assert.match(html, /https:\/\/example\.com\/deep\/path\?x=1/);
  assert.match(html, /We don&#39;t scan or review external lessons/);

  // Revoke.
  const { POST: revoke } = await import("@/app/api/artifacts/[id]/public-share/revoke/route");
  const revokeReq = new NextRequest("https://back-channel.app/api/artifacts/x/public-share/revoke", { method: "POST", headers: COOKIE_AUTH });
  const revokeRes = await revoke(revokeReq, { params: Promise.resolve({ id }) });
  assert.equal(revokeRes.status, 200);

  // The token is now dead — uniform-opaque 404.
  const goneReq = new NextRequest(`https://back-channel.app/a/${token}`, { headers: { accept: "application/json" } });
  const goneRes = await getShared(goneReq, { params: Promise.resolve({ token }) });
  assert.equal(goneRes.status, 404);
});
