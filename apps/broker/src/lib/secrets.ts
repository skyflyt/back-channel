/**
 * Secrets, Phase 1 (docs/secrets-epic.md §3.1, §3.3, §3.4): approve a secret broker request on a PC from anywhere with
 * a passkey, see each PC's broker, and ask its worker to install or update the pinned broker, trust a passkey for phone
 * approvals, or lock the broker down.
 *
 * Rules (§4), which every function here keeps:
 *   1. Back Channel never holds, relays or caches a secret value. What it stores is what the broker's own prompt shows
 *      (names, modes, hosts, the request code), the broker's digests, and passkey assertions over those digests.
 *   2. Back Channel never holds a key that can approve. The approval is a WebAuthn assertion whose challenge IS the
 *      broker's digest for the grant the person chose (src/lib/passkeys.ts, action approve_secret); the broker on the
 *      PC verifies it against the passkey it was told to trust under a signed admin op at the machine.
 *   3. The broker decides; Back Channel displays. A forged card has no valid digest, so nothing would accept its answer.
 *
 * Worker side (a FULL-SCOPE per-agent key, about itself only): POST /api/agents/self/secret-broker/sync carries the broker's
 * status and its remote-approvable requests out, and the person's decisions and the jobs back.
 * Person side (dashboard cookie, bc_csrf on changes, no bearer): GET /api/secret-broker, POST
 * /api/secret-broker/requests/:id/deny, POST /api/secret-broker/machines/:agentId/{install,update,enrol,lockdown}.
 */
import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import type { Account } from "@prisma/client";
import { prisma } from "@/lib/db";
// Namespace imports (see remote-app.ts): route tests replace these modules with only some exports.
import * as auth from "@/lib/auth";
import * as limits from "@/lib/rate-limit";
import * as SU from "@/lib/step-up";
import { hasFullScope } from "@/lib/agent-scope";
import { fireSecretsChanged } from "@/lib/inbox-bus";

export const MAX_SYNC_BYTES = 256 * 1024;
/** The broker status is "current" while the worker synced within this long (it syncs every few seconds). */
export const BROKER_FRESH_MS = 3 * 60_000;
/** A sent or running job with no progress for this long lost its worker (restarted mid-job): it is failed, not "busy" forever. */
export const JOB_STALE_MS = 15 * 60_000;
const MAX_PENDING = 20, MAX_OPTIONS = 32, MAX_JOBS = 10, MAX_APPROVERS = 10, MAX_CHECKS = 20;
const HEX40 = /^[0-9a-f]{40}$/;
const B64U_DIGEST = /^[A-Za-z0-9_-]{43}$/;
const REF = /^[A-Za-z0-9_-]{16,64}$/;
const CODE = /^[A-Z0-9]{4,12}$/;
const FP = /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STEP = /^[a-z_]{1,32}$/;
const FAILURE = /^[a-z0-9_]{1,40}$/;
const KINDS = ["serve", "unlock", "policy", "import", "rotation-check"] as const;
/** A broker secret name for the test job: `prefix/name`, as the broker's own `names` lists them. */
const SECRET_NAME = /^[a-z0-9][a-z0-9._-]{0,60}(\/[a-z0-9][a-z0-9._-]{0,60}){1,4}$/;
export const JOB_KINDS = ["install", "update", "enrol", "lockdown", "test"] as const;
// Control and invisible/direction characters out of anything shown; display text keeps its newlines.
const UNPRINTABLE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

export class SecretsError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
const fail = (status: number, code: string, message: string): never => { throw new SecretsError(status, code, message); };
const respond = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });

/**
 * The passkey fingerprint the broker shows when asked to trust a passkey: SHA-256 over the credential id's bytes, a
 * zero byte and the COSE public key exactly as stored, first 16 hex characters in groups of 4 (the broker's
 * webauthn.fingerprint uses the same bytes, so the person can compare the two).
 */
export function passkeyFingerprint(credentialId: string, publicKey: Uint8Array): string {
  const hex = createHash("sha256").update(Buffer.from(credentialId, "base64url")).update(Buffer.from([0])).update(publicKey)
    .digest("hex").toUpperCase();
  return (hex.slice(0, 16).match(/.{4}/g) as string[]).join("-");
}

// ── validating what the worker sends ────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function text(v: unknown, field: string, max: number, opts: { nullable?: boolean; multiline?: boolean } = {}): string | null {
  if (v === null || v === undefined) {
    if (opts.nullable) return null;
    return fail(400, "invalid_sync", `${field} is required.`);
  }
  if (typeof v !== "string") return fail(400, "invalid_sync", `${field} must be text.`);
  let t = v.replace(UNPRINTABLE, "");
  if (!opts.multiline) t = t.replace(/\n/g, " ");
  t = t.trim();
  if (!t) return opts.nullable ? null : fail(400, "invalid_sync", `${field} is empty.`);
  if ([...t].length > max) fail(400, "invalid_sync", `${field} is at most ${max} characters.`);
  return t;
}
const boolOrNull = (v: unknown, field: string) =>
  v === null || v === undefined ? null : typeof v === "boolean" ? v : fail(400, "invalid_sync", `${field} must be true, false or null.`);
const intIn = (v: unknown, field: string, lo: number, hi: number, nullable = false) =>
  (v === null || v === undefined) && nullable ? null
    : Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number)
    : fail(400, "invalid_sync", `${field} must be a whole number from ${lo} to ${hi}.`);
const hex40 = (v: unknown, field: string) =>
  v === null || v === undefined ? null : typeof v === "string" && HEX40.test(v) ? v : fail(400, "invalid_sync", `${field} must be a 40-character commit or tree id, or null.`);

export interface BrokerStatus {
  installed: boolean; commit: string | null; tree: string | null; healthy: boolean | null; names: number | null;
  lockdown: boolean | null; approverEnrolled: boolean | null; approvers: { fingerprint: string; label: string }[];
  checks: { label: string; ok: boolean }[]; pin: { commit: string; tree: string; subject: string | null } | null;
}
export interface PendingIn {
  ref: string; kind: (typeof KINDS)[number]; name: string; mode: string; tier: number | null; target: string | null;
  code: string; display: string; digest: string; options: { index: number; label: string; digest: string }[];
  expiresIn: number; requester: { agent: string | null; session: string | null } | null;
}
export interface JobIn { id: string; state: "running" | "done" | "failed"; steps: Record<string, boolean>; failure: string | null; fingerprint: string | null }

export function parseBroker(v: unknown): BrokerStatus {
  if (!isObj(v)) return fail(400, "invalid_sync", "broker must be an object.");
  const approvers = Array.isArray(v.approvers) ? v.approvers : [];
  if (approvers.length > MAX_APPROVERS) fail(400, "invalid_sync", `At most ${MAX_APPROVERS} approvers.`);
  const checks = Array.isArray(v.checks) ? v.checks : [];
  if (checks.length > MAX_CHECKS) fail(400, "invalid_sync", `At most ${MAX_CHECKS} checks.`);
  let pin: BrokerStatus["pin"] = null;
  if (v.pin !== null && v.pin !== undefined) {
    if (!isObj(v.pin)) fail(400, "invalid_sync", "broker.pin must be an object or null.");
    const p = v.pin as Record<string, unknown>;
    const commit = hex40(p.commit, "broker.pin.commit"), tree = hex40(p.tree, "broker.pin.tree");
    if (!commit || !tree) fail(400, "invalid_sync", "broker.pin needs commit and tree.");
    pin = { commit: commit as string, tree: tree as string, subject: text(p.subject, "broker.pin.subject", 120, { nullable: true }) };
  }
  return {
    installed: v.installed === true,
    commit: hex40(v.commit, "broker.commit"), tree: hex40(v.tree, "broker.tree"),
    healthy: boolOrNull(v.healthy, "broker.healthy"), names: intIn(v.names, "broker.names", 0, 10_000, true),
    lockdown: boolOrNull(v.lockdown, "broker.lockdown"), approverEnrolled: boolOrNull(v.approverEnrolled, "broker.approverEnrolled"),
    approvers: approvers.map((a) => {
      if (!isObj(a) || typeof a.fingerprint !== "string" || !FP.test(a.fingerprint)) return fail(400, "invalid_sync", "Each approver has a fingerprint like AB12-CD34-EF56-7890.");
      return { fingerprint: a.fingerprint, label: text(a.label, "approver.label", 60, { nullable: true }) ?? "passkey" };
    }),
    checks: checks.map((c) => {
      if (!isObj(c) || typeof c.ok !== "boolean") return fail(400, "invalid_sync", "Each check is { label, ok }.");
      return { label: text(c.label, "check.label", 80) as string, ok: c.ok };
    }),
    pin,
  };
}

export function parsePending(list: unknown): PendingIn[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > MAX_PENDING) return fail(400, "invalid_sync", `pending is a list of at most ${MAX_PENDING}.`);
  const seen = new Set<string>();
  return list.map((p) => {
    if (!isObj(p)) return fail(400, "invalid_sync", "Each pending request is an object.");
    if (typeof p.ref !== "string" || !REF.test(p.ref)) fail(400, "invalid_sync", "ref is the broker's remote reference.");
    if (seen.has(p.ref as string)) fail(400, "invalid_sync", "A ref is listed twice.");
    seen.add(p.ref as string);
    if (typeof p.kind !== "string" || !(KINDS as readonly string[]).includes(p.kind)) fail(400, "invalid_sync", `kind is one of ${KINDS.join(", ")}.`);
    if (typeof p.code !== "string" || !CODE.test(p.code)) fail(400, "invalid_sync", "code is the broker's request code.");
    if (typeof p.digest !== "string" || !B64U_DIGEST.test(p.digest)) fail(400, "invalid_sync", "digest is the broker's digest (base64url, 32 bytes).");
    const options = Array.isArray(p.options) ? p.options : [];
    if (options.length > MAX_OPTIONS) fail(400, "invalid_sync", `At most ${MAX_OPTIONS} grant options.`);
    const r = isObj(p.requester) ? p.requester : null;
    return {
      ref: p.ref as string, kind: p.kind as PendingIn["kind"],
      name: text(p.name, "name", 200) as string, mode: text(p.mode, "mode", 40) as string,
      tier: intIn(p.tier, "tier", 0, 3, true), target: text(p.target, "target", 300, { nullable: true }),
      code: p.code as string, display: text(p.display, "display", 8000, { multiline: true }) as string, digest: p.digest as string,
      options: options.map((o, i) => {
        if (!isObj(o) || o.index !== i || typeof o.digest !== "string" || !B64U_DIGEST.test(o.digest)) return fail(400, "invalid_sync", "Grant options are [{ index, label, digest }] in order.");
        return { index: i, label: text(o.label, "option.label", 60) as string, digest: o.digest };
      }),
      expiresIn: intIn(p.expiresIn, "expiresIn", 1, 600) as number,
      requester: r ? { agent: text(r.agent, "requester.agent", 80, { nullable: true }), session: text(r.session, "requester.session", 120, { nullable: true }) } : null,
    };
  });
}

export function parseJobs(list: unknown): JobIn[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > MAX_JOBS) return fail(400, "invalid_sync", `jobs is a list of at most ${MAX_JOBS}.`);
  return list.map((j) => {
    if (!isObj(j) || typeof j.id !== "string" || !UUID.test(j.id)) return fail(400, "invalid_sync", "Each job update names its job id.");
    if (j.state !== "running" && j.state !== "done" && j.state !== "failed") fail(400, "invalid_sync", "A job's state is running, done or failed.");
    const steps: Record<string, boolean> = {};
    if (j.steps !== undefined && j.steps !== null) {
      if (!isObj(j.steps) || Object.keys(j.steps).length > 12) fail(400, "invalid_sync", "steps is a map of at most 12 step names to true/false.");
      for (const [k, v] of Object.entries(j.steps as Record<string, unknown>)) {
        if (!STEP.test(k) || typeof v !== "boolean") fail(400, "invalid_sync", "Each step is a short name and true or false.");
        steps[k] = v as boolean;
      }
    }
    const failure = j.failure === null || j.failure === undefined ? null
      : typeof j.failure === "string" && FAILURE.test(j.failure) ? j.failure : fail(400, "invalid_sync", "failure is a short code.");
    const fingerprint = j.fingerprint === null || j.fingerprint === undefined ? null
      : typeof j.fingerprint === "string" && FP.test(j.fingerprint) ? j.fingerprint : fail(400, "invalid_sync", "fingerprint looks like AB12-CD34-EF56-7890.");
    return { id: j.id.toLowerCase(), state: j.state as JobIn["state"], steps, failure, fingerprint };
  });
}

async function audit(accountId: string, eventType: string, detail: Record<string, unknown>) {
  await prisma.accountAudit.create({ data: { accountId, eventType, detail: detail as Prisma.InputJsonValue } }).catch(() => {});
}

/** Fail the account's jobs that stopped reporting (seen 2026-10-20: a worker reinstalled mid-update left one "running"). */
async function expireStaleJobs(accountId: string, now: Date) {
  const stale = await prisma.secretJob.findMany({
    where: { accountId, state: { in: ["sent", "running"] }, updatedAt: { lt: new Date(now.getTime() - JOB_STALE_MS) } }, take: 50,
  });
  for (const job of stale) {
    const done = await prisma.secretJob.updateMany({ where: { id: job.id, state: job.state }, data: { state: "failed", failure: "timed_out", finishedAt: now } });
    if (done.count === 1) await audit(accountId, `secret.${job.kind}_failed`, { agent_id: job.agentId, job_id: job.id, failure: "timed_out" });
  }
}

// ── the worker's sync ───────────────────────────────────────────────────────

export async function syncForWorker(agent: { id: string; accountId: string }, body: Record<string, unknown>, now: Date) {
  if (body.v !== 1) fail(400, "unsupported_version", "This is secrets sync version 1 only.");
  const broker = parseBroker(body.broker);
  const pending = parsePending(body.pending);
  const jobsIn = parseJobs(body.jobs);

  const written = await prisma.agentToken.updateMany({
    where: { id: agent.id, accountId: agent.accountId, revokedAt: null, scope: "full" },
    data: { secretBroker: broker as unknown as Prisma.InputJsonValue, secretBrokerAt: now },
  });
  if (written.count !== 1) fail(401, "agent_revoked", "This agent's key has been revoked.");

  // New requests the broker would take a phone answer for. A row that exists is never reopened or rewritten.
  const known = new Set((await prisma.secretRequest.findMany({
    where: { agentId: agent.id, ref: { in: pending.map((p) => p.ref) } }, select: { ref: true },
  })).map((r) => r.ref));
  for (const p of pending.filter((x) => !known.has(x.ref))) {
    await prisma.secretRequest.create({
      data: {
        accountId: agent.accountId, agentId: agent.id, ref: p.ref, kind: p.kind, name: p.name, mode: p.mode, tier: p.tier,
        target: p.target, requestCode: p.code, display: p.display, digest: p.digest,
        options: p.options as unknown as Prisma.InputJsonValue, requester: (p.requester ?? undefined) as Prisma.InputJsonValue | undefined,
        expiresAt: new Date(now.getTime() + p.expiresIn * 1000),
      },
    }).catch((e: unknown) => { if (!(isObj(e) && e.code === "P2002")) throw e; });   // a racing sync made it first
    await audit(agent.accountId, "secret.requested", { agent_id: agent.id, code: p.code, name: p.name, mode: p.mode, tier: p.tier });
  }
  const raised = pending.some((x) => !known.has(x.ref));
  // Open requests the broker no longer lists were answered at the machine, served or expired: closed here too.
  const listed = pending.map((p) => p.ref);
  const expired = await prisma.secretRequest.updateMany({
    where: { agentId: agent.id, status: "open", ...(listed.length ? { ref: { notIn: listed } } : {}), expiresAt: { lte: now } },
    data: { status: "expired" },
  });
  const closed = await prisma.secretRequest.updateMany({
    where: { agentId: agent.id, status: "open", ...(listed.length ? { ref: { notIn: listed } } : {}) },
    data: { status: "closed" },
  });
  // The phones hear of a new request, and of one that went away, the moment the worker reports it (§3.6).
  if (raised || expired.count || closed.count) fireSecretsChanged(agent.accountId);

  // The person's decisions, each handed over once; the assertion leaves Back Channel with it.
  const decided = await prisma.secretRequest.findMany({
    where: { agentId: agent.id, status: { in: ["approved", "denied"] }, deliveredAt: null }, take: MAX_PENDING,
  });
  const decisions = decided.map((r) => r.status === "approved"
    ? { ref: r.ref, decision: "approve" as const, option: r.option ?? 0, assertion: r.assertion }
    : { ref: r.ref, decision: "deny" as const });
  if (decided.length) {
    await prisma.secretRequest.updateMany({ where: { id: { in: decided.map((r) => r.id) } }, data: { deliveredAt: now, assertion: Prisma.DbNull } });
  }

  // Job progress from the PC, then the jobs it should run.
  for (const j of jobsIn) {
    const job = await prisma.secretJob.findFirst({ where: { id: j.id, agentId: agent.id } });
    if (!job || job.state === "done" || job.state === "failed") continue;
    await prisma.secretJob.update({
      where: { id: job.id },
      data: {
        state: j.state, progress: { steps: j.steps, ...(j.fingerprint ? { fingerprint: j.fingerprint } : {}) } as Prisma.InputJsonValue,
        failure: j.failure, ...(j.state !== "running" ? { finishedAt: now } : {}),
      },
    });
    if (j.state !== "running") await audit(agent.accountId, `secret.${job.kind}_${j.state}`, { agent_id: agent.id, job_id: job.id, ...(j.failure ? { failure: j.failure } : {}) });
  }
  const jobs = await prisma.secretJob.findMany({ where: { agentId: agent.id, state: { in: ["requested", "sent"] } }, orderBy: { createdAt: "asc" }, take: MAX_JOBS });
  if (jobs.some((j) => j.state === "requested")) {
    await prisma.secretJob.updateMany({ where: { id: { in: jobs.filter((j) => j.state === "requested").map((j) => j.id) } }, data: { state: "sent" } });
  }
  return { decisions, jobs: jobs.map((j) => ({ id: j.id, kind: j.kind, payload: j.payload })) };
}

// ── the person's view ───────────────────────────────────────────────────────

export async function viewForPerson(account: Account, now: Date) {
  const agents = await prisma.agentToken.findMany({
    where: { accountId: account.id, revokedAt: null, scope: "full", secretBrokerAt: { not: null } },
    select: { id: true, name: true, secretBroker: true, secretBrokerAt: true }, orderBy: { name: "asc" }, take: 50,
  });
  const passkeys = await prisma.accountPasskey.findMany({ where: { accountId: account.id }, select: { id: true, label: true, credentialId: true, publicKey: true } });
  const keyed = passkeys.map((p) => ({ id: p.id, label: p.label, fingerprint: passkeyFingerprint(p.credentialId, new Uint8Array(p.publicKey)) }));
  await expireStaleJobs(account.id, now);
  const jobs = await prisma.secretJob.findMany({ where: { accountId: account.id }, orderBy: { createdAt: "desc" }, take: 100 });
  const machines = agents.map((a) => {
    const broker = a.secretBroker as unknown as BrokerStatus;
    const trusted = new Set((broker.approvers ?? []).map((x) => x.fingerprint));
    const latest = jobs.find((j) => j.agentId === a.id) ?? null;
    return {
      agentId: a.id, name: a.name, broker, brokerAt: a.secretBrokerAt?.toISOString() ?? null,
      current: !!a.secretBrokerAt && now.getTime() - a.secretBrokerAt.getTime() <= BROKER_FRESH_MS,
      // An installed broker that can't say its commit (one from before `relay` and `status` reported it) isn't at the pin.
      updateAvailable: !!(broker.installed && broker.pin && broker.pin.commit !== broker.commit),
      passkeys: keyed.map((p) => ({ ...p, trusted: trusted.has(p.fingerprint) })),
      job: latest && { id: latest.id, kind: latest.kind, state: latest.state, progress: latest.progress, failure: latest.failure,
        createdAt: latest.createdAt.toISOString(), finishedAt: latest.finishedAt?.toISOString() ?? null },
    };
  });
  const names = new Map(agents.map((a) => [a.id, a.name]));
  const rows = await prisma.secretRequest.findMany({
    where: { accountId: account.id, OR: [{ status: "open", expiresAt: { gt: now } }, { raisedAt: { gt: new Date(now.getTime() - 24 * 3600_000) } }] },
    orderBy: { raisedAt: "desc" }, take: 40,
  });
  const requests = rows.map((r) => ({
    id: r.id, agentId: r.agentId, machine: names.get(r.agentId) ?? "a PC", kind: r.kind, name: r.name, mode: r.mode, tier: r.tier,
    target: r.target, code: r.requestCode, display: r.display, requester: r.requester,
    options: (r.options as { index: number; label: string }[]).map((o) => ({ index: o.index, label: o.label })),
    status: r.status === "open" && r.expiresAt <= now ? "expired" : r.status, option: r.option,
    raisedAt: r.raisedAt.toISOString(), expiresAt: r.expiresAt.toISOString(), decidedAt: r.decidedAt?.toISOString() ?? null,
  }));
  return { machines, requests };
}

export async function denyRequest(account: Pick<Account, "id">, id: string, now: Date, by: Record<string, unknown> = {}) {
  if (!UUID.test(id)) fail(404, "not_found", "That request isn't on your account.");
  const done = await prisma.secretRequest.updateMany({
    where: { id, accountId: account.id, status: "open", expiresAt: { gt: now } },
    data: { status: "denied", decidedAt: now, decidedBy: "deny" },
  });
  if (done.count !== 1) fail(410, "request_closed", "That request was already answered or has expired.");
  await audit(account.id, "secret.denied", { request_id: id, ...by });
  fireSecretsChanged(account.id);
  return { denied: true };
}

/**
 * Called by the passkey step-up verify (passkeys.ts) for approve_secret, once the assertion verified against the
 * account's passkey: the challenge was this request's digest for one grant option, so that option is what it approves.
 */
export async function recordApproval(accountId: string, requestId: string, challenge: string, passkeyId: string,
  assertion: { credentialId: string; authenticatorData: string; clientDataJson: string; signature: string }, now: Date) {
  const r = await prisma.secretRequest.findFirst({ where: { id: requestId, accountId } });
  if (!r) return fail(404, "not_found", "That request isn't on your account.");
  const options = (r.options as { index: number; digest: string }[]) ?? [];
  const option = challenge === r.digest ? 0 : options.find((o) => o.digest === challenge)?.index;
  if (option === undefined) return fail(400, "wrong_digest", "That confirmation was for something else. Try again.");
  const done = await prisma.secretRequest.updateMany({
    where: { id: requestId, accountId, status: "open", expiresAt: { gt: now } },
    data: { status: "approved", option, assertion: assertion as unknown as Prisma.InputJsonValue, decidedAt: now, decidedBy: passkeyId },
  });
  if (done.count !== 1) fail(410, "request_closed", "That request was already answered or has expired.");
  await audit(accountId, "secret.approved", { request_id: requestId, code: r.requestCode, name: r.name, option, passkey_id: passkeyId });
  fireSecretsChanged(accountId);
  return { approved: true, option };
}

/**
 * For the approve_secret ceremony (passkeys.ts): the request's digest for the chosen grant (the WebAuthn challenge),
 * and the passkeys the PC's broker trusts (only those can answer).
 */
export async function approvalChallenge(accountId: string, requestId: string, option: unknown, now: Date) {
  const r = await prisma.secretRequest.findFirst({ where: { id: requestId, accountId }, include: { agent: { select: { secretBroker: true } } } });
  if (!r) return fail(404, "not_found", "That request isn't on your account.");
  if (r.status !== "open" || r.expiresAt <= now) fail(410, "request_closed", "That request was already answered or has expired.");
  const options = (r.options as { index: number; digest: string }[]) ?? [];
  const idx = option === undefined || option === null ? 0 : option;
  if (!Number.isInteger(idx) || (idx as number) < 0 || (idx as number) >= Math.max(1, options.length)) fail(400, "invalid_option", "option is one of the grant choices shown.");
  const digest = options.length ? (options[idx as number]?.digest ?? r.digest) : r.digest;
  const trusted = new Set(((r.agent.secretBroker as unknown as BrokerStatus | null)?.approvers ?? []).map((a) => a.fingerprint));
  const passkeys = (await prisma.accountPasskey.findMany({ where: { accountId }, select: { credentialId: true, transports: true, publicKey: true } }))
    .filter((p) => trusted.has(passkeyFingerprint(p.credentialId, new Uint8Array(p.publicKey))));
  if (!passkeys.length) {
    fail(409, "not_trusted", "No passkey of yours is trusted by that PC's broker yet. On its card, choose a passkey under \"Phone approvals\" first.");
  }
  return { digest, passkeys: passkeys.map((p) => ({ credentialId: p.credentialId, transports: p.transports ?? [] })) };
}

/**
 * Ask a PC's worker to do something with its broker. Install, update and enrol need the step-up; lockdown never does,
 * and neither does `test` (the worker asks the broker for a named secret, which raises an ordinary request the person
 * then answers from the phone: the test IS an approval, so it needs no gate of its own).
 */
export async function createJob(account: Pick<Account, "id">, agentId: string, kind: string, input: Record<string, unknown>, grant: string | null, now: Date) {
  if (!UUID.test(agentId)) fail(404, "not_found", "That PC's worker isn't on your account.");
  if (!(JOB_KINDS as readonly string[]).includes(kind)) fail(404, "not_found", "No such action.");
  const agent = await prisma.agentToken.findFirst({ where: { id: agentId, accountId: account.id, revokedAt: null, scope: "full" }, select: { id: true, secretBroker: true } });
  if (!agent) return fail(404, "not_found", "That PC's worker isn't on your account.");
  const broker = agent.secretBroker as unknown as BrokerStatus | null;
  let payload: Record<string, unknown> = {};
  if (kind === "install" || kind === "update") {
    if (!broker?.pin) fail(409, "no_release_pin", "That PC's worker hasn't reported the broker's release pin yet, so there is nothing to install. Check that GitHub is signed in there.");
    if (kind === "update" && !broker?.installed) fail(409, "not_installed", "The broker isn't installed there yet: use Install.");
    if (kind === "install" && broker?.installed) fail(409, "already_installed", "The broker is already installed there: use Update.");
    payload = { commit: broker!.pin!.commit, tree: broker!.pin!.tree };
  } else if (kind === "test") {
    if (!broker?.installed) fail(409, "not_installed", "The broker isn't installed there yet.");
    const ref = typeof input.ref === "string" && SECRET_NAME.test(input.ref) ? input.ref : fail(400, "invalid_name", "ref is a secret's name in that PC's policy, like home/example/test.");
    payload = { ref };
  } else if (kind === "enrol") {
    const pid = typeof input.passkeyId === "string" && UUID.test(input.passkeyId) ? input.passkeyId : fail(400, "invalid_passkey", "passkeyId is one of your passkeys.");
    const p = await prisma.accountPasskey.findFirst({ where: { id: pid as string, accountId: account.id } });
    if (!p) return fail(404, "not_found", "That passkey isn't on your account.");
    payload = { passkeyId: p.id, credentialId: p.credentialId, publicKeyCose: Buffer.from(p.publicKey).toString("base64url"), label: p.label,
      fingerprint: passkeyFingerprint(p.credentialId, new Uint8Array(p.publicKey)) };
  }
  if (kind !== "lockdown" && kind !== "test") {
    const refusal = await SU.requireStepUp(prisma, { accountId: account.id, action: "secret_broker_admin", targetId: agentId, grant, now });
    if (refusal) fail(refusal.status, refusal.error, refusal.message);
  }
  await expireStaleJobs(account.id, now);
  if (await prisma.secretJob.count({ where: { agentId, state: { in: ["requested", "sent", "running"] }, kind: { not: "lockdown" } } }) && kind !== "lockdown") {
    fail(409, "busy", "That PC already has a broker job in progress. Wait for it to finish.");
  }
  const job = await prisma.secretJob.create({ data: { accountId: account.id, agentId, kind, payload: payload as Prisma.InputJsonValue } });
  await audit(account.id, `secret.${kind}_requested`, { agent_id: agentId, job_id: job.id, ...(kind === "enrol" ? { passkey_id: payload.passkeyId } : {}) });
  return { job: { id: job.id, kind, state: job.state } };
}

// ── REST ────────────────────────────────────────────────────────────────────

async function readJson(req: NextRequest, max: number): Promise<Record<string, unknown>> {
  if (Number(req.headers.get("content-length")) > max) fail(413, "too_large", "Request too large.");
  const t = await req.text();
  if (!t) return {};
  if (t.length > max) fail(413, "too_large", "Request too large.");
  let body: unknown;
  try { body = JSON.parse(t); } catch { return fail(400, "invalid_json", "Send a JSON object."); }
  if (!isObj(body)) fail(400, "invalid_json", "Send a JSON object.");
  return body as Record<string, unknown>;
}

function onError(e: unknown, where: string) {
  if (e instanceof SecretsError) return respond({ error: e.code, message: e.message }, e.status);
  // Never log bodies, digests, assertions or keys.
  console.error(`[secrets] ${where} failed:`, e instanceof Error ? e.name : typeof e);
  return respond({ error: "unavailable", message: "Secrets are unavailable right now. Try again shortly." }, 503);
}

export async function workerSyncRoute(req: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await auth.getAuthContext(req.headers.get("authorization"));
    if (!ctx) return respond({ error: "unauthorized", message: "The Back Channel worker syncs with its own agent key." }, 401);
    if (!ctx.agentTokenId) return respond({ error: "agent_key_required", message: "Secrets sync with a per-agent key." }, 401);
    if (!hasFullScope(ctx)) return respond({ error: "not_available_to_connectors", message: "Only the worker on a PC syncs secrets, with a full agent key." }, 403);
    const r = limits.rateLimit("secrets-sync", ctx.agentTokenId, 120, 60_000);
    if (!r.ok) {
      const res = respond({ error: "rate_limited", message: "Too many syncs. Wait a moment." }, 429);
      res.headers.set("Retry-After", String(r.retryAfterSec));
      return res;
    }
    return respond(await syncForWorker({ id: ctx.agentTokenId, accountId: ctx.account.id }, await readJson(req, MAX_SYNC_BYTES), new Date()));
  } catch (e) { return onError(e, "sync"); }
}

async function person(req: NextRequest, write: boolean): Promise<Account> {
  // People only: a bearer key is an agent, whatever cookie rides along.
  if (req.headers.get("authorization")) fail(403, "people_only", "Only your person answers secret requests, signed in to the Back Channel dashboard.");
  const account = await auth.getAccountFromCookie(req.cookies?.get(auth.SESSION_COOKIE_NAME)?.value);
  if (!account) return fail(401, "unauthorized", "Unauthorized");
  if (write && !auth.csrfValid(req.headers.get(auth.CSRF_HEADER), req.cookies.get(auth.CSRF_COOKIE_NAME)?.value)) fail(403, "csrf", "Refresh the page and try again.");
  const r = limits.rateLimit(write ? "secrets:write" : "secrets:read", account.id, write ? 30 : 240, 60_000);
  if (!r.ok) fail(429, "rate_limited", "Too many tries. Wait a moment and try again.");
  return account;
}

export async function viewRoute(req: NextRequest): Promise<NextResponse> {
  try { return respond(await viewForPerson(await person(req, false), new Date())); } catch (e) { return onError(e, "view"); }
}

export async function denyRoute(req: NextRequest, id: string): Promise<NextResponse> {
  try { return respond(await denyRequest(await person(req, true), id, new Date())); } catch (e) { return onError(e, "deny"); }
}

export async function machineRoute(req: NextRequest, agentId: string, action: string): Promise<NextResponse> {
  try {
    const account = await person(req, true);
    return respond(await createJob(account, agentId.toLowerCase(), action, await readJson(req, 8 * 1024), req.headers.get(SU.STEP_UP_HEADER), new Date()));
  } catch (e) { return onError(e, "machine"); }
}
