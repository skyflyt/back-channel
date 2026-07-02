import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeyStore } from "./keystore.js";
import { prepareOutgoing, processIncoming, afterSessionEstablished } from "./e2e.js";
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

test("prepareOutgoing: session key already established -> seals immediately, no extra posts", async () => {
  const store = freshStore();
  const state = store.load();
  const peer = newEphemeralKeypair();
  const ours = newEphemeralKeypair();
  const key = deriveSessionKey(ours.handle, peer.publicKey);
  state.s1 = { role: "visitor", privateKey: ours.privateKey, publicKey: ours.publicKey, peerPublicKey: peer.publicKey, sessionKey: Buffer.from(key).toString("base64"), updatedAt: Date.now() };
  store.save(state);

  let postCount = 0;
  const ctx = { keystore: store, post: async () => { postCount++; return toolResp({}); }, log: () => {} };
  const out = await prepareOutgoing(sendMsg("s1", "visitor", { type: "msg", text: "fast path" }), ctx);
  assert.equal(postCount, 0, "should not need any handshake posts — key already derived");
  const sealedFrame = JSON.parse(out.line).params.arguments.frame;
  assert.deepEqual(open(sealedFrame, key), { type: "msg", text: "fast path" });
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
