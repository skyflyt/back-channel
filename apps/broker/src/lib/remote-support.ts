/**
 * Remote support: one-time, consented help for someone else through a temporary client (docs/remote-support.md).
 * Phase B of "agents and Back Channel Remote".
 *
 * The I/O half. Every decision (codes, states, the 45-minute cap, view-first steps, the outstanding and daily
 * caps, the words) lives in remote-support/rules.mjs, which has no database and is covered by `node --test`.
 * This file authenticates, loads rows, asks the rules, writes, and shapes responses, every operation in one
 * serializable transaction re-run whole on a conflict.
 *
 * Callers:
 *  - REST: src/app/api/support/[[...path]]/route.ts -> supportRoute()
 *  - MCP:  src/lib/remote-app.ts remoteTool() -> supportTool() for bc_support_* (catalog: mcp/remote-tools.mjs)
 *  - The landing page: src/app/support/[code]/page.tsx -> supportCodeForPage()
 *  - The helper's relay pass: src/lib/appbridge.ts issueSupportPass (it reads the session itself)
 *
 * Who may do what:
 *  - Ask for a code, follow it, withdraw or end it: an agent, with a FULL-SCOPE key (a connector key is refused,
 *    like Dispatch and remote app sessions). An agent never sees a code: no response to an agent carries one.
 *  - Approve (mint), deny, cancel a code, stop a session: the person, in the dashboard (cookie + CSRF), and in
 *    v1 only the owner (ADMIN_EMAILS, verified email, src/lib/owner.ts), on an account with Back Channel Remote.
 *    Any request that carries a bearer key is refused before anything else.
 *  - Redeem a code, or say "I didn't ask for this" from the landing page: anyone holding the code.
 *  - Allow, stop, report, record steps, send the removal receipt, read the session and transcript: the temporary
 *    client, with the abs_ credential its redemption returned (bound to the key that redeemed; Allow and the
 *    receipt are also signed with that key).
 *
 * Content-blind like remote app sessions: the broker stores fixed action kinds, a bounded control name and an
 * outcome. Never screen content, typed text or a screenshot, and never the code or the credential (hashes only).
 *
 * MCP route safety: the MCP route loads this module (through remote-app.ts). @/lib/auth and @/lib/rate-limit are
 * namespace imports, and nothing here imports admin.ts or appbridge.ts, whose named imports route tests stub.
 */
import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes, randomInt } from "node:crypto";
import type { Account, AgentToken, Prisma, RemoteAppActionLog, RemoteAppSession, SupportInvite } from "@prisma/client";
import { prisma } from "@/lib/db";
// Namespace imports on purpose (see lists.ts and remote-app.ts): route tests replace these modules with a few named exports.
import * as auth from "@/lib/auth";
import * as limits from "@/lib/rate-limit";
import { hasFullScope } from "@/lib/agent-scope";
import { isSerializationFailure, withSerializableRetry } from "@/lib/serializable";
import { remoteAccessSource } from "@/lib/remote-entitlement";
import { listsInTx } from "@/lib/lists";
import { isOwnerAccount } from "@/lib/owner";
import { SUPPORT_TOOL_NAMES } from "@/lib/mcp/remote-tools.mjs";
import * as R from "@/lib/remote-app/rules.mjs";
import * as S from "@/lib/remote-support/rules.mjs";
import * as P from "@/lib/remote-support/proof.mjs";

type Tx = Prisma.TransactionClient;
type Input = Record<string, unknown>;
type Invite = SupportInvite;
type Session = RemoteAppSession;
type SessionPatch = Prisma.RemoteAppSessionUpdateManyMutationInput;
type InvitePatch = Prisma.SupportInviteUpdateManyMutationInput;
type Caller =
  | { kind: "agent"; accountId: string; agentId: string }
  | { kind: "person"; accountId: string }
  | { kind: "client"; accountId: string; sessionId: string }
  | { kind: "public" };
type Op =
  | "request" | "list" | "get" | "end" | "approve" | "deny" | "void" | "stop" | "redeem" | "report"
  | "clientGet" | "allow" | "clientReport" | "clientStop" | "step" | "receipt" | "transcript";
type Ctx = { tx: Tx; caller: Caller; input: Input; now: Date; id?: string; origin: string };
type Outcome = { status?: number; body: Record<string, unknown> };

const AGENTS_ONLY = new Set<Op>(["request", "end"]);
const PEOPLE_ONLY = new Set<Op>(["approve", "deny", "void", "stop"]);
const CLIENT = new Set<Op>(["clientGet", "allow", "clientReport", "clientStop", "step", "receipt", "transcript"]);
const PUBLIC = new Set<Op>(["redeem", "report"]);
const WRITES = new Set<Op>(["request", "end", "approve", "deny", "void", "stop", "redeem", "report", "allow", "clientReport", "clientStop", "step", "receipt"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 8 * 1024;
const REQUESTS_PER_HOUR = 10;
// Unauthenticated by nature (redeem, the landing page's report, the landing page itself): only FAILED attempts
// spend this global budget, like AppBridge's device exchange. Guessing stays hopeless: a code is one of 31^8,
// lives 15 minutes and works once.
const PUBLIC_FAILURES = 300;
const LIST_TEXT_MAX = 7_900;

const fail = (status: number, code: string, message: string, extra?: Record<string, unknown>): never => {
  throw new R.RemoteRuleError(status, code, message, extra);
};
/** A guard that failed after a write: the whole attempt rolls back (other refusals commit what time did). */
class RollBack extends R.RemoteRuleError {}
const NOT_FOUND = () => fail(404, "not_found", "That support request isn't available.");
const INVALID_CODE = () => fail(410, "code_invalid", S.UNIFORM_INVALID);
const respond = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
const conflict = (e: unknown) => isSerializationFailure(e) || (!!e && typeof e === "object" && "code" in e && (e as { code?: unknown }).code === "P2002");
const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const cut = (text: string) => ([...text].length > LIST_TEXT_MAX ? [...text].slice(0, LIST_TEXT_MAX - 1).join("") + "…" : text);

function exact(input: Input, allowed: string[]) {
  const extra = Object.keys(input).find((k) => !allowed.includes(k));
  if (extra) fail(400, "unknown_field", `Unknown field "${extra}".`);
}

// ── auth ────────────────────────────────────────────────────────────────────

/** The temporary client's credential: abs_ only. A device's ab_ credential, an agent's bc_ key or a cookie is 401. */
async function clientCaller(req: NextRequest): Promise<Caller> {
  const m = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "");
  if (!m || !S.CREDENTIAL.test(m[1])) return fail(401, "unauthorized", "This needs the helper's own credential, from redeeming the code.");
  const s = await prisma.remoteAppSession.findUnique({ where: { supportCredentialHash: sha(m[1]) } });
  if (!s || s.kind !== "support" || !s.supportCredentialExpiresAt || s.supportCredentialExpiresAt.getTime() <= Date.now()) {
    return fail(401, "unauthorized", "This helper's credential no longer works. The support session is over.");
  }
  return { kind: "client", accountId: s.accountId, sessionId: s.id };
}

async function resolveCaller(req: NextRequest, op: Op): Promise<Caller> {
  if (CLIENT.has(op)) return clientCaller(req);
  if (PUBLIC.has(op)) return { kind: "public" };
  const authorization = req.headers.get("authorization");
  if (authorization) {
    // A bearer key is an agent, whatever cookie rides along: minting a code is a person's act, in the browser.
    if (PEOPLE_ONLY.has(op)) fail(403, "people_only", "Only your person can do this, signed in to the Back Channel dashboard. An agent never approves a support code or sees one.");
    const ctx = await auth.getAuthContext(authorization);
    if (!ctx) return fail(401, "unauthorized", "Unauthorized");
    if (!ctx.agentTokenId) fail(401, "agent_key_required", "Support codes need a per-agent key. Connect this agent from the Back Channel dashboard.");
    if (!hasFullScope(ctx)) {
      fail(403, "not_available_to_connectors", "Support codes need a full agent key. A hosted connector (claude.ai, ChatGPT) can't ask for one; use an agent that runs on one of your person's own machines.");
    }
    return { kind: "agent", accountId: ctx.account.id, agentId: ctx.agentTokenId };
  }
  if (AGENTS_ONLY.has(op)) fail(401, "agent_key_required", "This is for agents, with their own key.");
  const account = await auth.getAccountFromCookie(req.cookies?.get(auth.SESSION_COOKIE_NAME)?.value);
  if (!account) return fail(401, "unauthorized", "Unauthorized");
  if (WRITES.has(op) && !auth.csrfValid(req.headers.get(auth.CSRF_HEADER), req.cookies.get(auth.CSRF_COOKIE_NAME)?.value)) {
    fail(403, "csrf", "Refresh the page and try again.");
  }
  return { kind: "person", accountId: account.id };
}

/** The calling agent, read again inside the transaction: live, same account, full scope. */
async function liveAgent(tx: Tx, caller: Caller): Promise<AgentToken> {
  if (caller.kind !== "agent") return fail(401, "agent_key_required", "This is for agents, with their own key.");
  const a = await tx.agentToken.findFirst({ where: { id: caller.agentId, accountId: caller.accountId, revokedAt: null } });
  if (!a) return fail(401, "agent_revoked", "This agent's key has been revoked.");
  if (a.scope !== "full") fail(403, "not_available_to_connectors", "Support codes need a full agent key.");
  return a;
}

/**
 * The issuer can offer support right now: Back Channel Remote is on, the account is the owner (v1) with a
 * verified email, and it has Back Channel Remote. helped: the question comes from the helped side, which is
 * told only that help isn't available (never why: that is the issuer's business).
 */
async function issuerReady(tx: Tx, accountId: string, now: Date, helped = false): Promise<Account> {
  const no = (code: string, message: string) => fail(403, helped ? "unavailable" : code,
    helped ? "The person who sent this code can't offer help through Back Channel right now, so nothing will happen on your computer. You can close this." : message);
  if (process.env.APPBRIDGE_REMOTE_ACCESS !== "on") no("rollout_off", "Back Channel Remote is switched off for now, so support codes can't be issued.");
  const account = await tx.account.findUnique({ where: { id: accountId } });
  if (!account || !isOwnerAccount(account)) return no("owner_only", "One-time support codes are only available to Back Channel's owner for now.");
  if (!(await remoteAccessSource(tx, accountId, now))) {
    no("not_entitled", "Support codes are part of Back Channel Remote. Your person can turn it on from the Remote page of the dashboard.");
  }
  return account;
}

// ── rows ────────────────────────────────────────────────────────────────────

async function settleInvite(tx: Tx, inv: Invite, now: Date): Promise<Invite> {
  const patch = S.settleInvite(inv, now);
  if (!patch) return inv;
  await tx.supportInvite.updateMany({ where: { id: inv.id, status: inv.status }, data: patch as InvitePatch });
  return (await tx.supportInvite.findFirst({ where: { id: inv.id } }))!;
}

/** Time's effect on a session (Allow never came, the cap ran out), written; its relay leases go with it. */
async function settleSession(tx: Tx, s: Session, now: Date): Promise<Session> {
  const patch = R.settle(s, now);
  if (!patch) return s;
  const won = await tx.remoteAppSession.updateMany({ where: { id: s.id, status: s.status }, data: patch as SessionPatch });
  if (won.count === 1) await tx.appBridgeLease.deleteMany({ where: { remoteAppSessionId: s.id } });
  return (await tx.remoteAppSession.findFirst({ where: { id: s.id } }))!;
}

async function applyInvite(tx: Tx, inv: Invite, patch: Record<string, unknown>): Promise<Invite> {
  const won = await tx.supportInvite.updateMany({ where: { id: inv.id, status: inv.status }, data: patch as InvitePatch });
  if (won.count !== 1) throw new RollBack(409, "changed", "This changed at the same moment. Read it again and retry.");
  return { ...inv, ...patch } as Invite;
}

/** Move a session on, guarded by the status it was read with. Leaving "active" deletes its relay leases in this transaction. */
async function applySession(tx: Tx, s: Session, patch: Record<string, unknown>): Promise<Session> {
  const won = await tx.remoteAppSession.updateMany({ where: { id: s.id, status: s.status }, data: patch as SessionPatch });
  if (won.count !== 1) throw new RollBack(409, "changed", "This session changed at the same moment. Read it again and retry.");
  if (patch.status !== "active") await tx.appBridgeLease.deleteMany({ where: { remoteAppSessionId: s.id } });
  return { ...s, ...patch } as Session;
}

async function audit(tx: Tx, accountId: string, eventType: string, detail: Record<string, unknown>) {
  await tx.accountAudit.create({ data: { accountId, eventType, detail: detail as Prisma.InputJsonValue } });
}

/** A line on the bound Lists task: as the person, or as the agent that asked (it holds the claim). Best effort. */
async function mirror(tx: Tx, inv: Pick<Invite, "accountId" | "agentTokenId" | "listTaskId">, by: "person" | "starter", text: string, now: Date): Promise<boolean> {
  if (!inv.listTaskId) return false;
  const as = { accountId: inv.accountId, agentId: by === "person" ? null : inv.agentTokenId };
  const r = await listsInTx(tx, as, "addEntry", { task_id: inv.listTaskId, kind: "progress", text: cut(text) }, now);
  return r.ok;
}

async function stepsOf(tx: Tx, s: Session): Promise<RemoteAppActionLog[]> {
  return tx.remoteAppActionLog.findMany({ where: { sessionId: s.id }, orderBy: [{ at: "asc" }, { id: "asc" }], take: S.LIMITS.stepsPerSession });
}

async function issuerOf(tx: Tx, accountId: string) {
  const account = await tx.account.findUnique({ where: { id: accountId } });
  return S.issuerIdentity(account ?? { handle: "someone", displayName: null });
}

async function transcriptFor(tx: Tx, s: Session, audience: "issuer" | "helped", now: Date) {
  const issuer = S.issuerLine(await issuerOf(tx, s.accountId));
  return S.transcript(s, await stepsOf(tx, s), { audience, issuer, helped: s.helperLabel, now });
}

/** The issuer's transcript onto the bound task, once a session is over. Best effort. */
async function mirrorTranscript(tx: Tx, inv: Invite, s: Session, now: Date) {
  return mirror(tx, inv, "starter", (await transcriptFor(tx, s, "issuer", now)).text, now);
}

/** The account's support sessions waiting for Allow or running, after time has had its say. */
async function liveSupport(tx: Tx, accountId: string, now: Date, except?: string): Promise<Session[]> {
  const rows = await tx.remoteAppSession.findMany({ where: { accountId, kind: "support", status: { in: [...R.LIVE] } } });
  const out: Session[] = [];
  for (const row of rows) {
    if (row.id === except) continue;
    const s = await settleSession(tx, row, now);
    if (R.LIVE.includes(s.status)) out.push(s);
  }
  return out;
}

/** Codes of the account asked for or minted and not used yet. */
async function outstanding(tx: Tx, accountId: string, now: Date): Promise<number> {
  const rows = await tx.supportInvite.findMany({ where: { accountId, status: { in: [...S.OUTSTANDING] } } });
  let n = 0;
  for (const row of rows) if (S.OUTSTANDING.includes((await settleInvite(tx, row, now)).status)) n++;
  return n;
}

/** One invite the caller may see: an agent, the ones it asked for; the person, every one in the account. */
async function loadInvite(tx: Tx, caller: Caller, id: unknown, now: Date): Promise<Invite> {
  if (caller.kind !== "agent" && caller.kind !== "person") return NOT_FOUND();
  if (typeof id !== "string" || !UUID.test(id)) return NOT_FOUND();
  const inv = await tx.supportInvite.findFirst({ where: { id, accountId: caller.accountId } });
  if (!inv || (caller.kind === "agent" && inv.agentTokenId !== caller.agentId)) return NOT_FOUND();
  return settleInvite(tx, inv, now);
}

async function sessionOf(tx: Tx, inv: Invite, now: Date): Promise<Session | null> {
  if (!inv.sessionId) return null;
  const s = await tx.remoteAppSession.findFirst({ where: { id: inv.sessionId, kind: "support" } });
  return s ? settleSession(tx, s, now) : null;
}

/** The temporary client's own session, re-read inside the transaction. */
async function clientSession(tx: Tx, caller: Caller, now: Date): Promise<Session> {
  if (caller.kind !== "client") return fail(401, "unauthorized", "This needs the helper's own credential.");
  const s = await tx.remoteAppSession.findFirst({ where: { id: caller.sessionId, kind: "support" } });
  if (!s) return fail(401, "unauthorized", "This helper's credential no longer works.");
  return settleSession(tx, s, now);
}

async function inviteOfSession(tx: Tx, s: Session): Promise<Invite> {
  return (await tx.supportInvite.findFirst({ where: { sessionId: s.id } }))!;
}

async function view(tx: Tx, inv: Invite, now: Date, session?: Session | null) {
  const s = session === undefined ? await sessionOf(tx, inv, now) : session;
  const [agent, task, report] = await Promise.all([
    tx.agentToken.findFirst({ where: { id: inv.agentTokenId }, select: { name: true } }),
    inv.listTaskId ? tx.taskItem.findFirst({ where: { id: inv.listTaskId }, select: { id: true, title: true } }) : null,
    tx.supportReport.findFirst({ where: { inviteId: inv.id }, select: { id: true } }),
  ]);
  return S.inviteView(inv, { now, session: s, requestedBy: agent?.name || "a removed agent", task, reported: !!report });
}

const stepView = (row: Pick<RemoteAppActionLog, "at" | "action" | "target" | "outcome">, audience: "issuer" | "helped") =>
  ({ at: iso(row.at), action: row.action, target: row.target ?? null, outcome: row.outcome, text: S.stepPhrase(row, audience) });

// ── agents ──────────────────────────────────────────────────────────────────

async function opRequest({ tx, caller, input, now, origin }: Ctx): Promise<Outcome> {
  const me = await liveAgent(tx, caller);
  const p = S.parseInvite(input);
  await issuerReady(tx, me.accountId, now);
  if (p.taskId) {
    const r = await listsInTx(tx, { accountId: me.accountId, agentId: me.id }, "getTask", { task_id: p.taskId }, now);
    if (!r.ok) return fail(r.code === "not_available" ? 404 : 409, r.code, r.message);
    const t = r.result.task as { claim?: { by?: { is_this_agent?: boolean } } | null };
    if (!t.claim?.by?.is_this_agent) fail(409, "claim_first", "Claim the task first with bc_task_claim, then ask with its task_id, so the task shows who is on it.");
  }
  S.outstandingCheck(await outstanding(tx, me.accountId, now));
  const created = await tx.supportInvite.create({ data: S.newInvite({ accountId: me.accountId, agentId: me.id, ...p }) });
  // The one-tap approval link, built like bc_dashboard_link: a single-use, 15-minute sign-in for the person,
  // deep-linking to this request on the Remote page. Only its hash is stored. It is NOT the code.
  const raw = auth.generateViewToken();
  const linkExpiresAt = auth.viewTokenExpiry();
  await tx.viewToken.create({ data: { token: auth.hashToken(raw), accountId: me.accountId, purpose: "account", expiresAt: linkExpiresAt } });
  await audit(tx, me.accountId, "support.requested", { inviteId: created.id, agentId: me.id, minutes: p.minutes });
  await mirror(tx, created, "starter", `Asked for a one-time support code to help ${p.forName}, for up to ${p.minutes} minutes. Waiting for approval.`, now);
  const v = await view(tx, created, now, null);
  return {
    body: {
      support: v,
      approvalUrl: `${origin}/account/remote?vt=${encodeURIComponent(raw)}&support=${created.id}`,
      approvalUrlExpiresAt: linkExpiresAt.toISOString(),
      next: S.nextStep(v),
    },
  };
}

async function opEnd({ tx, caller, input, now, id }: Ctx): Promise<Outcome> {
  const inv = await loadInvite(tx, caller, id, now);
  await liveAgent(tx, caller);
  if (input.finished !== undefined && typeof input.finished !== "boolean") fail(400, "invalid_finished", "finished is true or false");
  const finished = input.finished !== false;
  let task: Record<string, unknown> | null = null;
  if (S.OUTSTANDING.includes(inv.status)) {
    // Not used yet: withdrawn, and an unused code dies with it.
    const next = await applyInvite(tx, inv, { status: "withdrawn", closedAt: now });
    await audit(tx, inv.accountId, "support.withdrawn", { inviteId: inv.id });
    const ok = await mirror(tx, inv, "starter", `Withdrew the request for a support code for ${inv.forName}.`, now);
    if (inv.listTaskId) task = { done: false, updated: ok };
    const v = await view(tx, next, now, null);
    return { body: { support: v, task, next: S.nextStep(v) } };
  }
  const s = await sessionOf(tx, inv, now);
  const patch = s ? S.stopPatch(s, "agent", now, { finished }) : null;
  if (!s || !patch) return fail(409, "already_over", `This is already over (${s ? S.sessionStatusText(s, "issuer") : S.inviteStatusLabel(inv.status)}).`);
  const ended = await applySession(tx, s, patch);
  await audit(tx, inv.accountId, "support.ended", { inviteId: inv.id, sessionId: s.id, endReason: patch.endReason ?? patch.status });
  if (inv.listTaskId) {
    const t = await transcriptFor(tx, ended, "issuer", now);
    if (patch.endReason === "done") {
      // The Lists done path, as the agent that holds the claim, with the transcript as the summary.
      const r = await listsInTx(tx, { accountId: inv.accountId, agentId: inv.agentTokenId }, "done", { task_id: inv.listTaskId, summary: cut(t.text) }, now);
      task = r.ok ? { done: true, status: (r.result.task as { status?: string }).status ?? null } : { done: false, why: r.message };
    } else {
      task = { done: false, updated: await mirror(tx, inv, "starter", t.text, now) };
    }
  }
  const v = await view(tx, inv, now, ended);
  return { body: { support: v, transcript: await transcriptFor(tx, ended, "issuer", now), task, next: S.nextStep(v) } };
}

// ── agents and the dashboard ────────────────────────────────────────────────

async function opList({ tx, caller, now }: Ctx): Promise<Outcome> {
  if (caller.kind === "agent") {
    const rows = await tx.supportInvite.findMany({ where: { accountId: caller.accountId, agentTokenId: caller.agentId }, orderBy: { createdAt: "desc" }, take: 20 });
    const support = [];
    for (const row of rows) support.push(await view(tx, await settleInvite(tx, row, now), now));
    return { body: { support } };
  }
  if (caller.kind !== "person") return NOT_FOUND();
  // The dashboard card. Owner-only in v1: anyone else gets a plain "not available", and the card hides.
  const account = await tx.account.findUnique({ where: { id: caller.accountId } });
  if (!account || !isOwnerAccount(account)) return { body: { available: false, reason: "owner_only" } };
  const remoteAccess = process.env.APPBRIDGE_REMOTE_ACCESS !== "on" ? "rollout_off" : (await remoteAccessSource(tx, caller.accountId, now)) ? "available" : "not_entitled";
  const weekAgo = new Date(now.getTime() - 7 * S.DAY_MS);
  const rows = await tx.supportInvite.findMany({
    where: { accountId: caller.accountId, OR: [{ status: { in: ["requested", "minted", "redeemed"] } }, { createdAt: { gt: weekAgo } }] },
    orderBy: { createdAt: "desc" }, take: 60,
  });
  const pending = []; const codes = []; const live = []; const recent = [];
  for (const row of rows) {
    const inv = await settleInvite(tx, row, now);
    const s = await sessionOf(tx, inv, now);
    const v = await view(tx, inv, now, s);
    if (inv.status === "requested") pending.push(v);
    else if (inv.status === "minted") codes.push(v);
    else if (s && R.LIVE.includes(s.status)) live.push({ ...v, steps: (await stepsOf(tx, s)).map((r) => stepView(r, "issuer")) });
    else if (recent.length < 20 && (s?.endedAt ?? inv.closedAt ?? inv.createdAt) > weekAgo) {
      recent.push({ ...v, ...(s ? { transcript: await transcriptFor(tx, s, "issuer", now) } : {}) });
    }
  }
  const reportRows = await tx.supportReport.findMany({ where: { accountId: caller.accountId, createdAt: { gt: new Date(now.getTime() - 30 * S.DAY_MS) } }, orderBy: { createdAt: "desc" }, take: 20 });
  const reported = reportRows.length ? await tx.supportInvite.findMany({ where: { id: { in: reportRows.map((r) => r.inviteId) } } }) : [];
  const byId = new Map(reported.map((i) => [i.id, i]));
  const reports = reportRows.map((r) => ({ id: r.id, at: iso(r.createdAt), via: r.via, inviteId: r.inviteId, for: byId.get(r.inviteId)?.forName ?? null, task: byId.get(r.inviteId)?.task ?? null }));
  const mintedToday = await tx.supportInvite.count({ where: { accountId: caller.accountId, mintedAt: { gt: new Date(now.getTime() - S.DAY_MS) } } });
  return {
    body: {
      available: true, remoteAccess,
      limits: { outstanding: pending.length + codes.length, maxOutstanding: S.LIMITS.outstanding, mintedToday, mintsPerDay: S.LIMITS.mintsPerDay, maxMinutes: S.LIMITS.maxMinutes },
      pending, codes, live, recent, reports,
    },
  };
}

async function opGet({ tx, caller, now, id }: Ctx): Promise<Outcome> {
  const inv = await loadInvite(tx, caller, id, now);
  const s = await sessionOf(tx, inv, now);
  const v = await view(tx, inv, now, s);
  return {
    body: {
      support: v,
      ...(s ? { steps: (await stepsOf(tx, s)).map((r) => stepView(r, "issuer")), transcript: await transcriptFor(tx, s, "issuer", now) } : {}),
      ...(caller.kind === "agent" ? { next: S.nextStep(v) } : {}),
    },
  };
}

// ── the person (dashboard; owner-only in v1) ────────────────────────────────

async function opApprove({ tx, caller, now, id, origin }: Ctx): Promise<Outcome> {
  const inv = await loadInvite(tx, caller, id, now);
  S.decideCheck(inv, now);
  await issuerReady(tx, inv.accountId, now);
  S.mintsCheck(await tx.supportInvite.count({ where: { accountId: inv.accountId, mintedAt: { gt: new Date(now.getTime() - S.DAY_MS) } } }));
  const agent = await tx.agentToken.findFirst({ where: { id: inv.agentTokenId, accountId: inv.accountId, revokedAt: null } });
  if (!agent || agent.scope !== "full") fail(409, "agent_unavailable", "The agent that asked has been removed or can no longer ask for support codes. Deny this request.");
  // Minted here, in the person's request, and shown to them only. Only its hash is stored. A clash with another
  // code's hash is a unique conflict: the whole attempt re-runs with a new code.
  const code = S.newCode((n) => randomInt(0, n));
  const next = await applyInvite(tx, inv, S.mintPatch(now, sha(code)));
  await audit(tx, inv.accountId, "support.minted", { inviteId: inv.id, minutes: inv.minutes });
  await mirror(tx, inv, "person", `Approved a one-time support code for ${inv.forName}, for up to ${inv.minutes} minutes. The code is shown only in the dashboard and is sent by hand.`, now);
  return {
    body: {
      support: await view(tx, next, now, null),
      code,
      url: `${origin}/support/${code}`,
      codeExpiresAt: iso(next.codeExpiresAt),
      note: `Shown once. Send it to ${inv.forName} yourself. It works once, for 15 minutes. Back Channel never shows it to your agent and can't show it again.`,
    },
  };
}

async function opDeny({ tx, caller, now, id }: Ctx): Promise<Outcome> {
  const inv = await loadInvite(tx, caller, id, now);
  S.decideCheck(inv, now);
  const next = await applyInvite(tx, inv, { status: "denied", closedAt: now });
  await audit(tx, inv.accountId, "support.denied", { inviteId: inv.id });
  await mirror(tx, inv, "person", `Said no to a support code for ${inv.forName}.`, now);
  return { body: { support: await view(tx, next, now, null) } };
}

async function opVoid({ tx, caller, now, id }: Ctx): Promise<Outcome> {
  const inv = await loadInvite(tx, caller, id, now);
  S.voidCheck(inv, now);
  const next = await applyInvite(tx, inv, { status: "voided", closedAt: now });
  await audit(tx, inv.accountId, "support.voided", { inviteId: inv.id });
  await mirror(tx, inv, "person", `Cancelled the support code for ${inv.forName} before it was used.`, now);
  return { body: { support: await view(tx, next, now, null) } };
}

/** The issuer's Stop (dashboard revoke). Final; the helper's relay lease goes in the same transaction. Idempotent. */
async function opStop({ tx, caller, now, id }: Ctx): Promise<Outcome> {
  const inv = await loadInvite(tx, caller, id, now);
  const s = await sessionOf(tx, inv, now);
  if (!s) return fail(409, "not_running", inv.status === "minted" ? "Nothing is running yet. To make the unused code stop working, cancel it." : `Nothing is running: this is ${S.inviteStatusLabel(inv.status)}.`);
  const patch = S.stopPatch(s, "issuer", now);
  let current = s;
  if (patch) {
    current = await applySession(tx, s, patch);
    await audit(tx, inv.accountId, "support.stopped", { inviteId: inv.id, sessionId: s.id, by: "issuer" });
    await mirrorTranscript(tx, inv, current, now);
  }
  return { body: { support: await view(tx, inv, now, current), transcript: await transcriptFor(tx, current, "issuer", now) } };
}

// ── the helped person (no account) ──────────────────────────────────────────

/**
 * Redeem: the temporary client trades the code and a fresh key's proof for a session pinned to that key. One
 * serializable transaction: two clients racing one code produce one session; the loser gets the uniform answer.
 */
async function opRedeem({ tx, input, now }: Ctx): Promise<Outcome> {
  exact(input, ["code", "keySpki", "proof"]);
  const code = S.normalizeCode(input.code);
  if (!code) return INVALID_CODE();
  const key = P.parseP256Spki(input.keySpki);
  if (!key) return fail(400, "invalid_key", "keySpki must be a P-256 public key: base64 DER SubjectPublicKeyInfo.");
  if (!P.proofValid(key.key, S.redeemMessage(code), input.proof)) fail(400, "invalid_proof", "proof must sign \"bc-support-redeem-v1:<code>\" with that key (ECDSA P-256, SHA-256, IEEE P1363, base64url).");
  const found = await tx.supportInvite.findUnique({ where: { codeHash: sha(code) } });
  if (!found) return INVALID_CODE();
  const inv = await settleInvite(tx, found, now);
  const credential = S.CREDENTIAL_PREFIX + randomBytes(32).toString("base64url");
  if (inv.status === "redeemed") {
    // The same key again, inside the code's window (its first reply was lost): a fresh credential, and the one
    // before it stops working. Any other key, or after the window, gets the uniform answer: pinned to the first key.
    const s = await sessionOf(tx, inv, now);
    if (!s || s.supportKeySha256 !== key.sha256 || !R.LIVE.includes(s.status) || !(inv.codeExpiresAt && inv.codeExpiresAt > now)) return INVALID_CODE();
    const again = await tx.remoteAppSession.update({ where: { id: s.id }, data: { supportCredentialHash: sha(credential) } });
    await audit(tx, inv.accountId, "support.redeemed_again", { inviteId: inv.id, sessionId: s.id });
    return { body: await redeemed(tx, again, credential) };
  }
  if (!S.redeemable(inv, now)) return INVALID_CODE();
  await issuerReady(tx, inv.accountId, now, true);
  if ((await liveSupport(tx, inv.accountId, now)).length) {
    fail(409, "issuer_busy", "The person helping you is in another support session right now. Try again in a few minutes: this code still works until it expires.");
  }
  if (await tx.remoteAppSession.findFirst({ where: { supportKeySha256: key.sha256 } })) fail(409, "key_in_use", "Use a fresh key for each code.");
  const relayHostId = S.RELAY_HOST_PREFIX + randomBytes(16).toString("base64url");
  const session = await tx.remoteAppSession.create({
    data: S.newSupportSession({ invite: inv, relayHostId, keySha256: key.sha256, keySpki: key.spki, credentialHash: sha(credential), now }),
  });
  const claimed = await tx.supportInvite.updateMany({ where: { id: inv.id, status: "minted", codeExpiresAt: { gt: now } }, data: { status: "redeemed", redeemedAt: now, sessionId: session.id } });
  if (claimed.count !== 1) throw new RollBack(410, "code_invalid", S.UNIFORM_INVALID);
  await audit(tx, inv.accountId, "support.redeemed", { inviteId: inv.id, sessionId: session.id });
  await mirror(tx, inv, "starter", `${inv.forName} opened the support code. Waiting for them to press Allow on their own screen.`, now);
  return { body: await redeemed(tx, session, credential) };
}

/** What the temporary client needs, and nothing else: no "for", no agent, nothing about the issuer's account but its asserted name. */
async function redeemed(tx: Tx, s: Session, credential: string) {
  return {
    sessionId: s.id,
    issuer: await issuerOf(tx, s.accountId),
    task: s.goal,
    minutes: s.minutes,
    allowBy: iso(R.consentDeadline(s)),
    credential,
    credentialExpiresAt: iso(s.supportCredentialExpiresAt),
  };
}

/** "I didn't ask for this" on the landing page: the code stops working, and the issuer sees a report. */
async function opReport({ tx, input, now }: Ctx): Promise<Outcome> {
  exact(input, ["code"]);
  const code = S.normalizeCode(input.code);
  if (!code) return INVALID_CODE();
  const found = await tx.supportInvite.findUnique({ where: { codeHash: sha(code) } });
  if (!found) return INVALID_CODE();
  const inv = await settleInvite(tx, found, now);
  if (!S.redeemable(inv, now)) return INVALID_CODE();
  await applyInvite(tx, inv, { status: "reported", closedAt: now });
  await tx.supportReport.create({ data: { accountId: inv.accountId, inviteId: inv.id, via: "page", createdAt: now } });
  await audit(tx, inv.accountId, "support.reported", { inviteId: inv.id, via: "page" });
  await mirror(tx, inv, "starter", `The support code for ${inv.forName} was reported as unrequested ("I didn't ask for this") and no longer works.`, now);
  const issuer = await issuerOf(tx, inv.accountId);
  return { body: { reported: true, message: `Thank you. This code no longer works, nothing happened on your computer, and ${issuer.name} can see that you reported it.` } };
}

async function opClientGet({ tx, caller, now }: Ctx): Promise<Outcome> {
  const s = await clientSession(tx, caller, now);
  const issuer = await issuerOf(tx, s.accountId);
  return { body: { session: S.helpedView(s, { now, issuer }), steps: (await stepsOf(tx, s)).map((r) => stepView(r, "helped")) } };
}

/** The signed Allow, on the helped person's own screen. Nothing can act before it. Idempotent. */
async function opAllow({ tx, caller, input, now }: Ctx): Promise<Outcome> {
  exact(input, ["proof"]);
  const s = await clientSession(tx, caller, now);
  if (!P.proofValid(s.supportKeySpki ?? "", S.allowMessage(s.id), input.proof)) fail(400, "invalid_proof", "Allow is signed with the helper's key: \"bc-support-allow-v1:<sessionId>\".");
  const issuer = await issuerOf(tx, s.accountId);
  if (S.allowCheck(s, now) === "already") return { body: { session: S.helpedView(s, { now, issuer }) } };
  await issuerReady(tx, s.accountId, now, true);
  if ((await liveSupport(tx, s.accountId, now, s.id)).some((x) => x.status === "active")) {
    fail(409, "issuer_busy", "The person helping you is in another support session right now. Try again in a few minutes.");
  }
  const next = await applySession(tx, s, S.allowPatch(s, now));
  const inv = await inviteOfSession(tx, s);
  await audit(tx, s.accountId, "support.allowed", { inviteId: inv.id, sessionId: s.id, minutes: s.minutes });
  await mirror(tx, inv, "starter", `${inv.forName} pressed Allow on their computer: the support session runs for up to ${s.minutes} minutes.`, now);
  return { body: { session: S.helpedView(next, { now, issuer }) } };
}

/** Stop on the helped person's screen. Before Allow it is a no. Final; the relay lease goes with it. Idempotent. */
async function opClientStop({ tx, caller, now }: Ctx): Promise<Outcome> {
  const s = await clientSession(tx, caller, now);
  const patch = S.stopPatch(s, "helped", now);
  let current = s;
  if (patch) {
    current = await applySession(tx, s, patch);
    const inv = await inviteOfSession(tx, s);
    await audit(tx, s.accountId, "support.stopped", { inviteId: inv.id, sessionId: s.id, by: "helped" });
    await mirrorTranscript(tx, inv, current, now);
  }
  return { body: { session: S.helpedView(current, { now, issuer: await issuerOf(tx, s.accountId) }) } };
}

/** "I didn't ask for this" in the temporary client: ends the session, marks the code reported, files a report. Idempotent. */
async function opClientReport({ tx, caller, now }: Ctx): Promise<Outcome> {
  const s = await clientSession(tx, caller, now);
  const issuer = await issuerOf(tx, s.accountId);
  const message = `Thank you. It's been cancelled, and ${issuer.name} can see that you reported it.`;
  if (await tx.supportReport.findFirst({ where: { sessionId: s.id, via: "helper" } })) {
    return { body: { reported: true, message, session: S.helpedView(s, { now, issuer }) } };
  }
  const inv = await inviteOfSession(tx, s);
  const patch = S.stopPatch(s, "report", now);
  const current = patch ? await applySession(tx, s, patch) : s;
  if (inv.status === "redeemed") await applyInvite(tx, inv, { status: "reported" });
  await tx.supportReport.create({ data: { accountId: s.accountId, inviteId: inv.id, sessionId: s.id, via: "helper", createdAt: now } });
  await audit(tx, s.accountId, "support.reported", { inviteId: inv.id, sessionId: s.id, via: "helper" });
  await mirrorTranscript(tx, inv, current, now);
  return { body: { reported: true, message, session: S.helpedView(current, { now, issuer }) } };
}

/** One step, reported by the temporary client: fixed kinds, view-first. */
async function opStep({ tx, caller, input, now }: Ctx): Promise<Outcome> {
  const s = await clientSession(tx, caller, now);
  const step = S.parseStep(input);
  S.stepCheck(s, now, await tx.remoteAppActionLog.count({ where: { sessionId: s.id } }));
  const row = await tx.remoteAppActionLog.create({ data: { sessionId: s.id, at: now, action: step.action, target: step.target, outcome: step.outcome, evidenceRef: null } });
  return { body: { recorded: true, step: stepView(row, "helped") } };
}

/**
 * The signed removal receipt: "removed", "in_memory" or "unconfirmed". If the session is still going, the helper
 * leaving ends it first. Once per session (the same receipt again is a no-op).
 */
async function opReceipt({ tx, caller, input, now }: Ctx): Promise<Outcome> {
  exact(input, ["removal", "proof"]);
  const s = await clientSession(tx, caller, now);
  const removal = typeof input.removal === "string" ? input.removal : "";
  const what = S.receiptCheck(s, removal);
  if (!P.proofValid(s.supportKeySpki ?? "", S.receiptMessage(s.id, removal), input.proof)) {
    fail(400, "invalid_proof", "The removal receipt is signed with the helper's key: \"bc-support-receipt-v1:<sessionId>:<removal>\".");
  }
  let current = s;
  if (what === "record") {
    const inv = await inviteOfSession(tx, s);
    const stop = S.stopPatch(s, "helped", now);
    if (stop) {
      current = await applySession(tx, s, stop);
      await audit(tx, s.accountId, "support.stopped", { inviteId: inv.id, sessionId: s.id, by: "helped" });
    }
    await tx.remoteAppSession.update({ where: { id: s.id }, data: { removal, removalAt: now } });
    current = { ...current, removal, removalAt: now };
    await audit(tx, s.accountId, "support.removal", { inviteId: inv.id, sessionId: s.id, removal });
    await mirror(tx, inv, "starter", stop ? (await transcriptFor(tx, current, "issuer", now)).text : S.removalText(current, "issuer")!, now);
  }
  return {
    body: {
      removal: { kind: current.removal, at: iso(current.removalAt), text: S.removalText(current, "helped") },
      transcript: await transcriptFor(tx, current, "helped", now),
    },
  };
}

async function opTranscript({ tx, caller, now }: Ctx): Promise<Outcome> {
  const s = await clientSession(tx, caller, now);
  return { body: { transcript: await transcriptFor(tx, s, "helped", now) } };
}

const OPS: Record<Op, (ctx: Ctx) => Promise<Outcome>> = {
  request: opRequest, list: opList, get: opGet, end: opEnd, approve: opApprove, deny: opDeny, void: opVoid, stop: opStop,
  redeem: opRedeem, report: opReport, clientGet: opClientGet, allow: opAllow, clientReport: opClientReport, clientStop: opClientStop,
  step: opStep, receipt: opReceipt, transcript: opTranscript,
};

/** Run one operation for whoever is calling. Shared by the REST route and the MCP tools. */
async function run(req: NextRequest, op: Op, input: Input | (() => Promise<Input>), id?: string): Promise<NextResponse> {
  const limited = (retryAfterSec: number) => {
    const res = respond({ error: "rate_limited", message: "Too many requests. Wait a moment and retry." }, 429);
    res.headers.set("Retry-After", String(retryAfterSec));
    return res;
  };
  try {
    if (PUBLIC.has(op)) {
      const budget = limits.rateLimitPeek("support:public-failed", "all", PUBLIC_FAILURES);
      if (!budget.ok) return limited(budget.retryAfterSec);
    }
    const caller = await resolveCaller(req, op);
    if (caller.kind !== "public") {
      const key = caller.kind === "agent" ? caller.agentId : caller.kind === "client" ? caller.sessionId : caller.accountId;
      const write = WRITES.has(op);
      const r = limits.rateLimit(write ? "support:write" : "support:read", key, write ? 60 : 240, 60_000);
      if (!r.ok) return limited(r.retryAfterSec);
      // Requests: at most REQUESTS_PER_HOUR per agent; only one that created a request spends it.
      if (op === "request") {
        const peek = limits.rateLimitPeek("support:request", key, REQUESTS_PER_HOUR);
        if (!peek.ok) return limited(peek.retryAfterSec);
      }
    }
    const body = typeof input === "function" ? await input() : input;
    const origin = (process.env.PUBLIC_APP_URL ?? new URL(req.url).origin).replace(/\/$/, "");
    const result = await withSerializableRetry(
      () => prisma.$transaction(async (tx: Tx): Promise<Outcome | { refusal: InstanceType<typeof R.RemoteRuleError> }> => {
        try {
          return await OPS[op]({ tx, caller, input: body, now: new Date(), id, origin });
        } catch (e) {
          if (e instanceof R.RemoteRuleError && !(e instanceof RollBack)) return { refusal: e };
          throw e;
        }
      }, { isolationLevel: "Serializable" }),
      { retryable: conflict },
    );
    if ("refusal" in result) throw result.refusal;
    if (op === "request" && caller.kind === "agent") limits.rateLimit("support:request", caller.agentId, REQUESTS_PER_HOUR, 60 * 60_000);
    return respond(result.body, result.status ?? 200);
  } catch (e) {
    if (e instanceof R.RemoteRuleError) {
      if (PUBLIC.has(op) && e.status < 500 && e.status !== 429) limits.rateLimit("support:public-failed", "all", PUBLIC_FAILURES, 60_000);
      return respond({ error: e.code, message: e.message, ...(e.extra ?? {}) }, e.status);
    }
    if (conflict(e)) {
      const res = respond({ error: "busy", message: "Someone else was changing this at the same moment. Retry.", retryable: true }, 503);
      res.headers.set("Retry-After", "1");
      return res;
    }
    // Never log bodies, codes, credentials, task text or keys.
    console.error(`[remote-support] ${op} failed:`, e instanceof Error ? e.name : typeof e);
    return respond({ error: "unavailable", message: "Support is unavailable right now. Try again shortly." }, 503);
  }
}

// ── REST: /api/support/... ─────────────────────────────────────────────────

async function readJson(req: NextRequest): Promise<Input> {
  if (Number(req.headers.get("content-length")) > MAX_BODY) fail(413, "too_large", "Request too large");
  const text = await req.text();
  if (!text) return {};
  if (text.length > MAX_BODY) fail(413, "too_large", "Request too large");
  let body: unknown;
  try { body = JSON.parse(text); } catch { return fail(400, "invalid_json", "Send a JSON object."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) fail(400, "invalid_json", "Send a JSON object.");
  return body as Input;
}

/**
 * Map a REST request onto an operation.
 *   POST /api/support/invites                  request       agent (full-scope key)
 *   GET  /api/support/invites                  list          agent (its own) or person (the dashboard card)
 *   GET  /api/support/invites/:id              get           the agent that asked, or the person
 *   POST /api/support/invites/:id/end          end           the agent that asked { finished? }
 *   POST /api/support/invites/:id/approve      approve       person (owner): mints the code, shown once
 *   POST /api/support/invites/:id/deny         deny          person
 *   POST /api/support/invites/:id/void         void          person: an unused code stops working
 *   POST /api/support/invites/:id/stop         stop          person: ends the running session
 *   POST /api/support/redeem                   redeem        the temporary client { code, keySpki, proof }
 *   POST /api/support/report                   report        the landing page { code }: "I didn't ask for this"
 *   GET  /api/support/client/session           clientGet     the temporary client (abs_ credential)
 *   POST /api/support/client/allow             allow         the temporary client { proof }
 *   POST /api/support/client/stop              clientStop    the temporary client
 *   POST /api/support/client/report            clientReport  the temporary client: "I didn't ask for this"
 *   POST /api/support/client/actions           step          the temporary client { action, target?, outcome, confirmed? }
 *   POST /api/support/client/receipt           receipt       the temporary client { removal, proof }
 *   GET  /api/support/client/transcript        transcript    the temporary client
 */
export async function supportRoute(req: NextRequest, path: string[]): Promise<NextResponse> {
  const m = req.method;
  const [a, b, c, extra] = path;
  const body = () => readJson(req);
  let route: [Op, Input | (() => Promise<Input>), string?] | null = null;
  if (extra === undefined) {
    if (a === "invites" && !b) route = m === "GET" ? ["list", {}] : m === "POST" ? ["request", body] : null;
    else if (a === "invites" && b && !c && m === "GET") route = ["get", {}, b];
    else if (a === "invites" && b && c && m === "POST") {
      const op = ({ end: "end", approve: "approve", deny: "deny", void: "void", stop: "stop" } as Record<string, Op>)[c];
      if (op) route = [op, op === "end" ? body : {}, b];
    } else if ((a === "redeem" || a === "report") && !b && m === "POST") route = [a, body];
    else if (a === "client" && b && !c) {
      const get = ({ session: "clientGet", transcript: "transcript" } as Record<string, Op>)[b];
      const post = ({ allow: "allow", stop: "clientStop", report: "clientReport", actions: "step", receipt: "receipt" } as Record<string, Op>)[b];
      if (m === "GET" && get) route = [get, {}];
      else if (m === "POST" && post) route = [post, body];
    }
  }
  if (!route) return respond({ error: "not_found", message: "No such support endpoint." }, 404);
  return run(req, route[0], route[1], route[2]);
}

// ── MCP: bc_support_* (catalog in src/lib/mcp/remote-tools.mjs) ─────────────

const TOOL_NAMES = new Set<string>(SUPPORT_TOOL_NAMES);
export function isSupportTool(name: string): boolean {
  return TOOL_NAMES.has(name);
}

/** One bc_support_* tool call: the same operations and rules as /api/support, with the caller's own key. */
export async function supportTool(req: NextRequest, name: string, args: Input): Promise<{ status: number; text: string }> {
  const id = typeof args.support_id === "string" ? args.support_id.trim() : undefined;
  let res: NextResponse;
  switch (name) {
    case "bc_support_invite":
      res = await run(req, "request", { for: args.for, task: args.task, minutes: args.minutes, taskId: args.task_id });
      break;
    case "bc_support_status":
      res = await run(req, "get", {}, id);
      break;
    default:
      res = await run(req, "end", { finished: args.finished }, id);
  }
  return { status: res.status, text: await res.text() };
}

// ── The landing page (src/app/support/[code]/page.tsx) ──────────────────────

export type SupportCodePage = { code: string; issuer: { name: string; handle: string }; task: string; minutes: number; expiresAt: string };

/**
 * What the landing page may show a holder of this code: who is asking (as the broker asserts it), the task, the
 * cap and when the code stops working. null for every code that can't be redeemed right now (unknown, mistyped,
 * used, cancelled, reported, expired), so nothing tells those apart. Read-only; spends the public failure budget
 * on a miss, like redeem.
 */
export async function supportCodeForPage(raw: string): Promise<SupportCodePage | null> {
  if (!limits.rateLimitPeek("support:public-failed", "all", PUBLIC_FAILURES).ok) return null;
  const miss = () => { limits.rateLimit("support:public-failed", "all", PUBLIC_FAILURES, 60_000); return null; };
  const code = S.normalizeCode(raw);
  if (!code) return miss();
  const now = new Date();
  const inv = await prisma.supportInvite.findUnique({ where: { codeHash: sha(code) } });
  if (!inv || !S.redeemable(inv, now)) return miss();
  const account = await prisma.account.findUnique({ where: { id: inv.accountId } });
  if (!account) return miss();
  return { code, issuer: S.issuerIdentity(account), task: inv.task, minutes: inv.minutes, expiresAt: inv.codeExpiresAt!.toISOString() };
}

/** The helper's download, only when Skylar has published a signed build (SUPPORT_CLIENT_URL, https only). */
export function supportClientUrl(): string | null {
  const raw = (process.env.SUPPORT_CLIENT_URL ?? "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}
