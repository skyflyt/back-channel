import { test } from "node:test";
import assert from "node:assert/strict";
import { createMailbox } from "./mailbox.js";
import { identity, open } from "./mailbox-crypto.js";

function setup() {
  const peers = ["one", "two", "three"].map(id => ({ id, name: id, ready: false }));
  const records = [], stores = {}, calls = [];
  function agent(id) {
    stores[id] ??= {};
    return createMailbox({ keystore: { load: () => structuredClone(stores[id]), save: s => { stores[id] = structuredClone(s); } }, call: async (name, args = {}) => {
      calls.push({ id, name, args });
      if (name === "bc_list_agents") return { self_agent_id: id, agents: structuredClone(peers) };
      if (name === "bc_mailbox_enroll") { const a = peers.find(p => p.id === id); if (a.ready && a.encryptionKey !== args.encryption_key) return null; Object.assign(a, { ready: true, encryptionKey: args.encryption_key, signingKey: args.signing_key }); return { agent: a }; }
      if (name === "bc_send_agent_message") { records.push({ id: args.id, sender_agent_id: id, target_agent_id: args.agent_id, expires_at: args.expires_at, sealed: args.sealed, senderSealed: args.sender_sealed }); return { message_id: args.id, status: "queued" }; }
      if (name === "bc_read_agent_messages") return { self_agent_id: id, messages: records.filter(m => m.sender_agent_id === id || m.target_agent_id === id).map(m => ({ ...m, sealed: id === m.sender_agent_id ? m.senderSealed : m.sealed })) };
    } });
  }
  return { agent, records, stores, calls, peers };
}
test("ordinary mail is sealed, recipient-specific, signed and readable after connector restart", async () => {
  const s = setup(), a = s.agent("one"), b = s.agent("two");
  await b.list(); await a.send({ agent_id: "two", text: "private hello" });
  assert.equal((await a.list()).agents[0].signingKey, undefined, "the model and panel need labels, not public-key material");
  assert.ok(!s.records[0].sealed.includes("private hello"));
  assert.equal((await s.agent("two").read()).messages[0].text, "private hello");
  assert.equal((await a.read()).messages[0].text, "private hello", "sender's sealed copy survives restart");
  assert.equal((await s.agent("three").read()).messages.length, 0);
  assert.ok(s.calls.filter(c => c.name === "bc_read_agent_messages").every(c => c.args.mark_read !== true));
});
test("tampered routes, ciphertext and sender signatures are shown as unreadable", async () => {
  for (const change of [m => { m.id = "different"; }, m => { const e = JSON.parse(m.sealed); e.ciphertext = "AAAA"; m.sealed = JSON.stringify(e); }, (_m, s) => { s.peers[0].signingKey = identity().signingKey; }]) {
    const s = setup(); await s.agent("two").list(); await s.agent("one").send({ agent_id: "two", text: "hello" });
    change(s.records[0], s);
    const m = (await s.agent("two").read()).messages[0];
    assert.equal(m.unreadable, true); assert.equal(m.text, undefined);
  }
});
test("unready/self recipients, empty/oversize input and lost keys fail without plaintext fallback", async () => {
  const s = setup(), a = s.agent("one");
  for (const args of [{ agent_id: "one", text: "hello" }, { agent_id: "two", text: "hello" }, { agent_id: "two", text: "" }, { agent_id: "two", text: "x".repeat(65537) }]) await assert.rejects(a.send(args));
  assert.equal(s.records.length, 0);
  await s.agent("two").list(); s.stores.two = {};
  await assert.rejects(s.agent("two").list(), /keys/);
});
