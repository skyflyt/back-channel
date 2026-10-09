// index.js is the .mcpb entry point and is intentionally NOT imported by the
// rest of the test suite (see the comment at the top of index.js: "tests
// import lib.js, never this" — importing it for real calls bridge.start(),
// which attaches real stdin listeners and can't be constructed with mocks).
//
// The one thing worth verifying about index.js in isolation is M4 (env
// scrub): that it does not leave BC_TOKEN sitting in process.env after
// startup. We verify this black-box, the same way Claude Desktop actually
// runs the file — as a child process — by having a tiny child script import
// index.js (which self-starts and calls stdin.resume()) and then report back
// whether BC_TOKEN survived in ITS OWN process.env. We immediately close its
// stdin so the bridge's "stdin closed — exiting" path lets the child exit
// instead of hanging as a real MCP server would.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(__dirname, "index.js");

function runChild(env, args = []) {
  return new Promise((resolve, reject) => {
    // Report env state right after import via a follow-up dynamic import that
    // resolves once index.js has run its top-level scrub code, then print a
    // single JSON line to stdout and exit.
    const probe = `
      import("./index.js").then(() => {
        console.log(JSON.stringify({ hasToken: "BC_TOKEN" in process.env }));
        process.exit(0);
      }).catch((e) => { console.error(e); process.exit(1); });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", probe, "--", ...args], {
      cwd: __dirname,
      env: { ...process.env, ...env, BC_MCP_URL: "https://example.invalid/api/mcp" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    // The bridge attaches stdin listeners and calls stdin.resume() — close it
    // immediately so the process doesn't hang waiting for JSON-RPC lines.
    child.stdin.end();
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`child exited ${code}: ${err}`));
      resolve({ out, err });
    });
    child.on("error", reject);
    setTimeout(() => { try { child.kill(); } catch {} reject(new Error("child timed out")); }, 5000);
  });
}

test("index.js: BC_TOKEN is scrubbed from process.env after startup (M4)", async () => {
  const { out } = await runChild({ BC_TOKEN: "bc_super_secret_value" });
  const line = out.trim().split("\n").filter(Boolean).pop();
  const parsed = JSON.parse(line);
  assert.equal(parsed.hasToken, false, "BC_TOKEN must be deleted from process.env once read");
});

test("index.js: source scrubs BC_TOKEN exactly once via delete, immediately after reading it into a const", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(INDEX_PATH, "utf8");
  assert.match(src, /const token = \(process\.env\.BC_TOKEN[^;]*\)\.trim\(\);\s*\n\s*delete process\.env\.BC_TOKEN;/,
    "token must be captured into a local const immediately followed by delete process.env.BC_TOKEN");
});

test("index.js: the host a manifest names (--host= or BC_HOST) gets its own keystore; the shared one moves once", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const home = mkdtempSync(join(tmpdir(), "bc-index-home-"));
  mkdirSync(join(home, ".bc"));
  const keys = (name) => join(home, ".bc", name);
  writeFileSync(keys("mcpb-session-keys.json"), JSON.stringify({ __resolved_bc_token__: { bcToken: "bc_first_app" } }));
  const base = { HOME: home, USERPROFILE: home, BC_KEYSTORE_PATH: "", BC_HOST: "" };

  await runChild(base);
  assert.ok(existsSync(keys("mcpb-session-keys.json")), "no host named: the shared keystore stays where it is");

  await runChild(base, ["--host=codex"]);
  assert.equal(existsSync(keys("mcpb-session-keys.json")), false);
  assert.match(readFileSync(keys("codex-session-keys.json"), "utf8"), /bc_first_app/, "the first host to start keeps its pairing");

  await runChild({ ...base, BC_HOST: "claude-code" });
  const second = keys("claude-code-session-keys.json");
  assert.ok(!existsSync(second) || !readFileSync(second, "utf8").includes("bc_first_app"), "a second host must not inherit the first host's key");
  assert.match(readFileSync(keys("codex-session-keys.json"), "utf8"), /bc_first_app/);
});
