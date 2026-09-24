import { test, before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { NextRequest } from "next/server";

// Back Channel Remote paid tier (docs/remote-paid-tier.md): Stripe webhook, checkout, portal,
// status, and the relay gate reading subscriptions. Stripe's HTTP API is mocked via fetch; no
// test ever reaches Stripe.

// ── In-memory Prisma (same pattern as appbridge.routetest.mts) ──
type Row = Record<string, any>;
function matches(row: Row | undefined, where: Row | undefined): boolean {
  if (!row) return false;
  return Object.entries(where ?? {}).every(([k, v]) => {
    if (v === undefined) return true;
    if (k === "OR") return (v as Row[]).some(w => matches(row, w));
    if (k === "hostDeviceId_enrollmentId" || k === "accountId_feature") return matches(row, v);
    if (v instanceof Date) return row[k]?.getTime() === v.getTime();
    if (v && typeof v === "object") return Object.entries(v).every(([op, x]: [string, any]) =>
      op === "gt" ? row[k] > x : op === "gte" ? row[k] >= x : op === "lt" ? row[k] < x : op === "not" ? row[k] !== x : false);
    return row[k] === v;
  });
}
const tables: Record<string, Row[]> = {};
function table(name: string, defaults: () => Row = () => ({}), unique: string[] = []) {
  tables[name] = [];
  const rows = () => tables[name];
  const conflict = (r: Row) => unique.some(k => rows().some(x => x !== r && x[k] === r[k]));
  const p2002 = () => Object.assign(new Error("unique"), { code: "P2002" });
  return {
    findUnique: async ({ where }: any) => rows().find(r => matches(r, where)) ?? null,
    findFirst: async ({ where }: any) => rows().find(r => matches(r, where)) ?? null,
    findMany: async ({ where, take }: any) => rows().filter(r => matches(r, where)).slice(0, take ?? Infinity),
    create: async ({ data }: any) => { const r = { ...defaults(), ...data }; if (conflict(r)) throw p2002(); rows().push(r); return r; },
    update: async ({ where, data }: any) => { const r = rows().find(x => matches(x, where)); if (!r) throw new Error("not found"); return Object.assign(r, data, "updatedAt" in r ? { updatedAt: new Date() } : {}); },
    updateMany: async ({ where, data }: any) => { const hit = rows().filter(r => matches(r, where)); hit.forEach(r => Object.assign(r, data)); return { count: hit.length }; },
    deleteMany: async ({ where }: any) => { const keep = rows().filter(r => !matches(r, where)); const count = rows().length - keep.length; tables[name] = keep; return { count }; },
    upsert: async ({ where, create, update }: any) => { const r = rows().find(x => matches(x, where)); if (r) return Object.assign(r, update); const n = { ...defaults(), ...create }; rows().push(n); return n; },
  };
}
const db: any = {
  account: table("account"),
  accountAudit: table("accountAudit", () => ({ createdAt: new Date() })),
  appBridgeDevice: table("device", () => ({ label: null, enabled: true, relayEnabled: false, createdAt: new Date(), revokedAt: null })),
  appBridgeCredential: table("credential", () => ({ createdAt: new Date(), revokedAt: null })),
  appBridgeDeviceCode: table("code", () => ({ createdAt: new Date(), usedAt: null })),
  appBridgePairing: table("pairing", () => ({ attestedAt: new Date(), withdrawnAt: null })),
  appBridgeEntitlement: table("entitlement", () => ({ updatedAt: new Date() })),
  appBridgePass: table("pass", () => ({ createdAt: new Date(), consumedAt: null, remoteDeviceId: null, enrollmentId: null })),
  appBridgeLease: table("lease", () => ({ createdAt: new Date() })),
  appBridgeConnectionEvent: table("connection", () => ({ id: crypto.randomUUID(), at: new Date() })),
  billingCustomer: table("billingCustomer", () => ({ createdAt: new Date() }), ["accountId", "stripeCustomerId"]),
  remoteSubscription: table("remoteSubscription", () => ({ createdAt: new Date(), updatedAt: new Date(), cancelAtPeriodEnd: false, pastDueSince: null }), ["stripeSubscriptionId"]),
  stripeEvent: table("stripeEvent", () => ({ processedAt: new Date() }), ["eventId"]),
};
const credentialFind = db.appBridgeCredential.findUnique;
db.appBridgeCredential.findUnique = async (args: any) => {
  const c = await credentialFind(args);
  return c && args.include?.device ? { ...c, device: tables.device.find(d => d.id === c.deviceId) } : c;
};
db.$transaction = async (fn: any, options: any) => {
  assert.equal(options?.isolationLevel, "Serializable");
  const snapshot = structuredClone(tables);
  try { return await fn(db); } catch (e) { Object.assign(tables, snapshot); throw e; }
};

// ── Stripe's HTTP API, mocked ──
type Call = { url: string; headers: Record<string, string>; params: URLSearchParams };
let calls: Call[] = [];
let stripeReply: (url: string) => { status: number; body: unknown } = () => ({ status: 500, body: {} });
const realFetch = globalThis.fetch;
function defaultStripe(url: string) {
  if (url === "https://api.stripe.com/v1/customers") return { status: 200, body: { id: `cus_New${calls.length}`, object: "customer" } };
  if (url === "https://api.stripe.com/v1/checkout/sessions") return { status: 200, body: { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" } };
  if (url === "https://api.stripe.com/v1/billing_portal/sessions") return { status: 200, body: { id: "bps_1", url: "https://billing.stripe.com/p/session/test_1" } };
  return { status: 404, body: { error: { message: "no such route" } } };
}

const PRICE = "price_Remote12345";
const WHSEC = "whsec_" + "Tq3v".repeat(8);
const SECRET_KEY = "sk_test_" + "K9x".repeat(10);
let limited = false;
let warnings: string[] = [];
before(() => {
  mock.module("@/lib/db", { namedExports: { prisma: db } });
  mock.module("@/lib/rate-limit", { namedExports: { rateLimit: () => ({ ok: !limited, retryAfterSec: 7 }) } });
  mock.module("@/lib/auth", { namedExports: {
    SESSION_COOKIE_NAME: "bc_session", CSRF_COOKIE_NAME: "bc_csrf", CSRF_HEADER: "x-bc-csrf",
    csrfValid: (h: string | null, c: string | null) => !!h && !!c && h === c,
    getAccountFromCookie: async (v: string | undefined) => tables.account.find(a => a.cookie === v) ?? null,
  } });
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    calls.push({ url, headers: { ...(init?.headers ?? {}) }, params: new URLSearchParams(String(init?.body ?? "")) });
    const r = stripeReply(url);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); void warn; };
});
beforeEach(() => {
  for (const k of Object.keys(tables)) tables[k] = [];
  limited = false; calls = []; warnings = []; stripeReply = defaultStripe;
  process.env.APPBRIDGE_REMOTE_ACCESS = "on";
  process.env.APPBRIDGE_RELAY_PUBLIC_KEY = RELAY_PUBLIC_KEY;
  process.env.STRIPE_SECRET_KEY = SECRET_KEY;
  process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
  process.env.STRIPE_REMOTE_PRICE_ID = PRICE;
  process.env.PUBLIC_APP_URL = "https://back-channel.app";
  tables.account.push(
    { id: "acct-a", handle: "skylar", admin: true, emailVerifiedAt: new Date(), cookie: "cs_a" },
    { id: "acct-b", handle: "other", admin: false, emailVerifiedAt: new Date(), cookie: "cs_b" },
    { id: "acct-c", handle: "payer", admin: false, emailVerifiedAt: new Date(), cookie: "cs_c" },
  );
});
void realFetch;

// ── Helpers ──
const routes = {
  checkout: () => import("@/app/api/appbridge/v1/billing/checkout/route"),
  portal: () => import("@/app/api/appbridge/v1/billing/portal/route"),
  webhook: () => import("@/app/api/appbridge/v1/billing/webhook/route"),
  status: () => import("@/app/api/appbridge/v1/billing/status/route"),
  exchange: () => import("@/app/api/appbridge/v1/devices/exchange/route"),
  self: () => import("@/app/api/appbridge/v1/devices/self/route"),
  relaySwitch: () => import("@/app/api/appbridge/v1/hosts/self/relay/route"),
  pairing: () => import("@/app/api/appbridge/v1/hosts/self/pairings/[enrollmentId]/route"),
  passes: () => import("@/app/api/appbridge/v1/relay/passes/route"),
  redeem: () => import("@/app/api/appbridge/v1/relay/redeem/route"),
  renew: () => import("@/app/api/appbridge/v1/relay/renew/route"),
  codes: () => import("@/app/api/appbridge/v1/account/device-codes/route"),
  devices: () => import("@/app/api/appbridge/v1/account/devices/route"),
  entitlements: () => import("@/app/api/appbridge/v1/admin/entitlements/route"),
};
const lib = () => import("@/lib/billing");
function req(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("https://back-channel.app/api/appbridge/v1/x", { method, headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
}
const cookie = (acct = "c", csrf = true) => ({ cookie: `bc_session=cs_${acct}; bc_csrf=tok`, ...(csrf ? { "x-bc-csrf": "tok" } : {}) });
const bearer = (credential: string) => ({ authorization: `Bearer ${credential}` });
const nowSec = () => Math.floor(Date.now() / 1000);
const DAY = 86_400;

// Stripe's signing scheme: v1 = hex HMAC-SHA256(secret, `${t}.${raw body}`).
function stripeSignature(raw: string | Buffer, o: { secret?: string; t?: number } = {}) {
  const t = o.t ?? nowSec();
  const v1 = createHmac("sha256", o.secret ?? WHSEC).update(`${t}.`).update(raw).digest("hex");
  return `t=${t},v1=${v1}`;
}
function webhookReq(raw: string, header: string | null) {
  return new NextRequest("https://back-channel.app/api/appbridge/v1/billing/webhook", { method: "POST", body: raw,
    headers: { "content-type": "application/json", ...(header === null ? {} : { "stripe-signature": header }) } });
}
let eventSeq = 0;
function stripeEvent(type: string, object: Row, created = nowSec()) {
  return { id: `evt_${++eventSeq}${randomBytes(6).toString("hex")}`, object: "event", api_version: "2025-03-31.basil", type, created, livemode: false, data: { object } };
}
async function deliver(event: unknown, o: { secret?: string; t?: number } = {}) {
  const raw = JSON.stringify(event);
  return (await routes.webhook()).POST(webhookReq(raw, stripeSignature(raw, o)));
}
function subscription(over: Row = {}) {
  return { id: "sub_C1", object: "subscription", customer: "cus_C", status: "active", cancel_at_period_end: false, cancel_at: null,
    items: { object: "list", data: [{ id: "si_1", price: { id: PRICE }, current_period_end: nowSec() + 30 * DAY }] },
    metadata: { accountId: "acct-c" }, ...over };
}
const customerOf = (accountId: string, stripeCustomerId: string) => tables.billingCustomer.push({ accountId, stripeCustomerId, createdAt: new Date() });

// Relay path helpers (see appbridge.routetest.mts).
const relayKeys = generateKeyPairSync("ed25519");
const RELAY_PUBLIC_KEY = relayKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
function relayReq(route: "redeem" | "renew", body: unknown) {
  const path = `/api/appbridge/v1/relay/${route}`; const raw = JSON.stringify(body);
  const seconds = String(nowSec()); const nonce = randomBytes(16).toString("base64url");
  const hash = createHash("sha256").update(raw).digest("hex");
  const sig = sign(null, Buffer.from(`appbridge-relay-broker-v1\nPOST\n${path}\n${seconds}\n${nonce}\n${hash}`), relayKeys.privateKey).toString("base64url");
  return new NextRequest(`https://back-channel.app${path}`, { method: "POST", body: raw, headers: { "content-type": "application/json", authorization: `AppBridge-Relay v1.${seconds}.${nonce}.${sig}` } });
}
function newKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const der = publicKey.export({ type: "spki", format: "der" });
  return { spki: der.toString("base64"), fp: createHash("sha256").update(der).digest("hex").toUpperCase(),
    sign: (m: string) => sign("sha256", Buffer.from(m), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
}
async function register(role: "host" | "remote", acct: string) {
  const key = newKey();
  const m = await (await routes.codes()).POST(req("POST", { role }, cookie(acct)));
  const { code } = await m.json();
  const r = await (await routes.exchange()).POST(req("POST", { code, role, connectorSpki: key.spki, proof: key.sign(`appbridge-device-exchange-v1:${code}`) }));
  assert.equal(r.status, 200);
  return { ...(await r.json()), key } as { deviceId: string; credential: string; key: ReturnType<typeof newKey> };
}
/** A PC and a paired phone in account C (the paying account), with no entitlement of any kind. */
async function pair(acct = "c") {
  const host = await register("host", acct); const remote = await register("remote", acct);
  assert.equal((await (await routes.relaySwitch()).PUT(req("PUT", { enabled: true }, bearer(host.credential)))).status, 200);
  assert.equal((await (await routes.pairing()).PUT(req("PUT", { remoteDeviceId: remote.deviceId }, bearer(host.credential)), { params: Promise.resolve({ enrollmentId: "enr-1" }) })).status, 204);
  return { host, remote };
}
async function sessionPass(remote: { credential: string }, hostDeviceId: string) {
  return (await routes.passes()).POST(req("POST", { hostDeviceId, enrollmentId: "enr-1" }, bearer(remote.credential)));
}
async function connect(host: { deviceId: string }, remote: { credential: string; key: { fp: string } }) {
  const issued = await sessionPass(remote, host.deviceId);
  assert.equal(issued.status, 200, "pass issued");
  const r = await (await routes.redeem()).POST(relayReq("redeem", { pass: (await issued.json()).pass, purpose: "session", connectorSpkiSha256: remote.key.fp }));
  assert.equal(r.status, 200, "redeemed");
  return (await r.json()).leaseId as string;
}
const renew = async (leaseId: string) => (await routes.renew()).POST(relayReq("renew", { leaseId }));
async function status(acct = "c") {
  const r = await (await routes.status()).GET(req("GET", undefined, cookie(acct, false)));
  assert.equal(r.status, 200);
  return r.json();
}

// ── Tests ──

test("webhook: prunes processed-event ids older than 30 days", async () => {
  tables.stripeEvent.push({ eventId: "evt_old", processedAt: new Date(Date.now() - 31 * DAY * 1000) }, { eventId: "evt_recent", processedAt: new Date(Date.now() - 29 * DAY * 1000) });
  assert.equal((await deliver(stripeEvent("customer.subscription.updated", subscription()))).status, 200);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(tables.stripeEvent.map(e => e.eventId).filter(id => id.startsWith("evt_old") || id.startsWith("evt_recent")), ["evt_recent"]);
});

test("webhook signature: valid passes; wrong secret, tampered body, stale or future timestamp, missing or malformed header are 400 and change nothing", async () => {
  customerOf("acct-c", "cus_C");
  const post = (await routes.webhook()).POST;
  const event = stripeEvent("customer.subscription.created", subscription());
  const raw = JSON.stringify(event);
  const bad = async (header: string | null, body = raw, why = "") => {
    const r = await post(webhookReq(body, header));
    assert.equal(r.status, 400, why); assert.deepEqual(await r.json(), { error: "bad_signature" }, why);
  };
  await bad(null, raw, "missing header");
  await bad("", raw, "empty header");
  await bad(stripeSignature(raw, { secret: "whsec_" + "x".repeat(32) }), raw, "wrong secret");
  await bad(stripeSignature(raw), raw.replace('"active"', '"trialing"'), "tampered body");
  await bad(stripeSignature(JSON.stringify(JSON.parse(raw), null, 1)), raw, "signed over a re-serialized body, not the raw bytes");
  await bad(stripeSignature(raw, { t: nowSec() - 301 }), raw, "stale timestamp");
  await bad(stripeSignature(raw, { t: nowSec() + 301 }), raw, "future timestamp");
  await bad(stripeSignature(raw).replace("v1=", "v0="), raw, "only a v0 signature");
  await bad(`t=${nowSec()}`, raw, "no v1");
  await bad(`${stripeSignature(raw)},t=${nowSec()}`, raw, "two timestamps");
  await bad(stripeSignature(raw).toUpperCase().replace("T=", "t=").replace("V1=", "v1="), raw, "uppercase hex");
  assert.equal(tables.stripeEvent.length, 0); assert.equal(tables.remoteSubscription.length, 0);
  // A header with a stale v1 from a rolled secret plus the current one is valid.
  const rolled = `${stripeSignature(raw, { secret: "whsec_" + "o".repeat(32) })},${stripeSignature(raw).split(",")[1]}`;
  const ok = await post(webhookReq(raw, rolled));
  assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { received: true }, "nothing from the payload is echoed");
  assert.equal(tables.remoteSubscription.length, 1);
  // Within tolerance is fine.
  assert.equal((await deliver(stripeEvent("customer.subscription.updated", subscription()), { t: nowSec() - 290 })).status, 200);
});

test("verifyStripeSignature runs over the exact bytes, including non-ASCII", async () => {
  const { verifyStripeSignature, SIGNATURE_TOLERANCE_SEC } = await lib();
  assert.equal(SIGNATURE_TOLERANCE_SEC, 300);
  const raw = Buffer.from('{"name":"Zoë ☃"}', "utf8");
  const header = stripeSignature(raw, { t: 1_700_000_000 });
  assert.equal(verifyStripeSignature(raw, header, WHSEC, 1_700_000_000), true);
  assert.equal(verifyStripeSignature(raw, header, WHSEC, 1_700_000_000 + 301), false);
  assert.equal(verifyStripeSignature(Buffer.from(raw.toString("latin1"), "utf8"), header, WHSEC, 1_700_000_000), false, "re-encoded bytes differ");
  assert.equal(verifyStripeSignature(raw, header.replace(/v1=([0-9a-f])/, (_, c) => `v1=${c === "0" ? "1" : "0"}`), WHSEC, 1_700_000_000), false);
});

test("webhook: an event is applied once; a replay changes nothing; a refused transaction records nothing", async () => {
  customerOf("acct-c", "cus_C");
  const created = stripeEvent("customer.subscription.created", subscription());
  assert.equal((await deliver(created)).status, 200);
  assert.equal(tables.stripeEvent.length, 1);
  const audits = () => tables.accountAudit.filter(a => a.eventType === "billing.remote_subscription").length;
  assert.equal(audits(), 1);
  // Change the row behind the webhook's back; replaying the same event id must not re-apply it.
  Object.assign(tables.remoteSubscription[0], { status: "unpaid", lastEventAt: new Date(0) });
  const replay = await deliver(created);
  assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), { received: true });
  assert.equal(tables.remoteSubscription[0].status, "unpaid", "the replay was not applied");
  assert.equal(tables.stripeEvent.length, 1); assert.equal(audits(), 1);
  // Without a configured price a new subscription cannot be classified: 503, and the event id is
  // not recorded, so Stripe's retry is processed once the price is set.
  delete process.env.STRIPE_REMOTE_PRICE_ID;
  const second = stripeEvent("customer.subscription.created", subscription({ id: "sub_C2" }));
  assert.equal((await deliver(second)).status, 503);
  assert.equal(tables.stripeEvent.length, 1); assert.equal(tables.remoteSubscription.length, 1);
  process.env.STRIPE_REMOTE_PRICE_ID = PRICE;
  assert.equal((await deliver(second)).status, 200);
  assert.equal(tables.remoteSubscription.length, 2);
});

test("webhook account mapping: only our stored customer id maps; our metadata must agree; nothing else is trusted", async () => {
  customerOf("acct-b", "cus_B"); customerOf("acct-c", "cus_C");
  // Unknown customer, even with metadata naming a real account: nothing.
  assert.equal((await deliver(stripeEvent("customer.subscription.created", subscription({ customer: "cus_Stranger", metadata: { accountId: "acct-c" } })))).status, 200);
  // Our customer, but metadata naming another account: a conflict, nothing.
  assert.equal((await deliver(stripeEvent("customer.subscription.created", subscription({ customer: "cus_B", metadata: { accountId: "acct-c" } })))).status, 200);
  // A customer that is not a string (an expanded object) is not trusted either.
  assert.equal((await deliver(stripeEvent("customer.subscription.created", subscription({ customer: { id: "cus_C", metadata: { accountId: "acct-c" } } })))).status, 200);
  // Another product's price on our customer: not a Remote subscription.
  assert.equal((await deliver(stripeEvent("customer.subscription.created", subscription({ items: { data: [{ price: { id: "price_Other9999" }, current_period_end: nowSec() + DAY }] } })))).status, 200);
  assert.equal(tables.remoteSubscription.length, 0);
  assert.deepEqual(warnings, ["billing webhook: unmapped", "billing webhook: conflict", "billing webhook: unmapped"]);
  // Our customer and no metadata: maps to the stored account.
  assert.equal((await deliver(stripeEvent("customer.subscription.created", subscription({ metadata: {} })))).status, 200);
  assert.deepEqual(tables.remoteSubscription.map(s => [s.stripeSubscriptionId, s.accountId, s.status, s.priceId]), [["sub_C1", "acct-c", "active", PRICE]]);
  // The same subscription id later arriving under another account's customer cannot move it.
  assert.equal((await deliver(stripeEvent("customer.subscription.deleted", subscription({ customer: "cus_B", status: "canceled", metadata: {} }), nowSec() + 5))).status, 200);
  assert.equal(tables.remoteSubscription[0].status, "active"); assert.equal(tables.remoteSubscription[0].accountId, "acct-c");
  // checkout.session.completed: client_reference_id and metadata must match the customer's account.
  const session = (over: Row) => ({ id: "cs_1", object: "checkout.session", mode: "subscription", customer: "cus_C", subscription: "sub_C1", client_reference_id: "acct-c", metadata: { accountId: "acct-c" }, ...over });
  await deliver(stripeEvent("checkout.session.completed", session({ client_reference_id: "acct-b" })));
  await deliver(stripeEvent("checkout.session.completed", session({ metadata: { accountId: "acct-b" } })));
  await deliver(stripeEvent("checkout.session.completed", session({ customer: "cus_Stranger" })));
  assert.equal(tables.accountAudit.filter(a => a.eventType === "billing.checkout_completed").length, 0);
  await deliver(stripeEvent("checkout.session.completed", session({})));
  assert.deepEqual(tables.accountAudit.filter(a => a.eventType === "billing.checkout_completed").map(a => a.accountId), ["acct-c"]);
  for (const w of warnings) assert.ok(!/cus_|sub_|acct-|evt_|price_/.test(w), "warnings carry codes only");
});

test("subscription active: entitled, a relay pass is issued and renewed; deleted: the next renewal and new passes are refused", async () => {
  customerOf("acct-c", "cus_C");
  const { host, remote } = await pair();
  assert.deepEqual(await (await sessionPass(remote, host.deviceId)).json(), { error: "not_entitled" });
  await deliver(stripeEvent("customer.subscription.created", subscription()));
  const leaseId = await connect(host, remote);
  assert.equal((await renew(leaseId)).status, 200);
  assert.equal((await (await (await routes.self()).GET(req("GET", undefined, bearer(remote.credential)))).json()).remoteAccess, "available");
  assert.equal((await (await (await routes.devices()).GET(req("GET", undefined, cookie("c", false)))).json()).entitled, true);
  // Cancelled in the portal at period end: still entitled until Stripe ends it.
  await deliver(stripeEvent("customer.subscription.updated", subscription({ cancel_at_period_end: true }), nowSec() + 1));
  assert.equal((await renew(leaseId)).status, 200);
  assert.equal((await status()).cancelAtPeriodEnd, true);
  // Stripe ends it: the very next renewal is refused and the lease is gone.
  await deliver(stripeEvent("customer.subscription.deleted", subscription({ status: "canceled" }), nowSec() + 2));
  assert.equal((await renew(leaseId)).status, 403);
  assert.equal(tables.lease.length, 0);
  assert.deepEqual(await (await sessionPass(remote, host.deviceId)).json(), { error: "not_entitled" });
  assert.equal((await (await (await routes.self()).GET(req("GET", undefined, bearer(remote.credential)))).json()).remoteAccess, "not_entitled");
});

test("an immediate cancellation (updated to canceled) and an unpaid subscription are refused at the next renewal", async () => {
  customerOf("acct-c", "cus_C");
  const { host, remote } = await pair();
  await deliver(stripeEvent("customer.subscription.created", subscription()));
  const leaseId = await connect(host, remote);
  await deliver(stripeEvent("customer.subscription.updated", subscription({ status: "unpaid" }), nowSec() + 1));
  assert.equal((await renew(leaseId)).status, 403);
  await deliver(stripeEvent("customer.subscription.updated", subscription({ status: "active" }), nowSec() + 2));
  const second = await connect(host, remote);
  await deliver(stripeEvent("customer.subscription.updated", subscription({ status: "canceled" }), nowSec() + 3));
  assert.equal((await renew(second)).status, 403);
});

test("out-of-order delivery: an older snapshot never overwrites a newer one, and a canceled subscription is never revived", async () => {
  customerOf("acct-c", "cus_C");
  const t = nowSec();
  await deliver(stripeEvent("customer.subscription.created", subscription(), t));
  await deliver(stripeEvent("customer.subscription.deleted", subscription({ status: "canceled" }), t + 10));
  await deliver(stripeEvent("customer.subscription.updated", subscription({ status: "active" }), t + 5));
  assert.equal(tables.remoteSubscription[0].status, "canceled", "older update after the deletion");
  await deliver(stripeEvent("customer.subscription.updated", subscription({ status: "active" }), t + 20));
  assert.equal(tables.remoteSubscription[0].status, "canceled", "a canceled subscription stays canceled");
  assert.equal((await status()).plan, "none");
  // Nothing goes back to incomplete.
  await deliver(stripeEvent("customer.subscription.created", subscription({ id: "sub_C2" }), t + 30));
  await deliver(stripeEvent("customer.subscription.updated", subscription({ id: "sub_C2", status: "incomplete" }), t + 30));
  assert.equal(tables.remoteSubscription.find(s => s.stripeSubscriptionId === "sub_C2")!.status, "active");
});

test("past_due: entitled for 3 days from the first past_due we saw, then refused; paying restores access", async () => {
  customerOf("acct-c", "cus_C");
  const { host, remote } = await pair();
  const t = nowSec();
  await deliver(stripeEvent("customer.subscription.created", subscription(), t - 10));
  await deliver(stripeEvent("customer.subscription.updated", subscription({ status: "past_due" }), t));
  const row = tables.remoteSubscription[0];
  assert.equal(row.pastDueSince.getTime(), t * 1000);
  const leaseId = await connect(host, remote);
  assert.equal((await renew(leaseId)).status, 200, "inside the grace");
  // A later past_due snapshot keeps the original clock.
  await deliver(stripeEvent("customer.subscription.updated", subscription({ status: "past_due" }), t + 60));
  assert.equal(row.pastDueSince.getTime(), t * 1000);
  // An earlier failed invoice pulls the clock back to that failure.
  const invoice = { id: "in_1", object: "invoice", customer: "cus_C", parent: { type: "subscription_details", subscription_details: { subscription: "sub_C1", metadata: { accountId: "acct-c" } } } };
  await deliver(stripeEvent("invoice.payment_failed", invoice, t - 30));
  assert.equal(row.pastDueSince.getTime(), (t - 30) * 1000);
  // Past the grace: refused at the next renewal and for new passes.
  row.pastDueSince = new Date(Date.now() - 3 * DAY * 1000 - 1000);
  assert.equal((await renew(leaseId)).status, 403);
  assert.deepEqual(await (await sessionPass(remote, host.deviceId)).json(), { error: "not_entitled" });
  const s = await status();
  assert.equal(s.plan, "none"); assert.equal(s.status, "past_due");
  // The invoice is paid: active again, the clock is cleared.
  await deliver(stripeEvent("customer.subscription.updated", subscription({ status: "active" }), t + 120));
  assert.equal(row.pastDueSince, null);
  await connect(host, remote);
  // A payment failure on a healthy subscription never grants or starts anything by itself.
  await deliver(stripeEvent("invoice.payment_failed", { ...invoice, id: "in_2" }, t + 130));
  assert.equal(row.pastDueSince, null);
});

test("the period-end backstop: a subscription Stripe has gone silent about stops entitling 3 days after its period", async () => {
  customerOf("acct-c", "cus_C");
  const { host, remote } = await pair();
  // Old API shape: current_period_end on the subscription itself.
  const { items: _items, ...flat } = subscription();
  await deliver(stripeEvent("customer.subscription.created", { ...flat, items: { data: [{ price: { id: PRICE } }] }, current_period_end: nowSec() - 2 * DAY }));
  assert.equal((await sessionPass(remote, host.deviceId)).status, 200, "2 days past the period: still inside the slack");
  tables.remoteSubscription[0].currentPeriodEnd = new Date(Date.now() - 3 * DAY * 1000 - 1000);
  assert.deepEqual(await (await sessionPass(remote, host.deviceId)).json(), { error: "not_entitled" });
});

test("the admin grant keeps working with or without a subscription, and status reports its source", async () => {
  customerOf("acct-c", "cus_C");
  const { host, remote } = await pair();
  assert.deepEqual(await status(), { plan: "none", status: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, source: null });
  assert.equal((await (await routes.entitlements()).PUT(req("PUT", { handle: "payer", active: true }, cookie("a")))).status, 200);
  assert.deepEqual(await status(), { plan: "remote", status: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, source: "admin" });
  const leaseId = await connect(host, remote);
  await deliver(stripeEvent("customer.subscription.created", subscription()));
  assert.equal((await status()).source, "subscription");
  await deliver(stripeEvent("customer.subscription.deleted", subscription({ status: "canceled" }), nowSec() + 1));
  assert.equal((await renew(leaseId)).status, 200, "the comp still stands");
  assert.deepEqual({ ...(await status()), currentPeriodEnd: null }, { plan: "remote", status: "canceled", currentPeriodEnd: null, cancelAtPeriodEnd: false, source: "admin" });
  assert.equal((await (await routes.entitlements()).PUT(req("PUT", { handle: "payer", active: false }, cookie("a")))).status, 200);
  assert.equal((await renew(leaseId)).status, 403);
});

test("status: the plan and nothing else — no Stripe ids, price, key or secret", async () => {
  customerOf("acct-c", "cus_C");
  await deliver(stripeEvent("customer.subscription.created", subscription()));
  const r = await (await routes.status()).GET(req("GET", undefined, cookie("c", false)));
  assert.equal(r.status, 200); assert.equal(r.headers.get("cache-control"), "no-store");
  const text = await r.text(); const body = JSON.parse(text);
  assert.deepEqual(Object.keys(body).sort(), ["cancelAtPeriodEnd", "currentPeriodEnd", "plan", "source", "status"]);
  assert.equal(body.plan, "remote"); assert.equal(body.status, "active"); assert.equal(body.source, "subscription");
  for (const secret of ["cus_", "sub_", "price_", "sk_", "whsec_", SECRET_KEY, WHSEC, PRICE, "acct-c"]) assert.ok(!text.includes(secret), secret);
  assert.equal((await (await routes.status()).GET(req("GET"))).status, 401);
  assert.equal((await (await routes.status()).GET(req("GET", undefined, bearer("bc_" + "x".repeat(43))))).status, 401);
});

test("checkout: cookie + CSRF only; refuses bc_ and ab_ credentials; one customer per account; our ids in the session", async () => {
  const post = (await routes.checkout()).POST;
  const device = await register("remote", "c");
  for (const headers of [{}, bearer("bc_" + "x".repeat(43)), bearer(device.credential), { ...bearer("bc_" + "x".repeat(43)), "x-bc-csrf": "tok" }]) {
    assert.equal((await post(req("POST", undefined, headers))).status, 401);
  }
  assert.equal((await post(req("POST", undefined, cookie("c", false)))).status, 403, "csrf");
  assert.equal((await post(req("POST", undefined, { cookie: "bc_session=cs_c; bc_csrf=tok", "x-bc-csrf": "other" }))).status, 403, "mismatched csrf");
  assert.equal(calls.length, 0, "nothing reached Stripe");
  const ok = await post(req("POST", undefined, cookie("c")));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { url: "https://checkout.stripe.com/c/pay/cs_test_1" });
  assert.deepEqual(calls.map(c => c.url), ["https://api.stripe.com/v1/customers", "https://api.stripe.com/v1/checkout/sessions"]);
  const [cust, session] = calls;
  assert.equal(cust.headers.authorization, `Bearer ${SECRET_KEY}`);
  assert.equal(cust.headers["idempotency-key"], "bc-remote-customer-v1-acct-c");
  assert.deepEqual([...cust.params.entries()], [["metadata[accountId]", "acct-c"]], "no email or name is sent");
  const customerId = tables.billingCustomer[0].stripeCustomerId;
  assert.deepEqual(tables.billingCustomer.map(b => b.accountId), ["acct-c"]);
  assert.deepEqual(Object.fromEntries(session.params), {
    mode: "subscription", customer: customerId, client_reference_id: "acct-c", "metadata[accountId]": "acct-c", "subscription_data[metadata][accountId]": "acct-c",
    "line_items[0][price]": PRICE, "line_items[0][quantity]": "1",
    success_url: "https://back-channel.app/account/remote?billing=success", cancel_url: "https://back-channel.app/account/remote?billing=cancel",
  });
  // A second checkout reuses the customer.
  calls = [];
  assert.equal((await post(req("POST", undefined, cookie("c")))).status, 200);
  assert.deepEqual(calls.map(c => c.url), ["https://api.stripe.com/v1/checkout/sessions"]);
  assert.equal(calls[0].params.get("customer"), customerId);
  // Subscribed: no second subscription.
  await deliver(stripeEvent("customer.subscription.created", subscription({ customer: customerId })));
  calls = [];
  assert.deepEqual(await (await post(req("POST", undefined, cookie("c")))).json(), { error: "already_subscribed" });
  assert.equal(calls.length, 0);
});

test("checkout: needs a verified email; Stripe failures and foreign URLs are 502 with nothing echoed", async () => {
  const post = (await routes.checkout()).POST;
  tables.account[2].emailVerifiedAt = null;
  assert.deepEqual(await (await post(req("POST", undefined, cookie("c")))).json(), { error: "email_unverified" });
  tables.account[2].emailVerifiedAt = new Date();
  stripeReply = url => url.endsWith("/checkout/sessions") ? { status: 400, body: { error: { message: `No such price: '${PRICE}'` } } } : defaultStripe(url);
  const failed = await post(req("POST", undefined, cookie("c")));
  assert.equal(failed.status, 502);
  const text = await failed.text();
  assert.deepEqual(JSON.parse(text), { error: "stripe_error" }); assert.ok(!text.includes(PRICE));
  stripeReply = url => url.endsWith("/checkout/sessions") ? { status: 200, body: { url: "https://evil.example/pay" } } : defaultStripe(url);
  assert.equal((await post(req("POST", undefined, cookie("c")))).status, 502, "only a Stripe-hosted page is handed to the browser");
  stripeReply = url => url.endsWith("/checkout/sessions") ? { status: 200, body: { url: "http://checkout.stripe.com/c/pay/x" } } : defaultStripe(url);
  assert.equal((await post(req("POST", undefined, cookie("c")))).status, 502, "https only");
  assert.equal(tables.billingCustomer.length, 1, "the customer is still one per account");
  limited = true;
  assert.equal((await post(req("POST", undefined, cookie("c")))).status, 429);
});

test("portal: cookie + CSRF only; refuses bc_ and ab_; needs our customer; returns the portal URL", async () => {
  const post = (await routes.portal()).POST;
  const device = await register("host", "c");
  for (const headers of [{}, bearer("bc_" + "x".repeat(43)), bearer(device.credential)]) assert.equal((await post(req("POST", undefined, headers))).status, 401);
  assert.equal((await post(req("POST", undefined, cookie("c", false)))).status, 403, "csrf");
  assert.deepEqual(await (await post(req("POST", undefined, cookie("c")))).json(), { error: "no_customer" });
  customerOf("acct-c", "cus_C");
  const ok = await post(req("POST", undefined, cookie("c")));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { url: "https://billing.stripe.com/p/session/test_1" });
  assert.deepEqual(calls.map(c => [c.url, Object.fromEntries(c.params)]), [["https://api.stripe.com/v1/billing_portal/sessions", { customer: "cus_C", return_url: "https://back-channel.app/account/remote" }]]);
});

test("unset or placeholder configuration: every billing route answers 503 and nothing reaches Stripe", async () => {
  customerOf("acct-c", "cus_C");
  const hit = async () => ({
    checkout: (await (await routes.checkout()).POST(req("POST", undefined, cookie("c")))).status,
    portal: (await (await routes.portal()).POST(req("POST", undefined, cookie("c")))).status,
    status: (await (await routes.status()).GET(req("GET", undefined, cookie("c", false)))).status,
  });
  for (const [name, value] of [["STRIPE_SECRET_KEY", undefined], ["STRIPE_SECRET_KEY", "unset"], ["STRIPE_WEBHOOK_SECRET", undefined], ["STRIPE_REMOTE_PRICE_ID", undefined],
    ["STRIPE_REMOTE_PRICE_ID", "price_REPLACE_ME"], ["PUBLIC_APP_URL", undefined], ["PUBLIC_APP_URL", "http://back-channel.app"]] as const) {
    const saved = process.env[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
    assert.deepEqual(await hit(), { checkout: 503, portal: 503, status: 503 }, `${name}=${value}`);
    process.env[name] = saved;
  }
  delete process.env.STRIPE_WEBHOOK_SECRET;
  const r = await deliver(stripeEvent("customer.subscription.created", subscription()));
  assert.equal(r.status, 503); assert.deepEqual(await r.json(), { error: "billing_unavailable" });
  process.env.STRIPE_WEBHOOK_SECRET = "placeholder";
  assert.equal((await deliver(stripeEvent("customer.subscription.created", subscription()))).status, 503);
  assert.equal(calls.length, 0); assert.equal(tables.remoteSubscription.length, 0);
  // The relay gate never depends on billing configuration: a tracked subscription still entitles.
  process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
  await deliver(stripeEvent("customer.subscription.created", subscription()));
  delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_WEBHOOK_SECRET; delete process.env.STRIPE_REMOTE_PRICE_ID;
  const { host, remote } = await pair();
  assert.equal((await sessionPass(remote, host.deviceId)).status, 200);
});

test("webhook: unknown event types are acknowledged and do nothing; a valid signature over junk is 400; no CSRF or cookie involved", async () => {
  customerOf("acct-c", "cus_C");
  const r = await deliver(stripeEvent("customer.created", { id: "cus_C", object: "customer", metadata: { accountId: "acct-c" } }));
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { received: true });
  assert.equal(tables.stripeEvent.length, 0); assert.equal(tables.accountAudit.length, 0);
  const post = (await routes.webhook()).POST;
  for (const raw of ["{not json", "[1]", JSON.stringify({ id: "evt_1", type: "customer.subscription.created" }), JSON.stringify({ ...stripeEvent("customer.subscription.created", subscription()), id: "not-an-event" })]) {
    assert.equal((await post(webhookReq(raw, stripeSignature(raw)))).status, 400);
  }
  // A dashboard cookie is not a webhook credential.
  const raw = JSON.stringify(stripeEvent("customer.subscription.created", subscription()));
  const withCookie = new NextRequest("https://back-channel.app/api/appbridge/v1/billing/webhook", { method: "POST", body: raw, headers: { ...cookie("c"), "content-type": "application/json" } });
  assert.equal((await post(withCookie)).status, 400);
  // Oversized bodies are refused before any work.
  const big = JSON.stringify({ pad: "x".repeat(1024 * 1024) });
  assert.equal((await post(webhookReq(big, stripeSignature(big)))).status, 413);
  assert.equal(tables.remoteSubscription.length, 0);
});
