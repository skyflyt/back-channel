// Isolated PostgreSQL test only. Uses real per-agent authentication, real
// mailbox transactions and the same crypto the installed connector uses.
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { prisma } from "../src/lib/db.ts";
import { agentMailbox } from "../src/lib/agent-mailbox.ts";
import { createMailbox } from "../connector/server/mailbox.js";

const database = new URL(process.env.DATABASE_URL ?? "");
assert.ok(["127.0.0.1", "localhost"].includes(database.hostname) && database.pathname.endsWith("/dispatch_test"), "Dedicated local dispatch_test database required");
const accounts: string[] = [];
const operation: Record<string, string> = { bc_list_agents: "agents", bc_mailbox_enroll: "enroll", bc_read_agent_messages: "read", bc_send_agent_message: "send" };
try {
  for (let n = 0; n < 2; n++) accounts.push((await prisma.account.create({ data: { handle: randomUUID() + "@bc", email: randomUUID() + "@example.invalid" } })).id);
  async function agent(accountId: string, name: string) {
    const token = "bc_" + randomBytes(24).toString("base64url");
    const row = await prisma.agentToken.create({ data: { accountId, name, keyHash: createHash("sha256").update(token).digest("hex"), scope: "connector" } });
    let state: Record<string, unknown> = {};
    const call = async (tool: string, args = {}) => {
      const response = await agentMailbox(new NextRequest("http://127.0.0.1/api/mcp", { method: "POST", headers: { authorization: `Bearer ${token}` } }), operation[tool], args);
      const result = await response.json(); if (!response.ok) throw Error(String(result.error)); return result;
    };
    const keystore = { load: () => structuredClone(state), save: (value: Record<string, unknown>) => { state = structuredClone(value); } };
    return { id: row.id, call, mailbox: createMailbox({ call, keystore }), restart: () => createMailbox({ call, keystore }) };
  }
  const a = await agent(accounts[0], "sender"), b = await agent(accounts[0], "recipient"), c = await agent(accounts[0], "other agent"), foreign = await agent(accounts[1], "foreign");
  await Promise.all([a.mailbox.list(), b.mailbox.list(), c.mailbox.list(), foreign.mailbox.list()]);
  const receipt = await a.mailbox.send({ agent_id: b.id, text: "MAILBOX_ROUNDTRIP_OK" });
  const stored = await prisma.agentMessage.findUniqueOrThrow({ where: { id: receipt.message_id } });
  assert.ok(!stored.sealed.includes("MAILBOX_ROUNDTRIP_OK") && !stored.senderSealed.includes("MAILBOX_ROUNDTRIP_OK"));
  assert.equal((await b.restart().read()).messages[0].text, "MAILBOX_ROUNDTRIP_OK");
  assert.equal((await a.restart().read()).messages[0].text, "MAILBOX_ROUNDTRIP_OK");
  assert.equal((await c.mailbox.read()).messages.length, 0);
  await assert.rejects(a.mailbox.send({ agent_id: foreign.id, text: "must not route" }));
  await a.mailbox.read({ mark_read: true });
  assert.equal((await prisma.agentMessage.findUniqueOrThrow({ where: { id: stored.id } })).readAt, null);
  await b.mailbox.read({ mark_read: true });
  assert.ok((await prisma.agentMessage.findUniqueOrThrow({ where: { id: stored.id } })).readAt);
  const envelope = { id: stored.id, agent_id: b.id, sealed: stored.sealed, sender_sealed: stored.senderSealed, expires_at: stored.expiresAt.toISOString() };
  await Promise.all(Array.from({ length: 6 }, () => a.call("bc_send_agent_message", envelope)));
  assert.equal(await prisma.agentMessage.count({ where: { senderAgentId: a.id } }), 1);
  await prisma.agentToken.update({ where: { id: b.id }, data: { revokedAt: new Date() } });
  await assert.rejects(b.mailbox.read()); await assert.rejects(a.mailbox.send({ agent_id: b.id, text: "revoked" }));
  console.log("PASS: encrypted mailbox restart, sender history, per-agent read receipts, same-account isolation, concurrent receipt retries and revocation");
} finally {
  for (const id of accounts) await prisma.account.delete({ where: { id } });
  await prisma.$disconnect();
}
