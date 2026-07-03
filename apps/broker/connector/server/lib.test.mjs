import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createBridge, looksLikeExchangeCode, redeemExchangeCode } from "./lib.js";

function memoryKeystore() {
  let state = {};
  return { load: () => state, save: (s) => { state = s; }, _peek: () => state };
}

function harness({ token = "bc_test", fetchImpl, keystore = memoryKeystore() } = {}) {
  const stdin = new PassThrough();
  const outLines = [];
  const stdout = { write: (s) => { outLines.push(...String(s).split("\n").filter(Boolean)); return true; } };
  const logs = [];
  const bridge = createBridge({
    url: "https://example.test/api/mcp",
    token,
    stdin,
    stdout,
    fetchImpl,
    timeoutMs: 200,
    keystore,
    log: (...a) => logs.push(a.join(" ")),
  });
  bridge.start();
  const send = async (obj) => { stdin.write(JSON.stringify(obj) + "\n"); await bridge.flush(); };
  return { stdin, outLines, logs, bridge, send, keystore, parsed: () => outLines.map((l) => JSON.parse(l)) };
}

const okFetch = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });

test("forwards a request and writes the response line", async () => {
  const h = harness({ fetchImpl: okFetch({ jsonrpc: "2.0", id: 1, result: { ok: true } }) });
  await h.send({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.deepEqual(h.parsed(), [{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
});

test("forwards auth header + body verbatim, with a bounded abort signal", async () => {
  let seen;
  const h = harness({
    fetchImpl: async (url, init) => { seen = { url, init }; return new Response('{"jsonrpc":"2.0","id":5,"result":{}}', { status: 200 }); },
  });
  await h.send({ jsonrpc: "2.0", id: 5, method: "tools/list" });
  assert.equal(seen.url, "https://example.test/api/mcp");
  assert.equal(seen.init.headers.authorization, "Bearer bc_test");
  assert.equal(seen.init.body, '{"jsonrpc":"2.0","id":5,"method":"tools/list"}');
  assert.ok(seen.init.signal instanceof AbortSignal, "every request carries an AbortSignal");
});

test("notifications produce NO stdout line (202 empty)", async () => {
  const h = harness({ fetchImpl: async () => new Response(null, { status: 202 }) });
  await h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.deepEqual(h.outLines, []);
});

test("split/multi-line chunks: partial JSON across chunks still parses; order preserved", async () => {
  const responses = [];
  const h = harness({
    fetchImpl: async (_u, init) => {
      const { id } = JSON.parse(init.body);
      responses.push(id);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { n: id } }), { status: 200 });
    },
  });
  const l1 = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
  const l2 = '{"jsonrpc":"2.0","id":2,"method":"ping"}';
  h.stdin.write(l1.slice(0, 10));
  h.stdin.write(l1.slice(10) + "\n" + l2 + "\n");
  await h.bridge.flush();
  assert.deepEqual(responses, [1, 2]);
  assert.deepEqual(h.parsed().map((r) => r.id), [1, 2]);
});

test("401 becomes a token-hint JSON-RPC error", async () => {
  const h = harness({ fetchImpl: async () => new Response('{"error":"unauthorized"}', { status: 401 }) });
  await h.send({ jsonrpc: "2.0", id: 9, method: "tools/list" });
  const [r] = h.parsed();
  assert.equal(r.error.code, -32001);
  assert.match(r.error.message, /Connect a new agent/);
});

test("unreachable server becomes a connectivity error, not a crash", async () => {
  const h = harness({ fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  await h.send({ jsonrpc: "2.0", id: 3, method: "ping" });
  const [r] = h.parsed();
  assert.equal(r.error.code, -32000);
  assert.match(r.error.message, /Can't reach/);
});

test("timeout is translated per-message (session survives)", async () => {
  // Throw TimeoutError directly rather than waiting on a real AbortSignal.timeout:
  // its internal timer is unref'ed, so on a quiet event loop (CI) the loop drains
  // before it fires and node --test cancels the pending test.
  const h = harness({
    fetchImpl: async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); },
  });
  await h.send({ jsonrpc: "2.0", id: 4, method: "tools/call" });
  const [r] = h.parsed();
  assert.match(r.error.message, /didn't answer/);
});

test("empty 5xx body becomes an explicit error", async () => {
  const h = harness({ fetchImpl: async () => new Response("", { status: 502 }) });
  await h.send({ jsonrpc: "2.0", id: 6, method: "ping" });
  assert.match(h.parsed()[0].error.message, /empty HTTP 502/);
});

test("missing token: local error with settings hint, nothing forwarded", async () => {
  let called = false;
  const h = harness({ token: "", fetchImpl: async () => { called = true; return new Response("{}"); } });
  await h.send({ jsonrpc: "2.0", id: 7, method: "initialize" });
  assert.equal(called, false);
  assert.match(h.parsed()[0].error.message, /No Back Channel token/);
});

test("garbage input line -> -32700, does not kill the bridge", async () => {
  const h = harness({ fetchImpl: okFetch({ jsonrpc: "2.0", id: 8, result: {} }) });
  h.stdin.write("not json at all\n");
  await h.bridge.flush();
  await h.send({ jsonrpc: "2.0", id: 8, method: "ping" });
  const rs = h.parsed();
  assert.equal(rs[0].error.code, -32700);
  assert.equal(rs[1].id, 8);
});

// ── Exchange-code bootstrap (BCX-… in the token field) ──────────────────────

test("looksLikeExchangeCode: recognizes BCX-XXXX-XXXX, case/whitespace-insensitive; rejects bc_ keys", () => {
  assert.equal(looksLikeExchangeCode("BCX-AB12-CD34"), true);
  assert.equal(looksLikeExchangeCode("  bcx-ab12-cd34  "), true);
  assert.equal(looksLikeExchangeCode("bc_realkeyabc123"), false);
  assert.equal(looksLikeExchangeCode(""), false);
  assert.equal(looksLikeExchangeCode("BCX-TOOLONGCODE-1234"), false);
});

test("redeemExchangeCode: success returns the minted api_key", async () => {
  let seenUrl, seenBody;
  const fetchImpl = async (url, init) => {
    seenUrl = url;
    seenBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ api_key: "bc_minted123", handle: "alice@bc", agent_id: "a1", agent_name: "Claude Desktop" }), { status: 200 });
  };
  const apiKey = await redeemExchangeCode("bcx-ab12-cd34", { mcpUrl: "https://example.test/api/mcp", fetchImpl });
  assert.equal(apiKey, "bc_minted123");
  assert.equal(seenUrl, "https://example.test/api/auth/exchange");
  assert.equal(seenBody.code, "BCX-AB12-CD34"); // normalized upper-case before send
});

test("redeemExchangeCode: 410 (used/expired/unknown) throws one friendly, non-technical error", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: "invalid_or_expired_code" }), { status: 410 });
  await assert.rejects(
    () => redeemExchangeCode("BCX-AAAA-BBBB", { mcpUrl: "https://example.test/api/mcp", fetchImpl }),
    (err) => {
      assert.match(err.message, /already been used, expired, or doesn't exist/);
      assert.match(err.message, /Connect a new agent/);
      return true;
    },
  );
});

test("bridge: exchange code in token config is redeemed on first tool call, then used to forward with the minted bc_ key", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    if (String(url).endsWith("/api/auth/exchange")) {
      return new Response(JSON.stringify({ api_key: "bc_minted999", handle: "alice@bc" }), { status: 200 });
    }
    assert.equal(init.headers.authorization, "Bearer bc_minted999", "forward must use the MINTED key, not the raw code");
    return new Response('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}', { status: 200 });
  };
  const h = harness({ token: "BCX-AB12-CD34", fetchImpl });
  await h.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(h.parsed(), [{ jsonrpc: "2.0", id: 1, result: { tools: [] } }]);
  assert.ok(calls.some((u) => u.endsWith("/api/auth/exchange")), "exchange endpoint was called");
});

test("bridge: minted key from a redeemed code is persisted to the keystore and reused without re-redeeming", async () => {
  const keystore = memoryKeystore();
  let exchangeCalls = 0;
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith("/api/auth/exchange")) {
      exchangeCalls++;
      return new Response(JSON.stringify({ api_key: "bc_persisted" }), { status: 200 });
    }
    return new Response(`{"jsonrpc":"2.0","id":${JSON.parse(init.body).id},"result":{}}`, { status: 200 });
  };
  const h1 = harness({ token: "BCX-AB12-CD34", fetchImpl, keystore });
  await h1.send({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(exchangeCalls, 1);

  // Simulate a Desktop restart: fresh bridge, SAME keystore, SAME (already-used) code still in config.
  const h2 = harness({ token: "BCX-AB12-CD34", fetchImpl, keystore });
  await h2.send({ jsonrpc: "2.0", id: 2, method: "ping" });
  assert.equal(exchangeCalls, 1, "second bridge instance must reuse the persisted key, not re-redeem the code");
});

test("bridge: already-used/expired code (410) surfaces a friendly local error, nothing forwarded", async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/api/auth/exchange")) return new Response(JSON.stringify({ error: "invalid_or_expired_code" }), { status: 410 });
    throw new Error("should not forward past a failed redemption");
  };
  const h = harness({ token: "BCX-DEAD-BEEF", fetchImpl });
  await h.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const [r] = h.parsed();
  assert.match(r.error.message, /already been used, expired, or doesn't exist/);

  // Second call also fails fast without hammering the exchange endpoint again.
  await h.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.match(h.parsed()[1].error.message, /already been used, expired, or doesn't exist/);
});

test("bridge: raw bc_ token passes through unchanged (no exchange call, existing behavior preserved)", async () => {
  let exchangeCalled = false;
  const h = harness({
    token: "bc_rawtoken",
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/api/auth/exchange")) exchangeCalled = true;
      assert.equal(init.headers.authorization, "Bearer bc_rawtoken");
      return new Response('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}', { status: 200 });
    },
  });
  await h.send({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(exchangeCalled, false);
  assert.deepEqual(h.parsed(), [{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
});
