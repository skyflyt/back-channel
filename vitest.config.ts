import { defineConfig } from "vitest/config";

// Scope the ROOT vitest run to the root library's own suites.
//
// Without this, vitest's default glob also swept up apps/broker/**/*.test.mjs
// and packages/**/test/*.test.mjs — files written against node:test, not
// vitest, which vitest can only report as "No test suite found in file"
// (14 such failures before this config existed). Those suites are not
// unowned: the broker's run under `node --test` in .github/workflows/broker.yml
// and the installer's under .github/workflows/install-cli.yml. This narrows
// what the root run claims to cover; it does not stop anything from being run.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
