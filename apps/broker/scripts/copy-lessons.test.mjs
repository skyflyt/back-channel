// Guards the Docker-build fix for the /lessons page (see scripts/copy-lessons.mjs
// for the full story). Broker CI runs tsc + `node --test`, not `next build`,
// so nothing else in CI would catch a regression here -- this is the cheap
// guard for a bug class that already broke a production Cloud Build once
// (Turbopack "Module not found" for a deep relative import that only
// resolved on disk, not inside the Docker image).
//
// What this proves:
//   1. scripts/copy-lessons.mjs actually produces src/generated/lessons.json
//      from the canonical community/lessons.json (byte-for-byte).
//   2. src/app/lessons/page.tsx imports from the generated location, not
//      straight from community/lessons.json -- so a well-meaning revert back
//      to the deep relative path gets caught here instead of in prod.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const BROKER_ROOT = path.resolve(here, "..");
const REPO_ROOT = path.resolve(BROKER_ROOT, "..", "..");
const CANONICAL_PATH = path.join(REPO_ROOT, "community", "lessons.json");
const GENERATED_PATH = path.join(BROKER_ROOT, "src", "generated", "lessons.json");
const COPY_SCRIPT = path.join(BROKER_ROOT, "scripts", "copy-lessons.mjs");
const PAGE_PATH = path.join(BROKER_ROOT, "src", "app", "lessons", "page.tsx");

test("copy-lessons.mjs generates src/generated/lessons.json from the canonical file", () => {
  // Start from a clean slate so this test actually proves the script writes
  // the file, rather than passing because a previous build already did.
  rmSync(GENERATED_PATH, { force: true });
  assert.ok(!existsSync(GENERATED_PATH), "precondition: generated file should not exist yet");

  execFileSync(process.execPath, [COPY_SCRIPT], { cwd: BROKER_ROOT, stdio: "pipe" });

  assert.ok(existsSync(GENERATED_PATH), "copy-lessons.mjs did not create src/generated/lessons.json");

  const canonical = readFileSync(CANONICAL_PATH, "utf8");
  const generated = readFileSync(GENERATED_PATH, "utf8");
  assert.equal(generated, canonical, "generated lessons.json must match community/lessons.json byte-for-byte");
});

test("the /lessons page imports the generated file, not community/lessons.json directly", () => {
  const src = readFileSync(PAGE_PATH, "utf8");
  assert.match(
    src,
    /from\s+["']\.\.\/\.\.\/generated\/lessons\.json["']/,
    "page.tsx should import from ../../generated/lessons.json (src/generated/lessons.json) -- " +
      "a deep relative import straight into community/ at the repo root does not resolve inside " +
      "the Docker build stage and will break `next build` in Cloud Build (see scripts/copy-lessons.mjs).",
  );
  assert.doesNotMatch(
    src,
    /from\s+["'](\.\.\/){4,}community\/lessons\.json["']/,
    "page.tsx must not import community/lessons.json via a deep relative path -- that is the exact " +
      "regression that broke Cloud Build 4ea61083. Import src/generated/lessons.json instead.",
  );
});