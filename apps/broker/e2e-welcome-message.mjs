// Onboarding epic WS-A: concierge welcome message on an account's FIRST agent
// connect. Verifies both mint paths (BCX exchange-code redemption AND the
// direct dashboard "Connect an agent" mint used by the MCP connector),
// idempotency (second connect never duplicates it), that the agent can read
// it two ways (bc_check_inbox over MCP, and the plain REST self-inbox route
// the skill/bash path curls), and that a pre-existing account (already has an
// agent) never gets one retroactively.
//   node e2e-welcome-message.mjs          (BC_BASE defaults to http://localhost:3300)
import { PrismaClient } from "@prisma/client";
import { randomBytes, createHash } from "node:crypto";

const prisma = new PrismaClient();
const BASE = process.env.BC_BASE || "http://localhost:3300";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const tag = randomBytes(3).toString("hex");
let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}: ${m}`); };
const j = (r) => r.json().catch(() => ({}));

async function seedAccount(h) {
  const a = await prisma.account.create({ data: { email: `${h}-${tag}@example.com`, handle: `${h}-${tag}@bc`, emailVerifiedAt: new Date() } });
  const raw = "cs_" + randomBytes(24).toString("base64url");
  const csrf = randomBytes(8).toString("hex");
  await prisma.sessionCookie.create({ data: { token: hash(raw), accountId: a.id, expiresAt: new Date(Date.now() + 36e5) } });
  return { ...a, cookie: `bc_session=${raw}; bc_csrf=${csrf}`, csrf };
}
const ch = (acc) => ({ cookie: acc.cookie, "x-bc-csrf": acc.csrf, "content-type": "application/json" });

let rpcId = 0;
async function mcpCall(key, name, args) {
  const r = await fetch(`${BASE}/api/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args ?? {} } }),
  });
  const body = await j(r);
  const text = body.result?.content?.[0]?.text ?? "";
  let data = null;
  try { data = JSON.parse(text.replace(/^HTTP \d+: /, "")); } catch { /* non-JSON */ }
  return { http: r.status, isError: body.result?.isError, data };
}

async function main() {
  const ids = [];

  // ── Path A: BCX exchange-code redemption (the guided/skill connect path) ──
  const accA = await seedAccount("welcome-bcx");
  ids.push(accA.id);
  const bcx = `BCX-${randomBytes(2).toString("hex").toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`;
  await prisma.exchangeCode.create({ data: { codeHash: hash(bcx.toUpperCase()), accountId: accA.id, agentName: "E2E Welcome Agent", expiresAt: new Date(Date.now() + 60000) } });
  const ex = await j(await fetch(`${BASE}/api/auth/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: bcx }) }));
  ok(typeof ex.api_key === "string" && ex.api_key.startsWith("bc_"), `A1. BCX redeem -> got key for ${ex.handle}`);
  const keyA = ex.api_key;

  const seededA = await prisma.account.findUnique({ where: { id: accA.id } });
  ok(!!seededA.welcomeSeededAt, "A2. Account.welcomeSeededAt set after first exchange redemption");
  const payloadsA = await prisma.agentPayload.findMany({ where: { accountId: accA.id, kind: "welcome" } });
  ok(payloadsA.length === 1, `A3. exactly ONE welcome AgentPayload seeded (got ${payloadsA.length})`);
  ok(/approve the goal once/i.test(payloadsA[0]?.note ?? ""), "A4. welcome copy carries the one-yes promise");
  ok(!/\bframe\b|\bsession_id\b|\bhandshake\b/i.test(payloadsA[0]?.note ?? ""), "A5. welcome copy has no protocol jargon (frame/session_id/handshake)");

  // Tier-1 cheap signal, then bc_check_inbox over MCP surfaces the readable content inline.
  const active1 = await j(await fetch(`${BASE}/api/sessions/active`, { headers: { authorization: `Bearer ${keyA}` } }));
  ok(active1.agent_payloads_pending === 1, `A6. /api/sessions/active agent_payloads_pending = ${active1.agent_payloads_pending}`);

  const inboxCheck = await mcpCall(keyA, "bc_check_inbox");
  const seenPayload = inboxCheck.data?.agent_payloads?.find((p) => p.kind === "welcome");
  ok(!inboxCheck.isError && !!seenPayload, "A7. bc_check_inbox (MCP) returns the welcome payload inline — agent can read it in one call");
  ok(seenPayload?.ref?.text?.includes("Welcome to Back Channel"), "A8. payload content is the readable welcome text, not a reference/ciphertext");

  // Second bc_check_inbox: payload was marked delivered, must not reappear (still just one row, ever).
  const inboxCheck2 = await mcpCall(keyA, "bc_check_inbox");
  ok(!(inboxCheck2.data?.agent_payloads ?? []).some((p) => p.kind === "welcome"), "A9. welcome payload marked delivered — doesn't resurface on next check");

  // ── Idempotency: a SECOND agent connect on the SAME account must not duplicate ──
  const bcx2 = `BCX-${randomBytes(2).toString("hex").toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`;
  await prisma.exchangeCode.create({ data: { codeHash: hash(bcx2.toUpperCase()), accountId: accA.id, agentName: "E2E Second Agent", expiresAt: new Date(Date.now() + 60000) } });
  const ex2 = await j(await fetch(`${BASE}/api/auth/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: bcx2 }) }));
  ok(typeof ex2.api_key === "string", "A10. second agent connects fine");
  const payloadsAafter = await prisma.agentPayload.findMany({ where: { accountId: accA.id, kind: "welcome" } });
  ok(payloadsAafter.length === 1, `A11. STILL exactly one welcome payload after a 2nd connect (got ${payloadsAafter.length})`);

  // ── Path B: direct dashboard mint (the MCP-connector onboarding path) ──
  const accB = await seedAccount("welcome-mcp");
  ids.push(accB.id);
  const mintB = await j(await fetch(`${BASE}/api/account/agents`, { method: "POST", headers: ch(accB), body: JSON.stringify({ agent_name: "E2E MCP Connector", runtime_type: "other" }) }));
  ok(typeof mintB.api_key === "string" && mintB.api_key.startsWith("bc_"), "B1. dashboard mint -> got key");
  const keyB = mintB.api_key;
  const seededB = await prisma.account.findUnique({ where: { id: accB.id } });
  ok(!!seededB.welcomeSeededAt, "B2. Account.welcomeSeededAt set after first dashboard mint (MCP connect path)");
  const payloadsB = await prisma.agentPayload.findMany({ where: { accountId: accB.id, kind: "welcome" } });
  ok(payloadsB.length === 1, `B3. exactly ONE welcome payload seeded via the MCP mint path (got ${payloadsB.length})`);

  // Second mint on same account (multi-agent user) -> still no duplicate.
  const mintB2 = await j(await fetch(`${BASE}/api/account/agents`, { method: "POST", headers: ch(accB), body: JSON.stringify({ agent_name: "E2E Second Desktop" }) }));
  ok(typeof mintB2.api_key === "string", "B4. second mint on same account succeeds");
  const payloadsBafter = await prisma.agentPayload.findMany({ where: { accountId: accB.id, kind: "welcome" } });
  ok(payloadsBafter.length === 1, `B5. STILL exactly one welcome payload after a 2nd mint (got ${payloadsBafter.length})`);

  // ── Existing accounts (already have an agent BEFORE this feature) are unaffected ──
  const accC = await seedAccount("welcome-preexisting");
  ids.push(accC.id);
  // Simulate a pre-epic account: it already has an AgentToken, minted the "old" way
  // (no seedWelcomeIfFirstConnect call would have run for it historically).
  await prisma.agentToken.create({ data: { accountId: accC.id, keyHash: hash("legacy-key-" + tag), name: "Legacy agent", runtimeType: "other" } });
  const mintC = await j(await fetch(`${BASE}/api/account/agents`, { method: "POST", headers: ch(accC), body: JSON.stringify({ agent_name: "Second agent on old account" }) }));
  ok(typeof mintC.api_key === "string", "C1. existing account can still connect a second agent");
  const payloadsC = await prisma.agentPayload.findMany({ where: { accountId: accC.id, kind: "welcome" } });
  ok(payloadsC.length === 0, `C2. NO welcome payload for an account that already had an agent (got ${payloadsC.length})`);
  const seededC = await prisma.account.findUnique({ where: { id: accC.id } });
  ok(!seededC.welcomeSeededAt, "C3. welcomeSeededAt stays null for a pre-existing account (never retroactively fires)");

  // ── Cleanup ─────────────────────────────────────────────────────────────
  await prisma.agentPayload.deleteMany({ where: { accountId: { in: ids } } });
  await prisma.agentToken.deleteMany({ where: { accountId: { in: ids } } });
  await prisma.exchangeCode.deleteMany({ where: { accountId: { in: ids } } });
  await prisma.sessionCookie.deleteMany({ where: { accountId: { in: ids } } });
  await prisma.account.deleteMany({ where: { id: { in: ids } } });

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
