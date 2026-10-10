/**
 * Keeping the Lists tab and the My plate card fresh (Phase 3, docs/lists.md).
 *
 * The dashboard listens on GET /api/lists/stream, a cookie-authenticated SSE
 * stream that says only "something you can see changed" ({at}). Whenever the
 * stream isn't there (no EventSource, a network error, the server closing it,
 * a stream that goes quiet past its heartbeat, or a newer tab taking this
 * one's slot) the page falls back to the Phase 1 poll of
 * /api/lists/changes?since= every 10 seconds while it's visible, and tries the
 * stream again later.
 *
 * Plain JS with every browser dependency passed in, so `node --test` covers
 * the fallback logic (live.test.mjs). api.ts wires it to the real EventSource,
 * fetch, timers and document.visibilityState, shared by every component on
 * the page so one tab holds one stream.
 *
 * @typedef {{ addEventListener: (type: string, fn: (e: { data?: string }) => void) => void, close: () => void }} StreamLike
 * @typedef {{
 *   onChange: () => void,
 *   fetchChanges: (since: string | null) => Promise<{ at: string, changed: boolean }>,
 *   openStream?: (() => StreamLike) | null,
 *   isVisible: () => boolean,
 *   watchVisibility?: (fn: () => void) => () => void,
 *   timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout, setInterval: typeof setInterval, clearInterval: typeof clearInterval },
 *   pollMs?: number, retryMs?: number, maxRetryMs?: number, staleMs?: number, reloadGapMs?: number,
 * }} FeedDeps
 */

export const POLL_MS = 10_000;
/**
 * A busy list (an agent posting progress every few seconds) shouldn't reload
 * the page on every event: the first change reloads at once, and changes in
 * the next RELOAD_GAP_MS become one more reload when it ends. That keeps a
 * dashboard well inside the 240 reads a minute an account gets.
 */
export const RELOAD_GAP_MS = 3_000;
/** First retry of a failed stream; doubles each time up to MAX_RETRY_MS. */
export const RETRY_MS = 15_000;
export const MAX_RETRY_MS = 5 * 60_000;
/** The server sends a heartbeat every 25 s; a stream silent this long is treated as broken. */
export const STALE_MS = 75_000;
export const STREAM_URL = "/api/lists/stream";

/**
 * One page's feed. `start()` runs the initial load (the first check always
 * counts as a change, so the caller loads through onChange) and opens the
 * stream, polling until it's ready. `state()` is "polling", "connecting",
 * "streaming" or "stopped".
 * @param {FeedDeps} deps
 */
export function createListsFeed(deps) {
  // Called through globalThis: a browser's timers throw "Illegal invocation" when called as methods of another
  // object (t.setInterval(...) with `this` = t), which blanked /account for every signed-in user. Node doesn't care.
  const t = deps.timers ?? {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (id) => globalThis.clearInterval(id),
  };
  const pollMs = deps.pollMs ?? POLL_MS;
  const firstRetry = deps.retryMs ?? RETRY_MS;
  const maxRetry = deps.maxRetryMs ?? MAX_RETRY_MS;
  const staleMs = deps.staleMs ?? STALE_MS;
  const reloadGap = deps.reloadGapMs ?? RELOAD_GAP_MS;

  /** The server time up to which this page has loaded everything. */
  let since = /** @type {string | null} */ (null);
  let mode = "idle";
  let stream = /** @type {StreamLike | null} */ (null);
  let pollTimer = /** @type {any} */ (null);
  let retryTimer = /** @type {any} */ (null);
  let staleTimer = /** @type {any} */ (null);
  let retryDelay = firstRetry;
  let busy = false;
  /** A check was asked for while one was running: run one more when it ends. */
  let again = false;
  /** A newer tab took this one's stream: wait until someone looks at this page again. */
  let parked = false;
  /** Something may have changed while the page was hidden: check when it's visible. */
  let pending = false;
  let unwatch = /** @type {(() => void) | null} */ (null);
  /** While set, stream changes wait; `queued` says one came in meanwhile. */
  let gapTimer = /** @type {any} */ (null);
  let queued = false;

  const stopped = () => mode === "stopped";

  /** Reload for a stream change: now, or once at the end of the current gap. */
  function reloadSoon() {
    if (gapTimer) {
      queued = true;
      return;
    }
    deps.onChange();
    gapTimer = t.setTimeout(function endGap() {
      gapTimer = null;
      if (!queued || stopped()) return;
      queued = false;
      deps.onChange();
      gapTimer = t.setTimeout(endGap, reloadGap);
    }, reloadGap);
  }

  /** Ask the server whether anything changed since the last load; reload if so. `first` always reloads. */
  async function check(first = false) {
    if (stopped()) return;
    if (busy) {
      again = true;
      return;
    }
    if (!first && since && !deps.isVisible()) {
      pending = true;
      return;
    }
    busy = true;
    try {
      const r = await deps.fetchChanges(since);
      if (stopped()) return;
      if (r.changed || !since) deps.onChange();
      since = r.at;
    } catch {
      // Offline or signed out: keep what's on screen. The very first time, let the page load (and show its own error).
      if (!since && !stopped()) deps.onChange();
    } finally {
      busy = false;
      if (again && !stopped()) {
        again = false;
        void check();
      }
    }
  }

  function startPolling() {
    if (pollTimer || stopped()) return;
    pollTimer = t.setInterval(() => void check(), pollMs);
  }
  function stopPolling() {
    if (pollTimer) t.clearInterval(pollTimer);
    pollTimer = null;
  }
  function armStale() {
    if (staleTimer) t.clearTimeout(staleTimer);
    staleTimer = t.setTimeout(() => {
      staleTimer = null;
      if (stream) fallBack({ retry: true });
    }, staleMs);
  }
  function closeStream() {
    if (staleTimer) t.clearTimeout(staleTimer);
    staleTimer = null;
    const s = stream;
    stream = null;
    try { s?.close(); } catch { /* already closed */ }
  }

  /** The stream is gone: poll, and either try again later or wait to be looked at. */
  function fallBack({ retry }) {
    closeStream();
    if (stopped()) return;
    mode = "polling";
    startPolling();
    if (!retry) {
      parked = true;
      return;
    }
    if (retryTimer) return;
    retryTimer = t.setTimeout(() => {
      retryTimer = null;
      connect();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, maxRetry);
  }

  function connect() {
    if (stopped() || stream || !deps.openStream) return;
    /** @type {StreamLike | null} */
    let s = null;
    try {
      s = deps.openStream();
    } catch {
      s = null;
    }
    if (!s) {
      fallBack({ retry: true });
      return;
    }
    const source = s;
    stream = source;
    parked = false;
    mode = "connecting";
    startPolling();
    armStale();
    const mine = () => stream === source && !stopped();
    source.addEventListener("ready", () => {
      if (!mine()) return;
      mode = "streaming";
      retryDelay = firstRetry;
      stopPolling();
      armStale();
      // Catch up on anything between the last load and the stream opening.
      void check();
    });
    source.addEventListener("changed", (e) => {
      if (!mine()) return;
      armStale();
      if (!deps.isVisible()) {
        pending = true;
        return;
      }
      reloadSoon();
      const at = readAt(e);
      if (at) since = at;
    });
    source.addEventListener("heartbeat", () => {
      if (mine()) armStale();
    });
    // Too many streams on this account: a newer tab or device has this slot now.
    source.addEventListener("replaced", () => {
      if (mine()) fallBack({ retry: false });
    });
    source.addEventListener("error", () => {
      if (mine()) fallBack({ retry: true });
    });
  }

  function onVisibility() {
    if (stopped() || !deps.isVisible()) return;
    if (parked && !stream) connect();
    if (mode !== "streaming" || pending) {
      pending = false;
      void check();
    }
  }

  return {
    start() {
      if (mode !== "idle") return;
      mode = "polling";
      unwatch = deps.watchVisibility?.(onVisibility) ?? null;
      void check(true);
      if (deps.openStream) connect();
      else startPolling();
    },
    stop() {
      mode = "stopped";
      stopPolling();
      closeStream();
      if (retryTimer) t.clearTimeout(retryTimer);
      retryTimer = null;
      if (gapTimer) t.clearTimeout(gapTimer);
      gapTimer = null;
      unwatch?.();
      unwatch = null;
    },
    /** For tests: the same as the page becoming visible. */
    visible: onVisibility,
    state: () => mode,
  };
}

/** @param {{ data?: string }} e */
function readAt(e) {
  try {
    const at = JSON.parse(e?.data ?? "null")?.at;
    return typeof at === "string" && Number.isFinite(Date.parse(at)) ? at : null;
  } catch {
    return null;
  }
}

/**
 * One feed per page, shared by every component that wants fresh lists. The
 * first subscriber starts it (and loads through it); a later one gets its own
 * initial load right away; the last one to leave stops it.
 * @param {(onChange: () => void) => ReturnType<typeof createListsFeed>} makeFeed
 */
export function createSharedFeed(makeFeed) {
  const listeners = new Set();
  /** @type {ReturnType<typeof createListsFeed> | null} */
  let feed = null;
  return {
    /** @param {() => void} listener @returns {() => void} */
    subscribe(listener) {
      listeners.add(listener);
      if (!feed) {
        feed = makeFeed(() => {
          for (const l of [...listeners]) l();
        });
        feed.start();
      } else {
        void Promise.resolve().then(() => {
          if (listeners.has(listener)) listener();
        });
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size && feed) {
          feed.stop();
          feed = null;
        }
      };
    },
    state: () => feed?.state() ?? "stopped",
  };
}
