/**
 * Passkeys on the account (WebAuthn), for the approval step-up (src/lib/step-up.ts explains the why and the gate).
 *
 * People only: the dashboard's cookie, and CSRF on every change. A request carrying any bearer key is refused first,
 * so no agent adds, removes or answers a passkey. Every route answers Cache-Control: no-store.
 *
 *   GET    /api/account/passkeys                    { stepUp: "on"|"off", connectStepUp: "on"|"off", passkeys: [{ id, label, createdAt, lastUsedAt, transports }] }
 *   POST   /api/account/passkeys/register/options   {}: { ceremonyId, options } (an account that already has a passkey
 *                                                   sends a manage_passkeys grant in x-bc-step-up)
 *   POST   /api/account/passkeys/register/verify    { ceremonyId, response, label? }: { passkey }
 *   DELETE /api/account/passkeys/:id                needs a manage_passkeys grant: { removed: true, remaining }
 *   POST   /api/account/passkeys/step-up/options    { action, targetId? }: { ceremonyId, options }
 *   POST   /api/account/passkeys/step-up/verify     { ceremonyId, response }: { grant, action, targetId, expiresAt }
 *
 * The relying party: RP ID and origin from PUBLIC_APP_URL (back-channel.app in production); in development a request
 * to localhost uses "localhost". Production never trusts the request's own host.
 *
 * The ceremonies: each options call stores its challenge on a PasskeyChallenge row (5 minutes); the first verify
 * attempt spends it, right or wrong. User verification is required both ways (a PIN, a fingerprint, a face), so a
 * password manager's silent passkey is refused. A verified step-up becomes a grant on the same row (step-up.ts).
 *
 * Stored per passkey: its credential id, its public key, the signature counter, how the browser reaches it, the label,
 * and when it was added and last used. Never a private key: that never leaves the authenticator.
 */
import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Account, AccountPasskey, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
// Namespace imports, like remote-app.ts: route tests replace these modules with a few named exports.
import * as auth from "@/lib/auth";
import * as limits from "@/lib/rate-limit";
import * as SU from "@/lib/step-up";

const MAX_PASSKEYS = 10;
const MAX_BODY = 64 * 1024;
const LABEL_MAX = 60;
const KEEP_CEREMONIES_MS = 24 * 3600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSPORT = /^[a-z][a-z-]{0,23}$/;

class Refusal extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
const fail = (status: number, code: string, message: string): never => { throw new Refusal(status, code, message); };
const respond = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });

/** The relying party this request's passkeys belong to. */
export function relyingParty(requestUrl: string): { rpID: string; origin: string } {
  const dev = process.env.NODE_ENV !== "production";
  const req = new URL(requestUrl);
  if (dev && req.hostname === "localhost") return { rpID: "localhost", origin: req.origin };
  const configured = (process.env.PUBLIC_APP_URL ?? "").trim();
  if (!configured) {
    if (dev) return { rpID: req.hostname, origin: req.origin };
    return fail(503, "not_configured", "Passkeys aren't set up on this server yet.");
  }
  const u = new URL(configured);
  return { rpID: u.hostname, origin: u.origin };
}

/** The user handle the authenticator keeps: opaque, stable per account, never the account id itself. */
const userHandle = (accountId: string) => new Uint8Array(createHash("sha256").update(`bc-passkey-user-v1:${accountId}`).digest());

function cleanLabel(v: unknown, fallback: string): string {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "string") return fail(400, "invalid_label", "The name is text, at most 60 characters.");
  // Control, zero-width and direction-changing characters out; whitespace collapsed.
  const s = v.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, "").replace(/\s+/g, " ").trim();
  if (!s) return fallback;
  if ([...s].length > LABEL_MAX) fail(400, "invalid_label", "The name is at most 60 characters.");
  return s;
}

const defaultLabel = (attachment: unknown) =>
  attachment === "platform" ? "This device" : attachment === "cross-platform" ? "Phone or security key" : "Passkey";

const transportsOf = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((t): t is string => typeof t === "string" && TRANSPORT.test(t)))].slice(0, 8) : [];

const view = (p: AccountPasskey) => ({
  id: p.id, label: p.label, transports: p.transports ?? [], createdAt: p.createdAt.toISOString(), lastUsedAt: p.lastUsedAt ? p.lastUsedAt.toISOString() : null,
});

async function audit(accountId: string, eventType: string, detail: Record<string, unknown>) {
  await prisma.accountAudit.create({ data: { accountId, eventType, detail: detail as Prisma.InputJsonValue } }).catch(() => {});
}

/** Old ceremonies of this account go (a day of them is kept, for the record). */
async function prune(accountId: string, now: Date) {
  await prisma.passkeyChallenge.deleteMany({ where: { accountId, expiresAt: { lt: new Date(now.getTime() - KEEP_CEREMONIES_MS) } } });
}

function ceremonyId(input: Record<string, unknown>): string {
  return typeof input.ceremonyId === "string" && UUID.test(input.ceremonyId) ? input.ceremonyId : fail(400, "invalid_ceremony", "ceremonyId is the id from the options call.");
}

/** The browser's answer, as @simplewebauthn/browser returns it. The library checks the rest. */
function answer<T extends RegistrationResponseJSON | AuthenticationResponseJSON>(input: Record<string, unknown>): T {
  const r = input.response as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object" || Array.isArray(r) || typeof r.id !== "string" || !r.id || typeof r.rawId !== "string" || r.type !== "public-key" || !r.response || typeof r.response !== "object") {
    return fail(400, "invalid_response", "response is what the browser's passkey prompt returned.");
  }
  return r as unknown as T;
}

/**
 * Spend a ceremony's challenge: the first verify attempt does, whatever its outcome. Returns the row as it was.
 * A step-up's row is also expired on the spot; it lives again only as a grant, if the answer verifies.
 */
async function spendCeremony(accountId: string, id: string, kind: "register" | "step_up", now: Date) {
  const row = await prisma.passkeyChallenge.findFirst({ where: { id, accountId, kind } });
  if (!row) return fail(404, "no_ceremony", "That passkey prompt isn't available. Start again.");
  const spent = await prisma.passkeyChallenge.updateMany({
    where: { id, accountId, kind, answeredAt: null, expiresAt: { gt: now } },
    data: kind === "step_up" ? { answeredAt: now, expiresAt: now } : { answeredAt: now },
  });
  if (spent.count !== 1) fail(410, "ceremony_over", "That passkey prompt expired or was already answered. Start again.");
  return row;
}

// ── operations ──────────────────────────────────────────────────────────────

async function opList(account: Account) {
  const rows = await prisma.accountPasskey.findMany({ where: { accountId: account.id }, orderBy: { createdAt: "asc" }, take: MAX_PASSKEYS * 2 });
  const on = SU.stepUpEnforced();
  // connectStepUp: whether connecting an agent asks for the passkey on this account (only with a PC: step-up.ts).
  return { stepUp: on ? "on" : "off", connectStepUp: on && (await SU.accountHasPc(prisma, account.id)) ? "on" : "off", passkeys: rows.map(view) };
}

async function opRegisterOptions(account: Account, req: NextRequest, now: Date) {
  const rp = relyingParty(req.url);
  const existing = await prisma.accountPasskey.findMany({ where: { accountId: account.id }, select: { credentialId: true, transports: true } });
  if (existing.length >= MAX_PASSKEYS) fail(409, "too_many_passkeys", `An account can have at most ${MAX_PASSKEYS} passkeys. Remove one first.`);
  // Adding another passkey to an account that has one takes a step-up with one it has, so nothing that drives this
  // browser can slip its own passkey in. The first passkey needs none: there is nothing to confirm with yet.
  let authorized = false;
  if (existing.length > 0) {
    const refusal = await SU.requireStepUp(prisma, { accountId: account.id, action: "manage_passkeys", grant: req.headers.get(SU.STEP_UP_HEADER), now });
    if (refusal) fail(refusal.status, refusal.error, refusal.message);
    authorized = SU.stepUpEnforced();
  }
  const options = await generateRegistrationOptions({
    rpName: "Back Channel",
    rpID: rp.rpID,
    userName: account.handle,
    userID: userHandle(account.id),
    userDisplayName: account.displayName?.trim() || account.handle,
    attestationType: "none",
    timeout: 60_000,
    excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: p.transports ?? [] })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
  await prune(account.id, now);
  const row = await prisma.passkeyChallenge.create({
    data: { accountId: account.id, kind: "register", action: authorized ? "manage_passkeys" : null, challenge: options.challenge, expiresAt: new Date(now.getTime() + SU.CEREMONY_TTL_MS) },
  });
  return { ceremonyId: row.id, options };
}

async function opRegisterVerify(account: Account, req: NextRequest, input: Record<string, unknown>, now: Date) {
  const rp = relyingParty(req.url);
  const id = ceremonyId(input);
  const response = answer<RegistrationResponseJSON>(input);
  const label = cleanLabel(input.label, defaultLabel(response.authenticatorAttachment));
  const row = await spendCeremony(account.id, id, "register", now);
  const count = await prisma.accountPasskey.count({ where: { accountId: account.id } });
  // Begun with no passkey on the account, but one was added meanwhile: adding another now takes that one's step-up.
  if (count > 0 && row.action !== "manage_passkeys" && SU.stepUpEnforced()) {
    fail(403, "step_up_required", "A passkey was added to your account while this one was being set up. Confirm with it, then add this one again.");
  }
  if (count >= MAX_PASSKEYS) fail(409, "too_many_passkeys", `An account can have at most ${MAX_PASSKEYS} passkeys. Remove one first.`);
  let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verified = await verifyRegistrationResponse({ response, expectedChallenge: row.challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: true });
  } catch {
    return fail(400, "not_verified", "That passkey couldn't be checked, so it wasn't added. Try again.");
  }
  if (!verified.verified) return fail(400, "not_verified", "That passkey couldn't be checked, so it wasn't added. Try again.");
  const { credential } = verified.registrationInfo;
  if (await prisma.accountPasskey.findUnique({ where: { credentialId: credential.id } })) {
    fail(409, "already_registered", "That passkey is already registered.");
  }
  const created = await prisma.accountPasskey.create({
    data: {
      accountId: account.id,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey),
      counter: BigInt(credential.counter),
      transports: transportsOf(credential.transports ?? response.response.transports),
      label,
    },
  });
  await audit(account.id, "passkey.added", { passkey_id: created.id, name: created.label });
  return { passkey: view(created) };
}

async function opRemove(account: Account, req: NextRequest, id: string, now: Date) {
  if (!UUID.test(id)) fail(404, "not_found", "That passkey isn't on your account.");
  const p = await prisma.accountPasskey.findFirst({ where: { id, accountId: account.id } });
  if (!p) return fail(404, "not_found", "That passkey isn't on your account.");
  const refusal = await SU.requireStepUp(prisma, { accountId: account.id, action: "manage_passkeys", grant: req.headers.get(SU.STEP_UP_HEADER), now });
  if (refusal) fail(refusal.status, refusal.error, refusal.message);
  await prisma.accountPasskey.deleteMany({ where: { id, accountId: account.id } });
  await audit(account.id, "passkey.removed", { passkey_id: id, name: p.label });
  return { removed: true, remaining: await prisma.accountPasskey.count({ where: { accountId: account.id } }) };
}

async function opStepUpOptions(account: Account, req: NextRequest, input: Record<string, unknown>, now: Date) {
  const rp = relyingParty(req.url);
  const action = input.action;
  if (!SU.isStepUpAction(action)) return fail(400, "invalid_action", `action is one of ${SU.STEP_UP_ACTIONS.join(", ")}.`);
  const targetId = SU.cleanTarget(action, input.targetId);
  if (targetId === undefined) {
    fail(400, "invalid_target", SU.actionTakesTarget(action) ? "targetId is the id of what you're approving." : "This action has no targetId.");
  }
  const passkeys = await prisma.accountPasskey.findMany({ where: { accountId: account.id }, select: { credentialId: true, transports: true } });
  if (!passkeys.length) fail(403, "passkey_required", "Add a passkey to your account first (Windows Hello on this PC, or your phone).");
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    allowCredentials: passkeys.map((p) => ({ id: p.credentialId, transports: p.transports ?? [] })),
    userVerification: "required",
    timeout: 60_000,
  });
  await prune(account.id, now);
  const row = await prisma.passkeyChallenge.create({
    data: { accountId: account.id, kind: "step_up", action, targetId: targetId ?? null, challenge: options.challenge, expiresAt: new Date(now.getTime() + SU.CEREMONY_TTL_MS) },
  });
  return { ceremonyId: row.id, options };
}

async function opStepUpVerify(account: Account, req: NextRequest, input: Record<string, unknown>, now: Date) {
  const rp = relyingParty(req.url);
  const id = ceremonyId(input);
  const response = answer<AuthenticationResponseJSON>(input);
  const row = await spendCeremony(account.id, id, "step_up", now);
  const passkey = await prisma.accountPasskey.findFirst({ where: { accountId: account.id, credentialId: response.id } });
  if (!passkey) return fail(400, "unknown_passkey", "That passkey isn't on your account. Use one listed in Settings → Passkeys.");
  let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verified = await verifyAuthenticationResponse({
      response, expectedChallenge: row.challenge, expectedOrigin: rp.origin, expectedRPID: rp.rpID, requireUserVerification: true,
      credential: { id: passkey.credentialId, publicKey: new Uint8Array(passkey.publicKey), counter: Number(passkey.counter), transports: passkey.transports ?? [] },
    });
  } catch {
    return fail(400, "not_verified", "Your passkey couldn't be checked, so nothing was confirmed. Try again.");
  }
  if (!verified.verified) return fail(400, "not_verified", "Your passkey couldn't be checked, so nothing was confirmed. Try again.");
  // The counter moves on only from the value just checked: a second use racing this one is refused, not merged.
  const bumped = await prisma.accountPasskey.updateMany({
    where: { id: passkey.id, counter: passkey.counter },
    data: { counter: BigInt(verified.authenticationInfo.newCounter), lastUsedAt: now },
  });
  if (bumped.count !== 1) fail(409, "passkey_busy", "That passkey was used at the same moment. Try again.");
  const grant = SU.newGrant();
  const expiresAt = new Date(now.getTime() + SU.GRANT_TTL_MS);
  await prisma.passkeyChallenge.update({ where: { id: row.id }, data: { grantHash: grant.hash, expiresAt, passkeyId: passkey.id } });
  await audit(account.id, "step_up.confirmed", { action: row.action, ...(row.targetId ? { target: row.targetId } : {}), passkey_id: passkey.id });
  return { grant: grant.raw, action: row.action, targetId: row.targetId, expiresAt: expiresAt.toISOString() };
}

// ── REST ────────────────────────────────────────────────────────────────────

async function readJson(req: NextRequest): Promise<Record<string, unknown>> {
  if (Number(req.headers.get("content-length")) > MAX_BODY) fail(413, "too_large", "Request too large");
  const text = await req.text();
  if (!text) return {};
  if (text.length > MAX_BODY) fail(413, "too_large", "Request too large");
  let body: unknown;
  try { body = JSON.parse(text); } catch { return fail(400, "invalid_json", "Send a JSON object."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) fail(400, "invalid_json", "Send a JSON object.");
  return body as Record<string, unknown>;
}

export async function passkeysRoute(req: NextRequest, path: string[]): Promise<NextResponse> {
  try {
    const m = req.method;
    const [a, b, extra] = path;
    type Route = "list" | "registerOptions" | "registerVerify" | "remove" | "stepUpOptions" | "stepUpVerify";
    let route: Route | null = null;
    if (extra === undefined) {
      if (!a && m === "GET") route = "list";
      else if (a === "register" && m === "POST") route = b === "options" ? "registerOptions" : b === "verify" ? "registerVerify" : null;
      else if (a === "step-up" && m === "POST") route = b === "options" ? "stepUpOptions" : b === "verify" ? "stepUpVerify" : null;
      else if (a && !b && m === "DELETE") route = "remove";
    }
    if (!route) return respond({ error: "not_found", message: "No such passkeys endpoint." }, 404);
    // People only: a bearer key is an agent, whatever cookie rides along.
    if (req.headers.get("authorization")) fail(403, "people_only", "Only your person manages passkeys, signed in to the Back Channel dashboard.");
    const account = await auth.getAccountFromCookie(req.cookies?.get(auth.SESSION_COOKIE_NAME)?.value);
    if (!account) return respond({ error: "unauthorized", message: "Unauthorized" }, 401);
    if (route !== "list" && !auth.csrfValid(req.headers.get(auth.CSRF_HEADER), req.cookies.get(auth.CSRF_COOKIE_NAME)?.value)) {
      fail(403, "csrf", "Refresh the page and try again.");
    }
    const r = route === "list" ? limits.rateLimit("passkeys:read", account.id, 120, 60_000) : limits.rateLimit("passkeys:write", account.id, 30, 60_000);
    if (!r.ok) {
      const res = respond({ error: "rate_limited", message: "Too many tries. Wait a moment and try again." }, 429);
      res.headers.set("Retry-After", String(r.retryAfterSec));
      return res;
    }
    const now = new Date();
    switch (route) {
      case "list": return respond(await opList(account));
      case "registerOptions": return respond(await opRegisterOptions(account, req, now));
      case "registerVerify": return respond(await opRegisterVerify(account, req, await readJson(req), now));
      case "remove": return respond(await opRemove(account, req, a, now));
      case "stepUpOptions": return respond(await opStepUpOptions(account, req, await readJson(req), now));
      case "stepUpVerify": return respond(await opStepUpVerify(account, req, await readJson(req), now));
    }
  } catch (e) {
    if (e instanceof Refusal) return respond({ error: e.code, message: e.message }, e.status);
    // Never log bodies, challenges, credentials or grants.
    console.error("[passkeys] failed:", e instanceof Error ? e.name : typeof e);
    return respond({ error: "unavailable", message: "Passkeys are unavailable right now. Try again shortly." }, 503);
  }
}
