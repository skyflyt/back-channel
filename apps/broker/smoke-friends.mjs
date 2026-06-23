// Smoke: Phase 3 invite-a-friend + auto mutual-trust. Run from apps/broker.
import { PrismaClient } from "@prisma/client";
import { randomBytes, createHash } from "node:crypto";
const prisma = new PrismaClient();
const BASE = "https://back-channel.app";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const rk = () => "bc_" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const tag = Math.random().toString(36).slice(2, 8);
let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}: ${m}`); };
function cookies(res) { const o = {}; for (const c of res.headers.getSetCookie?.() ?? []) { const [kv] = c.split(";"); const i = kv.indexOf("="); o[kv.slice(0,i)] = kv.slice(i+1); } return o; }
async function seed(h) { const key = rk(); const a = await prisma.account.create({ data: { email:`${h}-${tag}@bc`, handle:`${h}-${tag}@bc`, apiKey: key, emailVerifiedAt: new Date() } }); await prisma.agentToken.create({ data: { accountId: a.id, keyHash: hash(key), name:"t", runtimeType:"other" } }); return { ...a, key }; }
async function ck(key) { const vt = await fetch(`${BASE}/api/account/view-token-self`, { method:"POST", headers:{ authorization:`Bearer ${key}`, "content-type":"application/json" }, body:"{}" }).then(r=>r.json()); return cookies(await fetch(`${BASE}/api/auth/view-token-consume`, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify({ token: vt.view_token }) })); }

async function main() {
  const inviter = await seed("fr-inv"), invitee = await seed("fr-vee");
  const ids = [inviter.id, invitee.id];
  const ic = await ck(inviter.key), vc = await ck(invitee.key);

  // 1. invite endpoint works (200, row created)
  const r = await fetch(`${BASE}/api/friends/invite`, { method:"POST", headers:{ cookie:`bc_session=${ic.bc_session}; bc_csrf=${ic.bc_csrf}`, "x-bc-csrf": ic.bc_csrf, "content-type":"application/json" }, body: JSON.stringify({ email: `someone-${tag}@example.com`, note:"hi" }) });
  ok(r.status === 200, `POST /api/friends/invite -> 200 (got ${r.status})`);
  const row1 = await prisma.friendInvite.findFirst({ where: { inviterAccountId: inviter.id } });
  ok(!!row1, "FriendInvite row created");

  // 2. seed a known-token invite to test accept (raw token only lives in the email)
  const raw = "fi_" + randomBytes(16).toString("base64url");
  await prisma.friendInvite.create({ data: { inviterAccountId: inviter.id, inviteeEmail: invitee.email, tokenHash: hash(raw), note:"let's connect", expiresAt: new Date(Date.now()+6e8) } });

  // GET probe returns inviter handle
  const probe = await fetch(`${BASE}/api/friends/invite?token=${encodeURIComponent(raw)}`).then(r=>r.json());
  ok(probe.inviter_handle === inviter.handle, `GET probe returns inviter handle (got ${probe.inviter_handle})`);

  // 3. accept as invitee -> mutual trust created + accepted
  const ar = await fetch(`${BASE}/api/friends/accept`, { method:"POST", headers:{ cookie:`bc_session=${vc.bc_session}; bc_csrf=${vc.bc_csrf}`, "x-bc-csrf": vc.bc_csrf, "content-type":"application/json" }, body: JSON.stringify({ token: raw }) }).then(r=>r.json());
  ok(ar.ok && ar.friend_handle === inviter.handle, `accept -> ok + friend_handle (got ${JSON.stringify(ar)})`);
  const t1 = await prisma.trustedPeer.findUnique({ where: { accountId_trustedAccountId: { accountId: inviter.id, trustedAccountId: invitee.id } } });
  const t2 = await prisma.trustedPeer.findUnique({ where: { accountId_trustedAccountId: { accountId: invitee.id, trustedAccountId: inviter.id } } });
  ok(!!t1 && !!t2, "MUTUAL trust rows created (both directions)");
  const acc = await prisma.friendInvite.findFirst({ where: { tokenHash: hash(raw) } });
  ok(acc?.status === "accepted", "invite marked accepted");

  // 4. idempotent re-accept
  const ar2 = await fetch(`${BASE}/api/friends/accept`, { method:"POST", headers:{ cookie:`bc_session=${vc.bc_session}; bc_csrf=${vc.bc_csrf}`, "x-bc-csrf": vc.bc_csrf, "content-type":"application/json" }, body: JSON.stringify({ token: raw }) });
  ok(ar2.status === 200, `re-accept idempotent -> 200 (got ${ar2.status})`);

  // 5. self-befriend guarded
  const rawSelf = "fi_" + randomBytes(16).toString("base64url");
  await prisma.friendInvite.create({ data: { inviterAccountId: inviter.id, inviteeEmail: inviter.email, tokenHash: hash(rawSelf), expiresAt: new Date(Date.now()+6e8) } });
  const self = await fetch(`${BASE}/api/friends/accept`, { method:"POST", headers:{ cookie:`bc_session=${ic.bc_session}; bc_csrf=${ic.bc_csrf}`, "x-bc-csrf": ic.bc_csrf, "content-type":"application/json" }, body: JSON.stringify({ token: rawSelf }) });
  ok(self.status === 400, `self-befriend -> 400 (got ${self.status})`);

  // cleanup
  await prisma.friendInvite.deleteMany({ where: { inviterAccountId: { in: ids } } });
  await prisma.trustedPeer.deleteMany({ where: { OR: [{ accountId: { in: ids } }, { trustedAccountId: { in: ids } }] } });
  await prisma.agentToken.deleteMany({ where: { accountId: { in: ids } } });
  await prisma.accountAudit.deleteMany({ where: { accountId: { in: ids } } });
  await prisma.viewToken.deleteMany({ where: { accountId: { in: ids } } });
  await prisma.sessionCookie.deleteMany({ where: { accountId: { in: ids } } });
  await prisma.account.deleteMany({ where: { id: { in: ids } } });
  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
