import { NextRequest } from "next/server";
import { getAccountFromAuth } from "@/lib/auth";
import {
  subscribeSse,
  unsubscribeSse,
  writeSseEvent,
  writeSseHeartbeat,
  currentEvent,
} from "@/lib/inbox-bus";
// Side effect: registers the shared pendingCounter with inbox-bus (one
// definition of "pending", shared with /api/inbox/check - see that module).
import "@/lib/inbox-pending";

export const runtime = "nodejs";
// SSE streams live as long as the client holds them; Cloud Run's configured
// service timeout is the real ceiling (see docs/inbox-doorbell.md - "Cloud Run
// timeout handling"). maxDuration documents our intent; it does not itself
// raise the platform limit.
export const maxDuration = 3600;

const HEARTBEAT_MS = 25_000;

/**
 * GET /api/inbox/events - SSE doorbell (design spec S2a). Bearer-authed, same
 * as every other account API. Holds the connection open; sends a `ready`
 * snapshot immediately, then a `you-have-mail` event whenever fireInboxEvent
 * fires for this account, plus a heartbeat comment every ~25s so proxies don't
 * reap an idle stream. One stream per account - a second connect replaces the
 * first (`event: replaced`).
 *
 * Metadata only: { pending_count, since, timestamp, kinds }. No frame content,
 * topics, or anything user-authored ever crosses this endpoint.
 */
export async function GET(req: NextRequest) {
  const account = await getAccountFromAuth(req.headers.get("authorization"));
  if (!account) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });

  const accountId = account.id;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  // Hoisted so start() and cancel()/abort both close over the SAME writer
  // object - unsubscribeSse keys off reference identity (a Set<SseWriter>),
  // so passing a fresh object at cancel time would silently no-op.
  let writer: { write(chunk: string): void; close(): void } | null = null;

  // Cleanup used by BOTH the abort listener and the stream's cancel(). Safe to
  // call more than once (idempotent via `closed`).
  function cleanup(controller?: ReadableStreamDefaultController<Uint8Array>) {
    if (closed) return;
    closed = true;
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (writer) unsubscribeSse(accountId, writer);
    if (controller) { try { controller.close(); } catch {} }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Registered BEFORE any await below, so a client that disconnects
      // immediately (e.g. abort() called right after fetch resolves) can
      // never race past this listener and leak the heartbeat interval - the
      // bug this comment is guarding against was caught by the route tests.
      req.signal.addEventListener("abort", () => cleanup(controller));

      const encoder = new TextEncoder();
      writer = {
        write(chunk: string) {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            // Controller already closed (client disconnected mid-write) - the
            // request's abort handler already ran (or will) cleanup().
          }
        },
        close() {
          cleanup(controller);
        },
      };

      void (async () => {
        if (closed) return; // aborted synchronously, before this IIFE ran at all
        const { lastEventId } = subscribeSse(accountId, writer!);

        // `ready`: immediate snapshot, doubling as the session-start sync -
        // "what came in while I was away" is just a non-zero pending_count here.
        const snap = await currentEvent(accountId);
        if (closed) { unsubscribeSse(accountId, writer!); return; } // aborted mid-query
        writeSseEvent(writer!, "ready", lastEventId, snap);

        if (!closed) heartbeatTimer = setInterval(() => writer && writeSseHeartbeat(writer), HEARTBEAT_MS);
      })();
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
      "x-accel-buffering": "no", // disable proxy buffering (nginx-style intermediaries)
    },
  });
}