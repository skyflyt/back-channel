import { test, before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { NextRequest } from "next/server";
const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];
const mid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const encryptionKey = generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "pem" }).toString();
const signingKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
let agents: any[], messages: any[], limited = false, aborts = 0;
function matches(row: any, where: any): boolean {
  if (!row) return false;
  return Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (v === undefined) return true;
    if (k === "OR") return v.some((w: any) => matches(row, w));
    if (k === "AND") return v.every((w: any) => matches(row, w));
    if (k === "sender" || k === "target") return matches(agents.find(a => a.id === row[`${k}AgentId`]), v);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return v.in.includes(row[k]);
      if ("gt" in v) return row[k] > v.gt;
      if ("lt" in v) return row[k] < v.lt;
      if ("lte" in v) return row[k] <= v.lte;
    }
    return v instanceof Date ? row[k]?.getTime() === v.getTime() : row[k] === v;
  });
}
const db: any = {
  agentToken: {
    findFirst: async ({ where }: any) => agents.find(a => matches(a, where)) ?? null,
    findMany: async ({ where, take }: any) => agents.filter(a => matches(a, where)).slice(0, take),
    update: async ({ where, data }: any) => Object.assign(agents.find(a => matches(a, where)), data),
  },
  agentMessage: {
    findUnique: async ({ where }: any) => messages.find(m => matches(m, where)) ?? null,
    findFirst: async ({ where }: any) => messages.find(m => matches(m, where)) ?? null,
    findMany: async ({ where, take }: any) => messages.filter(m => matches(m, where)).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)).slice(0, take),
    count: async ({ where }: any) => messages.filter(m => matches(m, where)).length,
    create: async ({ data }: any) => { const m = { createdAt: new Date(), readAt: null, ...data }; messages.push(m); return m; },
    updateMany: async ({ where, data }: any) => { const rows = messages.filter(m => matches(m, where)); rows.forEach(m => Object.assign(m, data)); return { count: rows.length }; },
    deleteMany: async ({ where }: any) => { messages = messages.filter(m => !matches(m, where)); },
  },
};
db.$transaction = async (fn: any, options: any) => {
  assert.equal(options.isolationLevel, "Serializable"); const snapshot = structuredClone({ agents, messages });
  try { const r = await fn(db); if (aborts-- > 0) throw { code: "P2034" }; return r; }
  catch (e) { ({ agents, messages } = snapshot); throw e; }
};
before(() => {
  mock.module("@/lib/db", { namedExports: { prisma: db } });
  mock.module("@/lib/auth", { namedExports: { getAuthContext: async (h: string) => {
    const a = agents.find(a => a.id === h?.replace("Bearer ", ""));
    return a ? { account: { id: a.accountId }, agentTokenId: a.id, scope: "connector" } : null;
  } } });
  mock.module("@/lib/rate-limit", { namedExports: { rateLimit: () => ({ ok: !limited }) } });
});
beforeEach(() => {
  limited = false; aborts = 0; messages = [];
  agents = ids.map((id, i) => ({ id, accountId: i === 3 ? "other-account" : "mine", name: `Agent ${i}`, runtimeType: "codex", revokedAt: null, mailboxEncryptionKey: encryptionKey, mailboxSigningKey: signingKey }));
});
async function run(op: string, body: any = {}, id = ids[0]) {
  const { agentMailbox } = await import("@/lib/agent-mailbox");
  return agentMailbox(new NextRequest("https://back-channel.app/api/mcp", { method: "POST", headers: { authorization: `Bearer ${id}` } }), op, body);
}
const input = () => ({ id: mid, agent_id: ids[1], expires_at: new Date(Date.now() + 86400_000).toISOString(), sealed: "recipient ciphertext", sender_sealed: "sender ciphertext" });
test("mail routes are per-agent, same-account and reject revoked/unready recipients", async () => {
  assert.equal((await run("agents", {}, "unknown")).status, 401);
  const r = await run("agents"); assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual((await r.json()).agents.map((a: any) => a.id), ids.slice(0, 3));
  for (const target of [ids[0], ids[3]]) assert.ok((await run("send", { ...input(), agent_id: target })).status >= 400);
  agents[1].revokedAt = new Date(); assert.equal((await run("send", input())).status, 404);
  agents[1].revokedAt = null; agents[1].mailboxEncryptionKey = null; assert.equal((await run("send", input())).status, 404);
  agents[0].revokedAt = new Date(); assert.equal((await run("read")).status, 401);
  assert.equal(messages.length, 0);
});
test("receiver-specific acknowledgement and sender copies preserve independent inboxes", async () => {
  assert.equal((await run("send", input())).status, 200);
  assert.equal((await (await run("read", {}, ids[2])).json()).messages.length, 0);
  assert.equal((await (await run("read")).json()).messages[0].sealed, "sender ciphertext");
  assert.equal((await (await run("read", {}, ids[1])).json()).messages[0].sealed, "recipient ciphertext");
  assert.equal(messages[0].readAt, null);
  await run("read", { mark_read: true }); assert.equal(messages[0].readAt, null, "sender cannot acknowledge receiver's mail");
  await run("read", { mark_read: true }, ids[1]); assert.ok(messages[0].readAt instanceof Date);
});
test("enrollment is immutable and accepts only correct public key types", async () => {
  assert.equal((await run("enroll", { encryption_key: encryptionKey, signing_key: signingKey })).status, 200);
  assert.equal((await run("enroll", { encryption_key: signingKey, signing_key: signingKey })).status, 400);
  const newKey = generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  assert.equal((await run("enroll", { encryption_key: newKey, signing_key: signingKey })).status, 409);
});
test("identical receipts retry safely after serializable abort; conflicts do not overwrite", async () => {
  const body = input(); aborts = 1; assert.equal((await run("send", body)).status, 200);
  assert.equal((await run("send", body)).status, 200); assert.equal(messages.length, 1);
  assert.equal((await run("send", { ...body, sealed: "changed" })).status, 409);
});
test("bounded reads paginate using visible cursor, expired mail and alien cursors are excluded", async () => {
  for (let n = 0; n < 55; n++) messages.push({ id: `${String(n).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, senderAgentId: ids[0], targetAgentId: ids[1], sealed: "cipher", senderSealed: "copy", createdAt: new Date(Date.now() - n * 1000), expiresAt: new Date(Date.now() + 86400_000), readAt: null });
  const first = await (await run("read", {}, ids[1])).json(); assert.equal(first.messages.length, 50); assert.equal(first.has_more, true);
  const next = await (await run("read", { before_id: first.next_cursor }, ids[1])).json(); assert.equal(next.messages.length, 5);
  assert.equal((await run("read", { before_id: first.next_cursor }, ids[2])).status, 400);
  messages.forEach(m => { m.expiresAt = new Date(0); }); assert.equal((await (await run("read", {}, ids[1])).json()).messages.length, 0);
});
test("input size, expiry and rate limits stop writes", async () => {
  for (const body of [{ ...input(), sealed: "x".repeat(131073) }, { ...input(), expires_at: "nonsense" }, { ...input(), expires_at: new Date(Date.now() + 31 * 86400_000).toISOString() }]) assert.equal((await run("send", body)).status, 400);
  limited = true; assert.equal((await run("send", input())).status, 429); assert.equal(messages.length, 0);
});
