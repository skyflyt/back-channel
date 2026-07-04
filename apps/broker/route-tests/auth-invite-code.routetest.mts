/**
 * L6 (security-pass-2026-07-03.md): generateInviteCode format/shape tests.
 * Doesn't (and can't cheaply) prove CSPRNG-ness statistically -- the
 * meaningful assertion is format-shape plus a source-level check that the
 * function body no longer references Math.random. Run via test:routes since
 * auth.ts is TS-only (no .mjs runtime twin).
 *
 * Run with:
 *   node --experimental-strip-types --experimental-test-module-mocks \
 *        --import ./route-tests/register-hooks.mjs --test route-tests/*.routetest.mts
 */
import { test, mock, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

before(() => {
  // auth.ts imports @/lib/db (prisma) for other exports; generateInviteCode itself
  // touches no DB, but the module import graph needs prisma mocked so this test file
  // never needs a real Postgres connection - same pattern as the other route tests.
  mock.module("@/lib/db", { namedExports: { prisma: {} } });
});

async function loadGenerateInviteCode() {
  const mod = await import("@/lib/auth");
  return mod.generateInviteCode;
}

const CODE_RE = /^BC-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;

test("generateInviteCode matches the BC-XXXX-XXXX format over the expected alphabet", async () => {
  const generateInviteCode = await loadGenerateInviteCode();
  for (let i = 0; i < 200; i++) {
    const code = generateInviteCode();
    assert.match(code, CODE_RE, `code "${code}" did not match the expected format`);
  }
});

test("generateInviteCode never contains characters excluded from its alphabet (I, L, O, 0, 1)", async () => {
  const generateInviteCode = await loadGenerateInviteCode();
  for (let i = 0; i < 200; i++) {
    const code = generateInviteCode();
    assert.doesNotMatch(code, /[ILO01]/);
  }
});

test("generateInviteCode produces variation across calls (not a constant/degenerate output)", async () => {
  const generateInviteCode = await loadGenerateInviteCode();
  const codes = new Set(Array.from({ length: 50 }, () => generateInviteCode()));
  assert.ok(codes.size > 40, `expected mostly-unique codes across 50 draws, got ${codes.size} unique`);
});

test("source check: generateInviteCode's implementation no longer calls Math.random", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const authSrc = readFileSync(path.resolve(here, "..", "src", "lib", "auth.ts"), "utf8");
  const fnMatch = authSrc.match(/export function generateInviteCode\(\)[\s\S]*?\n}/);
  assert.ok(fnMatch, "could not locate generateInviteCode's source for inspection");
  assert.doesNotMatch(fnMatch![0], /Math\.random/, "generateInviteCode must not use Math.random (non-CSPRNG)");
  assert.match(fnMatch![0], /randomInt/, "generateInviteCode should draw from node:crypto's randomInt (CSPRNG)");
});