import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  fireListsChanged, subscribeListsStream, unsubscribeListsStream, listsStreamCount, writeEvent, _reset, MAX_STREAMS_PER_ACCOUNT,
} from "./bus.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function writer() {
  const w = { chunks: [], closed: false, write: (c) => w.chunks.push(c), close: () => { w.closed = true; } };
  return w;
}
const events = (w) => w.chunks.map((c) => {
  const [, event] = /^event: (.+)$/m.exec(c) ?? [];
  const [, data] = /^data: (.+)$/m.exec(c) ?? [];
  return { event, data: data ? JSON.parse(data) : null };
});

beforeEach(() => _reset({ coalesceMs: 5 }));

test("writeEvent writes one SSE event: event, id, data, blank line", () => {
  const w = writer();
  writeEvent(w, "changed", 3, { at: "2026-10-09T12:00:00.000Z" });
  assert.equal(w.chunks[0], 'event: changed\nid: 3\ndata: {"at":"2026-10-09T12:00:00.000Z"}\n\n');
  writeEvent(w, "heartbeat", null, { at: "x" });
  assert.equal(w.chunks[1], 'event: heartbeat\ndata: {"at":"x"}\n\n', "no id line");
});

test("a change reaches every stream the account holds, carrying only {at}", async () => {
  const a = writer();
  const b = writer();
  subscribeListsStream("acct-a", a);
  subscribeListsStream("acct-a", b);
  fireListsChanged("acct-a");
  await wait(20);
  for (const w of [a, b]) {
    const evs = events(w);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].event, "changed");
    assert.deepEqual(Object.keys(evs[0].data), ["at"], "metadata only");
    assert.ok(Number.isFinite(Date.parse(evs[0].data.at)));
  }
});

test("a burst of changes coalesces into one event; other accounts hear nothing", async () => {
  const a = writer();
  const other = writer();
  subscribeListsStream("acct-a", a);
  subscribeListsStream("acct-b", other);
  for (let i = 0; i < 10; i++) fireListsChanged("acct-a");
  await wait(20);
  assert.equal(events(a).length, 1);
  assert.equal(other.chunks.length, 0);
  fireListsChanged("acct-a");
  await wait(20);
  assert.deepEqual(events(a).map((e) => e.event), ["changed", "changed"], "the next burst is a new event");
  assert.match(a.chunks[1], /^event: changed\nid: 2\n/, "ids increase per account");
});

test("at most two streams per account: a third closes the oldest with `replaced`", async () => {
  assert.equal(MAX_STREAMS_PER_ACCOUNT, 2);
  const [first, second, third] = [writer(), writer(), writer()];
  subscribeListsStream("acct-a", first);
  subscribeListsStream("acct-a", second);
  assert.equal(listsStreamCount("acct-a"), 2);
  subscribeListsStream("acct-a", third);
  assert.equal(listsStreamCount("acct-a"), 2);
  assert.deepEqual(events(first), [{ event: "replaced", data: { reason: "too_many_streams" } }]);
  assert.equal(first.closed, true);
  assert.equal(second.closed, false);
  fireListsChanged("acct-a");
  await wait(20);
  assert.equal(events(first).length, 1, "the closed stream hears nothing more");
  assert.equal(events(second).length, 1);
  assert.equal(events(third).length, 1);
});

test("unsubscribing drops the stream (twice is harmless), and a change with no stream is a no-op", async () => {
  const a = writer();
  subscribeListsStream("acct-a", a);
  unsubscribeListsStream("acct-a", a);
  unsubscribeListsStream("acct-a", a);
  assert.equal(listsStreamCount("acct-a"), 0);
  assert.equal(listsStreamCount(), 0);
  fireListsChanged("acct-a");
  fireListsChanged("");
  await wait(20);
  assert.equal(a.chunks.length, 0);
});

test("a stream that throws on write doesn't stop the others", async () => {
  const bad = { write: () => { throw new Error("gone"); } };
  const good = writer();
  subscribeListsStream("acct-a", bad);
  subscribeListsStream("acct-a", good);
  fireListsChanged("acct-a");
  await wait(20);
  assert.equal(events(good).length, 1);
});
