// PostgreSQL SERIALIZABLE aborts a transaction whenever it cannot prove a serial
// order (SQLSTATE 40001) or picks it as a deadlock victim (40P01). The documented
// contract is that the client re-runs the WHOLE transaction: the aborted attempt
// rolled back completely, so re-running the callback is exactly-once for its writes.
// Anything else (validation failures, not-found, a real outage) is not retried.
//
// Prisma 5 surfaces these aborts in more than one shape, and a predicate that only
// knows one of them silently turns a routine conflict into a hard 503:
//   - PrismaClientKnownRequestError code P2034 ("write conflict or a deadlock"), the
//     usual shape for a statement inside an interactive transaction;
//   - meta.code "40001"/"40P01" (P2010 raw-query failures carry the SQLSTATE there);
//   - PrismaClientUnknownRequestError / P2028 "Transaction API error" whose message
//     carries the server text or SQLSTATE, e.g. a read/write-dependency abort at COMMIT;
//   - a bare driver error with code "40001"/"40P01" (driver adapters, pg).
const SQLSTATE = new Set(["40001", "40P01"]);
// Server text, or the SQLSTATE in the engine's debug dump (survives localized lc_messages).
const MESSAGE = /could not serialize access|deadlock detected|\bcode:\s*"?(?:40001|40P01)\b/i;

export function isSerializationFailure(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const { code, meta, message } = e as { code?: unknown; meta?: { code?: unknown }; message?: unknown };
  if (code === "P2034" || (typeof code === "string" && SQLSTATE.has(code))) return true;
  if (typeof meta?.code === "string" && SQLSTATE.has(meta.code)) return true;
  return typeof message === "string" && MESSAGE.test(message);
}

export type RetryOptions = {
  attempts?: number; // total tries, including the first
  baseMs?: number; // first backoff ceiling; doubles per retry
  capMs?: number; // per-retry backoff ceiling
  jitter?: "equal" | "full"; // equal: sleep in [ceiling/2, ceiling]; full: anywhere in [0, ceiling]
  deadlineMs?: number; // give up rather than start a sleep that would end later than this after the first try
  retryable?: (e: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
};
const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// Bounded: at most `attempts` tries and, with the defaults, at most 10+20+40+80 =
// 150ms of sleep, so a caller behind an HTTP request never stalls on contention.
// Equal jitter (half fixed, half random) de-synchronises colliding requests (the
// losers of one conflict would otherwise collide again in lockstep) while making
// each retry wait at least half its ceiling. That suits a conflict over one row:
// the loser waits on the winner's row lock and aborts the moment it commits.
// A crowd racing on one predicate needs more room: CONTENTION_RETRY.
export async function withSerializableRetry<T>(run: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { attempts = 5, baseMs = 10, capMs = 80, jitter = "equal", deadlineMs = Infinity, retryable = isSerializationFailure, sleep = pause, random = Math.random, now = Date.now } = opts;
  const started = now();
  for (let attempt = 1; ; attempt++) {
    try { return await run(); } catch (e) {
      if (attempt >= attempts || !retryable(e)) throw e;
      const ceiling = Math.min(capMs, baseMs * 2 ** (attempt - 1));
      const ms = jitter === "full" ? random() * ceiling : ceiling / 2 + random() * (ceiling / 2);
      if (now() - started + ms > deadlineMs) throw e;
      await sleep(ms);
    }
  }
}

// For transactions that race as a crowd on one predicate, not on one row: every AppBridge redeem reads the
// account's live leases for the caps and inserts one. Row locks cannot order a crowd like that; SSI cancels
// all but one member per round ("Canceled on identification as a pivot"), sometimes that one as well, so N
// concurrent requests need at least N rounds, each as long as the winner's transaction. The defaults above
// fit 5 rounds into ~150ms: on a busy CI runner four redeems racing for one account (a phone's pooled
// connections) intermittently ran out, and three of them got the 503 ([200,503,503,503], 2026-10-10), the
// three losers retrying within 10ms of each other in every round. So, for that shape:
//  - 10 attempts: room for a crowd of 8 (one remote's pairs across its PCs) plus cancelled rounds;
//  - ceilings doubling from 10ms to 320ms: the window soon outgrows N transactions, so the crowd spreads
//    out and commits one at a time instead of colliding again;
//  - full jitter: a retry lands anywhere under its ceiling, not bunched in the top half with the others;
//  - a 2s deadline: however slow the host, an HTTP caller gets the retryable 503 within about 2s.
export const CONTENTION_RETRY = { attempts: 10, baseMs: 10, capMs: 320, jitter: "full", deadlineMs: 2000 } as const satisfies RetryOptions;
