/**
 * Route tests for GET /api/account/identity. The route is intentionally
 * bearer-only and returns exactly one stable account identifier.
 */
import { test, mock, before } from "node:test";
import assert from "node:assert/strict";

const ACCOUNT = { id: "acct-stable" };
let seenAuth: string | null | undefined;

before(() => {
  mock.module("@/lib/auth", {
    namedExports: {
      getAccountFromAuth: async (header: string | null) => {
        seenAuth = header;
        return header === "Bearer good" ? ACCOUNT : null;
      },
    },
  });
});

function request(headers: HeadersInit = {}) {
  return new Request("https://back-channel.app/api/account/identity", { headers });
}

test("returns only accountId for a valid bearer", async () => {
  const { GET } = await import("@/app/api/account/identity/route");
  seenAuth = undefined;
  const res = await GET(request({ authorization: "Bearer good" }) as any);

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { accountId: "acct-stable" });
  assert.equal(seenAuth, "Bearer good");
});

test("rejects missing or invalid bearer credentials", async () => {
  const { GET } = await import("@/app/api/account/identity/route");
  for (const headers of [{}, { authorization: "Bearer revoked" }]) {
    const res = await GET(request(headers) as any);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  }
});

test("rejects cookie-only browser authentication", async () => {
  const { GET } = await import("@/app/api/account/identity/route");
  seenAuth = undefined;
  const res = await GET(request({ cookie: "bc_session=browser-session" }) as any);

  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "unauthorized" });
  assert.equal(seenAuth, null, "cookie is not passed to bearer auth");
});
