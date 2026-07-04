/**
 * Tests for the handshake-rotation guard in ingestFrame (C1, L5-adjacent) and
 * the WS upgrade's ticket validation (handleRelayUpgrade). Zero-dependency —
 * node:test, no live Postgres needed: relay.mjs's prisma calls fail fast
 * without DATABASE_URL and are caught by its own try/catch.
 *
 * Each test uses a UNIQUE sessionId (no _reset for the sessions Map, unlike
 * the ticket Map) to avoid cross-test pollution of the shared in-memory Map.
 *
 * KNOWN PRE-EXISTING ISSUE (not introduced by this change, not fixed here —
 * out of scope for the C1 security fix): sending a real CONTENT frame through
 * ingestFrame leaves the process unable to exit cleanly even after all work
 * completes and assertions pass (reproduced with plain `node script.mjs`, no
 * test runner involved, and independent of DB/network mocking — narrowed to
 * something in the fireInboxEvent/notifyIdleRecipient fire-and-forget paths
 * not releasing a handle when DATABASE_URL/RESEND_API_KEY are absent, as they
 * are in this dev/test environment). This file is a separate process per
 * node:test's default isolation (verified: combining this file with another
 * in one `node --test` invocation does not block the other file's tests or
 * its exit), so we force this file's process to exit in `after()` once
 * node:test has recorded pass/fail for every test above. This does not mask
 * failures: exitCode is read from process.exitCode, which node:test sets
 * before `after()` runs.
 *
 * Run from apps/broker with: node --test src/lib/
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  relayUserFrame,
  handleRelayUpgrade,
  mintRelayTicket,
  consumeRelayTicket,
  _resetRelayTickets,
} from "./relay.mjs";

let counter = 0;
function uniqueSessionId(label) {
  counter += 1;
  return `test-session-${label}-${Date.now()}-${counter}`;
}

function makeSession(overrides = {}) {
  return {
    scopesGranted: ["config.read"],
    invite: {
      id: `inv-${counter}`,
      createdAt: new Date(),
      ttlMinutes: 60,
      expiresAt: new Date(Date.now() + 3600_000),
      hostAccountId: "acct-host",
      visitorAccountId: "acct-visitor",
      ...overrides,
    },
  };
}

/** Minimal fake duplex socket satisfying handleRelayUpgrade's error paths. */
function fakeSocket() {
  return {
    destroyed: false,
    written: [],
    write(chunk) { this.written.push(chunk); },
    destroy() { this.destroyed = true; },
  };
}

// ── Handshake rotation guard ────────────────────────────────────────────────

test("a role's FIRST handshake.pubkey is accepted (no prior established key)", async () => {
  const sessionId = uniqueSessionId("first-handshake");
  const session = makeSession();
  const seq = await relayUserFrame({
    sessionId, role: "host", session,
    frameText: JSON.stringify({ type: "handshake.pubkey", pubkey: "pub-A" }),
  });
  assert.equal(seq, 1, "handshake frame was relayed (seq assigned)");
});

test("a pubkey RETRY before any content frame is sent is accepted (pre-established race)", async () => {
  const sessionId = uniqueSessionId("retry-pre-content");
  const session = makeSession();
  await relayUserFrame({ sessionId, role: "host", session, frameText: JSON.stringify({ type: "handshake.pubkey", pubkey: "pub-A" }) });
  // Same role resends a DIFFERENT pubkey before ever sending content -- this
  // is the legitimate retry case documented in the arbitration comment.
  const seq2 = await relayUserFrame({ sessionId, role: "host", session, frameText: JSON.stringify({ type: "handshake.pubkey", pubkey: "pub-B" }) });
  assert.ok(seq2 > 0, "retried handshake before content is still relayed, not dropped");
});

test("a pubkey rotation AFTER a content frame is sent is REJECTED (established pin)", async () => {
  const sessionId = uniqueSessionId("rotation-rejected");
  const session = makeSession();
  await relayUserFrame({ sessionId, role: "host", session, frameText: JSON.stringify({ type: "handshake.pubkey", pubkey: "pub-A" }) });
  // Host sends a real content frame -- this ESTABLISHES pub-A as pinned.
  const beforeRotationSeq = await relayUserFrame({ sessionId, role: "host", session, frameText: JSON.stringify({ type: "enc", ct: "sealed-blob-1" }) });
  assert.ok(beforeRotationSeq > 0, "content frame relayed normally");

  // Now an attacker (or a bug) tries to swap in a different pubkey for the
  // SAME role, mid-session. This must be dropped, not relayed or arbitrated.
  const rotationSeq = await relayUserFrame({ sessionId, role: "host", session, frameText: JSON.stringify({ type: "handshake.pubkey", pubkey: "pub-EVIL" }) });
  // The guard returns the CURRENT dest seq unchanged (no new frame appended).
  assert.equal(rotationSeq, beforeRotationSeq, "rotation attempt did not advance the seq counter -- it was dropped, not relayed");
});

test("a rotation attempt is dropped for the OFFENDING role only -- the other role's handshake is unaffected", async () => {
  const sessionId = uniqueSessionId("rotation-isolated");
  const session = makeSession();
  await relayUserFrame({ sessionId, role: "host", session, frameText: JSON.stringify({ type: "handshake.pubkey", pubkey: "host-pub" }) });
  await relayUserFrame({ sessionId, role: "host", session, frameText: JSON.stringify({ type: "enc", ct: "host-content" }) });

  // Visitor hasn't sent content yet -- their handshake is still in the
  // pre-established race window, so a pubkey resend for VISITOR must still work.
  const visitorSeq = await relayUserFrame({ sessionId, role: "visitor", session, frameText: JSON.stringify({ type: "handshake.pubkey", pubkey: "visitor-pub-1" }) });
  const visitorSeq2 = await relayUserFrame({ sessionId, role: "visitor", session, frameText: JSON.stringify({ type: "handshake.pubkey", pubkey: "visitor-pub-2" }) });
  assert.ok(visitorSeq2 > visitorSeq, "visitor's pre-established retry still relays fine, independent of host's established/pinned state");
});

test("the SAME pubkey resent after establishment is a no-op, not treated as rotation", async () => {
  const sessionId = uniqueSessionId("same-pubkey-noop");
  const session = makeSession();
  await relayUserFrame({ sessionId, role: "host", session, frameText: JSON.stringify({ type: "handshake.pubkey", pubkey: "pub-A" }) });
  await relayUserFrame({ sessionId, role: "host", session, frameText: JSON.stringify({ type: "enc", ct: "content-1" }) });
  // Resending the IDENTICAL pubkey isn't a rotation attempt (no key change) --
  // should relay normally (e.g. an idempotent retry of the same handshake frame).
  const seq = await relayUserFrame({ sessionId, role: "host", session, frameText: JSON.stringify({ type: "handshake.pubkey", pubkey: "pub-A" }) });
  assert.ok(seq > 0, "same-pubkey resend is not blocked");
});

// ── WS upgrade ticket validation ────────────────────────────────────────────

test("handleRelayUpgrade destroys the socket when no ticket is present", () => {
  const socket = fakeSocket();
  const req = { headers: {}, url: "/relay/some-session" };
  handleRelayUpgrade(req, socket, Buffer.alloc(0));
  assert.ok(socket.destroyed, "missing ticket -> destroyed");
});

test("handleRelayUpgrade destroys the socket for an unknown/garbage ticket", () => {
  const socket = fakeSocket();
  const req = { headers: {}, url: "/relay/some-session?ticket=totally-made-up" };
  handleRelayUpgrade(req, socket, Buffer.alloc(0));
  assert.ok(socket.destroyed, "garbage ticket -> destroyed");
});

test("handleRelayUpgrade destroys the socket when the ticket's sessionId doesn't match the URL", () => {
  _resetRelayTickets();
  const { ticket } = mintRelayTicket({ sessionId: "session-A", role: "host", accountId: "acct-1" });
  const socket = fakeSocket();
  const req = { headers: {}, url: "/relay/session-B?ticket=" + encodeURIComponent(ticket) };
  handleRelayUpgrade(req, socket, Buffer.alloc(0));
  assert.ok(socket.destroyed, "ticket minted for a different session -> destroyed");
});

test("handleRelayUpgrade rejects a REUSED ticket (single-use enforced at the upgrade boundary)", () => {
  _resetRelayTickets();
  const sessionId = "session-reuse";
  const { ticket } = mintRelayTicket({ sessionId, role: "host", accountId: "acct-1" });
  // Manually consume it first (simulating a prior successful upgrade).
  const first = consumeRelayTicket(ticket, sessionId);
  assert.ok(first, "sanity: first redemption works");

  const socket = fakeSocket();
  const req = { headers: {}, url: `/relay/${sessionId}?ticket=${encodeURIComponent(ticket)}` };
  handleRelayUpgrade(req, socket, Buffer.alloc(0));
  assert.ok(socket.destroyed, "replayed ticket -> destroyed, even on the WS upgrade path directly");
});

test("handleRelayUpgrade ignores a client-supplied ?role= -- there is no such param anymore", () => {
  // This test documents the contract: even if a client appends role=host to
  // the URL (old wire format), the upgrade handler only ever reads `ticket`.
  // We can't assert on the resulting role without a real WS upgrade, but we
  // CAN assert the ticket redemption contract directly: role is whatever was
  // minted, completely independent of any role query param (consumeRelayTicket's
  // signature doesn't even accept one).
  _resetRelayTickets();
  const sessionId = "session-role-param-ignored";
  const { ticket } = mintRelayTicket({ sessionId, role: "visitor", accountId: "acct-1" });
  const redeemed = consumeRelayTicket(ticket, sessionId);
  assert.equal(redeemed.role, "visitor", "role is what was minted, ignoring any ?role=host an attacker might append");
});

// See the file-level comment: this file's process needs to force-exit because
// of a pre-existing (out-of-scope) lingering-handle issue in the content-frame
// notify path, unrelated to the WS-ticket/handshake-guard logic under test.
// node:test runs each file in its own child process, so this does not affect
// any other test file. exitCode is read AFTER node:test has set it.
after(() => {
  setImmediate(() => process.exit(process.exitCode ?? 0));
});
