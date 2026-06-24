// Verify the share_artifact magic moment: POST /api/artifacts/share dedup + create +
// mint/reuse public link + structured response. Cookie auth (signature is opaque to broker).
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
const share = (s, b) => fetch(`${BASE}/api/artifacts/share`, { method: "POST", headers: ch(s), body: JSON.stringify(b) });
const sig = () => "edsig." + randomBytes(8).toString("hex");

async function main() {
  const u = await seed("share");
  const ids = [u.id];
  console.log(`BASE=${BASE}  ${u.handle}\n`);

  const prompt = { type: "prompt", name: "Trash Day Reminder", description: "nudge", body: "Remind me to take out the trash.", manifest: { type: "prompt", title: "Trash" }, signature: sig(), ttl: "7d" };

  // 1. first share -> created_and_shared
  let r = await share(u, prompt); let j = await r.json();
  ok(r.status === 200 && j.status === "created_and_shared", `first share -> ${j.status}`);
  ok(/^https:\/\/back-channel\.app\/a\/bcA/.test(j.share?.url || ""), "returns share.url");
  ok(j.paste_prompt_for_recipient === `Add this to my agent: ${j.share.url}`, "paste_prompt matches url");
  ok(j.share?.ttl_human === "7 days" && /expires in 7 days/.test(j.summary || ""), "summary mentions 7 days");
  ok(/back-channel\.app\/account\?artifact=/.test(j.artifact?.library_url || ""), "artifact.library_url present");
  const firstUrl = j.share.url, artId = j.artifact.id;

  // 2. dedup: same content -> reuse existing active share
  r = await share(u, prompt); j = await r.json();
  ok(r.status === 200 && j.status === "already_in_library_existing_share", `dedup -> ${j.status}`);
  ok(j.share.url === firstUrl, "dedup reuses the same active link");

  // count: only ONE artifact created
  ok((await prisma.userSkill.count({ where: { accountId: u.id } })) === 1, "dedup did not create a duplicate row");

  // 3. revoke then share again -> new link, same artifact
  await prisma.userSkill.update({ where: { id: artId }, data: { publicRevokedAt: new Date() } });
  r = await share(u, prompt); j = await r.json();
  ok(r.status === 200 && j.status === "already_in_library_shared" && j.share.url !== firstUrl, "after revoke -> mints fresh link, same artifact");
  ok((await prisma.userSkill.count({ where: { accountId: u.id } })) === 1, "still one row after re-share");

  // 4. new artifact without signature -> 409
  r = await share(u, { type: "prompt", name: "Unsigned One", body: "x" });
  ok(r.status === 409, "new artifact without signature -> 409 signature_required");

  // 5. scheduled_task without opt-in -> 403 friendly
  r = await share(u, { type: "scheduled_task", name: "Digest", body: "summarize", signature: sig(), manifest: { type: "scheduled_task", cron: "0 9 * * *", prompt: "summarize" } });
  j = await r.json();
  ok(r.status === 403 && j.error === "scheduled_task_opt_in_required" && j.alternative === "share_with_trusted_friends", "scheduled_task no opt-in -> 403 + alternative");

  // 6. scheduled_task with opt-in -> created_and_shared
  r = await share(u, { type: "scheduled_task", name: "Digest", body: "summarize", signature: sig(), ttl: "30d", manifest: { type: "scheduled_task", cron: "0 9 * * *", prompt: "summarize", public_share_allowed: true } });
  j = await r.json();
  ok(r.status === 200 && j.status === "created_and_shared" && j.share.ttl_human === "30 days", "scheduled_task opt-in -> shared (30d)");

  // 7. minted token actually resolves at /a
  ok((await fetch(j.share.url, { headers: { accept: "application/json" } })).status === 200, "minted share link resolves at /a");

  // 8. not connected -> friendly 401
  r = await fetch(`${BASE}/api/artifacts/share`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(prompt) });
  j = await r.json();
  ok(r.status === 401 && j.error === "not_connected", "no auth -> 401 not_connected (friendly)");

  await prisma.sessionCookie.deleteMany({ where: { accountId: { in: ids } } });
  await prisma.userSkill.deleteMany({ where: { accountId: { in: ids } } });
  await prisma.account.deleteMany({ where: { id: { in: ids } } });
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
