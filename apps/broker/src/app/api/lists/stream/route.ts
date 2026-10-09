import { NextRequest } from "next/server";
// Namespace imports: route tests replace these modules with a few named exports.
import * as auth from "@/lib/auth";
import * as rl from "@/lib/rate-limit";
import * as listsBus from "@/lib/lists/bus.mjs";

export const runtime = "nodejs";
// The stream lives as long as the page holds it; Cloud Run's service timeout is the real ceiling,
// and the page reconnects (or falls back to polling) when it ends.
export const maxDuration = 3600;

const HEARTBEAT_MS = 25_000;

const refuse = (status: number, error: string, message: string) =>
  new Response(JSON.stringify({ error, message }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/**
 * Only the dashboard's own pages may open the stream. The session cookie is
 * SameSite=Lax, so a cross-site page's request doesn't carry it; on top of
 * that, refuse anything the browser marks as coming from another site, and any
 * Origin other than this app's own.
 */
function fromElsewhere(req: NextRequest): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true;
  const origin = req.headers.get("origin");
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return true;
  }
  const own = new Set([req.headers.get("host"), req.nextUrl.host]);
  try {
    own.add(new URL(process.env.PUBLIC_APP_URL ?? "https://back-channel.app").host);
  } catch {
    // a malformed PUBLIC_APP_URL adds nothing
  }
  return !own.has(host);
}

/**
 * GET /api/lists/stream: the Lists tab's live updates (docs/lists.md, "Live
 * updates"). Cookie-authenticated SSE for the dashboard; an agent key is
 * refused (agents hear about tasks through the inbox doorbell). GET needs no
 * CSRF token, so the request must come from this app's own pages.
 *
 * Events, all metadata: `ready` {at} on connect; `changed` {at} after any
 * write to a list or task this person can see (src/lib/lists.ts announce());
 * `heartbeat` {at} every 25 seconds; `replaced` when a newer stream takes this
 * one's slot (at most two per account). Never a name, title or who did what:
 * the page reloads through the normal routes, which check access again.
 */
export async function GET(req: NextRequest) {
  if (req.headers.get("authorization")) {
    return refuse(403, "people_only", "The live stream is for the Back Channel dashboard. Agents hear about tasks through the inbox doorbell.");
  }
  if (fromElsewhere(req)) return refuse(403, "cross_site", "The live stream only opens from Back Channel's own pages.");
  const account = await auth.getAccountFromCookie(req.cookies.get(auth.SESSION_COOKIE_NAME)?.value);
  if (!account) return refuse(401, "unauthorized", "Unauthorized");
  const limit = rl.rateLimit("lists-stream", account.id, 30, 60_000);
  if (!limit.ok) {
    const res = refuse(429, "rate_limited", "Too many reconnects. The page will poll for a while.");
    res.headers.set("Retry-After", String(limit.retryAfterSec));
    return res;
  }

  const accountId = account.id;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  // One writer object for subscribe and unsubscribe: the bus keys streams by identity.
  let writer: { write(chunk: string): void; close(): void } | null = null;

  function cleanup(controller?: ReadableStreamDefaultController<Uint8Array>) {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    if (writer) listsBus.unsubscribeListsStream(accountId, writer);
    if (controller) {
      try {
        controller.close();
      } catch {
        // already closed
      }
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Before anything else, so a client that goes away at once can't leak the heartbeat.
      req.signal.addEventListener("abort", () => cleanup(controller));
      const encoder = new TextEncoder();
      writer = {
        write(chunk: string) {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            // the client went away mid-write; abort runs cleanup
          }
        },
        close() {
          cleanup(controller);
        },
      };
      if (req.signal.aborted) {
        cleanup(controller);
        return;
      }
      const { lastEventId } = listsBus.subscribeListsStream(accountId, writer);
      listsBus.writeEvent(writer, "ready", lastEventId, { at: new Date().toISOString() });
      heartbeat = setInterval(() => {
        if (writer) listsBus.writeEvent(writer, "heartbeat", null, { at: new Date().toISOString() });
      }, HEARTBEAT_MS);
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
