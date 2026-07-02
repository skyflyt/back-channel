import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateMessage,
  isNotification,
  negotiateProtocolVersion,
  initializeResult,
  rpcResult,
  rpcError,
  toolCallResult,
  SUPPORTED_PROTOCOL_VERSIONS,
  PARSE_ERROR,
  INVALID_REQUEST,
} from "./protocol.mjs";

test("validateMessage rejects batches (removed in MCP 2025-06-18)", () => {
  const v = validateMessage([{ jsonrpc: "2.0", method: "ping", id: 1 }]);
  assert.equal(v.ok, false);
  assert.equal(v.response.error.code, INVALID_REQUEST);
  assert.match(v.response.error.message, /batch/i);
});

test("validateMessage rejects non-2.0 and missing method", () => {
  for (const bad of [null, 42, "x", {}, { jsonrpc: "1.0", method: "ping" }, { jsonrpc: "2.0" }, { jsonrpc: "2.0", method: 5 }]) {
    assert.equal(validateMessage(bad).ok, false, JSON.stringify(bad));
  }
});

test("validateMessage rejects object/boolean ids, accepts string/number/null/absent", () => {
  assert.equal(validateMessage({ jsonrpc: "2.0", method: "m", id: {} }).ok, false);
  assert.equal(validateMessage({ jsonrpc: "2.0", method: "m", id: true }).ok, false);
  for (const id of ["a", 7, null]) {
    assert.equal(validateMessage({ jsonrpc: "2.0", method: "m", id }).ok, true);
  }
  assert.equal(validateMessage({ jsonrpc: "2.0", method: "m" }).ok, true);
});

test("isNotification: absent or null id — and ping is NOT structurally special", () => {
  assert.equal(isNotification({ jsonrpc: "2.0", method: "notifications/initialized" }), true);
  assert.equal(isNotification({ jsonrpc: "2.0", method: "anything", id: null }), true);
  // ping arrives WITH an id — it is a request and must get a result.
  assert.equal(isNotification({ jsonrpc: "2.0", method: "ping", id: 3 }), false);
});

test("protocol version negotiation echoes supported, falls back to latest", () => {
  for (const v of SUPPORTED_PROTOCOL_VERSIONS) assert.equal(negotiateProtocolVersion(v), v);
  assert.equal(negotiateProtocolVersion("1999-01-01"), SUPPORTED_PROTOCOL_VERSIONS[0]);
  assert.equal(negotiateProtocolVersion(undefined), SUPPORTED_PROTOCOL_VERSIONS[0]);
});

test("initializeResult advertises tools capability + serverInfo", () => {
  const r = initializeResult("2025-06-18");
  assert.equal(r.protocolVersion, "2025-06-18");
  assert.deepEqual(r.capabilities, { tools: {} });
  assert.equal(r.serverInfo.name, "back-channel");
  assert.ok(r.instructions.length > 0);
});

test("rpc helpers shape envelopes correctly", () => {
  assert.deepEqual(rpcResult(1, { a: 1 }), { jsonrpc: "2.0", id: 1, result: { a: 1 } });
  const e = rpcError(2, PARSE_ERROR, "bad", { hint: "x" });
  assert.deepEqual(e, { jsonrpc: "2.0", id: 2, error: { code: PARSE_ERROR, message: "bad", data: { hint: "x" } } });
  assert.equal(rpcError(undefined, PARSE_ERROR, "bad").id, null);
});

test("toolCallResult: 2xx plain, non-2xx isError with status prefix", () => {
  const ok = toolCallResult(1, 200, '{"ok":true}');
  assert.equal(ok.result.isError, false);
  assert.equal(ok.result.content[0].text, '{"ok":true}');
  const err = toolCallResult(1, 403, '{"error":"not_available"}');
  assert.equal(err.result.isError, true);
  assert.match(err.result.content[0].text, /^HTTP 403: /);
});
