// Verify #4/#5: POST /api/skills accepts polymorphic artifact types (prompt,
// scheduled_task) with manifest, and GET surfaces them. Seeds a cookie account,
// publishes through the REAL endpoint, asserts round-trip + manifest validation.
import { PrismaClient } from "@prisma/client";
import { randomBytes, createHash } from "node:crypto";

const prisma = new PrismaClient();
const BASE = process.env.BC_BASE || "http://localhost:3300";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const tag = randomBytes(3).toString("hex");
let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}: ${m}`); };

async function seed(h) {
  const a = await prisma.account.create({ data: { email: `${h}-${tag}@bc`, handle: `${h}-${tag}@bc`, agentPubkey: "ed25519:" + randomBytes(8).toString("hex"), emailVerifiedAt: new Date() } });
  const raw = "cs_" + randomBytes(24).toString("base64url");
  const csrf = randomBytes(8).toString("hex");
  await prisma.sessionCookie.create({ data: { token: hash(raw), accountId: a.id, expiresAt: new Date(Date.now() + 36e5) } });
  return { ...a, cookie: `bc_session=${raw}; bc_csrf=${csrf}`, csrf };
}
const ch = (s) => ({ cookie: s.cookie, "x-bc-csrf": s.csrf, "content-type": "application/json" });
const post = (s, b) => fetch(`${BASE}/api/skills`, { method: "POST", headers: ch(s), body: JSON.stringify(b) });

async function main() {
  const u = await seed("pub");
  console.log(`BASE=${BASE}  ${u.handle}\n`);

  // prompt
  let r = await post(u, { type: "prompt", name: "Polite Rewrite", description: "tone fixer", body: "Rewrite politely.", signature: "sig_x", manifest: { type: "prompt", title: "Polite", tags: ["writing"], suggested_invocation: "make polite" } });
  let j = await r.json();
  ok(r.status === 200 && j.type === "prompt", `publish prompt -> ${j.type}`);

  // scheduled_task valid
  r = await post(u, { type: "scheduled_task", name: "Morning digest", body: "summarize my inbox", signature: "sig_y", manifest: { type: "scheduled_task", cron: "0 9 * * *", prompt: "summarize", run_target: "self", public_share_allowed: true } });
  j = await r.json();
  ok(r.status === 200 && j.type === "scheduled_task", `publish scheduled_task -> ${j.type}`);

  // scheduled_task invalid manifest
  r = await post(u, { type: "scheduled_task", name: "Bad", body: "x", manifest: { type: "scheduled_task", prompt: "no cron here" } });
  ok(r.status === 400, "scheduled_task missing cron -> 400");

  // unknown type falls back to skill
  r = await post(u, { type: "bogus", name: "Fallback", body: "x", kind: "template", signature: "sig_z" });
  j = await r.json();
  ok(r.status === 200 && j.type === "skill", "unknown type -> falls back to skill");

  // GET surfaces type + manifest + signed + public state
  r = await fetch(`${BASE}/api/skills`, { headers: { cookie: u.cookie } });
  j = await r.json();
  const byType = Object.fromEntries((j.skills || []).map((s) => [s.type, s]));
  ok(!!byType.prompt && byType.prompt.manifest?.title === "Polite", "GET surfaces prompt + manifest");
  ok(byType.scheduled_task?.signed === true, "GET surfaces signed flag");
  ok("public_token" in (j.skills?.[0] || {}), "GET includes public_token field");

  await prisma.sessionCookie.deleteMany({ where: { accountId: u.id } });
  await prisma.userSkill.deleteMany({ where: { accountId: u.id } });
  await prisma.account.delete({ where: { id: u.id } });
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
