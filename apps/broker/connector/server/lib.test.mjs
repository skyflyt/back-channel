import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createBridge } from "./lib.js";

function harness({ token = "bc_test", fetchImpl } = {}) {
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
    log: (...a) => logs.push(a.join(" ")),
  });
  bridge.start();
  const send = async (obj) => { stdin.write(JSON.stringify(obj) + "\n"); await bridge.flush(); };
  return { stdin, outLines, logs, bridge, send, parsed: () => outLines.map((l) => JSON.parse(l)) };
}

const okFetch = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });

test("forwards a request and writes the response line", async () => {
  const h = harness({ fetchImpl: okFetch({ jsonrpc: "2.0", id: 1, result: { ok: true } }) });
  await h.send({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.deepEqual(h.parsed(), [{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
});

test("forwards auth header + body verbatim", async () => {
  let seen;
  const h = harness({
    fetchImpl: async (url, init) => { seen = { url, init }; return new Response('{"jsonrpc":"2.0","id":5,"result":{}}', { status: 200 }); },
  });
  await h.send({ jsonrpc: "2.0", id: 5, method: "tools/list" });
  assert.equal(seen.url, "https://example.test/api/mcp");
  assert.equal(seen.init.headers.authorization, "Bearer bc_test");
  assert.equal(seen.init.body, '{"jsonrpc":"2.0","id":5,"method":"tools/list"}');
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
  const h = harness({
    fetchImpl: (_u, init) => new Promise((_res, rej) => {
      init.signal.addEventListener("abort", () => rej(Object.assign(new Error("t"), { name: "TimeoutError" })));
    }),
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
