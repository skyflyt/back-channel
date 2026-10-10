/**
 * Route tests for the passkey step-up (src/lib/step-up.ts, src/lib/passkeys.ts; docs/remote-app-sessions.md,
 * "Approvals need a passkey"): /api/account/passkeys/* (register, list, remove, step-up options and verify), and the
 * dashboard routes that mint an agent key and now need a connect_agent grant (/api/auth/exchange-code,
 * POST /api/account/agents, /api/account/key/rotate, /api/account/bootstrap-prompt).
 *
 * The real route files and src/lib modules, including the real @/lib/auth (cookie lookup by hash, CSRF), run against
 * an in-memory Prisma. WebAuthn is faked at the library boundary (fake-webauthn.mts): @simplewebauthn/server is
 * replaced, and the browser's answers carry their client data as JSON the fake checks the way the library does.
 * The step-up gates on approving agent sessions and support codes are tested in remote-app and remote-support.
 */
import { test, before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library";
import { fakeWebAuthn } from "./fake-webauthn.mts";

type Row = Record<string, any>;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ── In-memory Prisma ──
const cmp = (a: any, b: any) => { const x = a instanceof Date ? a.getTime() : a; const y = b instanceof Date ? b.getTime() : b; return x < y ? -1 : x > y ? 1 : 0; };
function matches(row: Row | undefined, where: Row | undefined): boolean {
  if (!row) return false;
  return Object.entries(where ?? {}).every(([k, v]) => {
    if (v === undefined) return true;
    const val = row[k];
    if (v === null) return val === null || val === undefined;
    if (v instanceof Date) return val instanceof Date && val.getTime() === v.getTime();
    if (typeof v === "object" && !Array.isArray(v)) return Object.entries(v).every(([op, x]: [string, any]) => {
      switch (op) {
        case "gt": return val != null && cmp(val, x) > 0;
        case "lt": return val != null && cmp(val, x) < 0;
        case "not": return x === null ? val !== null && val !== undefined : val !== x;
        default: throw new Error(`in-memory prisma: unsupported filter ${op}`);
      }
    });
    return val === v;
  });
}
const tables: Record<string, Row[]> = {};
const copy = (r: Row | null | undefined) => (r ? { ...r } : null);
// unique: columns a real database refuses to duplicate (P2002).
function table(name: string, defaults: () => Row = () => ({}), unique: string[] = []) {
  tables[name] = [];
  const rows = () => tables[name];
  const clash = (r: Row, except?: Row) => unique.some(k => r[k] != null && rows().some(x => x !== except && x[k] === r[k]));
  const p2002 = () => new PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "5.22.0" });
  return {
    findUnique: async ({ where }: any) => copy(rows().find(r => matches(r, where))),
    findFirst: async ({ where }: any = {}) => copy(rows().find(r => matches(r, where))),
    findMany: async ({ where, take }: any = {}) => rows().filter(r => matches(r, where)).slice(0, take ?? Infinity).map(r => ({ ...r })),
    count: async ({ where }: any = {}) => rows().filter(r => matches(r, where)).length,
    create: async ({ data }: any) => { const r = { ...defaults(), ...data }; if (clash(r)) throw p2002(); rows().push(r); return { ...r }; },
    update: async ({ where, data }: any) => { const r = rows().find(x => matches(x, where)); if (!r) throw new Error("not found"); if (clash({ ...r, ...data }, r)) throw p2002(); return { ...Object.assign(r, data) }; },
    updateMany: async ({ where, data }: any) => { const hit = rows().filter(r => matches(r, where)); hit.forEach(r => Object.assign(r, data)); return { count: hit.length }; },
    deleteMany: async ({ where }: any) => { const keep = rows().filter(r => !matches(r, where)); const count = rows().length - keep.length; tables[name] = keep; return { count }; },
  };
}
const db: any = {
  account: table("account"),
  sessionCookie: table("sessionCookie"),
  accountAudit: table("accountAudit", () => ({ ts: new Date() })),
  agentToken: table("agentToken", () => ({ id: crypto.randomUUID(), createdAt: new Date(), revokedAt: null, lastUsedAt: null, scope: "full" }), ["keyHash"]),
  exchangeCode: table("exchangeCode", () => ({ createdAt: new Date(), usedAt: null }), ["codeHash"]),
  accountPasskey: table("accountPasskey", () => ({ id: crypto.randomUUID(), createdAt: new Date(), lastUsedAt: null, counter: 0n, transports: [] }), ["credentialId"]),
  passkeyChallenge: table("passkeyChallenge", () => ({ id: crypto.randomUUID(), createdAt: new Date(), action: null, targetId: null, answeredAt: null, grantHash: null, passkeyId: null, usedAt: null }), ["challenge", "grantHash"]),
};
// The real getAccountFromCookie reads the cookie's row with its account.
const cookieFind = db.sessionCookie.findUnique;
db.sessionCookie.findUnique = async (args: any) => {
  const c = await cookieFind(args);
  return c && args.include?.account ? { ...c, account: copy(tables.account.find(a => a.id === c.accountId)) } : c;
};

const webauthn = fakeWebAuthn();
let limited = false;
before(() => {
  process.env.PUBLIC_APP_URL = "https://back-channel.app";
  mock.module("@simplewebauthn/server", { namedExports: webauthn.lib });
  mock.module("@/lib/db", { namedExports: { prisma: db } });
  mock.module("@/lib/rate-limit", { namedExports: {
    rateLimit: () => ({ ok: !limited, retryAfterSec: 7 }), rateLimitPeek: () => ({ ok: !limited, retryAfterSec: 7 }), clientIp: () => "unknown",
  } });
  mock.module("@/lib/onboarding", { namedExports: { seedWelcomeIfFirstConnect: async () => {} } });
  mock.module("@/lib/email", { namedExports: { sendKeyRotatedEmail: async () => {} } });
  mock.module("@/lib/notify.mjs", { namedExports: {
    exchangePastePrompt: (code: string) => `Connect Back Channel with code ${code}.`,
    bootstrapPrompt: () => "Set up Back Channel with your key.",
  } });
});

// Session cookies are built at runtime, so no secret-shaped literal sits in the file.
const COOKIE = { a: ["cs", "accounta"].join("_"), b: ["cs", "accountb"].join("_") };
function reset() {
  for (const k of Object.keys(tables)) tables[k] = [];
  limited = false;
  webauthn.calls.length = 0;
  process.env.APPROVAL_STEP_UP = "on";
  const now = new Date();
  tables.account.push(
    { id: "acct-a", handle: "skylar@bc", displayName: "Skylar", email: "a@example.invalid", emailVerifiedAt: now, apiKeyLastUsedAt: null },
    { id: "acct-b", handle: "other@bc", displayName: null, email: "b@example.invalid", emailVerifiedAt: now, apiKeyLastUsedAt: null },
  );
  for (const [accountId, raw] of [["acct-a", COOKIE.a], ["acct-b", COOKIE.b]]) {
    tables.sessionCookie.push({ token: sha(raw), accountId, createdAt: now, expiresAt: new Date(Date.now() + 86_400_000), lastUsedAt: now });
  }
}
beforeEach(reset);

// ── Helpers ──
type Res = { status: number; body: any };
type Opts = { cookie?: string | null; csrf?: boolean; stepUp?: string; bearer?: string };
function req(method: string, url: string, body?: unknown, o: Opts = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const cookie = o.cookie === undefined ? COOKIE.a : o.cookie;
  if (cookie) headers.cookie = `bc_session=${cookie}; bc_csrf=tok`;
  if (o.csrf !== false) headers["x-bc-csrf"] = "tok";
  if (o.stepUp) headers["x-bc-step-up"] = o.stepUp;
  if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
  return new NextRequest(`https://back-channel.app${url}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
const read = async (res: Response): Promise<Res> => { const text = await res.text(); return { status: res.status, body: text ? JSON.parse(text) : null }; };
async function pk(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, o: Opts = {}): Promise<Res> {
  const mod = await import("@/app/api/account/passkeys/[[...path]]/route");
  return read(await mod[method](req(method, `/api/account/passkeys/${path}`, body, o), { params: Promise.resolve({ path: path.split("/").filter(Boolean) }) }));
}
const mintCode = async (o: Opts = {}) => read(await (await import("@/app/api/auth/exchange-code/route")).POST(req("POST", "/api/auth/exchange-code", { agent_name: "Laptop" }, o)));
const mintToken = async (o: Opts = {}) => read(await (await import("@/app/api/account/agents/route")).POST(req("POST", "/api/account/agents", { agent_name: "Desktop" }, o)));
const rotate = async (o: Opts = {}) => read(await (await import("@/app/api/account/key/rotate/route")).POST(req("POST", "/api/account/key/rotate", undefined, o)));
const bootstrap = async (o: Opts = {}) => read(await (await import("@/app/api/account/bootstrap-prompt/route")).GET(req("GET", "/api/account/bootstrap-prompt", undefined, o)));

/** Register a passkey through the routes (options, then the browser's answer). */
async function register(credentialId: string, o: Opts = {}, label?: string) {
  const opt = await pk("POST", "register/options", {}, o);
  assert.equal(opt.status, 200, JSON.stringify(opt.body));
  const v = await pk("POST", "register/verify", { ceremonyId: opt.body.ceremonyId, response: webauthn.registration(credentialId, opt.body.options.challenge), ...(label ? { label } : {}) }, o);
  return { opt, v };
}
/** A step-up through the routes: the grant, or the refusal. */
async function stepUp(action: string, targetId: string | null, credentialId: string, over: Parameters<typeof webauthn.authentication>[2] = {}, o: Opts = {}) {
  const opt = await pk("POST", "step-up/options", { action, ...(targetId ? { targetId } : {}) }, o);
  if (opt.status !== 200) return { opt, v: null as Res | null, grant: null as string | null };
  const v = await pk("POST", "step-up/verify", { ceremonyId: opt.body.ceremonyId, response: webauthn.authentication(credentialId, opt.body.options.challenge, over) }, o);
  return { opt, v, grant: v.status === 200 ? (v.body.grant as string) : null };
}
function passkeyOn(accountId = "acct-a", credentialId = `cred-${accountId}`) {
  const row = { id: crypto.randomUUID(), accountId, credentialId, publicKey: Buffer.from([165, 1, 2, 3, 38]), counter: 0n, transports: ["internal"], label: "Office PC", createdAt: new Date(), lastUsedAt: null };
  tables.accountPasskey.push(row);
  return row;
}
function grantFor(action: string, targetId: string | null, over: Row = {}, accountId = "acct-a"): string {
  const raw = ["bcsu", randomBytes(32).toString("base64url")].join("_");
  const now = new Date();
  tables.passkeyChallenge.push({ id: crypto.randomUUID(), accountId, kind: "step_up", action, targetId, challenge: `c${randomBytes(8).toString("hex")}`, createdAt: now,
    answeredAt: now, grantHash: sha(raw), passkeyId: null, usedAt: null, expiresAt: new Date(now.getTime() + 2 * 60_000), ...over });
  return raw;
}
const lastCall = (name: string) => [...webauthn.calls].reverse().find(([n]) => n === name)?.[1];
const everything = () => JSON.stringify(tables, (_, v) => (typeof v === "bigint" ? String(v) : v));

// ── Tests ──

test("register: the first passkey needs no step-up; user verification is required; only its public key, a counter and how to reach it are kept", async () => {
  const { opt, v } = await register("cred-hello", {}, "  Office​ PC  (Windows   Hello) ");
  const o = lastCall("generateRegistrationOptions");
  assert.equal(o.rpID, "back-channel.app"); assert.equal(o.rpName, "Back Channel");
  assert.equal(o.userName, "skylar@bc"); assert.equal(o.attestationType, "none");
  assert.deepEqual(o.authenticatorSelection, { residentKey: "preferred", userVerification: "required" });
  assert.deepEqual(o.excludeCredentials, []);
  assert.equal(o.userID.length, 32); assert.ok(!Buffer.from(o.userID).toString("utf8").includes("acct-a"), "an opaque user handle, never the account id");
  const row = tables.passkeyChallenge.find(c => c.id === opt.body.ceremonyId)!;
  assert.deepEqual([row.kind, row.action, row.accountId, row.challenge], ["register", null, "acct-a", opt.body.options.challenge]);
  assert.ok(row.expiresAt.getTime() - Date.now() <= 5 * 60_000);
  assert.equal(v.status, 200, JSON.stringify(v.body));
  const vr = lastCall("verifyRegistrationResponse");
  assert.deepEqual([vr.expectedOrigin, vr.expectedRPID, vr.requireUserVerification, vr.expectedChallenge], ["https://back-channel.app", "back-channel.app", true, opt.body.options.challenge]);
  assert.deepEqual(Object.keys(v.body.passkey).sort(), ["createdAt", "id", "label", "lastUsedAt", "transports"]);
  assert.equal(v.body.passkey.label, "Office PC (Windows Hello)", "control and zero-width characters out, spaces collapsed");
  const [p] = tables.accountPasskey;
  assert.deepEqual([p.accountId, p.credentialId, p.counter, p.transports, [...p.publicKey]], ["acct-a", "cred-hello", 0n, ["internal", "hybrid"], [165, 1, 2, 3, 38]]);
  assert.ok(row.answeredAt instanceof Date, "the challenge is spent");
  assert.deepEqual(tables.accountAudit.map(a => [a.eventType, a.detail.name]), [["passkey.added", "Office PC (Windows Hello)"]]);
  // A label too long is refused; none at all names it by its kind.
  const long = await register("cred-x", { stepUp: (await stepUp("manage_passkeys", null, "cred-hello")).grant! }, "x".repeat(61));
  assert.equal(long.v.status, 400); assert.equal(long.v.body.error, "invalid_label");
  const plain = await register("cred-y", { stepUp: (await stepUp("manage_passkeys", null, "cred-hello", { counter: 0 })).grant! });
  assert.equal(plain.v.status, 200); assert.equal(plain.v.body.passkey.label, "This device");
});

test("register: the first answer spends the challenge; a wrong origin, RP ID or challenge, or no user verification, adds nothing; expired and other accounts' ceremonies are refused", async () => {
  const bad: Array<[string, (c: string) => unknown]> = [
    ["another origin", c => webauthn.registration("cred-1", c, { origin: "https://evil.example" })],
    ["another RP ID", c => webauthn.registration("cred-1", c, { rpId: "evil.example" })],
    ["another challenge", () => webauthn.registration("cred-1", "not-the-challenge")],
    ["no user verification", c => webauthn.registration("cred-1", c, { uv: false })],
    ["not verified", c => webauthn.registration("cred-1", c, { bad: true })],
  ];
  for (const [why, answer] of bad) {
    const opt = await pk("POST", "register/options", {});
    const v = await pk("POST", "register/verify", { ceremonyId: opt.body.ceremonyId, response: answer(opt.body.options.challenge) });
    assert.equal(v.status, 400, why); assert.equal(v.body.error, "not_verified", why);
    // The same ceremony can't be tried again, even with the right answer.
    const again = await pk("POST", "register/verify", { ceremonyId: opt.body.ceremonyId, response: webauthn.registration("cred-1", opt.body.options.challenge) });
    assert.equal(again.status, 410, why); assert.equal(again.body.error, "ceremony_over");
  }
  assert.equal(tables.accountPasskey.length, 0);
  const opt = await pk("POST", "register/options", {});
  tables.passkeyChallenge.find(c => c.id === opt.body.ceremonyId)!.expiresAt = new Date(Date.now() - 1);
  assert.equal((await pk("POST", "register/verify", { ceremonyId: opt.body.ceremonyId, response: webauthn.registration("cred-1", opt.body.options.challenge) })).status, 410);
  const theirs = await pk("POST", "register/options", {}, { cookie: COOKIE.b });
  const stolen = await pk("POST", "register/verify", { ceremonyId: theirs.body.ceremonyId, response: webauthn.registration("cred-1", theirs.body.options.challenge) });
  assert.equal(stolen.status, 404);
  assert.equal(tables.accountPasskey.length, 0);
  // Malformed bodies.
  assert.equal((await pk("POST", "register/verify", { ceremonyId: "nope", response: {} })).body.error, "invalid_ceremony");
  assert.equal((await pk("POST", "register/verify", { ceremonyId: crypto.randomUUID(), response: { id: "x" } })).body.error, "invalid_response");
  // A passkey already registered (here or anywhere) isn't added twice.
  passkeyOn("acct-b", "cred-taken");
  const dup = await register("cred-taken");
  assert.equal(dup.v.status, 409); assert.equal(dup.v.body.error, "already_registered");
});

test("register: another passkey takes a manage_passkeys step-up with one the account has; a ceremony begun with none is refused once one exists", async () => {
  const first = passkeyOn();
  const bare = await pk("POST", "register/options", {});
  assert.equal(bare.status, 403); assert.equal(bare.body.error, "step_up_required");
  for (const g of [grantFor("connect_agent", null), grantFor("approve_session", crypto.randomUUID())]) {
    assert.equal((await pk("POST", "register/options", {}, { stepUp: g })).body.error, "step_up_required");
  }
  const g = (await stepUp("manage_passkeys", null, first.credentialId)).grant!;
  const ok = await register("cred-phone", { stepUp: g });
  assert.equal(ok.v.status, 200, JSON.stringify(ok.v.body));
  assert.deepEqual(lastCall("generateRegistrationOptions").excludeCredentials, [{ id: first.credentialId, transports: ["internal"] }], "this device can't register twice");
  assert.equal(tables.passkeyChallenge.find(c => c.id === ok.opt.body.ceremonyId)!.action, "manage_passkeys");
  // The grant went with that one ceremony.
  assert.equal((await pk("POST", "register/options", {}, { stepUp: g })).body.error, "step_up_required");
  // The race: a ceremony begun while the account had none, answered after someone added one.
  tables.accountPasskey.length = 0;
  const early = await pk("POST", "register/options", {});
  assert.equal(early.status, 200);
  passkeyOn();
  const late = await pk("POST", "register/verify", { ceremonyId: early.body.ceremonyId, response: webauthn.registration("cred-sneaky", early.body.options.challenge) });
  assert.equal(late.status, 403); assert.equal(late.body.error, "step_up_required");
  assert.ok(!tables.accountPasskey.some(p => p.credentialId === "cred-sneaky"));
});

test("people only: a bearer key, no cookie, or no CSRF on a change is refused by every passkeys route", async () => {
  const routes: Array<["GET" | "POST" | "DELETE", string, unknown?]> = [
    ["GET", ""], ["POST", "register/options", {}], ["POST", "register/verify", {}], ["POST", "step-up/options", { action: "connect_agent" }],
    ["POST", "step-up/verify", {}], ["DELETE", crypto.randomUUID()],
  ];
  for (const [m, path, body] of routes) {
    const agent = await pk(m, path, body, { bearer: ["bc", "agentkey"].join("_") });
    assert.equal(agent.status, 403, `${m} ${path}`); assert.equal(agent.body.error, "people_only");
    assert.equal((await pk(m, path, body, { cookie: null })).status, 401, `${m} ${path}`);
    if (m !== "GET") assert.equal((await pk(m, path, body, { csrf: false })).body.error, "csrf", `${m} ${path}`);
  }
  assert.equal((await pk("GET", "", undefined, { csrf: false })).status, 200, "reading the list needs no CSRF");
  assert.equal((await pk("POST", "nope", {})).status, 404);
  limited = true;
  assert.equal((await pk("POST", "register/options", {})).status, 429);
});

test("list and remove: labels and dates, never key material; removing needs a step-up and only ever touches this account", async () => {
  const mine = passkeyOn(); const theirs = passkeyOn("acct-b");
  const list = await pk("GET", "");
  assert.equal(list.status, 200);
  assert.equal(list.body.stepUp, "on");
  assert.deepEqual(list.body.passkeys.map((p: Row) => [p.id, p.label]), [[mine.id, "Office PC"]]);
  assert.ok(!JSON.stringify(list.body).includes(mine.credentialId) && !JSON.stringify(list.body).includes("publicKey"));
  const bare = await pk("DELETE", mine.id);
  assert.equal(bare.status, 403); assert.equal(bare.body.error, "step_up_required");
  assert.equal((await pk("DELETE", theirs.id, undefined, { stepUp: grantFor("manage_passkeys", null) })).status, 404, "another account's passkey");
  const g = (await stepUp("manage_passkeys", null, mine.credentialId)).grant!;
  const gone = await pk("DELETE", mine.id, undefined, { stepUp: g });
  assert.equal(gone.status, 200); assert.deepEqual(gone.body, { removed: true, remaining: 0 });
  assert.deepEqual(tables.accountPasskey.map(p => p.id), [theirs.id]);
  assert.ok(tables.accountAudit.some(a => a.eventType === "passkey.removed"));
  process.env.APPROVAL_STEP_UP = "off";
  assert.equal((await pk("GET", "")).body.stepUp, "off");
});

test("step-up options: the action and its target are checked, and an account with no passkey is passkey_required", async () => {
  const id = crypto.randomUUID();
  assert.equal((await pk("POST", "step-up/options", { action: "approve_session", targetId: id })).body.error, "passkey_required");
  passkeyOn();
  for (const [body, error] of [
    [{ action: "approve_everything" }, "invalid_action"],
    [{ action: "approve_session" }, "invalid_target"],
    [{ action: "approve_support", targetId: "not-a-uuid" }, "invalid_target"],
    [{ action: "connect_agent", targetId: id }, "invalid_target"],
  ] as Array<[Row, string]>) {
    assert.equal((await pk("POST", "step-up/options", body)).body.error, error, JSON.stringify(body));
  }
  const ok = await pk("POST", "step-up/options", { action: "approve_session", targetId: id.toUpperCase() });
  assert.equal(ok.status, 200);
  const row = tables.passkeyChallenge.find(c => c.id === ok.body.ceremonyId)!;
  assert.deepEqual([row.kind, row.action, row.targetId, row.grantHash], ["step_up", "approve_session", id, null]);
  assert.deepEqual(lastCall("generateAuthenticationOptions"), { rpID: "back-channel.app", allowCredentials: [{ id: "cred-acct-a", transports: ["internal"] }], userVerification: "required", timeout: 60_000 });
});

test("step-up verify: a good answer gets a single-use grant for that action only, at most 2 minutes; a bad signature, a stale counter, an unknown passkey, a replayed or expired ceremony get none", async () => {
  const key = passkeyOn();
  const target = crypto.randomUUID();
  const good = await stepUp("approve_support", target, key.credentialId, { counter: 7 });
  assert.equal(good.v!.status, 200, JSON.stringify(good.v!.body));
  assert.deepEqual([good.v!.body.action, good.v!.body.targetId], ["approve_support", target]);
  const row = tables.passkeyChallenge.find(c => c.id === good.opt.body.ceremonyId)!;
  assert.equal(row.grantHash, sha(good.grant!)); assert.equal(row.passkeyId, key.id); assert.equal(row.usedAt, null);
  assert.ok(row.expiresAt.getTime() - Date.now() <= 2 * 60_000 && row.expiresAt.getTime() > Date.now());
  assert.ok(!everything().includes(good.grant!), "only the grant's hash is stored");
  assert.equal(tables.accountPasskey[0].counter, 7n); assert.ok(tables.accountPasskey[0].lastUsedAt instanceof Date);
  const va = lastCall("verifyAuthenticationResponse");
  assert.deepEqual([va.expectedOrigin, va.expectedRPID, va.requireUserVerification, va.credential.id, va.credential.counter], ["https://back-channel.app", "back-channel.app", true, key.credentialId, 0]);
  // Replaying the same ceremony is refused, right answer or not.
  const replay = await pk("POST", "step-up/verify", { ceremonyId: good.opt.body.ceremonyId, response: webauthn.authentication(key.credentialId, good.opt.body.options.challenge, { counter: 8 }) });
  assert.equal(replay.status, 410);
  for (const [why, over, status, error] of [
    ["a bad signature", { signature: "bad", counter: 9 }, 400, "not_verified"],
    ["a counter that went back (a cloned key)", { counter: 7 }, 400, "not_verified"],
    ["no user verification", { uv: false, counter: 9 }, 400, "not_verified"],
    ["another origin", { origin: "https://evil.example", counter: 9 }, 400, "not_verified"],
  ] as Array<[string, Row, number, string]>) {
    const r = await stepUp("connect_agent", null, key.credentialId, over);
    assert.equal(r.v!.status, status, why); assert.equal(r.v!.body.error, error, why); assert.equal(r.grant, null, why);
    const spent = tables.passkeyChallenge.find(c => c.id === r.opt.body.ceremonyId)!;
    assert.equal(spent.grantHash, null, why); assert.ok(spent.answeredAt instanceof Date, `${why}: the challenge is spent`);
  }
  assert.equal((await stepUp("connect_agent", null, "cred-unknown")).v!.body.error, "unknown_passkey");
  const late = await pk("POST", "step-up/options", { action: "connect_agent" });
  tables.passkeyChallenge.find(c => c.id === late.body.ceremonyId)!.expiresAt = new Date(Date.now() - 1);
  assert.equal((await pk("POST", "step-up/verify", { ceremonyId: late.body.ceremonyId, response: webauthn.authentication(key.credentialId, late.body.options.challenge, { counter: 9 }) })).status, 410);
  // Another account can't answer this account's ceremony.
  passkeyOn("acct-b", "cred-b");
  const mineOpt = await pk("POST", "step-up/options", { action: "connect_agent" });
  assert.equal((await pk("POST", "step-up/verify", { ceremonyId: mineOpt.body.ceremonyId, response: webauthn.authentication("cred-b", mineOpt.body.options.challenge, { counter: 1 }) }, { cookie: COOKIE.b })).status, 404);
  assert.deepEqual(tables.accountAudit.filter(a => a.eventType === "step_up.confirmed").map(a => a.detail.action), ["approve_support"]);
});

test("connect codes: /api/auth/exchange-code needs a connect_agent grant; none, the wrong action, a reused or an expired grant is refused and mints nothing", async () => {
  const none = await mintCode();
  assert.equal(none.status, 403); assert.equal(none.body.error, "passkey_required");
  const key = passkeyOn();
  assert.equal((await mintCode()).body.error, "step_up_required");
  const now = Date.now();
  for (const [why, g] of [
    ["an approval's grant", grantFor("approve_session", crypto.randomUUID())],
    ["managing passkeys", grantFor("manage_passkeys", null)],
    ["another account's", grantFor("connect_agent", null, {}, "acct-b")],
    ["expired", grantFor("connect_agent", null, { expiresAt: new Date(now - 1) })],
  ] as Array<[string, string]>) {
    const r = await mintCode({ stepUp: g });
    assert.equal(r.status, 403, why); assert.equal(r.body.error, "step_up_required", why);
  }
  assert.equal(tables.exchangeCode.length, 0);
  // The real thing, through the routes: one step-up, one code.
  const { grant } = await stepUp("connect_agent", null, key.credentialId);
  const ok = await mintCode({ stepUp: grant! });
  assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.match(ok.body.code, /^BCX-/);
  assert.equal(tables.exchangeCode.length, 1);
  const reused = await mintCode({ stepUp: grant! });
  assert.equal(reused.status, 403); assert.equal(reused.body.error, "step_up_required"); assert.match(reused.body.message, /already used/);
  assert.equal(tables.exchangeCode.length, 1);
  // CSRF and the cookie still come first.
  assert.equal((await mintCode({ csrf: false, stepUp: grantFor("connect_agent", null) })).body.error, "csrf");
  // The emergency switch: no passkey needed.
  process.env.APPROVAL_STEP_UP = "off";
  tables.accountPasskey.length = 0;
  assert.equal((await mintCode()).status, 200);
});

test("every other dashboard route that mints an agent key needs the step-up too: a token, a rotated key, the setup prompt with a key", async () => {
  passkeyOn();
  const routes: Array<[string, (o?: Opts) => Promise<Res>, string]> = [["agent token", mintToken, "api_key"], ["rotated key", rotate, "api_key"], ["setup prompt", bootstrap, "prompt"]];
  for (const [what, call, field] of routes) {
    const bare = await call();
    assert.equal(bare.status, 403, what); assert.equal(bare.body.error, "step_up_required", what); assert.ok(!(field in bare.body), what);
    assert.equal((await call({ stepUp: grantFor("approve_support", crypto.randomUUID()) })).status, 403, `${what}: another action's grant`);
    const g = grantFor("connect_agent", null);
    const ok = await call({ stepUp: g });
    assert.equal(ok.status, 200, `${what}: ${JSON.stringify(ok.body)}`); assert.ok(ok.body[field], what);
    assert.equal((await call({ stepUp: g })).status, 403, `${what}: the grant was spent`);
  }
  assert.equal(tables.agentToken.filter(t => !t.revokedAt).length, 2, "one agent token and one Original key (the prompt's rotation revoked the rotated one)");
});