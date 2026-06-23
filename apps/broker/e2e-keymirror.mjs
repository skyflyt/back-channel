// Integration: key-mirror server+crypto path (Phase 2). Exercises the REAL endpoints
// with the REAL crypto core — enroll → agent wrap → browser unwrap → frame
// write/read — plus the guards (replay, stale version, rate-limit, participant ACL).
// Run from apps/broker with DATABASE_URL -> proxy. BASE defaults to localhost:3300
// (local prod/dev server); set BC_BASE=https://back-channel.app to hit prod.
import { PrismaClient } from "@prisma/client";
import { randomBytes, createHash } from "node:crypto";
import {
  generateMirrorKeypair, deriveKekFromSecret, wrapMirrorPriv, unwrapMirrorPriv,
  hpkeOpenK, importK, sealFrame, openFrame, ORIGIN_HUMAN, b64, unb64,
} from "./src/lib/crypto/keymirror.mjs";

const prisma = new PrismaClient();
const BASE = process.env.BC_BASE || "http://localhost:3300";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const tag = randomBytes(3).toString("hex");
let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}: ${m}`); };
const rk = () => "bc_" + randomBytes(16).toString("hex");

async function seedAccount(h) {
  const key = rk();
  const a = await prisma.account.create({ data: { email: `${h}-${tag}@bc`, handle: `${h}-${tag}@bc`, apiKey: key, emailVerifiedAt: new Date() } });
  await prisma.agentToken.create({ data: { accountId: a.id, keyHash: hash(key), name: "t", runtimeType: "other" } });
  const raw = "cs_" + randomBytes(24).toString("base64url");
  const csrf = randomBytes(8).toString("hex");
  await prisma.sessionCookie.create({ data: { token: hash(raw), accountId: a.id, expiresAt: new Date(Date.now() + 36e5) } });
  return { ...a, key, cookie: `bc_session=${raw}; bc_csrf=${csrf}`, csrf };
}
const ch = (s) => ({ cookie: s.cookie, "x-bc-csrf": s.csrf, "content-type": "application/json" });
const bearer = (s) => ({ authorization: `Bearer ${s.key}`, "content-type": "application/json" });

async function main() {
  const host = await seedAccount("km-host"), visitor = await seedAccount("km-vee");
  const ids = [host.id, visitor.id];
  // a real session between them (host is the account we enroll + drive)
  const invite = await prisma.invite.create({ data: { code: `KM-${tag}`, hostAccountId: host.id, visitorAccountId: visitor.id, scopes: ["config.read"], ttlMinutes: 60, expiresAt: new Date(Date.now() + 36e5), message: "km test" } });
  const session = await prisma.session.create({ data: { inviteId: invite.id, scopesGranted: ["config.read"] } });
  console.log(`\n— host ${host.handle} · session ${session.id.slice(0, 8)} · ${BASE} —\n`);

  // 1. BROWSER ENROLL: generate mirror keypair + KEK (from a fake PRF secret) + wrapped priv
  const { mirrorPub, mirrorPrivRaw } = await generateMirrorKeypair();
  const prfSecret = randomBytes(32);
  const kek = await deriveKekFromSecret(prfSecret);
  const wrappedPriv = await wrapMirrorPriv(kek, mirrorPrivRaw, host.id);
  const prfSalt = b64(randomBytes(32));
  const enr = await fetch(`${BASE}/api/account/key-mirror`, { method: "POST", headers: ch(host), body: JSON.stringify({ mirror_pub: mirrorPub, prf_salt: prfSalt, wrap: { method: "prf", label: "Test laptop", credential_id: b64(randomBytes(16)), wrapped_mirror_priv: wrappedPriv } }) });
  ok(enr.status === 200, `1. enroll -> 200 (got ${enr.status})`);
  const acct = await prisma.account.findUnique({ where: { id: host.id } });
  ok(acct?.mirrorPub === mirrorPub, "1. mirrorPub stored");

  // 2. passphrase enroll is gated (path C)
  const pp = await fetch(`${BASE}/api/account/key-mirror`, { method: "POST", headers: ch(visitor), body: JSON.stringify({ mirror_pub: "x".repeat(40), prf_salt: prfSalt, wrap: { method: "passphrase", kdf_params: {}, wrapped_mirror_priv: "a.b" } }) });
  ok(pp.status === 503, `2. passphrase enroll gated -> 503 (got ${pp.status})`);

  // 3. AGENT: fetch mirror-pub, HPKE-wrap K, post user-wrap (version 0)
  const mp = await fetch(`${BASE}/api/account/mirror-pub`, { headers: bearer(host) }).then(r => r.json());
  ok(mp.mirror_pub === mirrorPub && mp.version === 0, `3. agent GET mirror-pub (version ${mp.version})`);
  const K = randomBytes(32);
  // wrap K to the pub using the crypto core's hpke (agent side)
  const { hpkeWrapK } = await import("./src/lib/crypto/keymirror.mjs");
  const wrap = await hpkeWrapK(mirrorPub, K, session.id, host.id);
  const uw = await fetch(`${BASE}/api/sessions/${session.id}/user-wrap`, { method: "POST", headers: bearer(host), body: JSON.stringify({ wrap, version: 0 }) });
  ok(uw.status === 200, `3. user-wrap -> 200 (got ${uw.status})`);

  // 4. version mismatch -> 409
  const uwBad = await fetch(`${BASE}/api/sessions/${session.id}/user-wrap`, { method: "POST", headers: bearer(host), body: JSON.stringify({ wrap, version: 1 }) });
  ok(uwBad.status === 409, `4. user-wrap stale version -> 409 (got ${uwBad.status})`);

  // 5. BROWSER: GET wrapped -> unwrap mirror_priv with KEK -> open K
  const wr = await fetch(`${BASE}/api/sessions/${session.id}/wrapped`, { headers: { cookie: host.cookie } }).then(r => r.json());
  ok(!!wr.wrap, "5. GET wrapped returns the sealed K");
  const priv2 = await unwrapMirrorPriv(kek, wrappedPriv, host.id);
  const K2 = await hpkeOpenK(priv2, wr.wrap, session.id, host.id);
  ok(b64(K2) === b64(K), "5. browser recovered the exact session key K");

  // 6. BROWSER WRITE: seal a frame (origin human, counter 1) under K, POST frames
  const kKey = await importK(K2);
  const frame = await sealFrame(kKey, { type: "meta.dialog", origin: "human", text: "hi from the dashboard" }, ORIGIN_HUMAN, 1n);
  const wfr = await fetch(`${BASE}/api/sessions/${session.id}/frames`, { method: "POST", headers: ch(host), body: JSON.stringify({ frame }) }).then(r => r.json());
  ok(wfr.ok === true, `6. browser frame write -> ok (seq ${wfr.seq})`);

  // 7. REPLAY: re-post same frame (same counter) -> 409 stale_counter
  const replay = await fetch(`${BASE}/api/sessions/${session.id}/frames`, { method: "POST", headers: ch(host), body: JSON.stringify({ frame }) });
  ok(replay.status === 409, `7. replay (same counter) -> 409 (got ${replay.status})`);

  // 8. READ BACK: the frame landed in the peer's log; decrypt it
  const got = await fetch(`${BASE}/api/sessions/${session.id}/frames`, { headers: { cookie: host.cookie } }).then(r => r.json());
  const mine = (got.frames || []).filter((f) => f.role_dest === "visitor"); // host wrote -> addressed to visitor
  let decrypted = null;
  for (const f of mine) { try { decrypted = await openFrame(kKey, JSON.parse(f.body)); break; } catch { /* skip non-K frames */ } }
  ok(decrypted?.text === "hi from the dashboard", `8. read-back + decrypt the dashboard frame (got ${JSON.stringify(decrypted)})`);

  // 9. PARTICIPANT ACL: a non-participant (visitor's... actually a third account) can't read
  const stranger = await seedAccount("km-str"); ids.push(stranger.id);
  const denied = await fetch(`${BASE}/api/sessions/${session.id}/wrapped`, { headers: { cookie: stranger.cookie } });
  ok(denied.status === 404, `9. non-participant GET wrapped -> opaque 404 (got ${denied.status})`);

  // 10. RATE-LIMIT: >10 user-wrap/min -> 429
  let got429 = false;
  for (let i = 0; i < 12; i++) {
    const r = await fetch(`${BASE}/api/sessions/${session.id}/user-wrap`, { method: "POST", headers: bearer(host), body: JSON.stringify({ wrap, version: 0 }) });
    if (r.status === 429) { got429 = true; break; }
  }
  ok(got429, "10. user-wrap rate-limit fires (429 within 12 rapid posts)");

  // cleanup
  await prisma.frame.deleteMany({ where: { sessionId: session.id } });
  await prisma.session.deleteMany({ where: { id: session.id } });
  await prisma.invite.deleteMany({ where: { id: invite.id } });
  await prisma.mirrorKeyWrap.deleteMany({ where: { accountId: { in: ids } } });
  await prisma.agentToken.deleteMany({ where: { accountId: { in: ids } } });
  await prisma.sessionCookie.deleteMany({ where: { accountId: { in: ids } } });
  await prisma.accountAudit.deleteMany({ where: { accountId: { in: ids } } });
  await prisma.account.deleteMany({ where: { id: { in: ids } } });

  console.log(`\n${fail === 0 ? "ALL PASS ✅" : "FAILURES ❌"} — ${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
