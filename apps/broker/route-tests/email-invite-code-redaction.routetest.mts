/**
 * L7 (security-pass-2026-07-03.md): sendInviteEmail must never log the raw
 * invite code. When RESEND_API_KEY is unset, sendInviteEmail's "log-only"
 * fallback (see src/lib/email.ts) logs to stdout instead of sending -- this
 * is the exact original leak (the log line interpolated args.code directly).
 * Delete RESEND_API_KEY from the test process env to force that path
 * deterministically, capture console.log, and assert the real code is
 * nowhere in the output.
 *
 * Run with:
 *   node --experimental-strip-types --experimental-test-module-mocks \
 *        --import ./route-tests/register-hooks.mjs --test route-tests/*.routetest.mts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const SECRET_CODE = "BC-ZZZZ-YYYY"; // a distinctive value we can grep for in captured output

test("sendInviteEmail's log-only fallback (no RESEND_API_KEY) never logs the raw invite code", async () => {
  const savedKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;

  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };

  try {
    const { sendInviteEmail } = await import("@/lib/email");
    const delivered = await sendInviteEmail({
      to: "friend@example.com",
      inviterHandle: "alice@bc",
      code: SECRET_CODE,
      goal: null,
      needsSignup: false,
    });
    assert.equal(delivered, false, "log-only fallback reports not-delivered");
  } finally {
    console.log = originalLog;
    if (savedKey !== undefined) process.env.RESEND_API_KEY = savedKey;
  }

  const output = lines.join("\n");
  assert.ok(output.includes("[invite-email]"), "sanity: the log-only line did fire");
  assert.ok(!output.includes(SECRET_CODE), `the raw invite code must never appear in logs. Captured:\n${output}`);
  assert.match(output, /redacted/i, "the log line should explicitly note the redaction, not just omit the field silently");
});