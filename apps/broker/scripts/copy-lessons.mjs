// Copies the canonical, PR-curated community/lessons.json (repo root) into a
// git-ignored generated location inside apps/broker so the /lessons page can
// import it with a short, build-context-safe relative path.
//
// Why this exists: the broker's Docker build stage only has the repo root as
// its build CONTEXT, not its working directory -- the Dockerfile does
// `COPY community/ /community/` (context-root path) into the image, then
// `WORKDIR /app` holds only apps/broker's contents. A deep relative import
// like `../../../../../community/lessons.json` from src/app/lessons/page.tsx
// resolves fine when the repo root sits above apps/broker on disk (local dev,
// `npm run build` from a full checkout) but does NOT resolve inside the
// Docker image, where nothing lives above /app. That mismatch is exactly
// what broke the production build (Cloud Build ran `next build` inside the
// image; local dev and CI's tsc/node --test never did).
//
// Fix: copy the canonical file into src/generated/lessons.json (git-ignored,
// rebuilt every time) and have page.tsx import THAT. This script runs via
// `prebuild` (see package.json) so it's part of `npm run build` both locally
// and in Docker -- one canonical source, no hand-maintained duplicate.
//
// Resolution order for the canonical file:
//   1. <repoRoot>/community/lessons.json where repoRoot = apps/broker/../..
//      (true on disk in local dev / full-checkout CI runners)
//   2. /community/lessons.json (the path the Dockerfile COPYs it to)
// The first one found wins. If neither exists, fail loudly -- a silent empty
// lessons page is worse than a broken build.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const brokerRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  join(brokerRoot, "..", "..", "community", "lessons.json"), // local / monorepo checkout
  join("/community", "lessons.json"), // Docker build stage (see Dockerfile COPY)
];

const source = candidates.find((p) => existsSync(p));

if (!source) {
  console.error(
    "[copy-lessons] Could not find community/lessons.json in any known location:\n" +
      candidates.map((p) => `  - ${p}`).join("\n") +
      "\nThe /lessons page needs this file at build time. See apps/broker/Dockerfile" +
      " (COPY community/ /community/) and community/README.md.",
  );
  process.exit(1);
}

// Validate JSON shape before writing -- fail the build with a clear message
// rather than shipping a broken generated file.
let raw;
try {
  raw = readFileSync(source, "utf8");
  JSON.parse(raw);
} catch (err) {
  console.error(`[copy-lessons] ${source} is not valid JSON: ${err.message}`);
  process.exit(1);
}

const outDir = join(brokerRoot, "src", "generated");
const outPath = join(outDir, "lessons.json");
mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, raw, "utf8");

console.log(`[copy-lessons] Copied ${source} -> ${outPath}`);