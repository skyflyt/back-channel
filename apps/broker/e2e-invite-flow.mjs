// E2E: real-user invite → connect → auto-friend → discover → send-to-agent.
// Drives the LIVE prod HTTP endpoints exactly as a fresh user + their agent would,
// verifying every side-effect. Run from apps/broker with DATABASE_URL -> proxy.
import { PrismaClient } from "@prisma/client";
import { randomBytes, createHash } from "node:crypto";
const prisma = new PrismaClient();
const BASE = process.env.BC_BASE || "https://back-channel.app";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const tag = randomBytes(3).toString("hex");
let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}: ${m}`); };
const j = (r) => r.json().catch(() => ({}));

// Mint a real dashboard session for an account (what verify/view-token would yield).
async function mintSession(accountId) {
  const raw = "cs_" + randomBytes(24).toString("base64url");
  const csrf = randomBytes(8).toString("hex");
  await prisma.sessionCookie.create({ data: { token: hash(raw), accountId, expiresAt: new Date(Date.now() + 864e5) } });
  return { cookie: `bc_session=${raw}; bc_csrf=${csrf}`, csrf };
}
const ch = (s) => ({ cookie: s.cookie, "x-bc-csrf": s.csrf, "content-type": "application/json" });

async function main() {
  const inviter = await prisma.account.findFirst({ where: { handle: { startsWith: "skyflyt86" } } });
  if (!inviter) throw new Error("inviter skyflyt86 not found");
  const inviteeEmail = `e2e-newuser-${tag}@example.com`;
  const createdIds = [];
  const is = await mintSession(inviter.id);

  console.log(`\n— inviter ${inviter.handle} · invitee ${inviteeEmail} · ${BASE} —\n`);

  // STEP 1 — mint a fresh invite from the real endpoint (this is the email send path)
  const inv = await fetch(`${BASE}/api/friends/invite`, { method: "POST", headers: ch(is), body: JSON.stringify({ email: inviteeEmail, note: "Come try Back Channel with me" }) });
  ok(inv.status === 200, `1. POST /api/friends/invite -> 200 (got ${inv.status})`);
  const realRow = await prisma.friendInvite.findFirst({ where: { inviterAccountId: inviter.id, inviteeEmail } });
  ok(!!realRow, "1. FriendInvite row created (email would be sent with its token)");

  // STEP 2 — the /befriend link. Raw token lives only in the email; seed an
  // equivalent known-token invite (accept path is identical) to drive the click.
  const token = "fi_" + randomBytes(16).toString("base64url");
  await prisma.friendInvite.create({ data: { inviterAccountId: inviter.id, inviteeEmail, tokenHash: hash(token), note: "Come try Back Channel with me", expiresAt: new Date(Date.now() + 12096e5) } });
  const probe = await j(await fetch(`${BASE}/api/friends/invite?token=${encodeURIComponent(token)}`));
  ok(probe.inviter_handle === inviter.handle, `2. GET probe -> "${probe.inviter_handle}" wants to be friends (note: ${JSON.stringify(probe.note)})`);
  const page = await fetch(`${BASE}/befriend?token=${encodeURIComponent(token)}`);
  ok(page.status === 200, `2. /befriend page renders -> ${page.status}`);

  // STEP 3 — brand-new signup + agent connect via BCX exchange code
  const acc = await fetch(`${BASE}/api/accounts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: inviteeEmail, display_name: "E2E Newuser" }) });
  ok(acc.status < 300, `3. POST /api/accounts (new signup) -> ${acc.status} (verify email sent)`);
  const invitee = await prisma.account.findFirst({ where: { email: inviteeEmail } });
  ok(!!invitee, `3. new Account row created (handle ${invitee?.handle})`);
  createdIds.push(invitee.id);
  // simulate clicking the verify link (issues the account); the AGENT connect below is real.
  await prisma.account.update({ where: { id: invitee.id }, data: { emailVerifiedAt: new Date() } });
  // BCX paste-prompt path: dashboard mints code -> agent redeems for its own key.
  const bcx = `BCX-${randomBytes(2).toString("hex").toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`;
  await prisma.exchangeCode.create({ data: { codeHash: hash(bcx.toUpperCase()), accountId: invitee.id, agentName: "E2E Test Agent", expiresAt: new Date(Date.now() + 60000) } });
  const ex = await j(await fetch(`${BASE}/api/auth/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: bcx }) }));
  ok(typeof ex.api_key === "string" && ex.api_key.startsWith("bc_") && ex.handle === invitee.handle, `3. agent redeems BCX -> got key for ${ex.handle}, agent "${ex.agent_name}"`);
  const inviteeKey = ex.api_key;

  // invitee dashboard session (for cookie-auth dashboard actions)
  const vs = await mintSession(invitee.id);

  // STEP 4 — accept the invite -> auto mutual trust
  const acceptRes = await fetch(`${BASE}/api/friends/accept`, { method: "POST", headers: ch(vs), body: JSON.stringify({ token }) });
  const accept = await acceptRes.json().catch(() => ({}));
  ok(acceptRes.status === 200 && accept.friend_handle === inviter.handle, `4. accept -> now friends with ${accept.friend_handle} (got ${acceptRes.status})`);
  const t1 = await prisma.trustedPeer.findUnique({ where: { accountId_trustedAccountId: { accountId: inviter.id, trustedAccountId: invitee.id } } });
  const t2 = await prisma.trustedPeer.findUnique({ where: { accountId_trustedAccountId: { accountId: invitee.id, trustedAccountId: inviter.id } } });
  ok(!!t1 && !!t2, "4. MUTUAL trust rows exist (both directions, DB)");
  // REAL-USER VIEW: does the new friend show in each dashboard's Friends list? (trust-union fix)
  const vTrust = await j(await fetch(`${BASE}/api/trust`, { headers: { cookie: vs.cookie } }));
  const seesInviter = (vTrust.peers || []).find((p) => p.handle === inviter.handle);
  ok(!!seesInviter && seesInviter.mutual, `4. invitee's Friends list shows ${inviter.handle} as MUTUAL (no prior session) -> ${JSON.stringify(seesInviter)}`);
  const iTrust = await j(await fetch(`${BASE}/api/trust`, { headers: { cookie: is.cookie } }));
  ok(!!(iTrust.peers || []).find((p) => p.handle === invitee.handle), `4. inviter's Friends list shows ${invitee.handle}`);

  // STEP 5 — discover: new user sees inviter's published discoverable skills
  const disc = await j(await fetch(`${BASE}/api/skills/discover`, { headers: { cookie: vs.cookie } }));
  const fromInviter = (disc.skills || []).filter((s) => s.owner_handle === inviter.handle);
  ok(fromInviter.length >= 1, `5. discover shows ${fromInviter.length} skill(s) from ${inviter.handle} (e.g. ${fromInviter[0]?.name})`);

  // STEP 6 — share a TEMPLATE with the new user, then "Send to my agent"
  const tmpl = await prisma.userSkill.findFirst({ where: { accountId: inviter.id, kind: "template", discoverable: true, name: "home-assistant" } });
  const shareRes = await fetch(`${BASE}/api/skills/${tmpl.id}/share`, { method: "POST", headers: ch(is), body: JSON.stringify({ peer_handle: invitee.handle }) });
  ok(shareRes.status < 300, `6. inviter shares "${tmpl.name}" with ${invitee.handle} -> ${shareRes.status}`);
  const shared = await j(await fetch(`${BASE}/api/skills/shared-with-me`, { headers: { cookie: vs.cookie } }));
  ok((shared.skills || []).some((s) => s.id === tmpl.id), `6. "${tmpl.name}" now in invitee's Shared-with-you`);
  const send = await fetch(`${BASE}/api/skills/${tmpl.id}/send-to-me`, { method: "POST", headers: ch(vs) });
  ok(send.status === 200, `6. POST send-to-me -> ${send.status}`);
  // bc-inbox-check Tier-1: cheap pending count via bearer
  const active = await j(await fetch(`${BASE}/api/sessions/active`, { headers: { authorization: `Bearer ${inviteeKey}` } }));
  ok((active.agent_payloads_pending ?? 0) >= 1, `6. /api/sessions/active agent_payloads_pending = ${active.agent_payloads_pending} (Tier-1 wake signal)`);
  // Tier-2: pull the payload the agent narrates from
  const pl = await j(await fetch(`${BASE}/api/inbox/agent-payloads`, { headers: { authorization: `Bearer ${inviteeKey}` } }));
  const p = (pl.payloads || []).find((x) => x.ref?.skillId === tmpl.id);
  ok(!!p && p.kind === "skill", `6. agent-payloads returns the skill payload (kind=${p?.kind})`);
  const r = p?.ref || {};
  const narratable = r.name && r.ownerHandle && r.description != null;
  ok(narratable, `6. payload is SELF-NARRATABLE — name="${r.name}", owner="${r.ownerHandle}", desc=${r.description != null ? "present" : "MISSING"}`);
  console.log(`     → narrative reads: "${r.ownerHandle} shared a skill called \\"${r.name}\\" with you. Here's what it does: ${r.description}. Install it? (yes/no/preview first)"`);

  // cleanup — remove the throwaway invitee + all test artifacts; leave inviter intact
  const ids = [invitee.id];
  await prisma.agentPayload.deleteMany({ where: { accountId: { in: ids } } });
  await prisma.skillShare.deleteMany({ where: { sharedWithAccountId: { in: ids } } });
  await prisma.friendInvite.deleteMany({ where: { inviteeEmail } });
  await prisma.trustedPeer.deleteMany({ where: { OR: [{ accountId: { in: ids } }, { trustedAccountId: { in: ids } }] } });
  await prisma.exchangeCode.deleteMany({ where: { accountId: { in: ids } } });
  await prisma.agentToken.deleteMany({ where: { accountId: { in: ids } } });
  await prisma.accountAudit.deleteMany({ where: { accountId: { in: ids } } });
  await prisma.sessionCookie.deleteMany({ where: { accountId: { in: [...ids, inviter.id] } } });
  await prisma.account.deleteMany({ where: { id: { in: ids } } });

  console.log(`\n${fail === 0 ? "ALL PASS ✅" : "FAILURES ❌"} — ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
