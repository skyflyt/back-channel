// Verify Library CRUD: create/edit/delete via /api/skills (cookie+CSRF), including
// the content-edit-invalidates-signature + revokes-public-link behavior.
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
const patch = (s, id, b) => fetch(`${BASE}/api/skills/${id}`, { method: "PATCH", headers: ch(s), body: JSON.stringify(b) });
const del = (s, id) => fetch(`${BASE}/api/skills/${id}`, { method: "DELETE", headers: ch(s) });
const list = (s) => fetch(`${BASE}/api/skills`, { headers: { cookie: s.cookie } }).then((r) => r.json());

async function main() {
  const u = await seed("crud"), other = await seed("crud-x");
  const ids = [u.id, other.id];
  console.log(`BASE=${BASE}  ${u.handle}\n`);

  // create prompt (unsigned)
  let r = await post(u, { type: "prompt", name: "Draft", description: "d", body: "v1 body", manifest: { type: "prompt", title: "Draft", tags: ["a"] } });
  let j = await r.json(); const id = j.id;
  ok(r.status === 200 && j.type === "prompt", "create prompt");
  let row = (await list(u)).skills.find((s) => s.id === id);
  ok(row && row.signed === false && row.body === "v1 body", "created unsigned, body present");

  // edit body -> version bump, still unsigned
  r = await patch(u, id, { body: "v2 body" }); j = await r.json();
  ok(r.status === 200 && j.version === (row.version + 1), `edit bumps version ${row.version}->${j.version}`);
  row = (await list(u)).skills.find((s) => s.id === id);
  ok(row.body === "v2 body", "edited body persisted");

  // simulate an agent-signed + publicly-shared artifact, then edit content
  await prisma.userSkill.update({ where: { id }, data: { signature: "edpub.sig", publicToken: "bcASIMULATEDTOKEN0000000000000000", publicExpiresAt: new Date(Date.now() + 36e5), publicRevokedAt: null } });
  r = await patch(u, id, { body: "v3 body" }); j = await r.json();
  ok(r.status === 200 && j.signed === false && j.public_revoked === true, "content edit clears signature + revokes public link");
  const after = await prisma.userSkill.findUnique({ where: { id } });
  ok(after.signature === null && after.publicRevokedAt !== null, "DB: signature null + publicRevokedAt set");

  // metadata-only edit (description) does NOT bump version or touch signature
  await prisma.userSkill.update({ where: { id }, data: { signature: "edpub.sig2" } });
  const vBefore = (await prisma.userSkill.findUnique({ where: { id } })).version;
  r = await patch(u, id, { description: "just metadata" }); j = await r.json();
  const vAfter = (await prisma.userSkill.findUnique({ where: { id } })).version;
  ok(r.status === 200 && vAfter === vBefore, "metadata-only edit keeps version");
  ok((await prisma.userSkill.findUnique({ where: { id } })).signature === "edpub.sig2", "metadata-only edit keeps signature");

  // scheduled_task invalid manifest on edit -> 400
  const st = await post(u, { type: "scheduled_task", name: "S", body: "do x", manifest: { type: "scheduled_task", cron: "0 9 * * *", prompt: "x" } }).then((x) => x.json());
  ok((await patch(u, st.id, { manifest: { type: "scheduled_task", prompt: "no cron" } })).status === 400, "edit scheduled_task w/ bad manifest -> 400");

  // ownership
  ok((await patch(other, id, { body: "hax" })).status === 404, "non-owner edit -> 404");
  ok((await del(other, id)).status === 404, "non-owner delete -> 404");

  // delete
  ok((await del(u, id)).status === 200, "delete -> 200");
  ok(!(await list(u)).skills.find((s) => s.id === id), "deleted artifact gone from list");

  await prisma.sessionCookie.deleteMany({ where: { accountId: { in: ids } } });
  await prisma.userSkill.deleteMany({ where: { accountId: { in: ids } } });
  await prisma.account.deleteMany({ where: { id: { in: ids } } });
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
