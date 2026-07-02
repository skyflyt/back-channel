// Full-stack live check: two real bridge PROCESSES (connector/server, driven
// exactly as Claude Desktop would) carrying on a conversation through a
// running server's /api/mcp — proving end-to-end that the broker only ever
// persists ciphertext while both sides transparently see plaintext.
// (The packed .mcpb's determinism/file-set is separately verified by
// scripts/pack-mcpb.mjs's own sha256 output + a manual Expand-Archive check;
// this test drives the connector source directly.)
//   node e2e-mcpb-crypto.mjs          (BC_BASE defaults to http://localhost:3300)
import { PrismaClient } from "@prisma/client";
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const prisma = new PrismaClient();
const BASE = process.env.BC_BASE || "http://localhost:3300";
const BRIDGE_DIR = join(import.meta.dirname, "connector");
const tag = randomBytes(3).toString("hex");
let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}: ${m}`); };

async function seedAccountWithToken(handle) {
  const a = await prisma.account.create({ data: { email: `${handle}-${tag}@bc`, handle: `${handle}-${tag}@bc`, emailVerifiedAt: new Date() } });
  const key = "bc_" + randomBytes(24).toString("base64url");
  await prisma.agentToken.create({ data: { accountId: a.id, keyHash: createHash("sha256").update(key).digest("hex"), name: "e2e crypto", runtimeType: "cowork" } });
  return { ...a, token: key };
}

// Drive one bridge process as a raw stdio MCP client: write a line, read one response line.
function driveBridge(token, keystorePath) {
  const child = spawn("node", ["server/index.js"], {
    cwd: BRIDGE_DIR,
    env: { ...process.env, BC_MCP_URL: `${BASE}/api/mcp`, BC_TOKEN: token, BC_KEYSTORE_PATH: keystorePath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const waiters = [];
  child.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const w = waiters.shift();
      if (w) w(JSON.parse(line));
    }
  });
  child.stderr.on("data", (d) => { if (process.env.DEBUG_BRIDGE) console.error("[stderr]", d.toString()); });
  let id = 0;
  return {
    call(method, params) {
      return new Promise((resolve) => {
        waiters.push(resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) + "\n");
      });
    },
    kill() { child.kill(); },
  };
}

async function main() {
  const visitor = await seedAccountWithToken("crypto-vis");
  const host = await seedAccountWithToken("crypto-host");
  console.log(`BASE=${BASE}  ${visitor.handle} <-> ${host.handle}\n`);

  const keystoreDir = mkdtempSync(join(tmpdir(), "bc-mcpb-e2e-"));
  const visBridge = driveBridge(visitor.token, join(keystoreDir, "visitor.json"));
  const hostBridge = driveBridge(host.token, join(keystoreDir, "host.json"));

  await visBridge.call("initialize", { protocolVersion: "2025-06-18" });
  await hostBridge.call("initialize", { protocolVersion: "2025-06-18" });

  let r = await visBridge.call("tools/call", { name: "bc_create_invite", arguments: { host_handle: host.handle, scopes: ["config.read"], message: "crypto e2e" } });
  let data = JSON.parse(r.result.content[0].text);
  ok(!r.result.isError && data.code?.startsWith("BC-"), "bc_create_invite succeeded");
  const code = data.code, sessionId = data.session_id;

  await new Promise((res) => setTimeout(res, 300)); // visitor's fire-and-forget handshake send

  r = await hostBridge.call("tools/call", { name: "bc_claim_invite", arguments: { code } });
  data = JSON.parse(r.result.content[0].text);
  ok(!r.result.isError && data.session_id === sessionId, "bc_claim_invite succeeded, same session");
  await new Promise((res) => setTimeout(res, 300)); // host's own handshake send

  let sendResult;
  for (let attempt = 0; attempt < 5; attempt++) {
    r = await visBridge.call("tools/call", { name: "bc_send_message", arguments: { session_id: sessionId, role: "visitor", frame: { type: "msg", text: "hello from an encrypted visitor" } } });
    sendResult = JSON.parse(r.result.content[0].text);
    if (!sendResult.handshake_pending) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  ok(!sendResult.handshake_pending && typeof sendResult.sent_seq === "number", `bc_send_message delivered (${JSON.stringify(sendResult)})`);

  const rawFrame = await prisma.frame.findFirst({ where: { sessionId }, orderBy: { seq: "desc" } });
  let rawParsed; try { rawParsed = JSON.parse(rawFrame.body); } catch { /* not JSON */ }
  ok(rawParsed?.type === "enc", `broker-persisted frame is sealed ciphertext (type=${rawParsed?.type})`);

  r = await hostBridge.call("tools/call", { name: "bc_read_messages", arguments: { session_id: sessionId, role: "host" } });
  data = JSON.parse(r.result.content[0].text);
  const plaintextFrame = data.frames.map((f) => { try { return JSON.parse(f); } catch { return null; } }).find((f) => f?.type === "msg");
  ok(plaintextFrame?.text === "hello from an encrypted visitor", `host bridge transparently decrypted: ${JSON.stringify(plaintextFrame)}`);

  visBridge.kill(); hostBridge.kill();
  rmSync(keystoreDir, { recursive: true, force: true });
  await prisma.frame.deleteMany({ where: { sessionId } }).catch(() => {});
  await prisma.session.deleteMany({ where: { invite: { visitorAccountId: visitor.id } } });
  await prisma.invite.deleteMany({ where: { visitorAccountId: visitor.id } });
  await prisma.account.deleteMany({ where: { id: { in: [visitor.id, host.id] } } });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
