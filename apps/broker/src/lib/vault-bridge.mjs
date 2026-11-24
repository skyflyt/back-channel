/**
 * Back Channel - the vault bridge's in-memory rendezvous (docs/vault-bridge.md).
 *
 * A person's own agent asks for a read of their notes vault; the always-on worker on one of their PCs long-polls for
 * the next request, answers it from the vault's git server, and posts the answer back. This module only matches the
 * two up, per account:
 *   - nothing here is ever written to Postgres or logs: requests and answers live in this process's memory, an answer
 *     is handed out once and then dropped, and anything left over goes after HOLD_MS;
 *   - only the asking agent collects an answer, and only the worker a request was handed to can answer it;
 *   - a request is accepted only while one of the account's workers has polled within WORKER_FRESH_MS.
 *
 * Pure JS on globalThis, like inbox-bus.mjs: single-instance Cloud Run today; a multi-instance future moves this
 * behind the same exports. Typed shim at vault-bridge.ts.
 */
import { randomBytes } from "node:crypto";

export const OPS = Object.freeze(["status", "list", "search", "read"]);
export const MAX_WORKER_WAIT_MS = 25_000;
export const WORKER_FRESH_MS = 90_000;
export const HOLD_MS = 5 * 60_000;
export const MAX_OPEN_PER_ACCOUNT = 20;

const KEY = Symbol.for("backchannel.vaultBridge");
/** @returns {{ accounts: Map<string, any> }} */
function state() {
  return (globalThis[KEY] ??= { accounts: new Map() });
}
function account(accountId) {
  const accounts = state().accounts;
  let a = accounts.get(accountId);
  if (!a) {
    a = { workers: new Map(), queue: [], parked: new Map(), open: new Map() };
    accounts.set(accountId, a);
  }
  sweep(a);
  return a;
}
function sweep(a, now = Date.now()) {
  for (const [id, r] of a.open) {
    if (now - r.createdAt <= HOLD_MS) continue;
    a.open.delete(id);
    for (const w of r.waiters) w(null);
  }
  a.queue = a.queue.filter((id) => a.open.has(id));
  for (const [agentId, seen] of a.workers) if (now - seen > HOLD_MS) a.workers.delete(agentId);
}

export class VaultBridgeError extends Error {
  /** @param {"vault_offline"|"too_many_open"|"bad_request"} code */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Whether one of the account's workers polled recently enough to take a request now. */
export function workerOnline(accountId, now = Date.now()) {
  const a = state().accounts.get(accountId);
  if (!a) return false;
  for (const seen of a.workers.values()) if (now - seen <= WORKER_FRESH_MS) return true;
  return false;
}

/**
 * Queue one read for the account's vault worker. Returns its id. Throws VaultBridgeError vault_offline when no
 * worker has polled lately (so a tool answers at once instead of waiting for nothing), too_many_open past the cap.
 */
export function ask(accountId, askerAgentId, op, args) {
  if (!OPS.includes(op) || !args || typeof args !== "object" || Array.isArray(args)) throw new VaultBridgeError("bad_request", "Not a vault read.");
  const a = account(accountId);
  if (!workerOnline(accountId)) {
    throw new VaultBridgeError("vault_offline", "The PC that reads the vault isn't connected to Back Channel right now.");
  }
  if (a.open.size >= MAX_OPEN_PER_ACCOUNT) throw new VaultBridgeError("too_many_open", "Too many vault reads are waiting. Collect or wait for them first.");
  const id = "vr_" + randomBytes(12).toString("base64url");
  a.open.set(id, { id, askerAgentId, op, args, createdAt: Date.now(), handedTo: null, answer: null, waiters: new Set() });
  // Hand it straight to a parked worker poll if there is one, else queue it.
  const [workerId, resolve] = a.parked.entries().next().value ?? [];
  if (resolve) {
    a.parked.delete(workerId);
    a.open.get(id).handedTo = workerId;
    resolve({ id, op, args });
  } else a.queue.push(id);
  return id;
}

/**
 * The worker's long-poll: the next queued request for this account, or null after waitMs. One parked poll per
 * worker agent (a newer one ends the older with null). An aborted poll is unparked before anything is handed to it.
 */
export function nextRequest(accountId, workerAgentId, waitMs, signal) {
  const a = account(accountId);
  a.workers.set(workerAgentId, Date.now());
  const id = a.queue.shift();
  if (id) {
    const r = a.open.get(id);
    r.handedTo = workerAgentId;
    return Promise.resolve({ id, op: r.op, args: r.args });
  }
  const wait = Math.max(0, Math.min(MAX_WORKER_WAIT_MS, waitMs));
  if (wait === 0 || signal?.aborted) return Promise.resolve(null);
  a.parked.get(workerAgentId)?.(null);
  return new Promise((resolve) => {
    let timer;
    const finish = (value) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (a.parked.get(workerAgentId) === finish) a.parked.delete(workerAgentId);
      a.workers.set(workerAgentId, Date.now());
      resolve(value);
    };
    const onAbort = () => finish(null);
    timer = setTimeout(() => finish(null), wait);
    signal?.addEventListener("abort", onAbort, { once: true });
    a.parked.set(workerAgentId, finish);
  });
}

/** The worker's answer. Returns the request (for the audit row) or null when nobody waits for that id from this worker. */
export function deliver(accountId, workerAgentId, id, answer) {
  const a = account(accountId);
  const r = a.open.get(id);
  if (!r || r.handedTo !== workerAgentId || r.answer) return null;
  r.answer = answer;
  for (const w of r.waiters) w(answer);
  r.waiters.clear();
  return { id: r.id, op: r.op, args: r.args, askerAgentId: r.askerAgentId };
}

/**
 * The asker collects. Waits up to waitMs for the answer. Resolves { answer } (then drops it), { pending: true } when
 * it hasn't come yet, or null when there is no such request for this agent (never asked, collected or expired).
 */
export function collect(accountId, askerAgentId, id, waitMs = 0) {
  const a = account(accountId);
  const r = a.open.get(id);
  if (!r || r.askerAgentId !== askerAgentId) return Promise.resolve(null);
  const take = () => {
    a.open.delete(id);
    return { answer: r.answer };
  };
  if (r.answer) return Promise.resolve(take());
  if (waitMs <= 0) return Promise.resolve({ pending: true });
  return new Promise((resolve) => {
    const done = (answer) => {
      clearTimeout(timer);
      r.waiters.delete(done);
      if (answer && a.open.get(id) === r) return resolve(take());
      resolve(a.open.get(id) === r ? { pending: true } : null);
    };
    const timer = setTimeout(() => done(null), waitMs);
    r.waiters.add(done);
  });
}

/** Test-only: forget everything. */
export function _resetVaultBridge() {
  for (const a of state().accounts.values()) for (const p of a.parked.values()) p(null);
  state().accounts.clear();
}
