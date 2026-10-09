/**
 * Lists: the per-account live channel behind GET /api/lists/stream (docs/lists.md).
 *
 * The dashboard holds a cookie-authenticated SSE stream; src/lib/lists.ts calls
 * fireListsChanged(accountId) after a write commits, for everyone who can see
 * the list or task that changed. Same shape as the inbox doorbell
 * (inbox-bus.mjs): in memory on globalThis, coalesced, metadata only. A
 * `changed` event carries `{ at }` and nothing else: never a list name, task
 * title or who did what. The browser reloads through the normal routes, which
 * check access again.
 *
 * At most MAX_STREAMS_PER_ACCOUNT streams per account (two tabs, or a laptop
 * and a phone). A third connect closes the oldest with `event: replaced`, so a
 * forgotten tab can't hold a slot forever and the account's streams stay
 * bounded.
 *
 * Pure JS with no imports: the route and lists.ts share it, `node --test`
 * covers it, and the route tests run it unmocked. Single Cloud Run instance
 * today, like the inbox bus; scaling out would put this behind Redis pub/sub or
 * Postgres LISTEN/NOTIFY with the same four functions.
 *
 * @typedef {{ write: (chunk: string) => void, close?: () => void }} StreamWriter
 * @typedef {{ streams: Set<StreamWriter>, lastEventId: number, timer: ReturnType<typeof setTimeout> | null }} ListsBus
 */

export const MAX_STREAMS_PER_ACCOUNT = 2;
/** A burst of writes (a batch add, a template with 40 tasks) becomes one event. */
export const COALESCE_MS = 300;

/** @type {{ buses: Map<string, ListsBus>, coalesceMs: number }} */
const state = globalThis.__bcListsBus ?? (globalThis.__bcListsBus = { buses: new Map(), coalesceMs: COALESCE_MS });

/** @param {string} accountId @returns {ListsBus} */
function busFor(accountId) {
  let bus = state.buses.get(accountId);
  if (!bus) {
    bus = { streams: new Set(), lastEventId: 0, timer: null };
    state.buses.set(accountId, bus);
  }
  return bus;
}

/**
 * One SSE event. `data` is always a small metadata object. A null id writes no
 * id line (the heartbeat), so it doesn't move the browser's last event id.
 * @param {StreamWriter} writer @param {string} event @param {number | null} id @param {unknown} data
 */
export function writeEvent(writer, event, id, data) {
  writer.write(`event: ${event}\n${id === null ? "" : `id: ${id}\n`}data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Something this account can see changed. Coalesced per account: calls within
 * COALESCE_MS become one `changed` event to every stream the account holds.
 * Nothing is queued for an account with no stream open (the page loads fresh
 * when it opens one). Never throws.
 * @param {string} accountId
 */
export function fireListsChanged(accountId) {
  if (!accountId) return;
  const bus = state.buses.get(accountId);
  if (!bus || !bus.streams.size || bus.timer) return;
  bus.timer = setTimeout(() => {
    bus.timer = null;
    bus.lastEventId += 1;
    const data = { at: new Date().toISOString() };
    for (const writer of [...bus.streams]) {
      try {
        writeEvent(writer, "changed", bus.lastEventId, data);
      } catch {
        // A dead stream is removed by its own close handler.
      }
    }
  }, state.coalesceMs);
}

/**
 * Hold a stream for an account. When that makes more than
 * MAX_STREAMS_PER_ACCOUNT, the oldest is told `replaced` and closed.
 * @param {string} accountId @param {StreamWriter} writer
 * @returns {{ lastEventId: number }}
 */
export function subscribeListsStream(accountId, writer) {
  const bus = busFor(accountId);
  bus.streams.add(writer);
  while (bus.streams.size > MAX_STREAMS_PER_ACCOUNT) {
    const oldest = bus.streams.values().next().value;
    bus.streams.delete(oldest);
    try {
      writeEvent(oldest, "replaced", bus.lastEventId, { reason: "too_many_streams" });
      oldest.close?.();
    } catch {
      // already gone
    }
  }
  return { lastEventId: bus.lastEventId };
}

/** Let go of a stream (on close or abort). Safe to call twice. @param {string} accountId @param {StreamWriter} writer */
export function unsubscribeListsStream(accountId, writer) {
  const bus = state.buses.get(accountId);
  if (!bus) return;
  bus.streams.delete(writer);
  if (!bus.streams.size) {
    if (bus.timer) clearTimeout(bus.timer);
    state.buses.delete(accountId);
  }
}

/** How many streams an account holds (or all accounts together, with no argument). @param {string} [accountId] */
export function listsStreamCount(accountId) {
  if (accountId) return state.buses.get(accountId)?.streams.size ?? 0;
  let n = 0;
  for (const bus of state.buses.values()) n += bus.streams.size;
  return n;
}

/** Tests: forget every stream and timer, and optionally shorten the coalesce window. @param {{ coalesceMs?: number }} [opts] */
export function _reset({ coalesceMs = COALESCE_MS } = {}) {
  for (const bus of state.buses.values()) if (bus.timer) clearTimeout(bus.timer);
  state.buses.clear();
  state.coalesceMs = coalesceMs;
}
