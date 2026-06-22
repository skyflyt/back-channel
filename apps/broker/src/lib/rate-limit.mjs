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

// Fire-and-forget persistent counter of rate-limit hits per UTC day, so the
// admin dashboard can show "rate-limit hits (24h)" as an abuse signal. Lazy
// prisma import (avoids a hard dep when this module is used in non-DB contexts);
// never throws into the limiter path.
function bumpRateLimitHit() {
  import("./db.mjs").then(({ prisma }) => {
    const day = new Date().toISOString().slice(0, 10);
    return prisma.dailyMetric.upsert({
      where: { day_key: { day, key: "rate_limit_hits" } },
      update: { count: { increment: 1 } },
      create: { day, key: "rate_limit_hits", count: 1 },
    });
  }).catch(() => {});
}

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
    bumpRateLimitHit();
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
 * Take the RIGHTMOST entry, not the leftmost. On Cloud Run a client can prepend
 * its own X-Forwarded-For values and Google appends the real connection IP as
 * the LAST entry. Verified empirically: a request sent with
 * `X-Forwarded-For: 1.2.3.4` arrives at the container as
 * "1.2.3.4,<real-client-ip>". So the leftmost is attacker-controlled (spoofable
 * — an attacker could evade their own rate limit or poison a victim IP's
 * bucket) and the rightmost is the trustworthy value Google guarantees.
 *
 * CAVEAT for future maintainers: this assumes the current topology (Cloud Run
 * domain mapping via the Google Front End, which appends exactly one IP — the
 * client — and no trailing load-balancer hop). If an external HTTPS Load
 * Balancer is ever put in front, it appends ITS forwarding-rule IP after the
 * client, making the client the SECOND-from-last entry — revisit then. Do not
 * "fix" this back to leftmost: leftmost is the spoofable one.
 *
 * @param {string | string[] | null | undefined} xff  X-Forwarded-For value
 *   (Node may hand back an array if the header appears more than once)
 * @returns {string}
 */
export function clientIp(xff) {
  if (!xff) return "unknown";
  const raw = Array.isArray(xff) ? xff[xff.length - 1] : xff;
  const parts = raw ? raw.split(",") : [];
  const last = parts.length ? parts[parts.length - 1].trim() : "";
  return last || "unknown";
}

/** Test/diagnostic helper — wipe all counters. */
export function _reset() {
  windows.clear();
  lastSweep = Date.now();
}
