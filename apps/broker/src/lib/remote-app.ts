/**
 * Remote app sessions: an agent uses an app on one of its person's own PCs (docs/remote-app-sessions.md).
 *
 * The I/O half. Every decision (states, consent expiry, the minutes cap, the allow-list, fail closed,
 * one session per account, fixed phrases) lives in remote-app/rules.mjs, which has no database and is
 * covered by `node --test`. This file authenticates, loads rows, asks the rules, writes, and shapes
 * responses, every operation in one serializable transaction re-run whole on a conflict.
 *
 * Callers:
 *  - REST: src/app/api/remote-app/[[...path]]/route.ts -> remoteAppRoute()
 *  - MCP:  src/app/api/mcp/route.ts -> remoteTool() for the bc_remote_* tools (catalog: mcp/remote-tools.mjs)
 *  - The PC: src/lib/remote-app-host.ts, for the ab_-credential routes under /api/appbridge/v1/hosts/self
 *
 * Who may do what:
 *  - Agents: a FULL-SCOPE per-agent key only. A connector key (claude.ai, ChatGPT over OAuth) is refused,
 *    exactly like Dispatch: it lives on a hosted app's servers and has no business driving a PC.
 *  - Approve, deny, "go on" and Stop all: the person, in the dashboard (cookie + CSRF). A request that
 *    carries any bearer key is refused before anything else, so no agent can approve its own session.
 *    Approve also needs the person's passkey step-up for that session (src/lib/step-up.ts): an agent driving
 *    the PC, whose browser is signed in, can't complete a passkey prompt. Deny is never gated.
 *  - Stop: the person, the agent that asked, the agent driving, or the PC itself (remote-app-host.ts).
 *  - Steps (action reports): the agent driving the session only, with its own full-scope key.
 *
 * Every transition away from "active" deletes the session's "agent" relay leases in the same transaction
 * (the revokeInTx pattern in appbridge.ts), so the relay's next renewal is a 404 and the PC's agent
 * connection ends within about a minute. appbridge.ts is deliberately not imported here: it named-imports
 * from @/lib/auth, which route tests of the MCP route replace wholesale.
 *
 * Content-blind by construction: the broker stores fixed action kinds, a bounded control or app name, an
 * outcome and a pointer into the PC's own evidence store. Never screen content, typed text or a screenshot.
 *
 * Desktop scope (vault design agent-desktop-scope.md, decided 2026-10-10): every new agent session may use the whole
 * PC under the rails, and its apps are only what it expects to use. Sessions from before stay "apps" scope. The PC's
 * sessions list (sessionsForHost) carries `scope` only to an AppBridge that understands it (1.1.33, agent-control v1.2).
 *
 * The executor secret (agent-control v1.1, the support relay path contract §5): every session is born with a
 * secret's hash (the raw value is discarded). The executor (executorAgentId, or the agent that asked when it drives
 * itself) is handed a fresh value ONCE, in its first GET /sessions/{id} while the session runs, and sends it in the
 * hello on the PC's agent-control pipe; the PC reads the hash from GET /hosts/self/agent-sessions. A lost reply is
 * recovered by POST /sessions/{id}/executor-secret (the executor only). A session with no hash predates v1.1: it never
 * gets one, and its PC asks for none.
 */
import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import type { AgentToken, AppBridgeDevice, Prisma, RemoteAppSession } from "@prisma/client";
import { prisma } from "@/lib/db";
// Namespace import on purpose (see lists.ts): route tests replace @/lib/auth with a few named exports.
import * as auth from "@/lib/auth";
import { hasFullScope } from "@/lib/agent-scope";
// Namespace import: route tests stub @/lib/rate-limit with only some exports; a named import of one
// they left out would fail at link time for every module that loads this one (the MCP route does).
import * as limits from "@/lib/rate-limit";
import { isSerializationFailure, withSerializableRetry } from "@/lib/serializable";
import { remoteAccessSource } from "@/lib/remote-entitlement";
import { listsInTx } from "@/lib/lists";
import { AsyncLocalStorage } from "node:async_hooks";
// Effects a Lists operation owes (doorbells, email) collected per transaction attempt and run only after it commits.
const effects = new AsyncLocalStorage<Array<() => void>>();
import { REMOTE_TOOL_NAMES } from "@/lib/mcp/remote-tools.mjs";
// Remote support (bc_support_*, docs/remote-support.md) shares the bc_remote_* gating and is dispatched from remoteTool().
import { isSupportTool, supportTool } from "@/lib/remote-support";
import * as R from "@/lib/remote-app/rules.mjs";
// PC readiness for agents (the worker's reports, the six-step checklist): docs/remote-app-sessions.md, "Setting up a PC".
import * as RD from "@/lib/remote-app/readiness.mjs";
// The passkey step-up on approval (docs/remote-app-sessions.md, "Approvals need a passkey").
import * as SU from "@/lib/step-up";

type Tx = Prisma.TransactionClient;
type Input = Record<string, unknown>;
type Session = RemoteAppSession;
type Patch = Prisma.RemoteAppSessionUpdateManyMutationInput;
/** agentId null: the person, signed in to the dashboard. */
type Caller = { accountId: string; agentId: string | null };
type Op = "machines" | "readiness" | "start" | "list" | "get" | "approve" | "deny" | "resume" | "stop" | "stopAll" | "report" | "end" | "surface" | "rotate";
// viaTool: the request came through an MCP tool (a chat), never the executor's own worker.
// stepUp: the person's passkey step-up grant (the x-bc-step-up header), for approve only.
type Ctx = { tx: Tx; caller: Caller; input: Input; now: Date; id?: string; origin: string; viaTool?: boolean; stepUp?: string | null };
type Outcome = { status?: number; body: Record<string, unknown> };

const PEOPLE_ONLY = new Set<Op>(["approve", "deny", "resume", "stopAll", "readiness"]);
const AGENTS_ONLY = new Set<Op>(["start", "report", "end", "surface", "rotate"]);
const WRITES = new Set<Op>(["start", "approve", "deny", "resume", "stop", "stopAll", "report", "end", "rotate"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86_400_000;
const MAX_BODY = 16 * 1024;
const START_PER_HOUR = 10;

const fail = (status: number, code: string, message: string, extra?: Record<string, unknown>): never => {
  throw new R.RemoteRuleError(status, code, message, extra);
};
/**
 * A refusal is an answer: run() returns it as a value from inside the transaction, so what time alone did
 * (a request that lapsed, a session that ran out, written by settleInTx before the check) still commits.
 * Every operation checks before it writes. The one exception is this: a guard that failed after a write,
 * which must roll the whole attempt back.
 */
class RollBack extends R.RemoteRuleError {}
const NOT_FOUND = () => fail(404, "not_found", "That remote session isn't available.");
const respond = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
const conflict = (e: unknown) => isSerializationFailure(e) || (!!e && typeof e === "object" && "code" in e && (e as { code?: unknown }).code === "P2002");
const pcName = (d: Pick<AppBridgeDevice, "id" | "label"> | null | undefined, id?: string) => d?.label?.trim() || `PC ${(d?.id ?? id ?? "").slice(0, 6)}`;
const appList = R.appList;
/** "Expects to use Notepad." for a desktop session that named apps; nothing otherwise. */
const expects = (s: Pick<Session, "scope" | "appAllowList">) => (R.scopeOf(s) === "desktop" && s.appAllowList.length ? ` Expects to use ${appList(s.appAllowList)}.` : "");

// ── auth ────────────────────────────────────────────────────────────────────

async function resolveCaller(req: NextRequest, op: Op): Promise<Caller> {
  const authorization = req.headers.get("authorization");
  if (authorization) {
    // A bearer key is an agent, whatever cookie rides along: approving is a person's act, in the browser.
    if (PEOPLE_ONLY.has(op)) {
      fail(403, "people_only", op === "readiness"
        ? "This is the dashboard's view of your person's PCs. Agents get each PC's readiness from bc_remote_machines."
        : "Only your person can do this, signed in to the Back Channel dashboard. An agent never approves its own session.");
    }
    const ctx = await auth.getAuthContext(authorization);
    if (!ctx) return fail(401, "unauthorized", "Unauthorized");
    if (!ctx.agentTokenId) fail(401, "agent_key_required", "Remote app sessions need a per-agent key. Connect this agent from the Back Channel dashboard.");
    if (!hasFullScope(ctx)) {
      fail(403, "not_available_to_connectors", "Remote app sessions need a full agent key. A hosted connector (claude.ai, ChatGPT) can't use apps on your PCs; use an agent that runs on one of your own machines.");
    }
    return { accountId: ctx.account.id, agentId: ctx.agentTokenId };
  }
  if (AGENTS_ONLY.has(op)) fail(401, "agent_key_required", "This is for agents, with their own key.");
  const account = await auth.getAccountFromCookie(req.cookies?.get(auth.SESSION_COOKIE_NAME)?.value);
  if (!account) return fail(401, "unauthorized", "Unauthorized");
  if (WRITES.has(op) && !auth.csrfValid(req.headers.get(auth.CSRF_HEADER), req.cookies.get(auth.CSRF_COOKIE_NAME)?.value)) {
    fail(403, "csrf", "Refresh the page and try again.");
  }
  return { accountId: account.id, agentId: null };
}

/** The calling agent, read again inside the transaction: live, same account, full scope. */
async function liveAgent(tx: Tx, caller: Caller): Promise<AgentToken> {
  if (!caller.agentId) return fail(401, "agent_key_required", "This is for agents, with their own key.");
  const a = await tx.agentToken.findFirst({ where: { id: caller.agentId, accountId: caller.accountId, revokedAt: null } });
  if (!a) return fail(401, "agent_revoked", "This agent's key has been revoked.");
  if (a.scope !== "full") fail(403, "not_available_to_connectors", "Remote app sessions need a full agent key.");
  return a;
}

// ── sessions ────────────────────────────────────────────────────────────────

/** Write what time alone has done to a session (a request lapsed, a session ran out), and return the row. */
async function settleInTx(tx: Tx, s: Session, now: Date): Promise<Session> {
  const patch = R.settle(s, now);
  if (!patch) return s;
  const won = await tx.remoteAppSession.updateMany({ where: { id: s.id, status: s.status }, data: patch as Patch });
  if (won.count === 1) await tx.appBridgeLease.deleteMany({ where: { remoteAppSessionId: s.id } });
  return (await tx.remoteAppSession.findFirst({ where: { id: s.id } }))!;
}

/**
 * One session the caller may see: the person sees every one in the account; an agent, the ones it asked for or
 * drives. Agent sessions only: a support session (kind "support") lives behind /api/support, never here.
 */
async function loadSession(tx: Tx, caller: Caller, id: unknown, now: Date): Promise<Session> {
  if (typeof id !== "string" || !UUID.test(id)) return NOT_FOUND();
  const s = await tx.remoteAppSession.findFirst({ where: { id, accountId: caller.accountId, kind: "agent" } });
  if (!s) return NOT_FOUND();
  if (caller.agentId && caller.agentId !== s.agentTokenId && caller.agentId !== R.executorOf(s)) return NOT_FOUND();
  return settleInTx(tx, s, now);
}

/**
 * Move a session on, guarded by the status it was read with. Leaving "active" for anything (paused, stopped,
 * ended, denied) deletes its agent leases in this same transaction: the PC's next renewal is a 404.
 */
async function apply(tx: Tx, s: Session, patch: Record<string, unknown>): Promise<Session> {
  const won = await tx.remoteAppSession.updateMany({ where: { id: s.id, status: s.status }, data: patch as Patch });
  if (won.count !== 1) throw new RollBack(409, "changed", "This session changed at the same moment. Read it again and retry.");
  if (patch.status !== "active") await tx.appBridgeLease.deleteMany({ where: { remoteAppSessionId: s.id } });
  return { ...s, ...patch } as Session;
}

async function audit(tx: Tx, accountId: string, eventType: string, detail: Record<string, unknown>) {
  await tx.accountAudit.create({ data: { accountId, eventType, detail: detail as Prisma.InputJsonValue } });
}

/**
 * Mirror a line into the session's Lists task as a progress entry: as the person, or as the agent that asked
 * (it holds the claim, and its progress keeps the claim alive). Best effort: a Lists refusal (the claim moved,
 * the task is full, access was withdrawn) is reported back, never fatal to the session's own write.
 */
async function mirror(tx: Tx, s: Session, by: "person" | "starter", text: string, now: Date): Promise<boolean> {
  if (!s.listTaskId) return false;
  const as = { accountId: s.accountId, agentId: by === "person" ? null : s.agentTokenId };
  const r = await listsInTx(tx, as, "addEntry", { task_id: s.listTaskId, kind: "progress", text }, now, effects.getStore());
  return r.ok;
}

type Names = { pcs: Map<string, AppBridgeDevice>; agents: Map<string, { name: string }>; tasks: Map<string, { id: string; title: string }> };
async function names(tx: Tx, sessions: Session[]): Promise<Names> {
  const hostIds = [...new Set(sessions.map((s) => s.hostDeviceId))];
  const agentIds = [...new Set(sessions.flatMap((s) => [s.agentTokenId, R.executorOf(s)]))];
  const taskIds = [...new Set(sessions.map((s) => s.listTaskId).filter((t): t is string => !!t))];
  const [pcs, agents, tasks] = await Promise.all([
    hostIds.length ? tx.appBridgeDevice.findMany({ where: { id: { in: hostIds } } }) : [],
    agentIds.length ? tx.agentToken.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true } }) : [],
    taskIds.length ? tx.taskItem.findMany({ where: { id: { in: taskIds } }, select: { id: true, title: true } }) : [],
  ]);
  return {
    pcs: new Map(pcs.map((d) => [d.id, d])),
    agents: new Map(agents.map((a) => [a.id, { name: a.name || "agent" }])),
    tasks: new Map(tasks.map((t) => [t.id, t])),
  };
}

async function pausedBecause(tx: Tx, s: Session): Promise<string | null> {
  if (s.status !== "blocked") return null;
  const last = await tx.remoteAppActionLog.findFirst({ where: { sessionId: s.id, outcome: { not: "ok" } }, orderBy: [{ at: "desc" }, { id: "desc" }] });
  return last ? R.outcomePhrase(last.outcome, R.scopeOf(s)) : null;
}

async function view(tx: Tx, s: Session, n: Names, now: Date) {
  const agent = (id: string) => n.agents.get(id)?.name ?? "a removed agent";
  return R.sessionView(s, {
    now,
    pc: pcName(n.pcs.get(s.hostDeviceId), s.hostDeviceId),
    startedBy: agent(s.agentTokenId),
    drivenBy: agent(R.executorOf(s)),
    task: s.listTaskId ? n.tasks.get(s.listTaskId) ?? null : null,
    pausedBecause: await pausedBecause(tx, s),
  });
}

async function actions(tx: Tx, s: Session, take: number, pc?: string) {
  const rows = await tx.remoteAppActionLog.findMany({ where: { sessionId: s.id }, orderBy: [{ at: "desc" }, { id: "desc" }], take });
  return rows.reverse().map((r) => R.actionView(r, { pc, scope: R.scopeOf(s) }));
}

/**
 * Hand out the session's executor secret: a fresh value whose hash replaces the stored one (the one the session was
 * born with, or the last one handed out), returned to the caller and never kept. Guarded by the hash it was read with.
 */
async function handOutExecutorSecret(tx: Tx, s: Session, now: Date): Promise<string> {
  const { secret, hash } = R.newExecutorSecret(randomBytes(32));
  const won = await tx.remoteAppSession.updateMany({ where: { id: s.id, status: s.status, executorSecretHash: s.executorSecretHash }, data: R.executorSecretPatch(hash, now) });
  if (won.count !== 1) throw new RollBack(409, "changed", "This session changed at the same moment. Read it again and retry.");
  return secret;
}

function roleOf(caller: Caller, s: Session) {
  const role: "starter" | "driver" = caller.agentId === s.agentTokenId ? "starter" : "driver";
  return { role, sameAgent: !s.executorAgentId || s.executorAgentId === s.agentTokenId };
}

// ── checks shared by start and approve ──────────────────────────────────────

/**
 * Can this PC take an agent session at all? The same conditions the relay gate (appbridge.ts gate()) reads
 * for the PC's "agent" lease, asked up front so a request that could never run says why. The gate stays the
 * authority: it re-reads all of them, and the session, at every pass, redemption and renewal.
 */
async function pcReady(tx: Tx, accountId: string, host: AppBridgeDevice, now: Date) {
  if (process.env.APPBRIDGE_REMOTE_ACCESS !== "on") fail(403, "rollout_off", "Back Channel Remote is switched off for now, so no agent session can start.");
  if (!(await remoteAccessSource(tx, accountId, now))) {
    fail(403, "not_entitled", "Remote app sessions need Back Channel Remote on this account. Your person can turn it on from the Remote page of the dashboard.");
  }
  if (host.revokedAt || !host.enabled || host.role !== "host") fail(409, "pc_unavailable", `${pcName(host)} is no longer available in Back Channel Remote.`);
  if (!host.relayEnabled) fail(409, "internet_access_off", `Internet access is off on ${pcName(host)}. Your person can turn it on in Back Channel Remote on that PC.`);
}

async function resolveHost(tx: Tx, accountId: string, value: string): Promise<AppBridgeDevice> {
  const hosts = await tx.appBridgeDevice.findMany({ where: { accountId, role: "host", revokedAt: null }, orderBy: { createdAt: "asc" }, take: 50 });
  const byId = hosts.find((h) => h.id === value);
  if (byId) return byId;
  const want = value.trim().toLowerCase();
  const named = hosts.filter((h) => pcName(h).toLowerCase() === want);
  if (named.length === 1) return named[0];
  if (named.length > 1) return fail(409, "ambiguous_pc", `More than one PC is called "${value}". Use its id from bc_remote_machines.`);
  return fail(404, "no_such_pc", `No PC called "${value}". Your PCs: ${hosts.map((h) => pcName(h)).join(", ") || "none registered yet"}. See bc_remote_machines.`);
}

/** The agent on the PC that will drive the app: one of the person's own live agents with a full key, reachable by Dispatch. */
async function resolveExecutor(tx: Tx, accountId: string, me: AgentToken, value: string): Promise<AgentToken> {
  const agents = await tx.agentToken.findMany({ where: { accountId, revokedAt: null }, orderBy: { createdAt: "asc" }, take: 200 });
  const want = value.trim().toLowerCase();
  let hit = agents.filter((a) => a.id === value);
  if (!hit.length) hit = agents.filter((a) => a.name.trim().toLowerCase() === want || (a.dispatchName ?? "").trim().toLowerCase() === want);
  if (hit.length !== 1) {
    return fail(hit.length ? 409 : 404, hit.length ? "ambiguous_executor" : "no_such_executor",
      hit.length ? `More than one of your agents is called "${value}". Use its id.` : `"${value}" isn't one of your person's connected agents.`);
  }
  const a = hit[0];
  if (a.scope !== "full") fail(400, "executor_not_allowed", `${a.name} is a hosted connector. Only an agent with a full key, running on one of your person's machines, can drive a PC.`);
  if (a.id !== me.id && !(a.dispatchEncryptionKey && a.dispatchSigningKey)) {
    fail(400, "executor_not_reachable", `${a.name} isn't set up for Dispatch, so the session can't be handed to it. Leave executor out to drive it yourself, or set that agent up as a Dispatch worker first.`);
  }
  return a;
}

/** A task named at start must be one this agent is on right now (bc_task_claim first). */
async function claimedTask(tx: Tx, caller: Caller, taskId: string, now: Date) {
  const r = await listsInTx(tx, { accountId: caller.accountId, agentId: caller.agentId }, "getTask", { task_id: taskId }, now, effects.getStore());
  if (!r.ok) return fail(r.code === "not_available" ? 404 : 409, r.code, r.message);
  const task = r.result.task as { id: string; title: string; claim?: { by?: { is_this_agent?: boolean } } | null };
  if (!task.claim?.by?.is_this_agent) {
    fail(409, "claim_first", "Claim the task first with bc_task_claim, then start the session with its task_id, so the task shows who is on it while the session runs.");
  }
  return { id: task.id, title: task.title };
}

/** Running and waiting sessions of the account, other than `except`, after time has had its say. */
async function liveOthers(tx: Tx, accountId: string, now: Date, statuses: readonly string[], except?: string): Promise<Session[]> {
  const rows = await tx.remoteAppSession.findMany({ where: { accountId, kind: "agent", status: { in: [...statuses] } } });
  const out: Session[] = [];
  for (const row of rows) {
    if (row.id === except) continue;
    const s = await settleInTx(tx, row, now);
    if (statuses.includes(s.status)) out.push(s);
  }
  return out;
}

// ── operations ──────────────────────────────────────────────────────────────

async function accessState(tx: Tx, accountId: string, now: Date) {
  if (process.env.APPBRIDGE_REMOTE_ACCESS !== "on") return "rollout_off";
  return (await remoteAccessSource(tx, accountId, now)) ? "available" : "not_entitled";
}

/**
 * PC readiness for agents: each of the account's live full-scope agents that is enrolled for Dispatch or has reported
 * readiness, with its key fingerprint (computed here from its Dispatch keys), its last report, the PC it reports from
 * (a best-effort name match, never a hard link) and the six-step checklist; and each registered PC no worker reports
 * from. The owner's "Agents on your PCs" card shows all of it; bc_remote_machines gives agents ready/missing.
 */
async function readinessOf(tx: Tx, accountId: string, now: Date) {
  const [agents, hosts] = await Promise.all([
    tx.agentToken.findMany({
      where: { accountId, revokedAt: null, scope: "full", OR: [{ dispatchEncryptionKey: { not: null }, dispatchSigningKey: { not: null } }, { readinessAt: { not: null } }] },
      orderBy: { createdAt: "asc" }, take: 100,
    }),
    tx.appBridgeDevice.findMany({ where: { accountId, role: "host", revokedAt: null }, orderBy: { createdAt: "asc" }, take: 50 }),
  ]);
  const pcs = hosts.map((h) => ({ hostDeviceId: h.id, name: pcName(h) }));
  const nameOf = new Map(agents.map((a) => [a.id, a.name || a.dispatchName || "agent"]));
  const matched = new Set<string>();
  const rows = agents.map((a) => {
    const report = RD.storedReadiness(a.readiness, a.id);
    const pc = report ? RD.matchPc(report.appbridge.hostName, pcs) : null;
    if (pc) matched.add(pc.hostDeviceId);
    const c = RD.checklist({ report, readinessAt: report ? a.readinessAt : null, now, pc });
    // The senders by the names the person gave those agents here (the PC never sends names).
    const readiness = report && { ...report, profiles: { remoteApp: { ...report.profiles.remoteApp,
      senders: report.profiles.remoteApp.senders.map((x) => ({ ...x, name: nameOf.get(x.agentId) ?? null })) } } };
    return {
      agentId: a.id, name: nameOf.get(a.id) as string, fingerprint: RD.fingerprint(a.dispatchSigningKey, a.dispatchEncryptionKey),
      readiness, readinessAt: report && a.readinessAt ? a.readinessAt.toISOString() : null, reporting: c.reporting,
      pc, reportsFrom: report?.appbridge.hostName ?? null, steps: c.steps, ready: c.ready, missing: c.missing,
    };
  });
  return { agents: rows, pcs: pcs.filter((p) => !matched.has(p.hostDeviceId)).map((p) => ({ ...p, ...RD.pcWithoutAgent() })) };
}

/** GET /api/remote-app/readiness: the dashboard's "Agents on your PCs" card (the person only). */
async function opReadiness({ tx, caller, now }: Ctx): Promise<Outcome> {
  const r = await readinessOf(tx, caller.accountId, now);
  return { body: { staleAfterMinutes: RD.STALE_MS / 60_000, agents: r.agents, pcs: r.pcs } };
}

async function opMachines({ tx, caller, now }: Ctx): Promise<Outcome> {
  const hosts = await tx.appBridgeDevice.findMany({ where: { accountId: caller.accountId, role: "host", revokedAt: null, enabled: true }, orderBy: { createdAt: "asc" }, take: 50 });
  const presence = hosts.length
    ? await tx.appBridgeLease.findMany({ where: { accountId: caller.accountId, purpose: "presence", expiresAt: { gt: now } }, select: { hostDeviceId: true } })
    : [];
  const online = new Set(presence.map((p) => p.hostDeviceId));
  const ready = await readinessOf(tx, caller.accountId, now);
  const brief = (a: (typeof ready.agents)[number]) => ({ agentId: a.agentId, name: a.name, ready: a.ready, missing: a.missing });
  return {
    body: {
      remoteAccess: await accessState(tx, caller.accountId, now),
      machines: hosts.map((h) => ({ hostDeviceId: h.id, name: pcName(h), online: online.has(h.id), internetAccess: h.relayEnabled, appsAvailable: null,
        agents: ready.agents.filter((a) => a.pc?.hostDeviceId === h.id).map(brief) })),
      // Every agent that could drive an app on a PC (enrolled for Dispatch), where it reports from, and what's missing.
      executors: ready.agents.filter((a) => a.fingerprint).map((a) => ({ ...brief(a), hostDeviceId: a.pc?.hostDeviceId ?? null, pc: a.pc?.name ?? null, reporting: a.reporting })),
      howToFix: RD.HOW_TO,
      note: "Back Channel never sees a PC's apps, so it can't list them (appsAvailable is null). An approved session may use the whole PC toward its goal, under the PC's rails " +
        "(no passwords; UAC, sign-in and the lock screen stay your person's; administrator windows are refused; every step is recorded); apps is optional, the ones you expect to use. " +
        "A PC needs internet access on to take an agent session. Each machine's agents are the Back Channel workers that report from it (matched by the PC's name). " +
        "To have an agent on the PC drive the app, name a ready one as executor in bc_remote_session_start. If none is ready, don't start a session: " +
        "tell your person what's missing, using howToFix for each missing step. They fix it on that PC in AppBridge → Agents, and the Remote page of the dashboard shows the same checklist.",
    },
  };
}

async function opStart({ tx, caller, input, now, origin }: Ctx): Promise<Outcome> {
  const me = await liveAgent(tx, caller);
  const p = R.parseStart(input);
  const host = await resolveHost(tx, caller.accountId, p.host);
  await pcReady(tx, caller.accountId, host, now);
  const executor = p.executor ? await resolveExecutor(tx, caller.accountId, me, p.executor) : me;
  const task = p.taskId ? await claimedTask(tx, caller, p.taskId, now) : null;
  R.startCheck((await liveOthers(tx, caller.accountId, now, R.LIVE)).length);
  const created = await tx.remoteAppSession.create({
    data: R.newSession({ accountId: caller.accountId, hostDeviceId: host.id, agentId: me.id, executorAgentId: executor.id, taskId: p.taskId, goal: p.goal, apps: p.apps, minutes: p.minutes,
      // v1.1: born with an executor secret's hash; nobody holds that value, so the PC admits no hello until the executor is handed its own.
      executorSecretHash: R.newExecutorSecret(randomBytes(32)).hash }),
  });
  // The one-tap approval link, built like bc_dashboard_link: a single-use, 15-minute sign-in for the person,
  // deep-linking to this request's card on the Remote page. Only its hash is stored.
  const raw = auth.generateViewToken();
  const linkExpiresAt = auth.viewTokenExpiry();
  await tx.viewToken.create({ data: { token: auth.hashToken(raw), accountId: caller.accountId, purpose: "account", expiresAt: linkExpiresAt } });
  await audit(tx, caller.accountId, "remote_app.requested", { sessionId: created.id, hostDeviceId: host.id, agentId: me.id });
  if (task) await mirror(tx, created, "starter", `Asked to use ${R.reachPhrase(created, pcName(host))} for ${p.minutes} minutes.${expects(created)} Waiting for approval.`, now);
  const v = await view(tx, created, await names(tx, [created]), now);
  return {
    body: {
      session: v,
      approvalUrl: `${origin}/account/remote?vt=${encodeURIComponent(raw)}&approve=${created.id}`,
      approvalUrlExpiresAt: linkExpiresAt.toISOString(),
      next: R.nextStep(v, roleOf(caller, created)),
    },
  };
}

async function opList({ tx, caller, now }: Ctx): Promise<Outcome> {
  if (caller.agentId) {
    const rows = await tx.remoteAppSession.findMany({
      where: { accountId: caller.accountId, kind: "agent", OR: [{ agentTokenId: caller.agentId }, { executorAgentId: caller.agentId }] }, orderBy: { createdAt: "desc" }, take: 20,
    });
    const settled: Session[] = [];
    for (const r of rows) settled.push(await settleInTx(tx, r, now));
    const n = await names(tx, settled);
    const sessions = [];
    for (const s of settled) sessions.push(await view(tx, s, n, now));
    return { body: { sessions } };
  }
  // The dashboard card: waiting for approval, running, and the last week's finished ones with their steps.
  const rows = await tx.remoteAppSession.findMany({
    where: { accountId: caller.accountId, kind: "agent", OR: [{ status: { in: [...R.LIVE] } }, { createdAt: { gt: new Date(now.getTime() - 7 * DAY) } }] },
    orderBy: { createdAt: "desc" }, take: 40,
  });
  const settled: Session[] = [];
  for (const r of rows) settled.push(await settleInTx(tx, r, now));
  const n = await names(tx, settled);
  const pending = []; const live = []; const recent = [];
  for (const s of settled) {
    const v = await view(tx, s, n, now);
    if (s.status === "awaiting_consent") pending.push(v);
    else if (R.RUNNING.includes(s.status)) live.push({ ...v, actions: await actions(tx, s, 20) });
    else if (recent.length < 20) recent.push({ ...v, actions: await actions(tx, s, 50) });
  }
  return { body: { pending, live, recent } };
}

async function opGet({ tx, caller, now, id, viaTool }: Ctx): Promise<Outcome> {
  const s = await loadSession(tx, caller, id, now);
  // v1.1: the executor secret, handed out once, to the executor only (never the agent that asked when another drives,
  // never the person), on its first read while the session runs. A v1 session (no hash) never gets one. Never through
  // bc_remote_session_status either: a tool reply lands in a chat transcript, so only the worker's own REST read gets it.
  const executorSecret = !viaTool && caller.agentId && caller.agentId === R.executorOf(s) && R.executorSecretDue(s, now) ? await handOutExecutorSecret(tx, s, now) : undefined;
  const n = await names(tx, [s]);
  const v = { ...(await view(tx, s, n, now)), ...(executorSecret ? { executorSecret } : {}) };
  return { body: { session: v, actions: await actions(tx, s, 50), ...(caller.agentId ? { next: R.nextStep(v, roleOf(caller, s)) } : {}) } };
}

/**
 * The executor lost the reply that carried its executor secret: a fresh one, in this response only, and the old one
 * stops working (the PC reads the new hash from GET /hosts/self/agent-sessions). The executor only, while the session
 * runs, and never for a v1 session. Audited, without the secret.
 */
async function opRotate({ tx, caller, now, id }: Ctx): Promise<Outcome> {
  const s = await loadSession(tx, caller, id, now);
  if (caller.agentId !== R.executorOf(s)) fail(403, "not_driver", "Only the agent driving this session holds its executor secret.");
  await liveAgent(tx, caller);
  R.executorSecretRotateCheck(s, now);
  const executorSecret = await handOutExecutorSecret(tx, s, now);
  await audit(tx, s.accountId, "remote_app.executor_secret_rotated", { sessionId: s.id });
  const v = { ...(await view(tx, s, await names(tx, [s]), now)), executorSecret };
  return { body: { session: v, next: R.nextStep(v, roleOf(caller, s)) } };
}

async function opApprove({ tx, caller, now, id, stepUp }: Ctx): Promise<Outcome> {
  const s = await loadSession(tx, caller, id, now);
  R.decideCheck(s, now);
  if ((await liveOthers(tx, caller.accountId, now, R.RUNNING, s.id)).length) {
    fail(409, "session_in_progress", "Another agent session is running on this account. Stop it first; one runs at a time.");
  }
  const host = await tx.appBridgeDevice.findFirst({ where: { id: s.hostDeviceId, accountId: caller.accountId } });
  if (!host) fail(409, "pc_unavailable", "That PC is no longer registered. Deny this request.");
  await pcReady(tx, caller.accountId, host!, now);
  const agents = await tx.agentToken.findMany({ where: { id: { in: [s.agentTokenId, R.executorOf(s)] } }, select: { id: true, accountId: true, revokedAt: true, scope: true } });
  if (!R.agentsAdmit(s, agents)) fail(409, "agent_unavailable", "The agent that asked, or the one that would drive the app, has been removed or can no longer use your PCs. Deny this request.");
  // Last: the person's passkey, for this session only. A request refused above never spends a grant, and the grant is
  // spent in this transaction, so it rolls back with it.
  const refusal = await SU.requireStepUp(tx, { accountId: caller.accountId, action: "approve_session", targetId: s.id, grant: stepUp, now });
  if (refusal) fail(refusal.status, refusal.error, refusal.message);
  const next = await apply(tx, s, R.approvePatch(s, caller.accountId, now));
  await audit(tx, caller.accountId, "remote_app.approved", { sessionId: s.id, hostDeviceId: s.hostDeviceId, minutes: s.minutes });
  const n = await names(tx, [next]);
  const starter = n.agents.get(s.agentTokenId)?.name ?? "the agent";
  await mirror(tx, next, "person", `Approved ${starter} to use ${R.reachPhrase(s, pcName(n.pcs.get(s.hostDeviceId), s.hostDeviceId))} for ${s.minutes} minutes.`, now);
  return { body: { session: await view(tx, next, n, now) } };
}

async function opDeny({ tx, caller, now, id }: Ctx): Promise<Outcome> {
  const s = await loadSession(tx, caller, id, now);
  R.decideCheck(s, now);
  const next = await apply(tx, s, R.denyPatch(caller.accountId, now));
  await audit(tx, caller.accountId, "remote_app.denied", { sessionId: s.id, hostDeviceId: s.hostDeviceId });
  const n = await names(tx, [next]);
  await mirror(tx, next, "person", `Said no to using ${R.reachPhrase(s, pcName(n.pcs.get(s.hostDeviceId), s.hostDeviceId))}.`, now);
  return { body: { session: await view(tx, next, n, now) } };
}

async function opResume({ tx, caller, now, id }: Ctx): Promise<Outcome> {
  const s = await loadSession(tx, caller, id, now);
  R.resumeCheck(s, now);
  const next = await apply(tx, s, { status: "active" });
  await audit(tx, caller.accountId, "remote_app.resumed", { sessionId: s.id });
  await mirror(tx, next, "person", "Said the remote session can go on.", now);
  return { body: { session: await view(tx, next, await names(tx, [next]), now) } };
}

/**
 * Stop a session (shared with the PC's own Stop, remote-app-host.ts). Final: nothing restarts it. Deletes its
 * agent leases in the caller's transaction. Already over: unchanged, and no error (Stop is idempotent).
 */
export async function stopInTx(tx: Tx, row: Session, who: "person" | "host" | "agent", now: Date, accountId?: string): Promise<{ session: Session; changed: boolean }> {
  const s = await settleInTx(tx, row, now);
  const patch = R.stopPatch(s, who, now, accountId);
  if (!patch) return { session: s, changed: false };
  const next = await apply(tx, s, patch);
  await audit(tx, s.accountId, "remote_app.stopped", { sessionId: s.id, by: who });
  const n = await names(tx, [s]);
  const pc = pcName(n.pcs.get(s.hostDeviceId), s.hostDeviceId);
  const text = next.status === "denied" ? `Said no to using ${R.reachPhrase(s, pc)}.`
    : who === "person" ? `Stopped the remote session on ${pc}.`
    : who === "host" ? `The remote session on ${pc} was stopped at the PC.`
    : `The remote session on ${pc} was stopped by the agent.`;
  await mirror(tx, next, who === "person" ? "person" : "starter", text, now);
  return { session: next, changed: true };
}

async function opStop({ tx, caller, now, id }: Ctx): Promise<Outcome> {
  const s = await loadSession(tx, caller, id, now);
  const { session } = await stopInTx(tx, s, caller.agentId ? "agent" : "person", now, caller.accountId);
  return { body: { session: await view(tx, session, await names(tx, [session]), now) } };
}

async function opStopAll({ tx, caller, now }: Ctx): Promise<Outcome> {
  let stopped = 0;
  for (const s of await liveOthers(tx, caller.accountId, now, R.LIVE)) if ((await stopInTx(tx, s, "person", now, caller.accountId)).changed) stopped++;
  return { body: { stopped } };
}

async function opReport({ tx, caller, input, now, id }: Ctx): Promise<Outcome> {
  const s = await loadSession(tx, caller, id, now);
  if (caller.agentId !== R.executorOf(s)) fail(403, "not_driver", "Only the agent driving this session records its steps.");
  await liveAgent(tx, caller);
  const report = R.parseReport(input);
  const recorded = await tx.remoteAppActionLog.count({ where: { sessionId: s.id } });
  const d = R.reportDecision(s, report, now, recorded);
  await tx.remoteAppActionLog.create({ data: { sessionId: s.id, at: now, ...d.row } });
  const next = d.pause ? await apply(tx, s, { status: "blocked" }) : s;
  const n = await names(tx, [s]);
  const pc = pcName(n.pcs.get(s.hostDeviceId), s.hostDeviceId);
  const driver = s.executorAgentId ? `${n.agents.get(s.executorAgentId)?.name ?? "The agent on the PC"}: ` : "";
  const mirrored = await mirror(tx, next, "starter", `${driver}${R.actionPhrase(d.row, { pc, scope: R.scopeOf(s) })}`, now);
  if (d.pause) await audit(tx, s.accountId, "remote_app.paused", { sessionId: s.id, outcome: d.row.outcome });
  const v = await view(tx, next, n, now);
  const body: Record<string, unknown> = {
    recorded: true,
    step: R.actionView({ ...d.row, at: now }, { pc, scope: R.scopeOf(s) }),
    session: v,
    task: s.listTaskId ? { updated: mirrored } : null,
    ...(d.pause ? { next: R.nextStep(v, roleOf(caller, s)) } : {}),
  };
  // Refused, but recorded and paused: returned as a value so the step and the pause commit.
  if (d.refused) return { status: 409, body: { error: d.refused, message: "That app isn't one your person approved for this session, so the session is paused until they say it can go on.", ...body } };
  return { body };
}

async function opEnd({ tx, caller, input, now, id }: Ctx): Promise<Outcome> {
  const s = await loadSession(tx, caller, id, now);
  await liveAgent(tx, caller);
  const summary = R.cleanText(input.summary, { field: "summary", max: R.LIMITS.summary, required: true, singleLine: false })!;
  const evidenceRef = R.parseEvidenceRef(input.evidenceRef) ?? null;
  if (input.finished !== undefined && typeof input.finished !== "boolean") fail(400, "invalid_finished", "finished is true or false");
  const finished = input.finished !== false;
  const patch = R.endPatch(s, { finished }, now);
  const next = await apply(tx, s, { ...patch, summary, evidenceRef });
  await audit(tx, s.accountId, "remote_app.ended", { sessionId: s.id, endReason: patch.endReason });
  const n = await names(tx, [s]);
  const pc = pcName(n.pcs.get(s.hostDeviceId), s.hostDeviceId);
  let task: Record<string, unknown> | null = null;
  if (s.listTaskId) {
    const as = { accountId: s.accountId, agentId: s.agentTokenId };
    if (patch.endReason === "done") {
      // The Lists done path, as the agent that holds the claim, with the same rules bc_task_done has.
      const r = await listsInTx(tx, as, "done", { task_id: s.listTaskId, summary, ...(evidenceRef ? { evidence: `kept on ${pc}: ${evidenceRef}` } : {}) }, now, effects.getStore());
      task = r.ok ? { done: true, status: (r.result.task as { status?: string }).status ?? null } : { done: false, why: r.message };
    } else {
      const text = s.status === "awaiting_consent" ? `Withdrew the request to use ${R.reachPhrase(s, pc)}: ${summary}`
        : `Ended the remote session on ${pc} without finishing: ${summary}`;
      const ok = await mirror(tx, next, "starter", text, now);
      task = { done: false, updated: ok };
    }
  }
  return { body: { session: await view(tx, next, n, now), task } };
}

/**
 * bc_remote_app_open, bc_remote_observe, bc_remote_act. The PC-side surface they need (a bounded UI Automation
 * wire in the AppBridge host, design chunk A5) does not exist yet, so after the same session checks a real call
 * would make, they say so plainly. They never pretend: nothing is opened, read, clicked or recorded.
 */
async function opSurface({ tx, caller, now, id }: Ctx): Promise<Outcome> {
  const s = await loadSession(tx, caller, id, now);
  if (caller.agentId !== R.executorOf(s)) fail(403, "not_driver", "Another agent drives this session; only it can use the app.");
  if (s.status === "awaiting_consent") fail(409, "not_approved", "Your person hasn't approved this session yet. Nothing may happen on the PC until they do.");
  if (s.status === "blocked") fail(409, "paused", "This session is paused: it stopped to ask. Wait until your person says it can go on.");
  if (s.status !== "active") fail(409, "session_over", "This session is over.");
  const n = await names(tx, [s]);
  const pc = pcName(n.pcs.get(s.hostDeviceId), s.hostDeviceId);
  return {
    status: 501,
    body: {
      error: "not_available_yet",
      message: `The part of Back Channel Remote that lets an agent see and use an app's controls isn't installed on ${pc} yet, so nothing was opened, read or clicked, and nothing happened on the PC. ` +
        "Tell your person. Until it exists, an agent running on that PC itself has to do the work by its own means and record each step (docs/remote-app-sessions.md), or you can end this session with bc_remote_session_end (finished: false).",
      session: await view(tx, s, n, now),
    },
  };
}

const OPS: Record<Op, (ctx: Ctx) => Promise<Outcome>> = {
  machines: opMachines, readiness: opReadiness, start: opStart, list: opList, get: opGet, approve: opApprove, deny: opDeny, resume: opResume,
  stop: opStop, stopAll: opStopAll, report: opReport, end: opEnd, surface: opSurface, rotate: opRotate,
};

/** Run one operation for whoever is calling. Shared by the REST route and the MCP tools. */
async function run(req: NextRequest, op: Op, input: Input | (() => Promise<Input>), id?: string, viaTool = false): Promise<NextResponse> {
  try {
    const caller = await resolveCaller(req, op);
    const key = caller.agentId ?? caller.accountId;
    const limited = (retryAfterSec: number) => {
      const res = respond({ error: "rate_limited", message: "Too many requests. Wait a moment and retry." }, 429);
      res.headers.set("Retry-After", String(retryAfterSec));
      return res;
    };
    const r = limits.rateLimit(WRITES.has(op) ? "remote-app:write" : "remote-app:read", key, WRITES.has(op) ? 120 : 240, 60_000);
    if (!r.ok) return limited(r.retryAfterSec);
    // Session requests: at most START_PER_HOUR per agent. Only a request that created a session spends it,
    // so an agent fixing a refused request is never locked out by its own mistakes.
    if (op === "start") {
      const peek = limits.rateLimitPeek("remote-app:start", key, START_PER_HOUR);
      if (!peek.ok) return limited(peek.retryAfterSec);
    }
    const body = typeof input === "function" ? await input() : input;
    const origin = (process.env.PUBLIC_APP_URL ?? new URL(req.url).origin).replace(/\/$/, "");
    // Only the person's own request carries a step-up grant (a bearer request never reaches approve).
    const stepUp = caller.agentId ? null : req.headers.get(SU.STEP_UP_HEADER);
    let after: Array<() => void> = [];
    const result = await withSerializableRetry(
      () => effects.run((after = []), () => prisma.$transaction(async (tx: Tx): Promise<Outcome | { refusal: InstanceType<typeof R.RemoteRuleError> }> => {
        try {
          return await OPS[op]({ tx, caller, input: body, now: new Date(), id, origin, viaTool, stepUp });
        } catch (e) {
          if (e instanceof R.RemoteRuleError && !(e instanceof RollBack)) return { refusal: e };
          throw e;
        }
      }, { isolationLevel: "Serializable" })),
      { retryable: conflict },
    );
    // The transaction committed (a refusal commits too): now ring the doorbells and send the email it owes.
    for (const fn of after) fn();
    if ("refusal" in result) throw result.refusal;
    if (op === "start") limits.rateLimit("remote-app:start", key, START_PER_HOUR, 60 * 60_000);
    return respond(result.body, result.status ?? 200);
  } catch (e) {
    if (e instanceof R.RemoteRuleError) return respond({ error: e.code, message: e.message, ...(e.extra ?? {}) }, e.status);
    if (conflict(e)) {
      const res = respond({ error: "busy", message: "Someone else was changing this at the same moment. Retry.", retryable: true }, 503);
      res.headers.set("Retry-After", "1");
      return res;
    }
    // Never log bodies, goals, names or keys.
    console.error(`[remote-app] ${op} failed:`, e instanceof Error ? e.name : typeof e);
    return respond({ error: "unavailable", message: "Remote app sessions are unavailable right now. Try again shortly." }, 503);
  }
}

// ── REST: /api/remote-app/... ──────────────────────────────────────────────

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
 *   GET  /api/remote-app/machines                  machines   agent or person (with each PC's agents' readiness)
 *   GET  /api/remote-app/readiness                 readiness  person: the "Agents on your PCs" card
 *   GET  /api/remote-app/sessions                  list       agent (its own) or person (the dashboard card)
 *   POST /api/remote-app/sessions                  start      agent
 *   POST /api/remote-app/stop-all                  stopAll    person
 *   GET  /api/remote-app/sessions/:id              get        the agent that asked, the one driving, or the person
 *   POST /api/remote-app/sessions/:id/approve      approve    person
 *   POST /api/remote-app/sessions/:id/deny         deny       person
 *   POST /api/remote-app/sessions/:id/resume       resume     person
 *   POST /api/remote-app/sessions/:id/stop         stop       person, the agent that asked, or the one driving
 *   POST /api/remote-app/sessions/:id/actions      report     the agent driving
 *   POST /api/remote-app/sessions/:id/end          end        the agent that asked, or the one driving
 *   POST /api/remote-app/sessions/:id/executor-secret  rotate  the one driving: a fresh executor secret, once (v1.1)
 */
export async function remoteAppRoute(req: NextRequest, path: string[]): Promise<NextResponse> {
  const m = req.method;
  const [a, b, c, extra] = path;
  const body = () => readJson(req);
  let route: [Op, Input | (() => Promise<Input>), string?] | null = null;
  if (extra === undefined) {
    if (a === "machines" && !b && m === "GET") route = ["machines", {}];
    else if (a === "readiness" && !b && m === "GET") route = ["readiness", {}];
    else if (a === "stop-all" && !b && m === "POST") route = ["stopAll", {}];
    else if (a === "sessions" && !b) route = m === "GET" ? ["list", {}] : m === "POST" ? ["start", body] : null;
    else if (a === "sessions" && b && !c && m === "GET") route = ["get", {}, b];
    else if (a === "sessions" && b && c && m === "POST") {
      const op = ({ approve: "approve", deny: "deny", resume: "resume", stop: "stop", actions: "report", end: "end", "executor-secret": "rotate" } as Record<string, Op>)[c];
      if (op) route = [op, op === "report" || op === "end" ? body : {}, b];
    }
  }
  if (!route) return respond({ error: "not_found", message: "No such remote-app endpoint." }, 404);
  return run(req, route[0], route[1], route[2]);
}

// ── MCP: the bc_remote_* tools (catalog in src/lib/mcp/remote-tools.mjs) ────

const TOOL_NAMES = new Set<string>(REMOTE_TOOL_NAMES);
export function isRemoteTool(name: string): boolean {
  return TOOL_NAMES.has(name);
}

/** One bc_remote_* tool call: the same operations and rules as /api/remote-app, with the caller's own key. */
export async function remoteTool(req: NextRequest, name: string, args: Input): Promise<{ status: number; text: string }> {
  if (isSupportTool(name)) return supportTool(req, name, args);
  const id = typeof args.remote_session_id === "string" ? args.remote_session_id.trim() : undefined;
  let res: NextResponse;
  switch (name) {
    case "bc_remote_machines":
      res = await run(req, "machines", {});
      break;
    case "bc_remote_session_start":
      res = await run(req, "start", { host: args.host, apps: args.apps, minutes: args.minutes, goal: args.goal, taskId: args.task_id, executor: args.executor });
      break;
    case "bc_remote_session_status":
      res = await run(req, "get", {}, id, true);
      break;
    case "bc_remote_session_end":
      res = await run(req, "end", { summary: args.summary, evidenceRef: args.evidence, finished: args.finished }, id);
      break;
    default:
      res = await run(req, "surface", {}, id);
  }
  return { status: res.status, text: await res.text() };
}

// ── The PC (remote-app-host.ts) ─────────────────────────────────────────────

/**
 * Does this PC's AppBridge speak agent-control v1.2 (1.1.33 or newer: desktop scope, `scope` on each session, possibly
 * no apps)? Told by the newest readiness report of a worker of the account that reports from this PC (matched by the
 * PC's name, exactly as the readiness card matches it: one PC with that name, ignoring case) and says
 * `appbridge.version` >= 1.1.33. No such report means no: the older shape works on every AppBridge.
 */
async function hostSpeaksDesktop(tx: Tx, host: AppBridgeDevice): Promise<boolean> {
  const [agents, hosts] = await Promise.all([
    tx.agentToken.findMany({ where: { accountId: host.accountId, revokedAt: null, scope: "full", readinessAt: { not: null } }, orderBy: { readinessAt: "desc" }, take: 100 }),
    tx.appBridgeDevice.findMany({ where: { accountId: host.accountId, role: "host", revokedAt: null }, orderBy: { createdAt: "asc" }, take: 50 }),
  ]);
  const pcs = hosts.map((h) => ({ hostDeviceId: h.id, name: pcName(h) }));
  const reports = agents.map((a) => RD.storedReadiness(a.readiness, a.id))
    .filter((r) => !!r && RD.matchPc(r.appbridge.hostName, pcs)?.hostDeviceId === host.id);
  return RD.speaksDesktop(reports);
}

/**
 * The running sessions bound to one PC, for its banner and its own scope enforcement: which apps (or the whole PC),
 * toward what goal, until when, started by and driven by which agent, for which task. Waiting requests are not shown
 * to the PC: only the person's approval in the dashboard starts anything. executorSecretSha256 (v1.1): the hash the
 * PC's agent-control pipe checks the executor's hello against; null for a v1 session, whose hello needs no secret.
 * It changes when the secret is handed out or rotated, so a pipe whose check fails re-reads this before it refuses.
 *
 * The compatibility trap: AppBridge refuses unknown members in this list, so an AppBridge older than 1.1.33 would treat
 * a `scope` member (or an empty `apps`) as a malformed reply and drop every session. So `scope` goes only to a PC known
 * to run 1.1.33 or newer (hostSpeaksDesktop). Any other PC gets the v1.1 shape: a desktop session is sent as the apps it
 * expects to use, which that PC enforces as before (an apps session in effect), and a desktop session that named no
 * apps is left out, since an older PC can't run it. The readiness card says "AppBridge 1.1.33 or newer" for that PC.
 */
export async function sessionsForHost(tx: Tx, host: AppBridgeDevice, now: Date) {
  const rows = await tx.remoteAppSession.findMany({ where: { accountId: host.accountId, hostDeviceId: host.id, kind: "agent", status: { in: [...R.RUNNING] } }, orderBy: { createdAt: "desc" }, take: 5 });
  const settled: Session[] = [];
  for (const r of rows) {
    const s = await settleInTx(tx, r, now);
    if (R.RUNNING.includes(s.status)) settled.push(s);
  }
  const v12 = settled.length ? await hostSpeaksDesktop(tx, host) : false;
  const n = await names(tx, settled);
  const out = [];
  for (const s of settled) {
    const v = await view(tx, s, n, now);
    if (!v12 && v.scope === "desktop" && !v.apps.length) continue;
    out.push({ id: v.id, status: v.status, ...(v12 ? { scope: v.scope } : {}), apps: v.apps, goal: v.goal, startedAt: v.startedAt, expiresAt: v.expiresAt,
      startedBy: v.startedBy.name, drivenBy: v.drivenBy.name, task: v.task?.title ?? null, executorSecretSha256: s.executorSecretHash ?? null,
      ...(s.status === "blocked" ? { pausedBecause: (v as { pausedBecause?: string }).pausedBecause } : {}) });
  }
  return out;
}
