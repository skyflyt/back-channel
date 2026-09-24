/**
 * Back Channel Remote paid tier: a Stripe subscription that entitles an account to relay access.
 * Spec: docs/remote-paid-tier.md. Entitlement rules: src/lib/remote-entitlement.ts.
 *
 * Rules this file keeps:
 * - Checkout, portal and status are dashboard-session routes (cookie; mutations also need the
 *   double-submit CSRF header). A `bc_` agent key or an `ab_` device credential is never accepted.
 * - The webhook is authenticated only by Stripe's signature, checked over the raw body bytes
 *   (HMAC-SHA256 with the endpoint secret, constant-time compare, 5-minute tolerance).
 * - A Stripe object is mapped to an account ONLY through the BillingCustomer row the broker wrote
 *   when it created that customer. Metadata we set (accountId) is a cross-check: if it disagrees,
 *   the event does nothing. Nothing else in a payload is trusted for identity.
 * - Each event is processed once (StripeEvent), in one serializable transaction.
 * - No body, id or payload content is logged or echoed. Stripe is called with plain HTTPS; there is
 *   no SDK dependency.
 * - Unconfigured is closed: without the Stripe settings every billing route answers 503.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { accountContext, fail, handle, json, limit } from "@/lib/appbridge";
import { REMOTE_ACCESS_FEATURE, remoteSubscriptions, subscriptionEntitles } from "@/lib/remote-entitlement";

const STRIPE_API = "https://api.stripe.com/v1";
export const SIGNATURE_TOLERANCE_SEC = 300;
const WEBHOOK_MAX_BODY = 1024 * 1024;
const EVENT_RETENTION_MS = 30 * 86_400_000;
const serializable = { isolationLevel: "Serializable" as const };
/** Not entitling, but still a live subscription the owner should fix or cancel in the portal. */
const OPEN = new Set(["past_due", "unpaid", "paused"]);

// ── Configuration ───────────────────────────────────────────────────────────

const SECRET_KEY = /^(sk|rk)_(live|test)_[A-Za-z0-9]{16,}$/;
const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9+/=]{16,}$/;
const PRICE_ID = /^price_[A-Za-z0-9]{8,}$/;

export type BillingConfig = { secretKey: string; priceId: string; appOrigin: string };

function appOrigin(): string | null {
  try {
    const u = new URL(process.env.PUBLIC_APP_URL ?? "");
    const local = u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
    return u.protocol === "https:" || local ? u.origin : null;
  } catch { return null; }
}
const webhookSecret = () => { const s = process.env.STRIPE_WEBHOOK_SECRET ?? ""; return WEBHOOK_SECRET.test(s) ? s : null; };
const remotePriceId = () => { const p = process.env.STRIPE_REMOTE_PRICE_ID ?? ""; return PRICE_ID.test(p) ? p : null; };

/** Everything the dashboard routes need, or null (the routes then answer 503). */
export function billingConfig(): BillingConfig | null {
  const secretKey = process.env.STRIPE_SECRET_KEY ?? "";
  const priceId = remotePriceId(); const origin = appOrigin();
  if (!SECRET_KEY.test(secretKey) || !webhookSecret() || !priceId || !origin) return null;
  return { secretKey, priceId, appOrigin: origin };
}
function requireConfig(): BillingConfig { return billingConfig() ?? fail(503, "billing_unavailable"); }

// ── Stripe HTTP ─────────────────────────────────────────────────────────────

type StripeObject = Record<string, unknown>;

async function stripePost(cfg: BillingConfig, path: string, params: Record<string, string>, idempotencyKey?: string): Promise<StripeObject> {
  let res: Response;
  try {
    res = await fetch(`${STRIPE_API}/${path}`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${cfg.secretKey}`, "content-type": "application/x-www-form-urlencoded", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
      body: new URLSearchParams(params).toString(),
    });
  } catch { return fail(502, "stripe_error"); }
  // Stripe's error body is never read or relayed: it can describe our configuration.
  if (!res.ok) fail(502, "stripe_error");
  const body = await res.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) fail(502, "stripe_error");
  return body as StripeObject;
}

/** Only a Stripe-hosted https page is ever handed to the browser. */
function stripeUrl(value: unknown): string {
  if (typeof value !== "string") fail(502, "stripe_error");
  let u: URL;
  try { u = new URL(value); } catch { return fail(502, "stripe_error"); }
  if (u.protocol !== "https:" || !(u.hostname === "checkout.stripe.com" || u.hostname === "billing.stripe.com")) fail(502, "stripe_error");
  return u.toString();
}

const isUniqueViolation = (e: unknown) => !!e && typeof e === "object" && "code" in e && e.code === "P2002";

/** The account's one Stripe customer: reused if we have it, else created (idempotently) and recorded. */
async function customerFor(cfg: BillingConfig, accountId: string): Promise<string> {
  const existing = await prisma.billingCustomer.findUnique({ where: { accountId } });
  if (existing) return existing.stripeCustomerId;
  // No email, name or address: Checkout collects what Stripe needs. The idempotency key makes two
  // racing first checkouts get the same customer.
  const customer = await stripePost(cfg, "customers", { "metadata[accountId]": accountId }, `bc-remote-customer-v1-${accountId}`);
  if (typeof customer.id !== "string" || !/^cus_[A-Za-z0-9]{1,250}$/.test(customer.id)) fail(502, "stripe_error");
  try {
    await prisma.billingCustomer.create({ data: { accountId, stripeCustomerId: customer.id } });
    return customer.id;
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const again = await prisma.billingCustomer.findUnique({ where: { accountId } });
    if (!again) throw e;
    return again.stripeCustomerId;
  }
}

// ── Dashboard routes ────────────────────────────────────────────────────────

/** POST /billing/checkout — a Stripe Checkout Session (subscription mode) for the Remote price. */
export const createCheckout = (req: NextRequest) => handle(async () => {
  const cfg = requireConfig();
  const account = await accountContext(req, true);
  if (!account.emailVerifiedAt) fail(409, "email_unverified");
  limit("billing:checkout", account.id, 10, 60 * 60_000);
  const subs = await remoteSubscriptions(prisma, account.id);
  // One Remote subscription at a time: a live or payment-troubled one is managed in the portal.
  if (subs.some(s => subscriptionEntitles(s) || OPEN.has(s.status))) fail(409, "already_subscribed");
  const customer = await customerFor(cfg, account.id);
  const back = `${cfg.appOrigin}/account/remote`;
  const session = await stripePost(cfg, "checkout/sessions", {
    mode: "subscription",
    customer,
    client_reference_id: account.id,
    "metadata[accountId]": account.id,
    "subscription_data[metadata][accountId]": account.id,
    "line_items[0][price]": cfg.priceId,
    "line_items[0][quantity]": "1",
    success_url: `${back}?billing=success`,
    cancel_url: `${back}?billing=cancel`,
  });
  await prisma.accountAudit.create({ data: { accountId: account.id, eventType: "billing.checkout_started", detail: {} } }).catch(() => {});
  return json({ url: stripeUrl(session.url) });
});

/** POST /billing/portal — a Stripe Billing Portal session to manage or cancel the subscription. */
export const createPortal = (req: NextRequest) => handle(async () => {
  const cfg = requireConfig();
  const account = await accountContext(req, true);
  limit("billing:portal", account.id, 20, 60 * 60_000);
  const customer = await prisma.billingCustomer.findUnique({ where: { accountId: account.id } });
  if (!customer) fail(404, "no_customer");
  const session = await stripePost(cfg, "billing_portal/sessions", { customer: customer.stripeCustomerId, return_url: `${cfg.appOrigin}/account/remote` });
  return json({ url: stripeUrl(session.url) });
});

/** GET /billing/status — the account's plan. No Stripe id, price or secret is ever included. */
export const billingStatus = (req: NextRequest) => handle(async () => {
  requireConfig();
  const account = await accountContext(req, false);
  const now = new Date();
  const [grant, subs] = await Promise.all([
    prisma.appBridgeEntitlement.findUnique({ where: { accountId_feature: { accountId: account.id, feature: REMOTE_ACCESS_FEATURE } } }),
    remoteSubscriptions(prisma, account.id),
  ]);
  const entitling = subs.find(s => subscriptionEntitles(s, now)) ?? null;
  const shown = entitling ?? subs[0] ?? null;
  const source = entitling ? "subscription" : grant?.active ? "admin" : null;
  return json({
    plan: source ? "remote" : "none",
    status: shown?.status ?? null,
    currentPeriodEnd: shown?.currentPeriodEnd.toISOString() ?? null,
    cancelAtPeriodEnd: shown?.cancelAtPeriodEnd ?? false,
    source,
  });
});

// ── Webhook ─────────────────────────────────────────────────────────────────

/**
 * Stripe-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${raw body}`)>[,v1=…][,v0=…]
 * Valid when t is within 5 minutes of now and any v1 matches (several appear while a secret rolls).
 * The HMAC runs over the exact bytes received; the body is parsed only afterwards.
 */
export function verifyStripeSignature(raw: Buffer, header: string | null, secret: string, nowSec = Date.now() / 1000): boolean {
  if (!header || header.length > 4096) return false;
  let t: string | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const key = part.slice(0, i).trim(); const value = part.slice(i + 1).trim();
    if (key === "t") { if (t !== null) return false; t = value; }
    else if (key === "v1") v1.push(value);
  }
  if (t === null || !/^\d{1,12}$/.test(t) || v1.length === 0) return false;
  if (Math.abs(nowSec - Number(t)) > SIGNATURE_TOLERANCE_SEC) return false;
  const expected = createHmac("sha256", secret).update(`${t}.`, "utf8").update(raw).digest();
  let valid = false;
  for (const candidate of v1) {
    if (!/^[0-9a-f]{64}$/.test(candidate)) continue;
    if (timingSafeEqual(Buffer.from(candidate, "hex"), expected)) valid = true; // no early exit
  }
  return valid;
}

/** The raw request body as bytes, at most 1 MiB. */
async function readRawBytes(req: NextRequest): Promise<Buffer> {
  if (Number(req.headers.get("content-length")) > WEBHOOK_MAX_BODY) fail(413, "too_large");
  const reader = req.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > WEBHOOK_MAX_BODY) { await reader.cancel(); fail(413, "too_large"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

const HANDLED = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
]);
/** Stripe never moves a subscription out of these. */
const TERMINAL = new Set(["canceled", "incomplete_expired"]);
const STATUS = /^[a-z_]{1,32}$/;

const str = (v: unknown, re: RegExp): string | null => (typeof v === "string" && re.test(v) ? v : null);
const obj = (v: unknown): StripeObject | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as StripeObject) : null);
const CUS = /^cus_[A-Za-z0-9]{1,250}$/;
const SUB = /^sub_[A-Za-z0-9]{1,250}$/;
const ACCOUNT_REF = /^[A-Za-z0-9_-]{1,200}$/;

type Outcome = "ok" | "ignored" | "unmapped" | "conflict" | "stale";

/**
 * The account a Stripe customer belongs to: ONLY our BillingCustomer row. Account ids we put in
 * metadata / client_reference_id must agree when present; they never create a mapping on their own.
 */
async function accountFor(tx: Prisma.TransactionClient, customer: unknown, ...ours: unknown[]): Promise<string | "unmapped" | "conflict"> {
  const customerId = str(customer, CUS);
  if (!customerId) return "unmapped";
  const row = await tx.billingCustomer.findUnique({ where: { stripeCustomerId: customerId } });
  if (!row) return "unmapped";
  for (const claimed of ours) if (claimed !== undefined && claimed !== null && claimed !== row.accountId) return "conflict";
  return row.accountId;
}

function periodEnd(sub: StripeObject): Date | null {
  // Before API 2025-03-31 the period is on the subscription; from then on it is per item.
  const direct = sub.current_period_end;
  if (typeof direct === "number" && Number.isFinite(direct)) return new Date(direct * 1000);
  const items = (obj(sub.items)?.data as unknown[] | undefined) ?? [];
  const ends = items.map(i => obj(i)?.current_period_end).filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  return ends.length ? new Date(Math.max(...ends) * 1000) : null;
}
function priceIds(sub: StripeObject): string[] {
  const items = (obj(sub.items)?.data as unknown[] | undefined) ?? [];
  return items.map(i => str(obj(obj(i)?.price)?.id, /^price_[A-Za-z0-9]{1,250}$/)).filter((p): p is string => !!p);
}

async function audit(tx: Prisma.TransactionClient, accountId: string, status: string) {
  await tx.accountAudit.create({ data: { accountId, eventType: "billing.remote_subscription", detail: { status } } });
}

async function applySubscription(tx: Prisma.TransactionClient, type: string, sub: StripeObject, at: Date): Promise<Outcome> {
  const id = str(sub.id, SUB);
  let status = str(sub.status, STATUS);
  if (!id || !status) return "ignored";
  if (type === "customer.subscription.deleted") status = "canceled";
  const accountId = await accountFor(tx, sub.customer, obj(sub.metadata)?.accountId);
  if (accountId === "unmapped" || accountId === "conflict") return accountId;
  const existing = await tx.remoteSubscription.findUnique({ where: { stripeSubscriptionId: id } });
  if (existing && existing.accountId !== accountId) return "conflict";
  const end = periodEnd(sub) ?? existing?.currentPeriodEnd ?? null;
  if (!end) return "ignored";

  let priceId: string;
  if (!existing) {
    // Only a subscription to the Remote price is tracked. Without the price configured we cannot
    // tell, so the event is refused (503) and Stripe retries it later.
    const remote = remotePriceId();
    if (!remote) fail(503, "billing_unavailable");
    if (!priceIds(sub).includes(remote)) return "ignored";
    priceId = remote;
  } else {
    // Out-of-order delivery: an older snapshot never overwrites a newer one; a canceled
    // subscription is never revived; nothing goes back to "incomplete".
    if (at < existing.lastEventAt || TERMINAL.has(existing.status)) return "stale";
    if (status === "incomplete" && existing.status !== "incomplete") return "stale";
    priceId = existing.priceId;
  }

  // The grace clock starts when we first see past_due and keeps running while it stays past_due.
  const pastDueSince = status !== "past_due" ? null
    : existing?.status === "past_due" && existing.pastDueSince ? existing.pastDueSince : at;
  const cancelAtPeriodEnd = !TERMINAL.has(status) && (sub.cancel_at_period_end === true || typeof sub.cancel_at === "number");
  const data = { status, currentPeriodEnd: end, cancelAtPeriodEnd, pastDueSince, lastEventAt: at };
  if (existing) await tx.remoteSubscription.update({ where: { stripeSubscriptionId: id }, data });
  else await tx.remoteSubscription.create({ data: { stripeSubscriptionId: id, accountId, priceId, ...data } });
  if (existing?.status !== status) await audit(tx, accountId, status);
  return "ok";
}

/**
 * A failed payment on a past_due subscription pulls its grace clock back to that failure, if it was
 * earlier than the past_due snapshot we saw. It never grants anything and never touches a row in
 * any other state: the status itself comes from customer.subscription.* only.
 */
async function applyPaymentFailed(tx: Prisma.TransactionClient, invoice: StripeObject, at: Date): Promise<Outcome> {
  const parent = obj(obj(invoice.parent)?.subscription_details); // API 2025-03-31 and later
  const subId = str(invoice.subscription, SUB) ?? str(parent?.subscription, SUB);
  if (!subId) return "ignored";
  const accountId = await accountFor(tx, invoice.customer, obj(parent?.metadata)?.accountId);
  if (accountId === "unmapped" || accountId === "conflict") return accountId;
  const existing = await tx.remoteSubscription.findUnique({ where: { stripeSubscriptionId: subId } });
  if (!existing || existing.accountId !== accountId || existing.status !== "past_due") return "ignored";
  if (existing.pastDueSince && existing.pastDueSince <= at) return "ok";
  await tx.remoteSubscription.update({ where: { stripeSubscriptionId: subId }, data: { pastDueSince: at } });
  return "ok";
}

async function applyCheckoutCompleted(tx: Prisma.TransactionClient, session: StripeObject): Promise<Outcome> {
  if (session.mode !== "subscription") return "ignored";
  const ref = session.client_reference_id === null ? undefined : session.client_reference_id;
  if (ref !== undefined && str(ref, ACCOUNT_REF) === null) return "conflict";
  const accountId = await accountFor(tx, session.customer, ref, obj(session.metadata)?.accountId);
  if (accountId === "unmapped" || accountId === "conflict") return accountId;
  // The subscription's state arrives in customer.subscription.* events; this only records that
  // this account finished a checkout.
  await tx.accountAudit.create({ data: { accountId, eventType: "billing.checkout_completed", detail: {} } });
  return "ok";
}

let lastPrune = 0;
async function pruneEvents(now = Date.now()): Promise<void> {
  if (now - lastPrune < 60 * 60_000) return;
  lastPrune = now;
  try { await prisma.stripeEvent.deleteMany({ where: { processedAt: { lt: new Date(now - EVENT_RETENTION_MS) } } }); } catch { /* next time */ }
}

/** POST /billing/webhook — Stripe only. 400 on a bad signature; 200 for anything verified. */
export const stripeWebhook = (req: NextRequest) => handle(async () => {
  const secret = webhookSecret();
  if (!secret) fail(503, "billing_unavailable");
  const raw = await readRawBytes(req);
  if (!verifyStripeSignature(raw, req.headers.get("stripe-signature"), secret)) fail(400, "bad_signature");
  let event: StripeObject | null = null;
  try { event = obj(JSON.parse(raw.toString("utf8"))); } catch { event = null; }
  const eventId = str(event?.id, /^evt_[A-Za-z0-9]{1,250}$/);
  const type = typeof event?.type === "string" ? event.type : "";
  const created = typeof event?.created === "number" && Number.isFinite(event.created) ? new Date(event.created * 1000) : null;
  const object = obj(obj(event?.data)?.object);
  if (!event || !eventId || !created || !object) fail(400, "invalid_request");
  if (!HANDLED.has(type)) return json({ received: true }); // unknown types: acknowledged, no action

  const outcome = await prisma.$transaction(async (tx): Promise<Outcome | "duplicate"> => {
    if (await tx.stripeEvent.findUnique({ where: { eventId } })) return "duplicate";
    await tx.stripeEvent.create({ data: { eventId } });
    if (type === "checkout.session.completed") return applyCheckoutCompleted(tx, object);
    if (type === "invoice.payment_failed") return applyPaymentFailed(tx, object, created);
    return applySubscription(tx, type, object, created);
  }, serializable);
  // A code only: never an id or anything from the payload.
  if (outcome === "unmapped" || outcome === "conflict") console.warn(`billing webhook: ${outcome}`);
  void pruneEvents();
  return json({ received: true });
});
