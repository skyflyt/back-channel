/**
 * Back Channel — in-memory fixed-window rate limiter.
 *
 * Single-instance Cloud Run only (--min/max-instances=1, --session-affinity):
 * state lives in this process's memory and is lost on restart/redeploy. That's
 * fine for abuse mitigation — the goal is to blunt spam/brute-force, not to
 * persist counters. If we ever scale past one instance, swap the Map for Redis
 * (same interface).
 *
 * Pure JS (no TS) so server.mjs / relay.mjs can import it at runtime, matching
 * the db.mjs / relay.mjs pattern. The TS API routes import the rate-limit.ts
 * shim, which re-exports these symbols.
 */

/** @typedef {{ count: number, resetAt: number }} Window */

/** @type {Map<string, Window>} */
const windows = new Map();

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let lastSweep = Date.now();

/**
 * Drop expired windows so an attacker rotating through many keys (IPs/emails)
 * can't grow the Map without bound. Lazy — runs at most once per sweep interval.
 * @param {number} now
 */
function sweep(now) {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [k, w] of windows) {
    if (w.resetAt <= now) windows.delete(k);
  }
}

/**
 * Record one event against `bucket:key` and report whether it's allowed.
 *
 * @param {string} bucket   logical limiter name, e.g. "accounts:ip"
 * @param {string} key      identity within the bucket, e.g. an IP or email
 * @param {number} limit    max allowed events per window
 * @param {number} windowMs window length in milliseconds
 * @returns {{ ok: boolean, remaining: number, retryAfterSec: number }}
 */
export function rateLimit(bucket, key, limit, windowMs) {
  const now = Date.now();
  sweep(now);

  const id = `${bucket}:${key}`;
  let w = windows.get(id);
  if (!w || w.resetAt <= now) {
    w = { count: 0, resetAt: now + windowMs };
    windows.set(id, w);
  }
  w.count++;

  if (w.count > limit) {
    return {
      ok: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((w.resetAt - now) / 1000)),
    };
  }
  return { ok: true, remaining: limit - w.count, retryAfterSec: 0 };
}

/**
 * Extract the real client IP from the X-Forwarded-For header.
 *
 * On Cloud Run the trusted Google front-end appends the caller; the original
 * client is the FIRST entry. We deliberately do NOT use req.socket — behind
 * the proxy that's always the front-end, so every caller would share one
 * bucket. Falls back to "unknown" (one shared bucket) if the header is absent.
 *
 * @param {string | string[] | null | undefined} xff  X-Forwarded-For value
 *   (Node may hand back an array if the header appears more than once)
 * @returns {string}
 */
export function clientIp(xff) {
  if (!xff) return "unknown";
  const raw = Array.isArray(xff) ? xff[0] : xff;
  const first = raw?.split(",")[0]?.trim();
  return first || "unknown";
}

/** Test/diagnostic helper — wipe all counters. */
export function _reset() {
  windows.clear();
  lastSweep = Date.now();
}
