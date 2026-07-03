/**
 * Route tests for GET /api/inbox/events (SSE doorbell). Runs the actual route
 * handler with @/lib/auth and @/lib/inbox-pending mocked out - no Postgres
 * needed. Reads the streamed Response body directly (no real network hop).
 */
import { test, mock, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

const ACCOUNT = { id: "acct-1", handle: "tester@bc" };

before(() => {
  mock.module("@/lib/auth", {
    namedExports: {
      getAccountFromAuth: async (header) => (header === "Bearer good" ? ACCOUNT : null),
    },
  });
  mock.module("@/lib/inbox-pending", { namedExports: { pendingCount: async () => ({ count: 0, kinds: [] }) } });
});

beforeEach(async () => {
  const { _reset, setPendingCounter } = await import("@/lib/inbox-bus.mjs");
  _reset();
  setPendingCounter(async () => ({ count: 0, kinds: [] }));
});

/** Read chunks off a Response body until `predicate` is true or `maxChunks` is hit. */
async function readUntil(body, predicate, maxChunks = 10) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (let i = 0; i < maxChunks; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (predicate(text)) break;
  }
  await reader.cancel().catch(() => {});
  return text;
}
test("401 when no/invalid bearer (stream never opens)", async () => {
  const { GET } = await import("@/app/api/inbox/events/route");
  const req = new Request("https://back-channel.app/api/inbox/events", { headers: { authorization: "Bearer bad" } });
  const res = await GET(req);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("content-type"), "application/json");
});

test("200 with SSE headers on a good bearer", async () => {
  const { GET } = await import("@/app/api/inbox/events/route");
  const ac = new AbortController();
  const req = new Request("https://back-channel.app/api/inbox/events", {
    headers: { authorization: "Bearer good" },
    signal: ac.signal,
  });
  const res = await GET(req);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(res.headers.get("cache-control"), "no-cache, no-transform");
  assert.equal(res.headers.get("connection"), "keep-alive");
  assert.equal(res.headers.get("x-accel-buffering"), "no");
  ac.abort();
});

test("first event is `ready` with a metadata-only snapshot", async () => {
  const { setPendingCounter } = await import("@/lib/inbox-bus.mjs");
  setPendingCounter(async () => ({ count: 3, kinds: ["frame", "invite"] }));
  const { GET } = await import("@/app/api/inbox/events/route");

  const ac = new AbortController();
  const req = new Request("https://back-channel.app/api/inbox/events", {
    headers: { authorization: "Bearer good" },
    signal: ac.signal,
  });
  const res = await GET(req);
  const text = await readUntil(res.body, (t) => t.includes("\n\n"));
  ac.abort();

  assert.match(text, /^event: ready\nid: 0\ndata: /);
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  const payload = JSON.parse(dataLine.slice("data: ".length));
  assert.equal(payload.pending_count, 3);
  assert.deepEqual(payload.kinds.sort(), ["frame", "invite"]);
  assert.ok(payload.since && payload.timestamp);
  // Content-blind: nothing beyond the four documented metadata fields.
  assert.deepEqual(Object.keys(payload).sort(), ["kinds", "pending_count", "since", "timestamp"]);
});
test("a second connect for the same account replaces the first stream", async () => {
  const { GET } = await import("@/app/api/inbox/events/route");

  const ac1 = new AbortController();
  const req1 = new Request("https://back-channel.app/api/inbox/events", { headers: { authorization: "Bearer good" }, signal: ac1.signal });
  const res1 = await GET(req1);
  // Drain the `ready` event first so the reader is positioned past it.
  const reader1 = res1.body.getReader();
  await reader1.read();

  const ac2 = new AbortController();
  const req2 = new Request("https://back-channel.app/api/inbox/events", { headers: { authorization: "Bearer good" }, signal: ac2.signal });
  const res2 = await GET(req2);

  const { value } = await reader1.read();
  const text = new TextDecoder().decode(value);
  assert.match(text, /^event: replaced\n/, "the FIRST stream is told it was replaced");

  await reader1.cancel().catch(() => {});
  ac1.abort();
  ac2.abort();
  await res2.body.cancel().catch(() => {});
});

test("you-have-mail fires on the held stream when fireInboxEvent runs for that account", async () => {
  const { setPendingCounter, fireInboxEvent } = await import("@/lib/inbox-bus.mjs");
  setPendingCounter(async () => ({ count: 1, kinds: ["frame"] }));
  const { GET } = await import("@/app/api/inbox/events/route");

  const ac = new AbortController();
  const req = new Request("https://back-channel.app/api/inbox/events", { headers: { authorization: "Bearer good" }, signal: ac.signal });
  const res = await GET(req);
  const reader = res.body.getReader();
  await reader.read(); // drain `ready`

  fireInboxEvent(ACCOUNT.id, "frame");
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);

  assert.match(text, /^event: you-have-mail\nid: 1\ndata: /);
  const payload = JSON.parse(text.split("data: ")[1]);
  assert.equal(payload.pending_count, 1);

  await reader.cancel().catch(() => {});
  ac.abort();
});