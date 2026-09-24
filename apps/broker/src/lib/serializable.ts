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
  retryable?: (e: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};
const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// Bounded: at most `attempts` tries and, with the defaults, at most 10+20+40+80 =
// 150ms of sleep, so a caller behind an HTTP request never stalls on contention.
// Equal jitter (half fixed, half random) de-synchronises colliding requests (the
// losers of one conflict would otherwise collide again in lockstep) while
// guaranteeing each retry actually waits for the winner to commit.
export async function withSerializableRetry<T>(run: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { attempts = 5, baseMs = 10, capMs = 80, retryable = isSerializationFailure, sleep = pause, random = Math.random } = opts;
  for (let attempt = 1; ; attempt++) {
    try { return await run(); } catch (e) {
      if (attempt >= attempts || !retryable(e)) throw e;
      const ceiling = Math.min(capMs, baseMs * 2 ** (attempt - 1));
      await sleep(ceiling / 2 + random() * (ceiling / 2));
    }
  }
}
