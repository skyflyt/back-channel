import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, getTool, normalizeToolArgs, validateToolArgs, MISSING_THREAD_ID } from "./tools.mjs";

test("catalog: every tool has a bc_ name, description, and object schema", () => {
  assert.ok(TOOLS.length >= 8);
  const names = new Set();
  for (const t of TOOLS) {
    assert.match(t.name, /^bc_[a-z_]+$/);
    assert.ok(!names.has(t.name), `duplicate tool ${t.name}`);
    names.add(t.name);
    assert.ok(t.description.length > 40, `${t.name} needs a real description`);
    assert.equal(t.inputSchema.type, "object");
  }
});

test("catalog: consuming/caveated tools disclose their side effects", () => {
  // These descriptions are load-bearing: MCP clients decide from them alone.
  assert.match(getTool("bc_read_messages").description, /mark.*read|already seen/i);
  assert.match(getTool("bc_read_messages").description, /enc/i); // sealed-frame honesty
  assert.match(getTool("bc_send_message").description, /plaintext/i);
  assert.match(getTool("bc_request_session").description, /trust/i);
  assert.match(getTool("bc_dashboard_link").description, /don't fetch it yourself/i);
});

test("getTool: known and unknown", () => {
  assert.equal(getTool("bc_whoami").name, "bc_whoami");
  assert.equal(getTool("bc_nope"), null);
});

test("validateToolArgs: required, unknown, and null/undefined args", () => {
  const read = getTool("bc_read_messages");
  assert.equal(validateToolArgs(read, {}), MISSING_THREAD_ID);
  assert.match(validateToolArgs(read, { session_id: "s" }), /missing required argument: role/);
  assert.equal(validateToolArgs(read, { session_id: "s", role: "host" }), null);
  assert.match(validateToolArgs(read, { session_id: "s", role: "host", bogus: 1 }), /unknown argument: bogus/);
  assert.match(validateToolArgs(getTool("bc_whoami"), "nope"), /must be an object/);
  assert.equal(validateToolArgs(getTool("bc_whoami"), undefined), null);
  assert.equal(validateToolArgs(getTool("bc_whoami"), null), null);
});

test("validateToolArgs: enum + integer + boolean checks", () => {
  const read = getTool("bc_read_messages");
  assert.match(validateToolArgs(read, { session_id: "s", role: "spectator" }), /must be one of/);
  assert.match(validateToolArgs(read, { session_id: "s", role: "host", cursor: 1.5 }), /cursor must be integer/);
  assert.equal(validateToolArgs(read, { session_id: "s", role: "host", cursor: 3, mark_read: false }), null);
  assert.match(validateToolArgs(read, { session_id: "s", role: "host", mark_read: "yes" }), /mark_read must be boolean/);
});

test("validateToolArgs: multi-type frame (object or string), array-of-strings scopes", () => {
  const send = getTool("bc_send_message");
  assert.equal(validateToolArgs(send, { session_id: "s", role: "host", frame: { type: "msg", text: "hi" } }), null);
  assert.equal(validateToolArgs(send, { session_id: "s", role: "host", frame: "raw" }), null);
  assert.match(validateToolArgs(send, { session_id: "s", role: "host", frame: 42 }), /frame must be object or string/);

  const invite = getTool("bc_create_invite");
  assert.equal(validateToolArgs(invite, { scopes: ["config.read"] }), null);
  assert.match(validateToolArgs(invite, { scopes: "config.read" }), /scopes must be array/);
  assert.match(validateToolArgs(invite, { scopes: ["config.read", 5] }), /array of strings/);
});

test("bc_check_inbox: wait_seconds schema — optional integer 0-120, description is plain-language (no SSE/long-poll jargon)", () => {
  const tool = getTool("bc_check_inbox");
  assert.equal(tool.inputSchema.required, undefined, "wait_seconds is optional");
  const prop = tool.inputSchema.properties.wait_seconds;
  assert.equal(prop.type, "integer");
  assert.equal(prop.minimum, 0);
  assert.equal(prop.maximum, 120);
  assert.doesNotMatch(tool.description, /\bSSE\b|long-poll|long poll/i);
  assert.match(tool.description, /wait/i);
});

test("validateToolArgs: wait_seconds in range is valid; absent is valid (default 0)", () => {
  const tool = getTool("bc_check_inbox");
  assert.equal(validateToolArgs(tool, {}), null);
  assert.equal(validateToolArgs(tool, { wait_seconds: 0 }), null);
  assert.equal(validateToolArgs(tool, { wait_seconds: 120 }), null);
  assert.equal(validateToolArgs(tool, { wait_seconds: 60 }), null);
});

test("validateToolArgs: wait_seconds out of range or wrong type — clear error, not a silent clamp", () => {
  const tool = getTool("bc_check_inbox");
  assert.match(validateToolArgs(tool, { wait_seconds: 121 }), /must be <= 120/);
  assert.match(validateToolArgs(tool, { wait_seconds: -1 }), /must be >= 0/);
  assert.match(validateToolArgs(tool, { wait_seconds: 2.5 }), /must be integer/);
  assert.match(validateToolArgs(tool, { wait_seconds: "5" }), /must be integer/);
});

// ── Thread-id handling (field report 2026-10-05) ────────────────────────────

const THREAD_TOOLS = ["bc_read_messages", "bc_send_message", "bc_end_session"];

test("thread tools: session_id is NOT schema-required (a client-side validator must not block the thread_id alias) and thread_id is advertised", () => {
  for (const name of THREAD_TOOLS) {
    const schema = getTool(name).inputSchema;
    assert.ok(!(schema.required ?? []).includes("session_id"), `${name}: session_id must not be in required`);
    assert.equal(schema.properties.session_id.type, "string");
    assert.equal(schema.properties.thread_id.type, "string");
    // Top-level anyOf/oneOf/allOf would express "one of the two" but several MCP hosts reject it outright.
    for (const k of ["anyOf", "oneOf", "allOf"]) assert.equal(schema[k], undefined, `${name}: no top-level ${k}`);
  }
});

test("normalizeToolArgs: every accepted spelling folds into session_id; session_id wins; blank counts as absent", () => {
  const read = getTool("bc_read_messages");
  for (const alias of ["thread_id", "conversation_id", "sessionId", "threadId", "conversationId", "id"]) {
    const out = normalizeToolArgs(read, { [alias]: "s1", role: "host" });
    assert.deepEqual(out, { role: "host", session_id: "s1" }, alias);
    assert.equal(validateToolArgs(read, out), null, alias);
  }
  assert.deepEqual(normalizeToolArgs(read, { session_id: "real", thread_id: "other", role: "host" }), { session_id: "real", role: "host" });
  assert.deepEqual(normalizeToolArgs(read, { session_id: "  ", thread_id: " t9 ", role: "host" }), { session_id: "t9", role: "host" });
  assert.deepEqual(normalizeToolArgs(getTool("bc_end_session"), { thread_id: "s1" }), { session_id: "s1" });
});

test("normalizeToolArgs + validateToolArgs: no usable id -> the actionable error naming thread_id", () => {
  for (const name of THREAD_TOOLS) {
    const tool = getTool(name);
    for (const args of [{}, { role: "host" }, { session_id: "", role: "host" }, { session_id: null, role: "host" }, { thread_id: "", role: "host" }]) {
      const err = validateToolArgs(tool, normalizeToolArgs(tool, args));
      assert.equal(err, MISSING_THREAD_ID, `${name} ${JSON.stringify(args)}`);
    }
  }
  assert.match(MISSING_THREAD_ID, /session_id/);
  assert.match(MISSING_THREAD_ID, /thread_id/);
  // A wrong TYPE is still a type error, not "missing".
  const read = getTool("bc_read_messages");
  assert.match(validateToolArgs(read, normalizeToolArgs(read, { session_id: 42, role: "host" })), /session_id must be string/);
});

test("normalizeToolArgs: leaves non-thread tools and non-object input alone", () => {
  const claim = getTool("bc_claim_invite");
  const args = { code: "BC-AAAA-BBBB", id: "x" };
  assert.equal(normalizeToolArgs(claim, args), args, "an `id` on a tool that takes no thread id is not ours to rewrite");
  assert.match(validateToolArgs(claim, args), /unknown argument: id/);
  assert.equal(normalizeToolArgs(getTool("bc_read_messages"), "nope"), "nope");
  assert.equal(normalizeToolArgs(getTool("bc_read_messages"), null), null);
});