import { test } from "node:test";
import assert from "node:assert/strict";
import { createListsFeed, createSharedFeed, POLL_MS, RETRY_MS, STALE_MS } from "./live.mjs";

/** Fake timers driven by advance(). */
function clock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const add = (fn, ms, every) => {
    const id = ++seq;
    timers.set(id, { at: now + ms, fn, every });
    return id;
  };
  return {
    timers: {
      setTimeout: (fn, ms) => add(fn, ms, 0),
      clearTimeout: (id) => timers.delete(id),
      setInterval: (fn, ms) => add(fn, ms, ms),
      clearInterval: (id) => timers.delete(id),
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, x] = due;
        now = x.at;
        if (x.every) x.at += x.every;
        else timers.delete(id);
        x.fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A fake EventSource the test drives. */
function streams() {
  const opened = [];
  return {
    opened,
    open: () => {
      const handlers = {};
      const s = {
        closed: false,
        addEventListener: (type, fn) => { (handlers[type] ??= []).push(fn); },
        close: () => { s.closed = true; },
        emit: (type, data) => { for (const fn of handlers[type] ?? []) fn({ data: data === undefined ? undefined : JSON.stringify(data) }); },
      };
      opened.push(s);
      return s;
    },
    get last() { return opened.at(-1); },
  };
}

function setup({ stream = true, visible = true, changed = false } = {}) {
  const c = clock();
  const s = streams();
  const page = { visible, loads: 0, fetches: [], changed, failFetch: false, onVis: null };
  let n = 0;
  const feed = createListsFeed({
    onChange: () => { page.loads++; },
    fetchChanges: async (since) => {
      page.fetches.push(since);
      if (page.failFetch) throw new Error("offline");
      return { at: `t${++n}`, changed: page.changed };
    },
    openStream: stream ? s.open : null,
    isVisible: () => page.visible,
    watchVisibility: (fn) => { page.onVis = fn; return () => { page.onVis = null; }; },
    timers: c.timers,
  });
  return { c, s, page, feed };
}

test("no EventSource: the initial load, then a poll every 10 s while the page is visible", async () => {
  const { c, page, feed } = setup({ stream: false });
  feed.start();
  await flush();
  assert.equal(page.loads, 1, "the first check is the initial load");
  assert.deepEqual(page.fetches, [null]);
  assert.equal(feed.state(), "polling");
  await c.advance(POLL_MS);
  assert.deepEqual(page.fetches, [null, "t1"]);
  assert.equal(page.loads, 1, "nothing changed");
  page.changed = true;
  await c.advance(POLL_MS);
  assert.equal(page.loads, 2);
  page.visible = false;
  await c.advance(POLL_MS * 3);
  assert.equal(page.fetches.length, 3, "a hidden page doesn't poll");
  page.visible = true;
  page.onVis();
  await flush();
  assert.equal(page.fetches.length, 4, "coming back checks at once");
  feed.stop();
  await c.advance(POLL_MS * 3);
  assert.equal(page.fetches.length, 4, "stopped means stopped");
  assert.equal(page.onVis, null);
});

test("stream: polls until ready, then stops polling, catches up once, and reloads on each `changed`", async () => {
  const { c, s, page, feed } = setup();
  feed.start();
  await flush();
  assert.equal(s.opened.length, 1);
  assert.equal(feed.state(), "connecting");
  await c.advance(POLL_MS);
  assert.equal(page.fetches.length, 2, "still polling while connecting");
  s.last.emit("ready", { at: "r" });
  await flush();
  assert.equal(feed.state(), "streaming");
  assert.equal(page.fetches.length, 3, "one catch-up check when the stream opens");
  await c.advance(POLL_MS * 5);
  assert.equal(page.fetches.length, 3, "no polling while the stream is up");
  s.last.emit("changed", { at: "2026-10-09T12:00:00.000Z" });
  assert.equal(page.loads, 2);
  s.last.emit("heartbeat", { at: "h" });
  await c.advance(STALE_MS - 1);
  assert.equal(feed.state(), "streaming", "heartbeats and changes keep it alive");
  feed.stop();
  assert.equal(s.last.closed, true);
});

test("after a `changed`, a fallback poll asks only for what came after it", async () => {
  const { c, s, page, feed } = setup();
  feed.start();
  await flush();
  s.last.emit("ready", {});
  await flush();
  s.last.emit("changed", { at: "2026-10-09T12:00:00.000Z" });
  s.last.emit("error");
  await c.advance(POLL_MS);
  assert.equal(page.fetches.at(-1), "2026-10-09T12:00:00.000Z");
});

test("a stream error falls back to polling and retries with backoff: 15 s, then 30 s", async () => {
  const { c, s, page, feed } = setup();
  feed.start();
  await flush();
  s.last.emit("ready", {});
  await flush();
  const before = page.fetches.length;
  s.last.emit("error");
  assert.equal(feed.state(), "polling");
  assert.equal(s.opened[0].closed, true);
  await c.advance(POLL_MS);
  assert.equal(page.fetches.length, before + 1, "polling again");
  await c.advance(RETRY_MS - POLL_MS);
  assert.equal(s.opened.length, 2, "retried after 15 s");
  s.last.emit("error");
  await c.advance(RETRY_MS);
  assert.equal(s.opened.length, 2, "the second retry waits longer");
  await c.advance(RETRY_MS);
  assert.equal(s.opened.length, 3, "after 30 s");
  s.last.emit("ready", {});
  await flush();
  assert.equal(feed.state(), "streaming");
  s.last.emit("error");
  await c.advance(RETRY_MS);
  assert.equal(s.opened.length, 4, "a stream that reached ready resets the backoff");
  feed.stop();
});

test("a stream that goes quiet past its heartbeat is treated as broken", async () => {
  const { c, s, feed } = setup();
  feed.start();
  await flush();
  s.last.emit("ready", {});
  await flush();
  await c.advance(STALE_MS);
  assert.equal(feed.state(), "polling");
  assert.equal(s.opened[0].closed, true);
  await c.advance(RETRY_MS);
  assert.equal(s.opened.length, 2);
  feed.stop();
});

test("`replaced` (a newer tab took the slot): poll, and reconnect only when the page is looked at again", async () => {
  const { c, s, page, feed } = setup();
  feed.start();
  await flush();
  s.last.emit("ready", {});
  await flush();
  s.last.emit("replaced", { reason: "too_many_streams" });
  assert.equal(feed.state(), "polling");
  await c.advance(MAX());
  assert.equal(s.opened.length, 1, "no retry loop between tabs");
  page.visible = false;
  page.onVis();
  page.visible = true;
  page.onVis();
  await flush();
  assert.equal(s.opened.length, 2, "looked at again: take a stream back");
  feed.stop();
});
const MAX = () => 10 * 60_000;

test("a change while the page is hidden waits until it's visible, then checks", async () => {
  const { c, s, page, feed } = setup();
  feed.start();
  await flush();
  s.last.emit("ready", {});
  await flush();
  const fetches = page.fetches.length;
  page.visible = false;
  s.last.emit("changed", { at: "x" });
  assert.equal(page.loads, 1, "no reload in a hidden tab");
  page.visible = true;
  page.changed = true;
  page.onVis();
  await flush();
  assert.equal(page.fetches.length, fetches + 1);
  assert.equal(page.loads, 2);
  await c.advance(1);
  feed.stop();
});

test("opening the stream throws: poll and retry; an offline first check still lets the page load", async () => {
  const c = clock();
  let opens = 0;
  const page = { loads: 0 };
  const feed = createListsFeed({
    onChange: () => { page.loads++; },
    fetchChanges: async () => { throw new Error("offline"); },
    openStream: () => { opens++; throw new Error("blocked"); },
    isVisible: () => true,
    timers: c.timers,
  });
  feed.start();
  await flush();
  assert.equal(page.loads, 1, "the page loads and shows its own error");
  assert.equal(feed.state(), "polling");
  await c.advance(RETRY_MS);
  assert.equal(opens, 2);
  feed.stop();
});

test("shared feed: one feed for the page; a later subscriber gets its own initial load; the last one out stops it", async () => {
  let made = 0;
  let started = 0;
  let stopped = 0;
  let fire = () => {};
  const shared = createSharedFeed((onChange) => {
    made++;
    fire = onChange;
    return { start: () => { started++; onChange(); }, stop: () => { stopped++; }, visible: () => {}, state: () => "streaming" };
  });
  const calls = { a: 0, b: 0 };
  const offA = shared.subscribe(() => calls.a++);
  assert.deepEqual([made, started, calls.a], [1, 1, 1]);
  const offB = shared.subscribe(() => calls.b++);
  await flush();
  assert.equal(made, 1, "still one feed");
  assert.equal(calls.b, 1, "B loads at once");
  fire();
  assert.deepEqual(calls, { a: 2, b: 2 });
  offA();
  assert.equal(stopped, 0);
  offB();
  assert.equal(stopped, 1);
  assert.equal(shared.state(), "stopped");
  shared.subscribe(() => {})();
  assert.equal(made, 2, "a new subscriber after that starts a fresh feed");
});
