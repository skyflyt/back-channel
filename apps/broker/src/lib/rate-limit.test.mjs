/**
 * Tests for the in-memory rate limiter. Zero-dependency — uses Node's built-in
 * test runner. Run from apps/broker with:  node --test src/lib/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rateLimit, clientIp, _reset } from "./rate-limit.mjs";

test("allows up to the limit, then denies", () => {
  _reset();
  const limit = 3;
  for (let i = 0; i < limit; i++) {
    const r = rateLimit("t", "k", limit, 60_000);
    assert.equal(r.ok, true, `event ${i + 1} should be allowed`);
  }
  const denied = rateLimit("t", "k", limit, 60_000);
  assert.equal(denied.ok, false);
  assert.ok(denied.retryAfterSec > 0, "denied response carries Retry-After");
});

test("buckets are isolated by bucket name and key", () => {
  _reset();
  assert.equal(rateLimit("a", "k1", 1, 60_000).ok, true);
  assert.equal(rateLimit("a", "k1", 1, 60_000).ok, false); // k1 exhausted
  assert.equal(rateLimit("a", "k2", 1, 60_000).ok, true); // different key, fresh
  assert.equal(rateLimit("b", "k1", 1, 60_000).ok, true); // different bucket, fresh
});

test("window resets after it expires", async () => {
  _reset();
  assert.equal(rateLimit("w", "k", 1, 20).ok, true);
  assert.equal(rateLimit("w", "k", 1, 20).ok, false);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(rateLimit("w", "k", 1, 20).ok, true, "fresh window after expiry");
});

test("clientIp takes the RIGHTMOST X-Forwarded-For hop (Google-appended, trustworthy)", () => {
  // Plain request on Cloud Run: just the real client IP.
  assert.equal(clientIp("203.0.113.7"), "203.0.113.7");
  // Spoof attempt: client prepends a fake; Cloud Run appends the real IP last.
  // Verified live: `X-Forwarded-For: 1.2.3.4` arrives as "1.2.3.4,<real-ip>".
  assert.equal(clientIp("1.2.3.4,203.0.113.7"), "203.0.113.7");
  assert.equal(clientIp("9.9.9.9, 8.8.8.8, 203.0.113.7"), "203.0.113.7");
  // Two spoofed leftmosts resolve to the SAME real client -> same bucket.
  assert.equal(clientIp("1.1.1.1,203.0.113.7"), clientIp("2.2.2.2,203.0.113.7"));
  // Array form (header seen more than once) -> last element, last hop.
  assert.equal(clientIp(["1.2.3.4", "9.9.9.9,203.0.113.7"]), "203.0.113.7");
  assert.equal(clientIp(null), "unknown");
  assert.equal(clientIp(undefined), "unknown");
  assert.equal(clientIp(""), "unknown");
});
