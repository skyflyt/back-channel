/**
 * Tests for the per-account inbox event bus (the doorbell). Zero-dependency -
 * uses Node's built-in test runner, mirrors rate-limit.test.mjs. Run from
 * apps/broker with: node --test src/lib/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fireInboxEvent,
  setPendingCounter,
  currentEvent,
  subscribeSse,
  unsubscribeSse,
  waitForInbox,
  heldStreamCount,
  MAX_WAIT_MS,
  MAX_LONGPOLL_WAITERS_PER_ACCOUNT,
  TooManyWaitersError,
  _reset,
} from "./inbox-bus.mjs";

/** A fake SSE writer that records every chunk written to it. */
function fakeWriter() {
  const chunks = [];
  let closed = false;
  return {
    chunks,
    get closed() { return closed; },
    write(chunk) { chunks.push(chunk); },
    close() { closed = true; },
  };
}

/** Install a counter that returns a fixed { count, kinds } per accountId. */
function stubCounter(map) {
  setPendingCounter(async (accountId) => map[accountId] ?? { count: 0, kinds: [] });
}

test("subscribeSse + fireInboxEvent delivers a you-have-mail event to the writer", async () => {
  _reset();
  stubCounter({ acct1: { count: 1, kinds: ["frame"] } });
  const w = fakeWriter();
  subscribeSse("acct1", w);

  fireInboxEvent("acct1", "frame");
  // Coalesce window is 300ms; wait past it.
  await new Promise((r) => setTimeout(r, 350));

  assert.equal(w.chunks.length, 1, "exactly one coalesced event delivered");
  assert.match(w.chunks[0], /^event: you-have-mail\nid: 1\ndata: /);
  const payload = JSON.parse(w.chunks[0].split("data: ")[1]);
  assert.equal(payload.pending_count, 1);
  assert.deepEqual(payload.kinds, ["frame"]);
  assert.ok(payload.since);
  assert.ok(payload.timestamp);
});

test("rapid fires within the coalesce window collapse into ONE event with cumulative kinds", async () => {
  _reset();
  stubCounter({ acct1: { count: 3, kinds: ["frame", "invite"] } });
  const w = fakeWriter();
  subscribeSse("acct1", w);

  fireInboxEvent("acct1", "frame");
  fireInboxEvent("acct1", "frame");
  fireInboxEvent("acct1", "invite");
  await new Promise((r) => setTimeout(r, 350));

  assert.equal(w.chunks.length, 1, "burst collapses to one delivered event");
  const payload = JSON.parse(w.chunks[0].split("data: ")[1]);
  assert.deepEqual(payload.kinds.sort(), ["frame", "invite"]);
});

test("unsubscribeSse stops further delivery to that writer", async () => {
  _reset();
  stubCounter({ acct1: { count: 1, kinds: ["frame"] } });
  const w = fakeWriter();
  subscribeSse("acct1", w);
  unsubscribeSse("acct1", w);

  fireInboxEvent("acct1", "frame");
  await new Promise((r) => setTimeout(r, 350));

  assert.equal(w.chunks.length, 0, "no event delivered after unsubscribe");
});
test("multiple SSE subscribers on DIFFERENT accounts each get their own event, no cross-account leaks", async () => {
  _reset();
  stubCounter({
    acct1: { count: 1, kinds: ["frame"] },
    acct2: { count: 2, kinds: ["payload"] },
  });
  const w1 = fakeWriter();
  const w2 = fakeWriter();
  subscribeSse("acct1", w1);
  subscribeSse("acct2", w2);

  fireInboxEvent("acct1", "frame");
  await new Promise((r) => setTimeout(r, 350));

  assert.equal(w1.chunks.length, 1, "acct1's writer got the event");
  assert.equal(w2.chunks.length, 0, "acct2's writer got NOTHING - no cross-account leak");

  fireInboxEvent("acct2", "payload");
  await new Promise((r) => setTimeout(r, 350));

  assert.equal(w1.chunks.length, 1, "acct1 unaffected by acct2's event");
  assert.equal(w2.chunks.length, 1, "acct2 now has its own event");
  const p2 = JSON.parse(w2.chunks[0].split("data: ")[1]);
  assert.equal(p2.pending_count, 2);
});

test("a second SSE subscribe on the SAME account replaces the first (one stream per account)", async () => {
  _reset();
  stubCounter({ acct1: { count: 0, kinds: [] } });
  const w1 = fakeWriter();
  const w2 = fakeWriter();
  subscribeSse("acct1", w1);
  subscribeSse("acct1", w2);

  assert.equal(w1.chunks.length, 1, "the replaced writer got a `replaced` event");
  assert.match(w1.chunks[0], /^event: replaced\n/);
  assert.ok(w1.closed, "the replaced writer was closed");
  assert.equal(heldStreamCount(), 1, "only ONE stream held for the account afterward");

  fireInboxEvent("acct1", "frame");
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(w2.chunks.length, 1, "the new (surviving) writer gets subsequent events");
  assert.equal(w1.chunks.length, 1, "the replaced writer gets nothing further");
});

test("currentEvent returns a zero snapshot when no counter is registered", async () => {
  _reset();
  const evt = await currentEvent("acct-unknown");
  assert.equal(evt.pending_count, 0);
  assert.equal(evt.kinds, undefined, "kinds omitted when empty");
  assert.ok(evt.since);
  assert.ok(evt.timestamp);
});

test("waitForInbox resolves immediately when pending_count > 0 (no waiting)", async () => {
  _reset();
  stubCounter({ acct1: { count: 5, kinds: ["frame"] } });
  const start = Date.now();
  const result = await waitForInbox("acct1", 10_000);
  const elapsed = Date.now() - start;

  assert.equal(result.pending_count, 5);
  assert.ok(elapsed < 100, `resolved immediately (took ${elapsed}ms)`);
  assert.equal(result.waited_seconds, 0);
});
test("waitForInbox parks and resolves the instant fireInboxEvent fires (no polling-interval lag)", async () => {
  _reset();
  stubCounter({ acct1: { count: 0, kinds: [] } });
  const start = Date.now();
  const pending = waitForInbox("acct1", 5000);

  setTimeout(() => {
    stubCounter({ acct1: { count: 1, kinds: ["frame"] } });
    fireInboxEvent("acct1", "frame");
  }, 50);

  const result = await pending;
  const elapsed = Date.now() - start;

  assert.equal(result.pending_count, 1);
  // Coalesce (300ms) + the 50ms delay above, well under the 5s wait cap.
  assert.ok(elapsed < 1000, `resolved promptly on fire (took ${elapsed}ms)`);
});

test("waitForInbox times out with an empty-doorbell response when nothing arrives", async () => {
  _reset();
  stubCounter({ acct1: { count: 0, kinds: [] } });
  const result = await waitForInbox("acct1", 100);

  assert.equal(result.pending_count, 0);
  assert.equal(result.kinds, undefined);
  assert.ok(result.waited_seconds >= 0);
});

test("waitForInbox with waitMs<=0 returns the immediate snapshot without parking", async () => {
  _reset();
  stubCounter({ acct1: { count: 0, kinds: [] } });
  const start = Date.now();
  const result = await waitForInbox("acct1", 0);
  const elapsed = Date.now() - start;

  assert.equal(result.pending_count, 0);
  assert.ok(elapsed < 50, `returned immediately (took ${elapsed}ms)`);
});

test("a long-poll waiter on one account is not resolved by another account's event", async () => {
  _reset();
  stubCounter({ acct1: { count: 0, kinds: [] }, acct2: { count: 9, kinds: ["invite"] } });
  const pending = waitForInbox("acct1", 300);

  fireInboxEvent("acct2", "invite");
  await new Promise((r) => setTimeout(r, 350));

  const result = await pending;
  assert.equal(result.pending_count, 0, "acct1's waiter times out unaffected by acct2's event");
});

test("MAX_WAIT_MS matches the design spec's 300s cap", () => {
  assert.equal(MAX_WAIT_MS, 300_000);
});

test("_reset clears all bus state and the registered counter", async () => {
  _reset();
  stubCounter({ acct1: { count: 7, kinds: ["frame"] } });
  const w = fakeWriter();
  subscribeSse("acct1", w);
  assert.equal(heldStreamCount(), 1);

  _reset();
  assert.equal(heldStreamCount(), 0, "all streams cleared");
  const evt = await currentEvent("acct1");
  assert.equal(evt.pending_count, 0, "counter was cleared too - falls back to zero snapshot");
});
// --- L1 (security-pass-2026-07-03.md): per-account long-poll waiter cap -------------------

test(`MAX_LONGPOLL_WAITERS_PER_ACCOUNT mirrors SSE's 1-connection-per-account limit`, () => {
  assert.equal(MAX_LONGPOLL_WAITERS_PER_ACCOUNT, 1);
});

test("a second concurrent long-poll waiter on the SAME account is rejected with TooManyWaitersError, not parked unbounded", async () => {
  _reset();
  stubCounter({ acct1: { count: 0, kinds: [] } });

  // First waiter parks (nothing pending yet) - don't await it yet.
  const first = waitForInbox("acct1", 2000);
  // Give the first call a tick to actually park its waiter before the second arrives.
  await new Promise((r) => setTimeout(r, 10));

  await assert.rejects(() => waitForInbox("acct1", 2000), TooManyWaitersError);

  // The first waiter is unaffected - still resolves normally (e.g. via timeout here).
  const result = await first;
  assert.equal(result.pending_count, 0);
});

test("the cap is per-account: a parked waiter on one account does not block a long-poll on another", async () => {
  _reset();
  stubCounter({ acct1: { count: 0, kinds: [] }, acct2: { count: 0, kinds: [] } });

  const first = waitForInbox("acct1", 300);
  await new Promise((r) => setTimeout(r, 10));

  // Different account - must NOT throw.
  const second = await waitForInbox("acct2", 100);
  assert.equal(second.pending_count, 0);

  await first; // let the first waiter's timer clean up
});

test("once a parked waiter resolves (times out), a new long-poll on that account is accepted again (no permanent lockout)", async () => {
  _reset();
  stubCounter({ acct1: { count: 0, kinds: [] } });

  const first = await waitForInbox("acct1", 100); // resolves via timeout
  assert.equal(first.pending_count, 0);

  // The slot should be free again - this must NOT throw.
  const second = await waitForInbox("acct1", 100);
  assert.equal(second.pending_count, 0);
});

test("the immediate-resolve path (pending mail already waiting) is never capped, even with a waiter already parked", async () => {
  _reset();
  stubCounter({ acct1: { count: 0, kinds: [] } });

  const parked = waitForInbox("acct1", 2000);
  await new Promise((r) => setTimeout(r, 10));

  // Now flip to pending mail and issue a THIRD call for the same account - it
  // should resolve immediately (no parking, so no cap check applies) rather
  // than throwing.
  stubCounter({ acct1: { count: 1, kinds: ["frame"] } });
  const immediate = await waitForInbox("acct1", 2000);
  assert.equal(immediate.pending_count, 1);
  assert.equal(immediate.waited_seconds, 0);

  fireInboxEvent("acct1", "frame");
  await parked;
});