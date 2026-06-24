// Integration: artifact public-share lifecycle (spec §3). Seeds an ephemeral account
// + artifacts directly in the DB, then exercises the REAL prod endpoints:
//   POST /api/artifacts/:id/public-share (+ /revoke) and GET /a/<token>.
// Run from apps/broker with DATABASE_URL -> proxy. BC_BASE=https://back-channel.app for prod.
import { PrismaClient } from "@prisma/client";
import { randomBytes, createHash } from "node:crypto";

const prisma = new PrismaClient();
const BASE = process.env.BC_BASE || "http://localhost:3300";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const tag = randomBytes(3).toString("hex");
let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}: ${m}`); };

async function seedAccount(h) {
  const a = await prisma.account.create({ data: { email: `${h}-${tag}@bc`, handle: `${h}-${tag}@bc`, agentPubkey: "ed25519:" + randomBytes(8).toString("hex"), emailVerifiedAt: new Date() } });
  const raw = "cs_" + randomBytes(24).toString("base64url");
  const csrf = randomBytes(8).toString("hex");
  await prisma.sessionCookie.create({ data: { token: hash(raw), accountId: a.id, expiresAt: new Date(Date.now() + 36e5) } });
  return { ...a, cookie: `bc_session=${raw}; bc_csrf=${csrf}`, csrf };
}
const ch = (s) => ({ cookie: s.cookie, "x-bc-csrf": s.csrf, "content-type": "application/json" });

async function mkArtifact(accountId, o) {
  return prisma.userSkill.create({ data: {
    accountId, name: o.name, description: o.description ?? null, type: o.type ?? "skill",
    kind: o.kind ?? (o.type && o.type !== "skill" ? "template" : "rpc"),
    body: o.body ?? "# body\nhello", signature: o.signature === undefined ? "sig_" + randomBytes(8).toString("hex") : o.signature,
    manifest: o.manifest ?? undefined,
  } });
}
const share = (s, id, ttl) => fetch(`${BASE}/api/artifacts/${id}/public-share`, { method: "POST", headers: ch(s), body: JSON.stringify({ ttl }) });
const revoke = (s, id) => fetch(`${BASE}/api/artifacts/${id}/public-share/revoke`, { method: "POST", headers: ch(s) });
const getJson = (tok) => fetch(`${BASE}/a/${tok}`, { headers: { accept: "application/json" } });
const getHtml = (tok) => fetch(`${BASE}/a/${tok}`, { headers: { accept: "text/html" } });

async function main() {
  const u = await seedAccount("art");
  const ids = [u.id];
  console.log(`BASE=${BASE}  test account ${u.handle}\n`);

  // 1. signed skill -> share -> envelope
  const sk = await mkArtifact(u.id, { name: "Hello Skill", description: "demo", type: "skill", kind: "template" });
  let r = await share(u, sk.id, "7d"); let j = await r.json();
  ok(r.status === 200 && /^bcA[0-9A-HJKMNP-TV-Z]+$/.test(j.token || ""), `share signed skill -> ${j.token}`);
  const tok = j.token;
  ok((j.url || "").endsWith(`/a/${tok}`), "share returns /a/<token> url");
  ok(j.expires_at && new Date(j.expires_at) > new Date(), "7d ttl expiry in the future");

  r = await getJson(tok); const env = await r.json();
  ok(r.status === 200 && env.artifact?.id === sk.id, "GET /a json -> envelope artifact id matches");
  ok(env.artifact?.type === "skill" && env.artifact?.body?.includes("hello"), "envelope carries type + body");
  ok(env.artifact?.author?.handle === u.handle && env.artifact?.author?.pubkey, "envelope author handle + pubkey present");
  ok(!!env.install_instructions?.human_readable_md && env.install_instructions?.install_verb === "install", "envelope install_instructions present");
  ok(env.sdk_version === "0.1" && (env.claim_account_url || "").includes(tok), "envelope sdk_version + claim url");

  r = await getHtml(tok); const html = await r.text();
  ok(r.status === 200 && r.headers.get("content-type")?.includes("text/html"), "GET /a html -> 200 text/html");
  ok(html.includes(`Add this to my agent: https://back-channel.app/a/${tok}`), "landing page has universal paste prompt");
  ok(html.includes("Hello Skill"), "landing page shows artifact name");

  // 2. opaque 404s
  ok((await getJson("bcAZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ")).status === 404, "unknown token -> 404 (json)");
  ok((await getJson("not-a-token")).status === 404, "malformed token -> 404");

  // 3. revoke -> opaque 404
  ok((await revoke(u, sk.id)).status === 200, "revoke -> 200");
  ok((await getJson(tok)).status === 404, "revoked token -> opaque 404");

  // 4. re-share mints a fresh token (old one stays dead)
  r = await share(u, sk.id, "24h"); j = await r.json();
  ok(r.status === 200 && j.token && j.token !== tok, "re-share after revoke mints new token");
  ok((await getJson(tok)).status === 404, "old revoked token still 404 after re-share");
  ok((await getJson(j.token)).status === 200, "new token resolves");

  // 5. unsigned artifact cannot be shared (use a non-RPC kind so the signature
  // gate is what trips, not the RPC gate)
  const uns = await mkArtifact(u.id, { name: "Unsigned", type: "skill", kind: "template", signature: null });
  ok((await share(u, uns.id, "7d")).status === 409, "unsigned artifact -> 409 signature_required");

  // 6. RPC skill cannot be shared (even if signed)
  const rpc = await mkArtifact(u.id, { name: "RPC", type: "skill", kind: "rpc" });
  ok((await share(u, rpc.id, "7d")).status === 400, "signed RPC skill -> 400 rpc_not_shareable");

  // 7. prompt artifact shares + envelope verb
  const pr = await mkArtifact(u.id, { name: "Tone Prompt", type: "prompt", body: "Rewrite politely.", manifest: { type: "prompt", title: "Tone", tags: ["writing"], suggested_invocation: "make it polite" } });
  r = await share(u, pr.id, "7d"); j = await r.json();
  ok(r.status === 200 && j.token, "prompt artifact shares");
  { const e = await (await getJson(j.token)).json(); ok(e.artifact?.type === "prompt" && e.install_instructions?.install_verb === "save_prompt", "prompt envelope -> save_prompt verb"); }

  // 8. scheduled_task gated on opt-in
  const stOff = await mkArtifact(u.id, { name: "Daily digest (private)", type: "scheduled_task", body: "run digest", manifest: { type: "scheduled_task", cron: "0 9 * * *", prompt: "summarize", run_target: "self" } });
  ok((await share(u, stOff.id, "7d")).status === 403, "scheduled_task without opt-in -> 403 opt_in_required");
  const stOn = await mkArtifact(u.id, { name: "Daily digest (shared)", type: "scheduled_task", body: "run digest", manifest: { type: "scheduled_task", cron: "0 9 * * *", prompt: "summarize", run_target: "self", public_share_allowed: true } });
  r = await share(u, stOn.id, "7d"); j = await r.json();
  ok(r.status === 200 && j.token, "scheduled_task with opt-in -> shares");
  { const e = await (await getJson(j.token)).json(); ok(e.install_instructions?.install_verb === "register_schedule", "scheduled_task envelope -> register_schedule verb"); }

  // 9. ownership: a different account cannot share/revoke mine (opaque 404)
  const other = await seedAccount("art-other"); ids.push(other.id);
  ok((await share(other, sk.id, "7d")).status === 404, "non-owner share -> opaque 404");
  ok((await revoke(other, sk.id)).status === 404, "non-owner revoke -> opaque 404");

  // 10. CSRF required
  ok((await fetch(`${BASE}/api/artifacts/${sk.id}/public-share`, { method: "POST", headers: { cookie: u.cookie, "content-type": "application/json" }, body: "{}" })).status === 403, "missing CSRF -> 403");

  // cleanup
  await prisma.sessionCookie.deleteMany({ where: { accountId: { in: ids } } });
  await prisma.userSkill.deleteMany({ where: { accountId: { in: ids } } });
  await prisma.account.deleteMany({ where: { id: { in: ids } } });
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
