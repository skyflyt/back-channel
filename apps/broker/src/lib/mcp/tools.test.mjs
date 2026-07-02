import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, getTool, validateToolArgs } from "./tools.mjs";

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
  assert.match(validateToolArgs(read, {}), /missing required argument: session_id/);
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
