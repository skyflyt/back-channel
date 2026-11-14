/**
 * Route tests for PATCH /api/account/settings: the writes behind Settings → Notifications and
 * Settings → Agents & Inbox, including the Advanced controls (an exact check interval, an exact live
 * length, limits on friends' requests). These tests pin the route's clamps. The page offers the same
 * ranges except the check interval, which it stops at 60 minutes until the skill can schedule longer
 * ones (docs/web-ia.md § Settings); the route still accepts up to 1440.
 *
 * Runs the REAL route file with @/lib/auth and @/lib/db mocked (no Postgres).
 */
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

const ACCOUNT = { id: "acct-1", handle: "tester@bc" };
type Row = Record<string, unknown>;
let stored: Row;
let updates: Row[];

before(() => {
  mock.module("@/lib/auth", {
    namedExports: {
      SESSION_COOKIE_NAME: "bc_session",
      CSRF_COOKIE_NAME: "bc_csrf",
      CSRF_HEADER: "x-bc-csrf",
      getAccountFromCookie: async (v: string | undefined) => (v === "good" ? ACCOUNT : null),
      csrfValid: (h: string | null, c: string | undefined) => !!h && !!c && h === c,
    },
  });
  mock.module("@/lib/db", {
    namedExports: {
      prisma: {
        account: {
          update: async ({ where, data }: { where: { id: string }; data: Row }) => {
            assert.equal(where.id, ACCOUNT.id, "only ever writes the signed-in account");
            updates.push(data);
            stored = { ...stored, ...data };
            return stored;
          },
        },
      },
    },
  });
});

beforeEach(() => {
  stored = { notifyIdleFrames: true, favorPerPeerDaily: 5, favorGlobalTokensDaily: 50000, liveModeDefaultMinutes: 15, inboxCheckEnabled: true, inboxCheckMinutes: 10 };
  updates = [];
});

function patch(body: unknown, o: { cookie?: string | null; csrf?: string | null } = {}) {
  const cookie = o.cookie === undefined ? "good" : o.cookie;
  const csrf = o.csrf === undefined ? "tok" : o.csrf;
  const headers: Record<string, string> = { "content-type": "application/json" };
  const jar = [cookie ? `bc_session=${cookie}` : "", "bc_csrf=tok"].filter(Boolean).join("; ");
  headers.cookie = jar;
  if (csrf !== null) headers["x-bc-csrf"] = csrf;
  return new NextRequest("https://back-channel.app/api/account/settings", { method: "PATCH", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}
const run = async (r: NextRequest) => (await import("@/app/api/account/settings/route")).PATCH(r);

test("401 signed out, 403 without the CSRF echo; nothing written", async () => {
  assert.equal((await run(patch({ inbox_check_minutes: 30 }, { cookie: null }))).status, 401);
  assert.equal((await run(patch({ inbox_check_minutes: 30 }, { csrf: null }))).status, 403);
  assert.equal((await run(patch({ inbox_check_minutes: 30 }, { csrf: "other" }))).status, 403);
  assert.equal(updates.length, 0);
});

test("400 on bad JSON and on a body with nothing it understands", async () => {
  assert.equal((await run(patch("{not json"))).status, 400);
  const r = await run(patch({ theme: "dark" }));
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "no_valid_fields");
  assert.equal(updates.length, 0);
});

test("the check interval: anything from 5 minutes to once a day, clamped and floored", async () => {
  for (const [sent, kept] of [[1440, 1440], [720, 720], [60, 60], [5, 5], [2, 5], [99999, 1440], [17.9, 17]] as const) {
    const r = await run(patch({ inbox_check_minutes: sent }));
    assert.equal(r.status, 200);
    assert.equal((await r.json()).inbox_check_minutes, kept, `sent ${sent}`);
  }
});

test("the live length: 1 to 120 minutes", async () => {
  for (const [sent, kept] of [[1, 1], [45, 45], [120, 120], [0, 1], [500, 120]] as const) {
    const r = await run(patch({ live_mode_default_minutes: sent }));
    assert.equal((await r.json()).live_mode_default_minutes, kept, `sent ${sent}`);
  }
});

test("limits on friends' requests: 0 (off) to 1,000 a friend, 0 to 100,000,000 tokens", async () => {
  let r = await run(patch({ favor_per_peer_daily: 0, favor_global_tokens_daily: 250000 }));
  let j = await r.json();
  assert.equal(j.favor_per_peer_daily, 0);
  assert.equal(j.favor_global_tokens_daily, 250000);
  r = await run(patch({ favor_per_peer_daily: 5000, favor_global_tokens_daily: -3 }));
  j = await r.json();
  assert.equal(j.favor_per_peer_daily, 1000);
  assert.equal(j.favor_global_tokens_daily, 0);
});

test("a number that isn't finite is ignored rather than written", async () => {
  // JSON cannot carry NaN or Infinity, but 1e400 parses to Infinity; it must never reach the database.
  const r = await run(patch('{"inbox_check_minutes": 1e400, "notify_idle_frames": false}'));
  assert.equal(r.status, 200);
  assert.equal(updates.length, 1);
  assert.deepEqual(Object.keys(updates[0]), ["notifyIdleFrames"]);
  const only = await run(patch('{"live_mode_default_minutes": -1e400}'));
  assert.equal(only.status, 400, "nothing valid left: refused, not written");
});

test("the reply carries every setting, so the page shows what the server actually kept", async () => {
  const j = await (await run(patch({ inbox_check_enabled: false }))).json();
  assert.deepEqual(Object.keys(j).sort(), ["favor_global_tokens_daily", "favor_per_peer_daily", "inbox_check_enabled", "inbox_check_minutes", "live_mode_default_minutes", "notify_idle_frames"]);
  assert.equal(j.inbox_check_enabled, false);
});
