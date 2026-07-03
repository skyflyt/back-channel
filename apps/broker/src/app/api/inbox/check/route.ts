import { NextRequest, NextResponse } from "next/server";
import { getAccountFromAuth } from "@/lib/auth";
import { waitForInbox, MAX_WAIT_MS } from "@/lib/inbox-bus";
// Side effect: registers the shared pendingCounter with inbox-bus (one
// definition of "pending", shared with /api/inbox/events - see that module).
import "@/lib/inbox-pending";

export const runtime = "nodejs";
// Long-poll `wait` is capped at 300s (MAX_WAIT_MS); give the route headroom
// past that so a full-length wait always has time to respond cleanly.
export const maxDuration = 330;

/**
 * GET /api/inbox/check?wait=<seconds>&since=<ISO8601> - long-poll doorbell
 * (design spec S2b). Bearer-authed. Returns immediately if something is
 * already pending; otherwise holds the connection up to `wait` seconds
 * (capped at 300) and returns the moment fireInboxEvent fires for this
 * account, or an empty-doorbell response at timeout.
 *
 * `since` is currently accepted but advisory only (the bus is absolute-count,
 * not a delta feed - see inbox-bus.mjs's `since` doc) - reserved for a future
 * cursor-based long-poll without a response-shape change.
 *
 * Response: { pending_count, since, timestamp, kinds?, waited_seconds }
 */
export async function GET(req: NextRequest) {
  const account = await getAccountFromAuth(req.headers.get("authorization"));
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const waitParam = url.searchParams.get("wait");
  const waitSeconds = waitParam != null ? Number(waitParam) : 0;
  if (waitParam != null && (!Number.isFinite(waitSeconds) || waitSeconds < 0)) {
    return NextResponse.json({ error: "invalid_wait" }, { status: 400 });
  }
  if (waitSeconds * 1000 > MAX_WAIT_MS) {
    return NextResponse.json({ error: "wait_too_large", detail: `max ${MAX_WAIT_MS / 1000}s` }, { status: 400 });
  }
  const waitMs = Math.min(Math.max(waitSeconds, 0) * 1000, MAX_WAIT_MS);

  const result = await waitForInbox(account.id, waitMs);
  return NextResponse.json(result);
}