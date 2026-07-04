/**
 * Back Channel - per-account inbox event bus (the "doorbell").
 *
 * Mirrors relay.mjs's per-SESSION bus (globalThis map, WS fanout, long-poll
 * waiters), lifted one level to per-ACCOUNT. Two transports share this one
 * mechanism: SSE (a held writer per account) and long-poll (a resolver set).
 * Both carry METADATA ONLY - { pending_count, since, timestamp, kinds } - the
 * broker never puts frame content, topics, or anything user-authored here.
 *
 * Pure JS (no TS) so relay.mjs can import it at runtime and fire the doorbell
 * from inside ingestFrame, exactly where notifyIdleRecipient already fires -
 * same reason rate-limit.mjs / notify.mjs are runtime JS (relay runs outside
 * Next's bundler; see relay.mjs's top comment). TS API routes get a typed
 * shim at inbox-bus.ts, same split as relay.ts / rate-limit.ts.
 *
 * State lives on globalThis so it's shared with relay.mjs regardless of which
 * bundle imports first - single-instance Cloud Run today (see relay.mjs); a
 * multi-instance future swaps this Map for Redis pub/sub behind the same
 * four exported functions (documented, not built - v1 is in-memory only).
 *
 * @typedef {"frame" | "payload" | "invite"} InboxKind
 *
 * @typedef {Object} InboxEvent
 * @property {number} pending_count
 * @property {string} since       ISO8601 - a fixed reference point (bus creation
 *                                 time for this account), NOT a moving window;
 *                                 absolute-count design (see fireInboxEvent doc).
 * @property {string} timestamp   ISO8601 - when this snapshot/event was built
 * @property {InboxKind[]} [kinds]
 *
 * @typedef {Object} SseWriter
 * @property {(chunk: string) => void} write
 * @property {() => void} [close]
 *
 * @typedef {Object} AccountBus
 * @property {Set<SseWriter>} sse
 * @property {Set<{ resolve: (evt: InboxEvent) => void, kinds: Set<InboxKind> }>} longpoll
 * @property {number} lastEventId
 * @property {string} since             ISO8601 - fixed per-account reference instant
 * @property {ReturnType<typeof setTimeout> | null} coalesceTimer
 * @property {Set<InboxKind>} pendingKinds  kinds accumulated during the current coalesce window
 */

// Coalesce window: rapid arrivals (e.g. a burst of frames) collapse into one
// fired event carrying the cumulative count, so a fast sender doesn't wake the
// recipient once per frame. Short enough to feel instant, long enough to
// collapse a multi-frame burst (see design spec S4.4, open question #2).
const COALESCE_MS = 300;

// Long-poll wait cap in ms (design spec S2b: 300s, Cloud Run timeout headroom).
export const MAX_WAIT_MS = 300 * 1000;

// L1 (security-pass-2026-07-03.md): cap concurrent parked long-poll waiters per
// account, mirroring SSE's 1-connection-per-account limit (subscribeSse below
// replaces any existing stream rather than growing unbounded). Long-poll has no
// single persistent connection object to "replace", so instead of silently
// evicting an older waiter (which would just move the resource-exhaustion
// vector from "grow forever" to "starve the first caller"), a waiter over the
// cap is rejected immediately and the route maps that to a fast, harmless
// response. 1 mirrors SSE's own limit; legitimate multi-tab/multi-agent use of
// one account already tends to prefer SSE (held connection) over long-poll
// (repeated short-lived requests) for exactly this reason.
export const MAX_LONGPOLL_WAITERS_PER_ACCOUNT = 1;

/** @type {Map<string, AccountBus>} */
const buses = globalThis.__bcInboxWaiters ?? (globalThis.__bcInboxWaiters = new Map());

/** @param {string} accountId @returns {AccountBus} */
function getOrCreateBus(accountId) {
  let bus = buses.get(accountId);
  if (!bus) {
    bus = {
      sse: new Set(),
      longpoll: new Set(),
      lastEventId: 0,
      since: new Date().toISOString(),
      coalesceTimer: null,
      pendingKinds: new Set(),
    };
    buses.set(accountId, bus);
  }
  return bus;
}
/**
 * Thin, content-blind pending count for an account. Injected by the caller
 * (API routes have prisma + relay session access; this module stays free of
 * those imports so it has zero DB dependency and is trivially unit-testable).
 * @callback PendingCounter
 * @param {string} accountId
 * @returns {Promise<{ count: number, kinds: InboxKind[] }>}
 */

/** @type {PendingCounter | null} */
let pendingCounter = null;

/**
 * Register the function that computes `pending_count` + `kinds` for an
 * account. Called once at startup (from a route module that has DB/relay
 * access) - see pendingCount() in the inbox/events + inbox/check routes.
 * @param {PendingCounter} fn
 */
export function setPendingCounter(fn) {
  pendingCounter = fn;
}

/**
 * Compute the current snapshot for an account: pending_count + kinds, via the
 * registered counter (or a zero snapshot if none is registered - e.g. in a
 * unit test that only exercises subscribe/fire wiring, not real counts).
 * @param {string} accountId
 * @returns {Promise<{ count: number, kinds: InboxKind[] }>}
 */
async function snapshot(accountId) {
  if (!pendingCounter) return { count: 0, kinds: [] };
  try {
    return await pendingCounter(accountId);
  } catch (e) {
    console.error(`[inbox-bus] pendingCounter failed for ${accountId}:`, e instanceof Error ? e.message : e);
    return { count: 0, kinds: [] };
  }
}

/**
 * Build the wire event for an account (used for both the SSE `ready`/
 * `you-have-mail` payload and the long-poll response body).
 * @param {string} accountId
 * @returns {Promise<InboxEvent>}
 */
export async function currentEvent(accountId) {
  const bus = getOrCreateBus(accountId);
  const { count, kinds } = await snapshot(accountId);
  return {
    pending_count: count,
    since: bus.since,
    timestamp: new Date().toISOString(),
    ...(kinds.length ? { kinds } : {}),
  };
}

/**
 * Fire the doorbell for an account: something just became pending. Called
 * from the three hook points named in the spec (relay.mjs ingestFrame for a
 * content frame, send-to-me for a new agent.payload, inbox/request for a new
 * InboxRequest) - the same choke points notifyIdleRecipient already lives at.
 *
 * Coalesced: rapid calls within COALESCE_MS collapse into ONE fired event
 * carrying the cumulative count (computed fresh at fire time, not summed) -
 * absolute-count design, so a dropped/delayed event is never a lost message,
 * only a delayed accurate count (see design spec S4.4).
 *
 * @param {string} accountId
 * @param {InboxKind} kind
 */
export function fireInboxEvent(accountId, kind) {
  const bus = getOrCreateBus(accountId);
  bus.pendingKinds.add(kind);
  if (bus.coalesceTimer) return; // already scheduled - this call just adds to pendingKinds
  bus.coalesceTimer = setTimeout(() => {
    bus.coalesceTimer = null;
    const kinds = Array.from(bus.pendingKinds);
    bus.pendingKinds.clear();
    void deliver(accountId, bus, kinds);
  }, COALESCE_MS);
}
/**
 * Push the current snapshot to every held SSE writer and resolve every
 * parked long-poll waiter for this account. Internal - called only from the
 * coalesce timer in fireInboxEvent.
 * @param {string} accountId
 * @param {AccountBus} bus
 * @param {InboxKind[]} kinds
 */
async function deliver(accountId, bus, kinds) {
  bus.lastEventId += 1;
  const { count } = await snapshot(accountId);
  /** @type {InboxEvent} */
  const evt = {
    pending_count: count,
    since: bus.since,
    timestamp: new Date().toISOString(),
    ...(kinds.length ? { kinds } : {}),
  };

  for (const writer of bus.sse) {
    try {
      writeSseEvent(writer, "you-have-mail", bus.lastEventId, evt);
    } catch {
      // A dead writer will be cleaned up by its own close/error handler via
      // unsubscribeSse; don't let one bad connection block the others.
    }
  }

  // Resolve every parked long-poll waiter for this account. Each waiter set
  // its own `kinds` filter at park time (currently unused - all waiters get
  // the same event; the field exists so a future per-kind long-poll doesn't
  // need a shape change).
  const waiters = Array.from(bus.longpoll);
  bus.longpoll.clear();
  for (const w of waiters) {
    try { w.resolve(evt); } catch {}
  }
}

/**
 * Write one SSE event (`event:`/`id:`/`data:` lines + blank-line terminator)
 * to a writer. Exported so the route can also send the initial `ready` event
 * and heartbeat comments through the same writer shape.
 * @param {SseWriter} writer
 * @param {string} event
 * @param {number} id
 * @param {unknown} data
 */
export function writeSseEvent(writer, event, id, data) {
  writer.write(`event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Write a heartbeat comment line (keeps intermediaries from reaping an idle stream). */
export function writeSseHeartbeat(writer) {
  writer.write(`: heartbeat ${new Date().toISOString()}\n\n`);
}

/**
 * Register a held SSE writer for an account. One stream per account: if a
 * stream is already registered, it is told `event: replaced` and closed -
 * mirrors the relay's `replaced_by_reconnect` for WS. Returns the bus's
 * current lastEventId so the caller can send `ready` with a matching id.
 * @param {string} accountId
 * @param {SseWriter} writer
 * @returns {{ lastEventId: number }}
 */
export function subscribeSse(accountId, writer) {
  const bus = getOrCreateBus(accountId);
  for (const existing of bus.sse) {
    try {
      writeSseEvent(existing, "replaced", bus.lastEventId, { reason: "new_connection" });
      existing.close?.();
    } catch {}
    bus.sse.delete(existing);
  }
  bus.sse.add(writer);
  return { lastEventId: bus.lastEventId };
}

/**
 * Unregister an SSE writer (on close/error). Safe to call even if the writer
 * was already replaced/removed.
 * @param {string} accountId
 * @param {SseWriter} writer
 */
export function unsubscribeSse(accountId, writer) {
  const bus = buses.get(accountId);
  if (!bus) return;
  bus.sse.delete(writer);
}
/**
 * Thrown by waitForInbox when the account already has MAX_LONGPOLL_WAITERS_PER_ACCOUNT
 * parked waiters - see the cap's doc comment above. The route catches this and returns
 * a fast, explicit response instead of piling on a third/fourth/... unbounded waiter.
 */
export class TooManyWaitersError extends Error {
  constructor(accountId) {
    super(`account ${accountId} already has ${MAX_LONGPOLL_WAITERS_PER_ACCOUNT} parked long-poll waiter(s)`);
    this.name = "TooManyWaitersError";
  }
}

/**
 * Long-poll: resolve immediately with the current snapshot if pending_count
 * > 0, else park a resolver and race a timer - returns the instant
 * fireInboxEvent's coalesce timer runs, no polling-interval granularity.
 *
 * L1 fix: before parking, checks the account's current waiter count against
 * MAX_LONGPOLL_WAITERS_PER_ACCOUNT and throws TooManyWaitersError instead of
 * growing the Set unbounded - mirrors SSE's per-account cap (subscribeSse).
 * The immediate (non-parking) path above is never capped: it doesn't hold a
 * resource, so a burst of polls that all resolve instantly isn't the resource-
 * exhaustion shape this guards against.
 * @param {string} accountId
 * @param {number} waitMs  capped at MAX_WAIT_MS by the caller (route validates)
 * @returns {Promise<InboxEvent & { waited_seconds: number }>}
 * @throws {TooManyWaitersError}
 */
export async function waitForInbox(accountId, waitMs) {
  const startedAt = Date.now();
  const immediate = await currentEvent(accountId);
  if (immediate.pending_count > 0 || waitMs <= 0) {
    return { ...immediate, waited_seconds: Math.round((Date.now() - startedAt) / 1000) };
  }

  const bus = getOrCreateBus(accountId);
  if (bus.longpoll.size >= MAX_LONGPOLL_WAITERS_PER_ACCOUNT) {
    throw new TooManyWaitersError(accountId);
  }
  return new Promise((resolve) => {
    /** @type {{ resolve: (evt: InboxEvent) => void, kinds: Set<InboxKind> }} */
    const waiter = {
      kinds: new Set(),
      resolve: (evt) => {
        clearTimeout(timer);
        bus.longpoll.delete(waiter);
        resolve({ ...evt, waited_seconds: Math.round((Date.now() - startedAt) / 1000) });
      },
    };
    const timer = setTimeout(async () => {
      bus.longpoll.delete(waiter);
      const snap = await currentEvent(accountId);
      resolve({ ...snap, waited_seconds: Math.round((Date.now() - startedAt) / 1000) });
    }, waitMs);
    bus.longpoll.add(waiter);
  });
}

/** Number of held SSE streams across all accounts (for a future cap/alarm - spec S4.4). */
export function heldStreamCount() {
  let n = 0;
  for (const bus of buses.values()) n += bus.sse.size;
  return n;
}

/** Test/diagnostic helper - wipe all bus state (mirrors rate-limit.mjs's _reset). */
export function _reset() {
  for (const bus of buses.values()) {
    if (bus.coalesceTimer) clearTimeout(bus.coalesceTimer);
  }
  buses.clear();
  pendingCounter = null;
}