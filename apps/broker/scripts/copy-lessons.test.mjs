/**
 * Build-gate test for scripts/copy-lessons.mjs (M3 fix,
 * security-pass-2026-07-03.md). This does NOT re-test validateLessonsDocument
 * itself (see src/lib/community-lessons.test.mjs for that) -- it proves the
 * *script* actually calls the validator and fails the build (non-zero exit,
 * no generated file written) when community/lessons.json has a bad entry,
 * since that wiring is the whole point of the fix (a validator that exists
 * but is never invoked at build time is exactly the bug being closed here).
 *
 * Runs the real script as a child process against a throwaway fake repo
 * layout (os.tmpdir()) so it never touches the actual community/lessons.json.
 *
 * Run with: node --test scripts/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const brokerRoot = join(here, ".."); // scripts/ -> apps/broker
const scriptPath = join(brokerRoot, "scripts", "copy-lessons.mjs");
const libDir = join(brokerRoot, "src", "lib");

// Build a fake "<tmp>/apps/broker" + "<tmp>/community" layout so the script's
// candidate-path resolution (brokerRoot/../../community/lessons.json) finds
// our fixture instead of the real repo-root file. We can't relocate the
// script itself (it imports community-lessons.mjs via a relative path), so
// instead we copy the whole scripts/+src/lib validator pair into the fake
// broker root -- cheap, and keeps this test from ever touching the real file.
function makeFakeRepo(lessonsJson) {
  const fakeRepoRoot = mkdtempSync(join(tmpdir(), "bc-copy-lessons-"));
  const fakeBrokerRoot = join(fakeRepoRoot, "apps", "broker");
  mkdirSync(join(fakeBrokerRoot, "scripts"), { recursive: true });
  mkdirSync(join(fakeBrokerRoot, "src", "lib"), { recursive: true });
  mkdirSync(join(fakeRepoRoot, "community"), { recursive: true });

  copyFileSync(scriptPath, join(fakeBrokerRoot, "scripts", "copy-lessons.mjs"));
  copyFileSync(join(libDir, "community-lessons.mjs"), join(fakeBrokerRoot, "src", "lib", "community-lessons.mjs"));
  writeFileSync(join(fakeRepoRoot, "community", "lessons.json"), JSON.stringify(lessonsJson), "utf8");
  return { fakeRepoRoot, fakeBrokerRoot };
}

function runScript(fakeBrokerRoot) {
  return spawnSync(process.execPath, [join(fakeBrokerRoot, "scripts", "copy-lessons.mjs")], {
    cwd: fakeBrokerRoot,
    encoding: "utf8",
  });
}

test("copy-lessons.mjs fails the build (non-zero exit) on a javascript: URL scheme", () => {
  const { fakeRepoRoot, fakeBrokerRoot } = makeFakeRepo([
    { title: "Evil", url: "javascript:alert(1)", source: "web", description: "d", submitted_by: "x", added: "2026-07-03" },
  ]);
  try {
    const result = runScript(fakeBrokerRoot);
    assert.notEqual(result.status, 0, `expected non-zero exit, got ${result.status}. stderr:\n${result.stderr}`);
    assert.match(result.stderr, /scheme/i);
    assert.match(result.stderr, /javascript:/);
    assert.equal(existsSync(join(fakeBrokerRoot, "src", "generated", "lessons.json")), false, "must not write the generated file when validation fails");
  } finally {
    rmSync(fakeRepoRoot, { recursive: true, force: true });
  }
});

test("copy-lessons.mjs succeeds and writes the generated file for a well-formed lessons.json", () => {
  const { fakeRepoRoot, fakeBrokerRoot } = makeFakeRepo([
    { title: "Fine", url: "https://example.com/x", source: "web", description: "d", submitted_by: "x", added: "2026-07-03" },
  ]);
  try {
    const result = runScript(fakeBrokerRoot);
    assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr:\n${result.stderr}`);
    assert.equal(existsSync(join(fakeBrokerRoot, "src", "generated", "lessons.json")), true);
  } finally {
    rmSync(fakeRepoRoot, { recursive: true, force: true });
  }
});