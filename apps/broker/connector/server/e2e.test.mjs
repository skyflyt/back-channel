import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeyStore } from "./keystore.js";
import { prepareOutgoing, processIncoming, afterSessionEstablished, canonicalizeThreadCall, MISSING_THREAD_ID } from "./e2e.js";
import { newEphemeralKeypair, deriveSessionKey, seal, open } from "./crypto.js";

function memoryFs() {
  const files = new Map();
  return { existsSync: (p) => files.has(p), readFileSync: (p) => files.get(p), writeFileSync: (p, d) => files.set(p, d), renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); }, mkdirSync: () => {}, chmodSync: () => {} };
}
const freshStore = () => createKeyStore({ path: "/keys.json", fs: memoryFs() });
const readMsg = (sessionId, role, overrides = {}) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bc_read_messages", arguments: { session_id: sessionId, role, ...overrides } } });
const sendMsg = (sessionId, role, frame) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bc_send_message", arguments: { session_id: sessionId, role, frame } } });
const toolResp = (dataObj, isError = false) => ({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(dataObj) }], isError } });

test("prepareOutgoing: control frames (handshake.pubkey) pass through unsealed, untouched", async () => {
  const ctx = { keystore: freshStore(), post: async () => { throw new Error("should not be called"); }, log: () => {} };
  const msg = sendMsg("s1", "visitor", { type: "handshake.pubkey", pubkey: "abc" });
  const out = await prepareOutgoing(msg, ctx);
  assert.deepEqual(JSON.parse(out.line), msg);
});

test("prepareOutgoing: no peer key yet -> sends our handshake, waits, then short-circuits handshake_pending", async () => {
  const posted = [];
  const ctx = { keystore: freshStore(), post: async (m) => { posted.push(m); return toolResp({ frames: [], next_cursor: 0 }); }, log: () => {}, handshakeWaitIntervalMs: 5 };
  const out = await prepareOutgoing(sendMsg("s1", "visitor", { type: "msg", text: "hi" }), ctx);
  assert.ok(out.shortCircuitResponse, "should short-circuit, not forward the content frame");
  assert.equal(out.shortCircuitResponse.result.isError, false);
  const body = JSON.parse(out.shortCircuitResponse.result.content[0].text);
  assert.equal(body.handshake_pending, true);
  // First posted call is our own handshake send.
  assert.equal(posted[0].params.name, "bc_send_message");
  assert.equal(posted[0].params.arguments.frame.type, "handshake.pubkey");
  // Then retry reads.
  assert.ok(posted.slice(1).every((p) => p.params.name === "bc_read_messages"));
});

test("prepareOutgoing: peer's handshake arrives mid-wait -> derives key and seals the real content frame", async () => {
  const peer = newEphemeralKeypair();
  let readCount = 0;
  const ctx = {
    keystore: freshStore(),
    post: async (m) => {
      if (m.params.name === "bc_send_message") return toolResp({ ok: true });
      readCount++;
      // Peer's handshake shows up on the 2nd read attempt.
      const frames = readCount >= 2 ? [JSON.stringify({ type: "handshake.pubkey", pubkey: peer.publicKey })] : [];
      return toolResp({ frames, next_cursor: 0 });
    },
    log: () => {}, handshakeWaitIntervalMs: 5,
  };
  const out = await prepareOutgoing(sendMsg("s1", "visitor", { type: "msg", text: "hi" }), ctx);
  assert.ok(out.line, "should forward a sealed frame, not short-circuit");
  const forwarded = JSON.parse(out.line);
  const sealedFrame = forwarded.params.arguments.frame;
  assert.equal(sealedFrame.type, "enc");

  // Prove it's decryptable with the key the peer would derive.
  const state = ctx.keystore.load();
  const ourPub = state.s1.publicKey;
  const peerDerivedKey = deriveSessionKey(peer.handle, ourPub);
  assert.deepEqual(open(sealedFrame, peerDerivedKey), { type: "msg", text: "hi" });
});

test("prepareOutgoing: session key established and our pubkey already published -> seals immediately, no extra posts", async () => {
  const store = freshStore();
  const state = store.load();
  const peer = newEphemeralKeypair();
  const ours = newEphemeralKeypair();
  const key = deriveSessionKey(ours.handle, peer.publicKey);
  state.s1 = { role: "visitor", privateKey: ours.privateKey, publicKey: ours.publicKey, peerPublicKey: peer.publicKey, sessionKey: Buffer.from(key).toString("base64"), pubkeySentAt: Date.now(), updatedAt: Date.now() };
  store.save(state);

  let postCount = 0;
  const ctx = { keystore: store, post: async () => { postCount++; return toolResp({}); }, log: () => {} };
  const out = await prepareOutgoing(sendMsg("s1", "visitor", { type: "msg", text: "fast path" }), ctx);
  assert.equal(postCount, 0, "should not need any handshake posts — key already derived");
  const sealedFrame = JSON.parse(out.line).params.arguments.frame;
  assert.deepEqual(open(sealedFrame, key), { type: "msg", text: "fast path" });
});

// ── Field report 2026-10-05: reads failed "session_id missing" on every call,
// and the send that depended on them reported "handshake pending — retry".

test("prepareOutgoing: a thread first seen via a READ still publishes our pubkey before sealing", async () => {
  // bc_request_session / dashboard-opened threads never pass through
  // create/claim, so the keypair is minted by processIncoming — which derives
  // the session key without ever sending ours. Sealing then would produce a
  // frame the peer cannot open.
  const store = freshStore();
  const peer = newEphemeralKeypair();
  const posted = [];
  const ctx = { keystore: store, post: async (m) => { posted.push(m); return toolResp({ sent_seq: 1 }); }, log: () => {} };
  await processIncoming(readMsg("s1", "host"), toolResp({ frames: [JSON.stringify({ type: "handshake.pubkey", pubkey: peer.publicKey })], next_cursor: 1 }), ctx);
  assert.ok(store.load().s1.sessionKey, "read alone derives the key");
  assert.equal(posted.length, 0);

  const out = await prepareOutgoing(sendMsg("s1", "host", { type: "msg", text: "hi" }), ctx);
  assert.equal(posted.length, 1, "exactly one post: our handshake.pubkey — no wait polls, the peer key is already held");
  assert.deepEqual(posted[0].params.arguments.frame, { type: "handshake.pubkey", pubkey: store.load().s1.publicKey });
  assert.ok(store.load().s1.pubkeySentAt);
  const sealedFrame = JSON.parse(out.line).params.arguments.frame;
  assert.deepEqual(open(sealedFrame, deriveSessionKey(peer.handle, store.load().s1.publicKey)), { type: "msg", text: "hi" });

  await prepareOutgoing(sendMsg("s1", "host", { type: "msg", text: "again" }), ctx);
  assert.equal(posted.length, 1, "published once, not on every send");
});

test("prepareOutgoing: handshake send REJECTED -> real error, not handshake_pending, and no wait polls", async () => {
  const posted = [];
  const ctx = {
    keystore: freshStore(),
    post: async (m) => { posted.push(m); return toolResp("HTTP 404: {\"error\":\"session_not_found\"}", true); },
    log: () => {}, handshakeWaitIntervalMs: 5,
  };
  const out = await prepareOutgoing(sendMsg("nope", "visitor", { type: "msg", text: "hi" }), ctx);
  const res = out.shortCircuitResponse.result;
  assert.equal(res.isError, true);
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.handshake_pending, undefined, "a rejected thread must never be reported as a pending handshake");
  assert.equal(body.sent, false);
  assert.match(body.message, /NOT sent/);
  assert.match(body.message, /session_not_found/);
  assert.equal(posted.length, 1, "no point polling a thread the broker just refused");
  assert.equal(ctx.keystore.load().nope.pubkeySentAt, undefined);
});

test("prepareOutgoing: wait-poll read REJECTED (JSON-RPC error) -> surfaces that error instead of handshake_pending", async () => {
  const ctx = {
    keystore: freshStore(),
    post: async (m) => (m.params.name === "bc_send_message"
      ? toolResp({ sent_seq: 1 })
      : { jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "missing required argument: session_id" } }),
    log: () => {}, handshakeWaitIntervalMs: 5,
  };
  const out = await prepareOutgoing(sendMsg("s1", "visitor", { type: "msg", text: "hi" }), ctx);
  const res = out.shortCircuitResponse.result;
  assert.equal(res.isError, true);
  assert.match(JSON.parse(res.content[0].text).message, /couldn't read this thread.*missing required argument: session_id/);
});

test("prepareOutgoing: thread already ended -> says so, isError", async () => {
  const ctx = {
    keystore: freshStore(),
    post: async () => toolResp({ ended: true, end_reason: "kicked" }),
    log: () => {}, handshakeWaitIntervalMs: 5,
  };
  const out = await prepareOutgoing(sendMsg("s1", "visitor", { type: "msg", text: "hi" }), ctx);
  assert.equal(out.shortCircuitResponse.result.isError, true);
  assert.match(JSON.parse(out.shortCircuitResponse.result.content[0].text).message, /thread has ended \(kicked\)/);
});

test("prepareOutgoing: missing id or bad role -> local error, nothing posted, keystore untouched", async () => {
  const store = freshStore();
  const ctx = { keystore: store, post: async () => { throw new Error("should not be called"); }, log: () => {} };
  const noId = await prepareOutgoing(sendMsg(undefined, "visitor", { type: "msg", text: "hi" }), ctx);
  assert.equal(noId.shortCircuitResponse.result.isError, true);
  assert.match(noId.shortCircuitResponse.result.content[0].text, /missing thread id/);
  const badRole = await prepareOutgoing(sendMsg("s1", "spectator", { type: "msg", text: "hi" }), ctx);
  assert.match(badRole.shortCircuitResponse.result.content[0].text, /role must be/);
  assert.deepEqual(store.load(), {}, "no junk 'undefined' session entry");
});

test("canonicalizeThreadCall: session_id untouched (same object); aliases fold into session_id; other tools ignored", () => {
  const plain = readMsg("s1", "host");
  assert.equal(canonicalizeThreadCall(plain).msg, plain, "an already-canonical call is forwarded byte-for-byte");

  for (const alias of ["thread_id", "conversation_id", "sessionId", "threadId", "conversationId", "id"]) {
    const msg = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bc_read_messages", arguments: { [alias]: "s1", role: "host", cursor: 2 } } };
    assert.deepEqual(canonicalizeThreadCall(msg).msg.params.arguments, { role: "host", cursor: 2, session_id: "s1" }, alias);
  }
  // session_id wins over an alias; a blank session_id falls back to the alias.
  const both = canonicalizeThreadCall({ method: "tools/call", params: { name: "bc_send_message", arguments: { session_id: "real", thread_id: "other", role: "host", frame: "x" } } });
  assert.equal(both.msg.params.arguments.session_id, "real");
  assert.equal("thread_id" in both.msg.params.arguments, false);
  const blank = canonicalizeThreadCall({ method: "tools/call", params: { name: "bc_end_session", arguments: { session_id: "  ", thread_id: "t9" } } });
  assert.deepEqual(blank.msg.params.arguments, { session_id: "t9" });

  const other = { method: "tools/call", params: { name: "bc_claim_invite", arguments: { code: "BC-AAAA-BBBB" } } };
  assert.equal(canonicalizeThreadCall(other).msg, other);
  assert.equal(canonicalizeThreadCall({ method: "tools/list" }).error, undefined);
});

test("canonicalizeThreadCall: no usable id -> the actionable error", () => {
  for (const args of [{ role: "host" }, { session_id: "", role: "host" }, { session_id: null, role: "host" }, undefined, "s1"]) {
    const out = canonicalizeThreadCall({ method: "tools/call", params: { name: "bc_read_messages", arguments: args } });
    assert.equal(out.error, MISSING_THREAD_ID);
    assert.match(out.error, /thread_id/);
  }
});

test("processIncoming: absorbs peer handshake.pubkey, derives session key, redacts raw pubkey from output", async () => {
  const store = freshStore();
  const peer = newEphemeralKeypair();
  const ctx = { keystore: store, post: async () => { throw new Error("unused"); }, log: () => {} };
  const resp = toolResp({ frames: [JSON.stringify({ type: "handshake.pubkey", pubkey: peer.publicKey })], next_cursor: 1 });
  const out = await processIncoming(readMsg("s1", "host"), resp, ctx);
  const data = JSON.parse(out.result.content[0].text);
  assert.deepEqual(JSON.parse(data.frames[0]), { type: "handshake.pubkey", status: "received" });
  assert.equal(data.frames[0].includes(peer.publicKey), false, "raw pubkey must not leak into the LLM-visible output");
  const entry = store.load().s1;
  assert.equal(entry.peerPublicKey, peer.publicKey);
  assert.ok(entry.sessionKey);
});

test("processIncoming: decrypts an enc frame transparently when the session key is known", async () => {
  const store = freshStore();
  const state = store.load();
  const peer = newEphemeralKeypair();
  const ours = newEphemeralKeypair();
  const key = deriveSessionKey(ours.handle, peer.publicKey);
  state.s1 = { role: "host", privateKey: ours.privateKey, publicKey: ours.publicKey, peerPublicKey: peer.publicKey, sessionKey: Buffer.from(key).toString("base64"), updatedAt: Date.now() };
  store.save(state);

  const sealedFrame = seal({ type: "msg", text: "secret payload" }, key);
  const resp = toolResp({ frames: [JSON.stringify(sealedFrame)], next_cursor: 2 });
  const ctx = { keystore: store, post: async () => { throw new Error("unused"); }, log: () => {} };
  const out = await processIncoming(readMsg("s1", "host"), resp, ctx);
  const data = JSON.parse(out.result.content[0].text);
  assert.deepEqual(JSON.parse(data.frames[0]), { type: "msg", text: "secret payload" });
});

test("processIncoming: enc frame with no session key yet -> honest undecryptable marker, no crash", async () => {
  const ctx = { keystore: freshStore(), post: async () => { throw new Error("unused"); }, log: () => {} };
  const resp = toolResp({ frames: [JSON.stringify({ type: "enc", v: 1, iv: "AAAAAAAAAAAAAAAA", ct: "AAAA", tag: "AAAAAAAAAAAAAAAAAAAAAA==" })], next_cursor: 1 });
  const out = await processIncoming(readMsg("s1", "host"), resp, ctx);
  const data = JSON.parse(out.result.content[0].text);
  assert.equal(JSON.parse(data.frames[0]).type, "enc_undecryptable");
});

test("processIncoming: wrong-key enc frame -> undecryptable marker instead of throwing", async () => {
  const store = freshStore();
  const state = store.load();
  const wrongKeyOwner = newEphemeralKeypair();
  const someoneElse = newEphemeralKeypair();
  state.s1 = { role: "host", privateKey: newEphemeralKeypair().privateKey, publicKey: "x", peerPublicKey: "y", sessionKey: Buffer.from(deriveSessionKey(wrongKeyOwner.handle, someoneElse.publicKey)).toString("base64"), updatedAt: Date.now() };
  store.save(state);
  const sealedUnderADifferentKey = seal({ secret: true }, Buffer.alloc(32, 7));
  const resp = toolResp({ frames: [JSON.stringify(sealedUnderADifferentKey)], next_cursor: 1 });
  const ctx = { keystore: store, post: async () => { throw new Error("unused"); }, log: () => {} };
  const out = await processIncoming(readMsg("s1", "host"), resp, ctx);
  const data = JSON.parse(out.result.content[0].text);
  assert.equal(JSON.parse(data.frames[0]).type, "enc_undecryptable");
});

test("processIncoming: non-bc_read_messages calls and tool-level errors pass through untouched", async () => {
  const ctx = { keystore: freshStore(), post: async () => { throw new Error("unused"); }, log: () => {} };
  const otherToolResp = toolResp({ ok: true });
  assert.equal(await processIncoming({ method: "tools/call", params: { name: "bc_check_inbox" } }, otherToolResp, ctx), otherToolResp);

  const errorResp = toolResp({ error: "not_found" }, true);
  const out = await processIncoming(readMsg("s1", "host"), errorResp, ctx);
  assert.equal(out, errorResp); // untouched — same reference, no frame processing attempted
});

test("afterSessionEstablished: bc_create_invite success sends our handshake.pubkey as visitor", async () => {
  const posted = [];
  const store = freshStore();
  const ctx = { keystore: store, post: async (m) => { posted.push(m); return toolResp({}); }, log: () => {} };
  const respObj = toolResp({ session_id: "s99", code: "BC-AAAA-BBBB" });
  await afterSessionEstablished({ method: "tools/call", params: { name: "bc_create_invite" } }, respObj, ctx);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].params.arguments.session_id, "s99");
  assert.equal(posted[0].params.arguments.role, "visitor");
  assert.equal(posted[0].params.arguments.frame.type, "handshake.pubkey");
  assert.equal(store.load().s99.role, "visitor");
  assert.ok(store.load().s99.pubkeySentAt, "a delivered pubkey is recorded so the first send doesn't repeat it");
});

test("afterSessionEstablished: a handshake send that fails is NOT recorded as sent (first send retries it)", async () => {
  const store = freshStore();
  const ctx = { keystore: store, post: async () => { throw new TypeError("fetch failed"); }, log: () => {} };
  await afterSessionEstablished({ method: "tools/call", params: { name: "bc_create_invite" } }, toolResp({ session_id: "s7" }), ctx);
  assert.ok(store.load().s7.publicKey, "keypair is kept");
  assert.equal(store.load().s7.pubkeySentAt, undefined);
});

test("afterSessionEstablished: bc_claim_invite success sends handshake as host; failed calls send nothing", async () => {
  const posted = [];
  const ctx = { keystore: freshStore(), post: async (m) => { posted.push(m); return toolResp({}); }, log: () => {} };
  await afterSessionEstablished({ method: "tools/call", params: { name: "bc_claim_invite" } }, toolResp({ session_id: "s1" }), ctx);
  assert.equal(posted[0].params.arguments.role, "host");

  await afterSessionEstablished({ method: "tools/call", params: { name: "bc_claim_invite" } }, toolResp({ error: "invite_not_found" }, true), ctx);
  assert.equal(posted.length, 1, "an isError result must not trigger a handshake send");
});

test("afterSessionEstablished: unrelated tools are no-ops", async () => {
  let called = false;
  const ctx = { keystore: freshStore(), post: async () => { called = true; }, log: () => {} };
  await afterSessionEstablished({ method: "tools/call", params: { name: "bc_end_session" } }, toolResp({ ok: true }), ctx);
  assert.equal(called, false);
});
