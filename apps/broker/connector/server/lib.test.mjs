import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createBridge, looksLikeExchangeCode, redeemExchangeCode, cleanConfiguredToken } from "./lib.js";

function memoryKeystore() {
  let state = {};
  return { load: () => state, save: (s) => { state = s; }, _peek: () => state };
}

function harness({ token = "bc_test", fetchImpl, keystore = memoryKeystore(), readTokenFile } = {}) {
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
    ...(readTokenFile ? { readTokenFile } : {}),
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

// ── Unconnected mode + bc_connect (plugin hosts with no install-time secret prompt) ──

const exchangeOk = (extra = {}) => async (url, init) => {
  if (String(url).endsWith("/api/auth/exchange")) return new Response(JSON.stringify({ api_key: "bc_minted", handle: "alice@bc", agent_name: "Codex", ...extra }), { status: 200 });
  const m = JSON.parse(init.body);
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "bc_check_inbox" }], auth: init.headers.authorization } }), { status: 200 });
};

test("no token: the server still comes up — initialize, ping and tools/list are answered locally, nothing forwarded", async () => {
  let called = false;
  const h = harness({ token: "", fetchImpl: async () => { called = true; return new Response("{}"); } });
  await h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  await h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await h.send({ jsonrpc: "2.0", id: 2, method: "ping" });
  await h.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  await h.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "bc_check_inbox", arguments: {} } });
  assert.equal(called, false);
  const [init, ping, list, call] = h.parsed();
  assert.equal(h.parsed().length, 4, "the notification gets no reply line");
  assert.equal(init.result.protocolVersion, "2025-03-26", "echoes a supported requested version");
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: true }, resources: {} });
  assert.match(init.result.instructions, /bc_connect/);
  assert.deepEqual(ping.result, {});
  assert.deepEqual(list.result.tools.map((t) => t.name), ["bc_connect", "bc_open_panel"]);
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /isn't connected.*bc_connect/s);
  assert.match(call.result.content[0].text, /Never ask for the bc_ key/);
});

test("no token: an unsubstituted host placeholder counts as no token", async () => {
  assert.equal(cleanConfiguredToken("${user_config.token}"), "");
  assert.equal(cleanConfiguredToken("  bc_real  "), "bc_real");
  assert.equal(cleanConfiguredToken(undefined), "");
  const h = harness({ token: "${user_config.token}", fetchImpl: async () => { throw new Error("must not forward a placeholder as a bearer token"); } });
  await h.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(h.parsed()[0].result.tools.map((t) => t.name), ["bc_connect", "bc_open_panel"]);
});

test("bc_connect: redeems the code, persists the key, announces list_changed AFTER the reply, then forwards with the new key", async () => {
  const h = harness({ token: "", fetchImpl: exchangeOk() });
  await h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bc_connect", arguments: { code: " bcx-ab12-cd34 " } } });
  const [reply, note] = h.parsed();
  assert.equal(reply.id, 1);
  assert.equal(reply.result.isError, false);
  const body = JSON.parse(reply.result.content[0].text);
  assert.deepEqual([body.connected, body.handle, body.agent_name, body.persisted], [true, "alice@bc", "Codex", true]);
  assert.equal(reply.result.content[0].text.includes("bc_minted"), false, "the key itself is never shown to the model");
  assert.deepEqual(note, { jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  assert.equal(h.keystore._peek().__resolved_bc_token__.bcToken, "bc_minted");

  await h.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const list = h.parsed()[2];
  assert.equal(list.result.auth, "Bearer bc_minted");
  assert.deepEqual(list.result.tools.map((t) => t.name), ["bc_check_inbox", "bc_open_panel"], "once connected the catalog is the server's, plus the bridge's own panel");
});

test("bc_connect: malformed code and a spent code both fail plainly, stay unconnected, and announce nothing", async () => {
  const h = harness({ token: "", fetchImpl: async () => new Response(JSON.stringify({ error: "invalid_or_expired_code" }), { status: 410 }) });
  await h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bc_connect", arguments: { code: "bc_somekey" } } });
  await h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "bc_connect", arguments: { code: "BCX-DEAD-BEEF" } } });
  await h.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  const [bad, spent, list] = h.parsed();
  assert.equal(h.parsed().length, 3, "no list_changed notification on failure");
  assert.match(bad.result.content[0].text, /doesn't look like a connect code/);
  assert.equal(spent.result.isError, true);
  assert.match(spent.result.content[0].text, /already been used, expired, or doesn't exist/);
  assert.deepEqual(list.result.tools.map((t) => t.name), ["bc_connect", "bc_open_panel"]);
});

test("bc_connect: a key that can't be saved still connects this session and says it won't persist", async () => {
  const keystore = { load: () => ({}), save: () => { throw new Error("EACCES"); } };
  const h = harness({ token: "", fetchImpl: exchangeOk(), keystore });
  await h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bc_connect", arguments: { code: "BCX-AB12-CD34" } } });
  const body = JSON.parse(h.parsed()[0].result.content[0].text);
  assert.equal(body.connected, true);
  assert.equal(body.persisted, false);
  assert.match(body.note, /this session only/);
  await h.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(h.parsed().at(-1).result.auth, "Bearer bc_minted");
});

test("no token configured: adopts the installer's ~/.bc/token, and a key stored by an earlier bc_connect wins over it", async () => {
  const fetchImpl = async (_u, init) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { auth: init.headers.authorization } }), { status: 200 });
  const fromFile = harness({ token: "", fetchImpl, readTokenFile: () => "bc_from_cli\n" });
  await fromFile.send({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(fromFile.parsed()[0].result.auth, "Bearer bc_from_cli");

  const keystore = memoryKeystore();
  keystore.save({ __resolved_bc_token__: { bcToken: "bc_from_connect", updatedAt: Date.now() } });
  const both = harness({ token: "", fetchImpl, keystore, readTokenFile: () => "bc_from_cli" });
  await both.send({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(both.parsed()[0].result.auth, "Bearer bc_from_connect");

  // A configured token always wins and the fallbacks are never consulted.
  const configured = harness({ token: "bc_configured", fetchImpl, keystore, readTokenFile: () => { throw new Error("must not read the token file"); } });
  await configured.send({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(configured.parsed()[0].result.auth, "Bearer bc_configured");
});

test("pairing from another terminal mid-session takes effect on the next call, no restart", async () => {
  let onDisk = "";
  const h = harness({ token: "", readTokenFile: () => onDisk, fetchImpl: async (_u, init) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { auth: init.headers.authorization } }), { status: 200 }) });
  await h.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(h.parsed()[0].result.tools.map((t) => t.name), ["bc_connect", "bc_open_panel"]);
  onDisk = "bc_just_paired";
  await h.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(h.parsed()[1].result.auth, "Bearer bc_just_paired");
});

test("a fallback key the server refuses (401) is dropped: back to offering bc_connect, not replaying the dead key", async () => {
  let forwards = 0;
  const h = harness({ token: "", readTokenFile: () => "bc_revoked", fetchImpl: async () => { forwards++; return new Response('{"error":"unauthorized"}', { status: 401 }); } });
  await h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bc_check_inbox", arguments: {} } });
  const [err, note] = h.parsed();
  assert.equal(err.error.code, -32001);
  assert.match(err.error.message, /rejected the saved key.*bc_connect/s);
  assert.deepEqual(note, { jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  await h.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(h.parsed()[2].result.tools.map((t) => t.name), ["bc_connect", "bc_open_panel"]);
  assert.equal(forwards, 1, "the refused key is not tried again");
});

test("a CONFIGURED token is unaffected: bc_connect is not intercepted and a 401 keeps the settings hint", async () => {
  const seen = [];
  const h = harness({ token: "bc_configured", fetchImpl: async (_u, init) => { seen.push(JSON.parse(init.body)); return new Response('{"error":"unauthorized"}', { status: 401 }); } });
  await h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bc_connect", arguments: { code: "BCX-AB12-CD34" } } });
  assert.equal(seen[0].params.name, "bc_connect", "forwarded like any other call — the extension's settings own the token");
  assert.match(h.parsed()[0].error.message, /update the extension settings/);
  assert.equal(h.parsed().length, 1);
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
  assert.deepEqual(h.parsed()[0].result.tools.map((t) => t.name), ["bc_open_panel"]);
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

// ── bc_check_inbox wait_seconds (doorbell wait) ─────────────────────────────

function checkInboxCall(id, args) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name: "bc_check_inbox", ...(args ? { arguments: args } : {}) } };
}

test("bc_check_inbox: wait_seconds absent — no doorbell call, forwarded exactly as before (zero behavior change)", async () => {
  const calls = [];
  const h = harness({
    fetchImpl: async (u, init) => {
      calls.push(String(u));
      return new Response('{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"sessions\\":[]}"}]}}', { status: 200 });
    },
  });
  await h.send(checkInboxCall(1));
  assert.equal(calls.length, 1, "only the normal /api/mcp forward, no doorbell GET");
  assert.ok(calls[0].endsWith("/api/mcp"));
  const [r] = h.parsed();
  assert.deepEqual(JSON.parse(r.result.content[0].text), { sessions: [] }, "response passed through untouched");
});

test("bc_check_inbox: wait_seconds=0 — no doorbell call, same as absent", async () => {
  const calls = [];
  const h = harness({
    fetchImpl: async (u) => { calls.push(String(u)); return new Response('{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{}"}]}}', { status: 200 }); },
  });
  await h.send(checkInboxCall(1, { wait_seconds: 0 }));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].endsWith("/api/mcp"));
});

test("bc_check_inbox: wait_seconds out of range (>120) — local validation error, nothing forwarded", async () => {
  let called = false;
  const h = harness({ fetchImpl: async () => { called = true; return new Response("{}"); } });
  await h.send(checkInboxCall(1, { wait_seconds: 121 }));
  assert.equal(called, false, "must not forward or hit the doorbell on an invalid value");
  const [r] = h.parsed();
  assert.equal(r.error.code, -32602);
  assert.match(r.error.message, /between 0 and 120/);
});

test("bc_check_inbox: negative wait_seconds — local validation error", async () => {
  let called = false;
  const h = harness({ fetchImpl: async () => { called = true; return new Response("{}"); } });
  await h.send(checkInboxCall(1, { wait_seconds: -1 }));
  assert.equal(called, false);
  assert.match(h.parsed()[0].error.message, /between 0 and 120/);
});

test("bc_check_inbox: non-integer wait_seconds — local validation error", async () => {
  let called = false;
  const h = harness({ fetchImpl: async () => { called = true; return new Response("{}"); } });
  await h.send(checkInboxCall(1, { wait_seconds: 2.5 }));
  assert.equal(called, false);
  assert.match(h.parsed()[0].error.message, /between 0 and 120/);
});

test("bc_check_inbox: wait_seconds>0, doorbell reports pending — hits doorbell then forwards a wait_seconds-stripped tools/call", async () => {
  const calls = [];
  const h = harness({
    fetchImpl: async (u, init) => {
      const url = String(u);
      calls.push(url);
      if (url.includes("/api/inbox/check")) {
        assert.match(url, /wait=5\b/);
        return new Response(JSON.stringify({ pending_count: 2, since: "t0", timestamp: "t1", kinds: ["frame"], waited_seconds: 1 }), { status: 200 });
      }
      const sentMsg = JSON.parse(init.body);
      assert.equal(sentMsg.params.arguments.wait_seconds, undefined, "wait_seconds must be stripped before forwarding");
      return new Response('{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"sessions\\":[{\\"id\\":\\"s1\\"}]}"}]}}', { status: 200 });
    },
  });
  await h.send(checkInboxCall(1, { wait_seconds: 5 }));
  assert.equal(calls.length, 2, "doorbell GET, then the normal /api/mcp forward");
  assert.ok(calls[0].includes("/api/inbox/check"));
  assert.ok(calls[1].endsWith("/api/mcp"));
  const [r] = h.parsed();
  const body = JSON.parse(r.result.content[0].text);
  assert.deepEqual(body.sessions, [{ id: "s1" }]);
});

test("bc_check_inbox: wait_seconds>0, doorbell times out empty — still forwards the normal check, merges waited_seconds into the result", async () => {
  const h = harness({
    fetchImpl: async (u) => {
      const url = String(u);
      if (url.includes("/api/inbox/check")) {
        return new Response(JSON.stringify({ pending_count: 0, since: "t0", timestamp: "t1", waited_seconds: 5 }), { status: 200 });
      }
      return new Response('{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"sessions\\":[]}"}]}}', { status: 200 });
    },
  });
  await h.send(checkInboxCall(1, { wait_seconds: 5 }));
  const [r] = h.parsed();
  const body = JSON.parse(r.result.content[0].text);
  assert.deepEqual(body.sessions, []);
  assert.equal(body.waited_seconds, 5, "waited_seconds merged in so the agent knows it actually waited");
});

test("bc_check_inbox: doorbell call itself fails (network) — falls back to a normal un-waited forward, no waited_seconds merged", async () => {
  const h = harness({
    fetchImpl: async (u) => {
      const url = String(u);
      if (url.includes("/api/inbox/check")) throw new TypeError("fetch failed");
      return new Response('{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"sessions\\":[]}"}]}}', { status: 200 });
    },
  });
  await h.send(checkInboxCall(1, { wait_seconds: 5 }));
  const [r] = h.parsed();
  const body = JSON.parse(r.result.content[0].text);
  assert.equal(body.waited_seconds, undefined, "no fabricated waited_seconds when the doorbell call itself errored");
});

test("bc_check_inbox: doorbell GET carries the same bearer token as the normal forward", async () => {
  let doorbellAuth;
  const h = harness({
    token: "bc_mytoken",
    fetchImpl: async (u, init) => {
      const url = String(u);
      if (url.includes("/api/inbox/check")) {
        doorbellAuth = init.headers.authorization;
        return new Response(JSON.stringify({ pending_count: 0, waited_seconds: 1 }), { status: 200 });
      }
      return new Response('{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{}"}]}}', { status: 200 });
    },
  });
  await h.send(checkInboxCall(1, { wait_seconds: 1 }));
  assert.equal(doorbellAuth, "Bearer bc_mytoken");
});

// ── Thread-id handling (field report 2026-10-05) ────────────────────────────

const toolText = (obj, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(obj) }], isError });

test("bc_read_messages: canonical session_id is forwarded byte-for-byte", async () => {
  let body;
  const h = harness({ fetchImpl: async (_u, init) => { body = init.body; return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: toolText({ frames: [], next_cursor: 0 }) }), { status: 200 }); } });
  const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bc_read_messages", arguments: { session_id: "s1", role: "host" } } };
  await h.send(call);
  assert.equal(body, JSON.stringify(call));
});

test("bc_read_messages: thread_id alias is rewritten to session_id before forwarding, and keys the keystore by the real id", async () => {
  let forwarded;
  const { newEphemeralKeypair } = await import("./crypto.js");
  const peer = newEphemeralKeypair();
  const h = harness({
    fetchImpl: async (_u, init) => {
      forwarded = JSON.parse(init.body);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: toolText({ frames: [JSON.stringify({ type: "handshake.pubkey", pubkey: peer.publicKey })], next_cursor: 1 }) }), { status: 200 });
    },
  });
  await h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bc_read_messages", arguments: { thread_id: "s1", role: "host" } } });
  assert.deepEqual(forwarded.params.arguments, { role: "host", session_id: "s1" });
  assert.ok(h.keystore._peek().s1?.sessionKey, "peer key absorbed under the real session id");
  assert.equal(h.keystore._peek().undefined, undefined, "never a junk 'undefined' entry");
});

test("bc_read_messages / bc_send_message / bc_end_session with no thread id: local actionable error, nothing forwarded", async () => {
  let called = false;
  const h = harness({ fetchImpl: async () => { called = true; return new Response("{}"); } });
  await h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bc_read_messages", arguments: { role: "host" } } });
  await h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "bc_send_message", arguments: { role: "host", frame: { type: "msg", text: "hi" } } } });
  await h.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "bc_end_session", arguments: {} } });
  assert.equal(called, false);
  for (const r of h.parsed()) {
    assert.equal(r.error.code, -32602);
    assert.match(r.error.message, /missing thread id/);
    assert.match(r.error.message, /thread_id/, "tells the model the spelling to retry with");
  }
  assert.ok(h.logs.some((l) => /no thread id in arguments \(keys: role\)/.test(l)), "logs which argument NAMES arrived (never values) for field diagnosis");
  assert.deepEqual(h.keystore._peek(), {});
});

test("bc_send_message via thread_id: handshakes and seals under the real session id end to end", async () => {
  const { newEphemeralKeypair, deriveSessionKey, open } = await import("./crypto.js");
  const peer = newEphemeralKeypair();
  const seen = [];
  const h = harness({
    fetchImpl: async (_u, init) => {
      const m = JSON.parse(init.body);
      seen.push(m);
      const a = m.params.arguments;
      assert.equal(a.session_id, "s1", "every call the broker sees carries the canonical id");
      assert.equal("thread_id" in a, false);
      const result = m.params.name === "bc_read_messages"
        ? toolText({ frames: [JSON.stringify({ type: "handshake.pubkey", pubkey: peer.publicKey })], next_cursor: 1 })
        : toolText({ sent_seq: seen.length });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }), { status: 200 });
    },
  });
  await h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bc_send_message", arguments: { thread_id: "s1", role: "visitor", frame: { type: "msg", text: "handover" } } } });
  const [r] = h.parsed();
  assert.equal(r.result.isError, false);
  const last = seen.at(-1).params.arguments;
  assert.equal(last.frame.type, "enc");
  const ourPub = h.keystore._peek().s1.publicKey;
  assert.deepEqual(open(last.frame, deriveSessionKey(peer.handle, ourPub)), { type: "msg", text: "handover" });
});

test("bc_send_message: when the handshake read is rejected, the model gets the real reason — not 'handshake pending, retry'", async () => {
  const h = harness({
    fetchImpl: async (_u, init) => {
      const m = JSON.parse(init.body);
      const result = m.params.name === "bc_read_messages" ? toolText("HTTP 403: {\"error\":\"role_mismatch\",\"detail\":\"your account is the host on this session\"}", true) : toolText({ sent_seq: 1 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }), { status: 200 });
    },
  });
  await h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bc_send_message", arguments: { session_id: "s1", role: "visitor", frame: { type: "msg", text: "hi" } } } });
  const [r] = h.parsed();
  assert.equal(r.result.isError, true);
  const body = JSON.parse(r.result.content[0].text);
  assert.equal(body.handshake_pending, undefined);
  assert.match(body.message, /NOT sent/);
  assert.match(body.message, /role_mismatch/);
});

// ── Channel: push "you have mail" into the session (Claude Code research preview) ──

const FAST = { waitSeconds: 1, minGapMs: 1, unreadIntervalMs: 1, unconnectedMs: 1, shortPollsAfterBusy: 2, minBackoffMs: 1, maxBackoffMs: 4 };
const until = async (cond, ms = 2000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 2)); } };
const initReply = (id) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "back-channel", version: "1.0.0" }, instructions: "Server says hi." } }), { status: 200 });

function channelHarness(doorbell, { token = "bc_test", channel = true, readTokenFile } = {}) {
  const stdin = new PassThrough();
  const lines = [];
  const stdout = { write: (s) => { lines.push(...String(s).split("\n").filter(Boolean).map((l) => JSON.parse(l))); return true; } };
  const polls = [];
  const fetchImpl = async (u, init) => {
    const url = String(u);
    if (url.includes("/api/inbox/check")) {
      polls.push({ wait: new URL(url).searchParams.get("wait"), auth: init.headers.authorization });
      return doorbell(polls.length, init);
    }
    return initReply(JSON.parse(init.body).id);
  };
  const bridge = createBridge({ url: "https://example.test/api/mcp", token, stdin, stdout, fetchImpl, timeoutMs: 200, keystore: memoryKeystore(), log: () => {}, channel, channelTiming: FAST, ...(readTokenFile ? { readTokenFile } : {}) });
  bridge.start();
  const send = async (obj) => { stdin.write(JSON.stringify(obj) + "\n"); await bridge.flush(); };
  const events = () => lines.filter((l) => l.method === "notifications/claude/channel");
  return { bridge, send, lines, polls, events };
}
const pending = (n, kinds) => new Response(JSON.stringify({ pending_count: n, ...(kinds ? { kinds } : {}), waited_seconds: 0 }), { status: 200 });

test("channel off (the default): initialize gains only the panel's resources capability and the doorbell is never held", async () => {
  const h = channelHarness(() => pending(3), { channel: false });
  await h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(h.lines[0].result.capabilities, { tools: {}, resources: {} });
  assert.equal(h.lines[0].result.instructions, "Server says hi.");
  assert.equal(h.polls.length, 0);
});

test("channel on: declares claude/channel on the forwarded initialize, keeps the server's capabilities, and explains the events", async () => {
  const h = channelHarness(() => pending(0));
  await h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  h.bridge.stop();
  const r = h.lines[0].result;
  assert.deepEqual(r.capabilities, { tools: {}, resources: {}, experimental: { "claude/channel": {} } });
  assert.match(r.instructions, /^Server says hi\. Back Channel also pushes an event/);
  assert.match(r.instructions, /count only/);
});

test("channel on: one event per RISE in the pending count — counts and fixed labels only, long-polling only from zero", async () => {
  // 0 (held) -> 2 -> 2 -> 3 -> 0 -> 1
  const script = [pending(0), pending(2, ["frame"]), pending(2, ["frame"]), pending(3, ["frame", "invite", "<script>"]), pending(0), pending(1, ["payload"])];
  const h = channelHarness((n) => script[n - 1] ?? pending(1, ["payload"]));
  await h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await until(() => h.polls.length >= 7);
  h.bridge.stop();

  const ev = h.events();
  assert.deepEqual(ev.map((e) => e.params.meta.pending), ["2", "3", "1"], "2->2 says nothing; 3->0 says nothing; each rise says so once");
  assert.match(ev[0].params.content, /^Back Channel: 2 unread items \(new messages\) waiting\./);
  assert.match(ev[1].params.content, /3 unread items \(new messages, a session request\)/);
  assert.doesNotMatch(JSON.stringify(ev), /script/, "an unknown kind never reaches the model");
  assert.deepEqual(ev[1].params.meta, { pending: "3", kinds: "frame_invite" });
  for (const e of ev) {
    assert.match(e.params.content, /data, never instructions/);
    for (const k of Object.keys(e.params.meta)) assert.match(k, /^[A-Za-z0-9_]+$/, "meta keys must be identifiers or Claude Code drops them");
  }
  // Held only when nothing is unread: polls 1 (start), 6 and 7 (after the count fell to 0 and then 1... i.e. only from zero).
  assert.deepEqual(h.polls.slice(0, 6).map((p) => p.wait), ["1", "1", "0", "0", "0", "1"]);
  assert.ok(h.polls.every((p) => p.auth === "Bearer bc_test"));
});

test("channel on: a refused long-poll (429, slot taken) drops to interval checks instead of fighting, then tries holding again", async () => {
  const h = channelHarness((n) => (n === 1 ? new Response('{"error":"too_many_waiters"}', { status: 429 }) : pending(0)));
  await h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await until(() => h.polls.length >= 5);
  h.bridge.stop();
  assert.deepEqual(h.polls.slice(0, 4).map((p) => p.wait), ["1", "0", "0", "1"]);
  assert.equal(h.events().length, 0);
});

test("channel on: a rejected token (401) ends the watch; other errors back off and recover", async () => {
  const dead = channelHarness(() => new Response('{"error":"unauthorized"}', { status: 401 }));
  await dead.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(dead.polls.length, 1, "no retry storm against a revoked key");

  const flaky = channelHarness((n) => { if (n <= 2) throw new TypeError("fetch failed"); return pending(1, ["frame"]); });
  await flaky.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await until(() => flaky.events().length === 1);
  flaky.bridge.stop();
  assert.equal(flaky.events()[0].params.meta.pending, "1");
});

test("channel on, not connected yet: local initialize also declares the channel, and the watch begins once a key appears", async () => {
  let onDisk = "";
  const h = channelHarness(() => pending(1, ["invite"]), { token: "", readTokenFile: () => onDisk });
  await h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.deepEqual(h.lines[0].result.capabilities, { tools: { listChanged: true }, resources: {}, experimental: { "claude/channel": {} } });
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(h.polls.length, 0, "nothing to authenticate with yet");
  onDisk = "bc_paired_later";
  await until(() => h.events().length === 1);
  h.bridge.stop();
  assert.equal(h.polls[0].auth, "Bearer bc_paired_later");
});

test("channel on: stop() cancels a held long-poll so the process can exit", async () => {
  let aborted = false;
  const h = channelHarness((_n, init) => new Promise((_res, rej) => init.signal.addEventListener("abort", () => { aborted = true; rej(new Error("aborted")); })));
  await h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await until(() => h.polls.length === 1);
  h.bridge.stop();
  await until(() => aborted);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.polls.length, 1, "no further polls after stop");
});
