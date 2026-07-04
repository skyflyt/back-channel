// Generates apps/broker/public/skill.sha256 -- the integrity manifest
// install.sh cross-checks the fetched skill files against.
//
// Why this exists (security H3 / SEC-4): install.sh's ONLY prior validation of
// the fetched SKILL.md/REFERENCE.md was a liveness check (non-empty + contains
// "name: back-channel") -- no integrity check at all. A compromised broker host
// or a MITM between the agent and back-channel.app could substitute malicious
// agent instructions and the liveness check would happily pass. See the
// 2026-07-03 security pass, finding H3.
//
// The fix needs an integrity anchor published from an origin INDEPENDENT of
// the artifact host (back-channel.app / Cloud Run). A same-origin hash (e.g.
// serving a hash file from back-channel.app right next to the content it
// hashes) gives near-zero protection: an attacker who can rewrite the served
// skill content can trivially rewrite the served hash to match. This repo`'s
// public GitHub mirror (raw.githubusercontent.com/skyflyt/back-channel) is a
// genuinely separate origin/infra -- compromising Cloud Run does not give an
// attacker write access to GitHub, and vice versa. install.sh fetches the
// expected hash from GitHub raw and the content from back-channel.app, then
// cross-checks: compromising either origin ALONE is no longer sufficient.
//
// This script is the "regenerate, don`'t hand-maintain" half of that story. It
// hashes the CANONICAL skill source files (skill/SKILL.md, skill/REFERENCE.md
// at the repo root -- the exact files apps/broker/src/app/skill/route.ts and
// .../skill/reference/route.ts read verbatim with no transform) and writes
// the manifest as build output, the same pattern as scripts/copy-lessons.mjs.
// A hand-maintained hash would silently drift from the served content and
// brick every install; this keeps the manifest mechanically in sync with the
// files that are actually served.
//
// THE MANUAL STEP THIS DOES NOT AUTOMATE (see docs/install-prompt.md and the
// PR description for SEC-4): generating the file locally or in CI is not
// enough -- the manifest must be committed and pushed to the `main` branch on
// GitHub so raw.githubusercontent.com serves the fresh hash. That push is a
// manual (or CI-on-merge) release step; there`'s no way to make GitHub publish
// a file this repo hasn`'t pushed there. Until that push lands, install.sh`'s
// cross-origin check will see a stale GitHub hash and refuse to install,
// which is the fail-closed behavior we want -- but it means: whoever bumps
// skill/SKILL.md or skill/REFERENCE.md MUST run this script and push
// apps/broker/public/skill.sha256 to main as part of that same change (or in
// immediate CI-driven follow-up) or installs will start failing loudly.
//
// Usage: node apps/broker/scripts/generate-skill-manifest.mjs [--check]
//   (no flags)  regenerate apps/broker/public/skill.sha256 from the current
//               skill/SKILL.md + skill/REFERENCE.md and write it.
//   --check     compute the manifest and compare against the committed file;
//               exit 1 with a diff-shaped message if stale (CI gate, mirrors
//               the existing install.sh.sha256 staleness check).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const brokerRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRootCandidates = [
  join(brokerRoot, "..", ".."), // apps/broker/scripts/.. /.. -> repo root (local / full checkout)
];

const repoRoot = repoRootCandidates.find((p) => existsSync(join(p, "skill", "SKILL.md")));

if (!repoRoot) {
  console.error(
    "[generate-skill-manifest] Could not find skill/SKILL.md above apps/broker.\n" +
      "This script must run from a full repo checkout (same requirement as the\n" +
      "/skill and /skill/reference routes it mirrors).",
  );
  process.exit(1);
}

const files = [
  { key: "SKILL.md", path: join(repoRoot, "skill", "SKILL.md") },
  { key: "REFERENCE.md", path: join(repoRoot, "skill", "REFERENCE.md") },
];

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

const lines = [];
for (const f of files) {
  if (!existsSync(f.path)) {
    console.error(`[generate-skill-manifest] Missing required skill file: ${f.path}`);
    process.exit(1);
  }
  const buf = readFileSync(f.path); // raw bytes -- must match what the routes serve
  const hash = sha256Hex(buf);
  // sha256sum-compatible format: "<hash>  <name>" (two spaces, text mode)
  lines.push(`${hash}  ${f.key}`);
}

const manifest = lines.join("\n") + "\n";
const outPath = join(brokerRoot, "public", "skill.sha256");

const checkMode = process.argv.includes("--check");

if (checkMode) {
  if (!existsSync(outPath)) {
    console.error(`[generate-skill-manifest] ${outPath} does not exist. Run without --check to generate it.`);
    process.exit(1);
  }
  const committed = readFileSync(outPath, "utf8");
  if (committed !== manifest) {
    console.error(
      "[generate-skill-manifest] apps/broker/public/skill.sha256 is STALE relative to skill/SKILL.md / skill/REFERENCE.md.\n" +
        "Regenerate with: node apps/broker/scripts/generate-skill-manifest.mjs\n" +
        "Then commit the updated manifest AND push it to `main` on GitHub -- install.sh\n" +
        "cross-checks the fetched skill against raw.githubusercontent.com/skyflyt/back-channel/main/apps/broker/public/skill.sha256,\n" +
        "so a stale or unpushed manifest will make every install.sh run fail closed.\n\n" +
        `--- committed ---\n${committed}\n--- expected ---\n${manifest}`,
    );
    process.exit(1);
  }
  console.log("[generate-skill-manifest] apps/broker/public/skill.sha256 is up to date.");
  process.exit(0);
}

writeFileSync(outPath, manifest, "utf8");
console.log(`[generate-skill-manifest] Wrote ${outPath}:`);
process.stdout.write(manifest);
console.log(
  "\n[generate-skill-manifest] REMINDER: commit this file and push to `main` on GitHub.\n" +
    "install.sh fetches the expected hash from raw.githubusercontent.com (an origin\n" +
    "independent of back-channel.app) -- until this file is pushed to main, installs\n" +
    "will cross-check against the OLD hash and fail closed on any skill content change.",
);