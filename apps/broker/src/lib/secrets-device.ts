/**
 * Secret broker requests in the BC Remote app (docs/secrets-epic.md §3.1, §3.6): the phone answers with its AppBridge
 * device credential (an `ab_` bearer with appbridge.secrets, src/lib/appbridge.ts), which lasts a year, instead of
 * the dashboard's day-long cookie.
 *
 *   GET  /api/appbridge/v1/devices/self/secret-broker[?wait=25&since=<version>]   { requests: [...], machines: [...], now, version }
 *   POST /api/appbridge/v1/devices/self/secret-broker/requests/:id/deny                 {}: { denied: true }
 *   POST /api/appbridge/v1/devices/self/secret-broker/requests/:id/approve-options      { option? }: { ceremonyId, options }
 *   POST /api/appbridge/v1/devices/self/secret-broker/requests/:id/approve-verify       { ceremonyId, response }: { approved, option }
 *   POST /api/appbridge/v1/devices/self/secret-broker/machines/:agentId/enrol-options   {}: { ceremonyId, options }
 *   POST /api/appbridge/v1/devices/self/secret-broker/machines/:agentId/enrol-verify    { ceremonyId, response }: { job }
 *   POST /api/appbridge/v1/devices/self/secret-broker/machines/:agentId/test            { ref }: { job }
 *
 * The credential alone only sees and denies, as a deny is never gated. Approving is the same approve_secret ceremony
 * as the dashboard's: the WebAuthn challenge is the broker's digest, only a passkey that PC's broker trusts can answer,
 * the answer must come from the release app (src/lib/android-app.ts), and the PC's broker checks the assertion itself.
 *
 * `wait` holds the read until the account's requests change (raised, answered, expired) or the wait runs out, on the
 * phones' own channel (src/lib/inbox-bus.mjs, fireSecretsChanged); `since` is the `version` of the last answer. With
 * it the app needs no timer while its screen is open, and the push nudge (src/lib/push.ts) wakes it when closed.
 *
 * `machines` is the first-run checklist's view of each PC: whether its broker is installed and healthy, and whether it
 * trusts a passkey of this account (then this phone can approve for it). "Trust this phone" is the dashboard's
 * secret_broker_admin ceremony answered by the phone's passkey (enrol-options / enrol-verify): the passkey that
 * answered is the one the PC's worker is asked to enrol, and the PC's broker still decides at the machine.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { AppBridgeError, secretsDevice } from "@/lib/appbridge";
import { SecretsError, BROKER_FRESH_MS, createJob, denyRequest, passkeyFingerprint, type BrokerStatus } from "@/lib/secrets";
import { PasskeyRefusal, appAdminOptions, appAdminVerify, appApprovalOptions, appApprovalVerify } from "@/lib/passkeys";
import { TooManyWaitersError, secretsVersion, waitForSecrets } from "@/lib/inbox-bus";
import { installPushNudge } from "@/lib/push";

const MAX_BODY = 64 * 1024;
/** A phone waits at most this long on one read: well inside Cloud Run's request timeout, and the app's own. */
export const MAX_WAIT_SECONDS = 25;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const respond = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });

installPushNudge();

async function readJson(req: NextRequest): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new SecretsError(413, "too_large", "Request too large.");
  if (!text) return {};
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new SecretsError(400, "invalid_json", "Send a JSON object."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new SecretsError(400, "invalid_json", "Send a JSON object.");
  return body as Record<string, unknown>;
}

function onError(e: unknown): NextResponse {
  if (e instanceof AppBridgeError) return respond({ error: e.message }, e.status);
  if (e instanceof SecretsError || e instanceof PasskeyRefusal) return respond({ error: e.code, message: e.message }, e.status);
  if (e instanceof TooManyWaitersError) return respond({ error: "too_many_waiters", message: "Too many phones are waiting on this account. Try again in a moment." }, 429);
  console.error("secrets-device: unexpected error", e instanceof Error ? e.name : typeof e);
  return respond({ error: "unavailable", message: "Something went wrong. Try again." }, 503);
}

/** `wait` in whole seconds (0 to MAX_WAIT_SECONDS) and `since` (a version), both optional; anything else is 400. */
function waitQuery(req: NextRequest): { waitMs: number; since: number } {
  const q = req.nextUrl.searchParams;
  const wait = q.get("wait"), since = q.get("since");
  const w = wait === null ? 0 : /^\d{1,2}$/.test(wait) ? Number(wait) : NaN;
  const s = since === null ? 0 : /^\d{1,12}$/.test(since) ? Number(since) : NaN;
  if (!Number.isInteger(w) || w > MAX_WAIT_SECONDS || !Number.isInteger(s)) throw new SecretsError(400, "invalid_wait", `wait is 0 to ${MAX_WAIT_SECONDS} seconds and since is the last answer's version.`);
  return { waitMs: w * 1000, since: s };
}

/** Each PC's broker as the checklist shows it: never a value, never the passkeys' keys. */
async function machinesFor(accountId: string, now: Date) {
  const agents = await prisma.agentToken.findMany({
    where: { accountId, revokedAt: null, scope: "full", secretBrokerAt: { not: null } },
    select: { id: true, name: true, secretBroker: true, secretBrokerAt: true }, orderBy: { name: "asc" }, take: 50,
  });
  if (!agents.length) return [];
  const passkeys = await prisma.accountPasskey.findMany({ where: { accountId }, select: { id: true, label: true, credentialId: true, publicKey: true } });
  const mine = passkeys.map((p) => ({ id: p.id, label: p.label, fingerprint: passkeyFingerprint(p.credentialId, new Uint8Array(p.publicKey)) }));
  const jobs = await prisma.secretJob.findMany({ where: { accountId, agentId: { in: agents.map((a) => a.id) } }, orderBy: { createdAt: "desc" }, take: 100 });
  return agents.map((a) => {
    const broker = (a.secretBroker ?? {}) as unknown as Partial<BrokerStatus>;
    const trusted = new Set((broker.approvers ?? []).map((x) => x.fingerprint));
    const latest = jobs.find((j) => j.agentId === a.id) ?? null;
    return {
      agentId: a.id, name: a.name,
      current: !!a.secretBrokerAt && now.getTime() - a.secretBrokerAt.getTime() <= BROKER_FRESH_MS,
      installed: broker.installed === true, healthy: broker.healthy ?? null, lockdown: broker.lockdown ?? null,
      approverEnrolled: broker.approverEnrolled ?? null,
      trustedPasskeys: mine.filter((p) => trusted.has(p.fingerprint)).map((p) => ({ id: p.id, label: p.label })),
      job: latest && { id: latest.id, kind: latest.kind, state: latest.state, progress: latest.progress, failure: latest.failure, createdAt: latest.createdAt.toISOString(), finishedAt: latest.finishedAt?.toISOString() ?? null },
    };
  });
}

/** The account's requests still waiting for an answer, as the Remote page shows them, and its PCs; never a value. */
export async function deviceView(req: NextRequest): Promise<NextResponse> {
  try {
    const device = await secretsDevice(req);
    const { waitMs, since } = waitQuery(req);
    const version = waitMs > 0 ? await waitForSecrets(device.accountId, since, waitMs) : secretsVersion(device.accountId);
    const now = new Date();
    const rows = await prisma.secretRequest.findMany({
      where: { accountId: device.accountId, status: "open", expiresAt: { gt: now } }, orderBy: { raisedAt: "desc" }, take: 20,
      include: { agent: { select: { name: true } } },
    });
    return respond({
      now: now.toISOString(), version,
      requests: rows.map((r) => ({
        id: r.id, machine: r.agent.name, agentId: r.agentId, kind: r.kind, name: r.name, mode: r.mode, tier: r.tier, target: r.target,
        code: r.requestCode, display: r.display, requester: r.requester,
        options: (r.options as { index: number; label: string }[]).map((o) => ({ index: o.index, label: o.label })),
        raisedAt: r.raisedAt.toISOString(), expiresAt: r.expiresAt.toISOString(),
      })),
      machines: await machinesFor(device.accountId, now),
    });
  } catch (e) { return onError(e); }
}

export async function deviceAnswer(req: NextRequest, id: string, action: string): Promise<NextResponse> {
  try {
    const device = await secretsDevice(req);
    if (!UUID.test(id)) throw new SecretsError(404, "not_found", "That request isn't on your account.");
    const now = new Date();
    const by = { device_id: device.id };
    if (action === "deny") return respond(await denyRequest({ id: device.accountId }, id, now, by));
    const input = await readJson(req);
    if (action === "approve-options") return respond(await appApprovalOptions(device.accountId, req.url, id, input.option, now));
    if (action === "approve-verify") return respond(await appApprovalVerify(device.accountId, req.url, id, input, now));
    return respond({ error: "not_found", message: "No such action." }, 404);
  } catch (e) { return onError(e); }
}

/**
 * The checklist's two actions on one PC. `enrol-options` / `enrol-verify`: trust the passkey that answers, through
 * the worker's enrol job (the PC's broker shows its fingerprint and asks for Hello there). `test`: ask the worker to
 * resolve one named secret, which raises a request this phone then answers: the whole path, end to end.
 */
export async function deviceMachine(req: NextRequest, agentId: string, action: string): Promise<NextResponse> {
  try {
    const device = await secretsDevice(req);
    if (!UUID.test(agentId)) throw new SecretsError(404, "not_found", "That PC's worker isn't on your account.");
    const id = agentId.toLowerCase();
    const now = new Date();
    // The PC must be this account's before any ceremony is minted for it (createJob checks again when it runs).
    if (!(await prisma.agentToken.findFirst({ where: { id, accountId: device.accountId, revokedAt: null, scope: "full" }, select: { id: true } }))) {
      throw new SecretsError(404, "not_found", "That PC's worker isn't on your account.");
    }
    const input = await readJson(req);
    if (action === "enrol-options") return respond(await appAdminOptions(device.accountId, req.url, id, now));
    if (action === "enrol-verify") {
      const { grant, passkeyId } = await appAdminVerify(device.accountId, req.url, id, input, now);
      return respond(await createJob({ id: device.accountId }, id, "enrol", { passkeyId }, grant, now));
    }
    if (action === "test") return respond(await createJob({ id: device.accountId }, id, "test", input, null, now));
    return respond({ error: "not_found", message: "No such action." }, 404);
  } catch (e) { return onError(e); }
}
