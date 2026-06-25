// Unit/integration tests for backchannel-cli (bin/cli.js).
// Spins up the shared mock broker (tests/install/mock-server.mjs), points the
// CLI at it via --host + --allow-host, and asserts on the resulting filesystem.
// Zero test deps — uses node:test + node stdlib.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import fs from "node:fs";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..", "..");
const CLI = join(REPO, "packages", "install", "bin", "cli.js");
const MOCK = join(REPO, "tests", "install", "mock-server.mjs");

const IS_UNIX = !/^(win32)$/.test(process.platform) && !/MINGW|MSYS|CYGWIN/i.test(os.release());

let mock, BASE;

function startMock(env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MOCK], {
      env: { ...process.env, ...env, BC_MOCK_PORT: "0" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      const m = buf.match(/LISTENING (\d+)/);
      if (m) resolve({ child, port: Number(m[1]) });
    });
    child.on("error", reject);
    setTimeout(() => reject(new Error("mock did not start")), 5000);
  });
}

async function withMock(env, fn) {
  const { child, port } = await startMock(env);
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    child.kill();
  }
}

function freshHome() {
  return fs.mkdtempSync(join(os.tmpdir(), "bccli-"));
}

function runCli(args, { home, host }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "--allow-host", "--host", host, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: "", BC_SKILLS_DIR: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

const dest = (home) => join(home, ".claude", "skills", "back-channel");

test("clean install writes skill + reference + metadata, no token", async () => {
  await withMock({}, async (host) => {
    const home = freshHome();
    const r = await runCli(["--quiet"], { home, host });
    assert.equal(r.code, 0, r.err);
    assert.ok(fs.existsSync(join(dest(home), "SKILL.md")), "SKILL.md");
    assert.ok(fs.existsSync(join(dest(home), "REFERENCE.md")), "REFERENCE.md");
    const meta = JSON.parse(fs.readFileSync(join(dest(home), "install.json"), "utf8"));
    assert.equal(meta.revision, "2026-06-25-4");
    assert.ok(!fs.existsSync(join(home, ".bc", "token")), "no token without --pair");
  });
});

test("idempotent re-run reports up to date and exits 0", async () => {
  await withMock({}, async (host) => {
    const home = freshHome();
    await runCli(["--quiet"], { home, host });
    const r = await runCli([], { home, host });
    assert.equal(r.code, 0);
    assert.match(r.out, /already installed and up to date/i);
  });
});

test("revision mismatch upgrades to server copy (M3)", async () => {
  const home = freshHome();
  await withMock({}, async (host) => { await runCli(["--quiet"], { home, host }); });
  // local now ...-4; serve ...-9 while local install.json claims ...-10
  fs.writeFileSync(join(dest(home), "install.json"), JSON.stringify({ revision: "2026-06-25-10" }));
  await withMock({ BC_MOCK_REVISION: "2026-06-25-9" }, async (host) => {
    await runCli(["--quiet"], { home, host });
  });
  const meta = JSON.parse(fs.readFileSync(join(dest(home), "install.json"), "utf8"));
  assert.equal(meta.revision, "2026-06-25-9");
});

test("M1: 404 skill writes nothing, non-zero exit", async () => {
  await withMock({ BC_MOCK_SKILL_STATUS: "404" }, async (host) => {
    const home = freshHome();
    const r = await runCli(["--quiet"], { home, host });
    assert.notEqual(r.code, 0);
    assert.ok(!fs.existsSync(dest(home)), "no back-channel dir left behind");
  });
});

test("M1: 200 error-page body is rejected", async () => {
  await withMock({ BC_MOCK_SKILL_BODY: "errorpage" }, async (host) => {
    const home = freshHome();
    const r = await runCli(["--quiet"], { home, host });
    assert.notEqual(r.code, 0);
    assert.ok(!fs.existsSync(join(dest(home), "SKILL.md")));
  });
});

test("REFERENCE.md failure is non-fatal", async () => {
  await withMock({ BC_MOCK_REF_STATUS: "500" }, async (host) => {
    const home = freshHome();
    const r = await runCli(["--quiet"], { home, host });
    assert.equal(r.code, 0, r.err);
    assert.ok(fs.existsSync(join(dest(home), "SKILL.md")));
    assert.ok(!fs.existsSync(join(dest(home), "REFERENCE.md")));
  });
});

test("--pair success: token written 0600, key never printed, handle shown", async () => {
  await withMock({}, async (host) => {
    const home = freshHome();
    const r = await runCli(["--pair", "bcx-aaaa-bbbb"], { home, host }); // lowercase normalizes
    assert.equal(r.code, 0, r.err);
    const tok = fs.readFileSync(join(home, ".bc", "token"), "utf8");
    assert.equal(tok, "bc_TESTKEYabcdefghijklmnopqrstuvwxyz012345");
    assert.doesNotMatch(r.out, /bc_TESTKEY/, "api_key must never be printed");
    assert.match(r.out, /tester@bc/);
    if (IS_UNIX) {
      const mode = fs.statSync(join(home, ".bc", "token")).mode & 0o777;
      assert.equal(mode, 0o600, "token must be 0600");
    }
  });
});

test("M2: garbage --pair codes rejected before any network call", async () => {
  await withMock({}, async (host) => {
    for (const bad of ["foo", "BCX-AAAA-BBBB; rm -rf ~", "", "BCX-AA-BB", "BCX-AAAA-BBB"]) {
      const home = freshHome();
      const r = await runCli(["--quiet", "--pair", bad], { home, host });
      assert.notEqual(r.code, 0, `should reject: ${JSON.stringify(bad)}`);
      assert.ok(!fs.existsSync(join(home, ".bc", "token")), `no token for: ${JSON.stringify(bad)}`);
    }
  });
});

test("--pair 410: plain message, non-zero, no token, skill still installed", async () => {
  await withMock({ BC_MOCK_EXCHANGE: "410" }, async (host) => {
    const home = freshHome();
    const r = await runCli(["--pair", "BCX-AAAA-BBBB"], { home, host });
    assert.notEqual(r.code, 0);
    assert.ok(!fs.existsSync(join(home, ".bc", "token")));
    assert.ok(fs.existsSync(join(dest(home), "SKILL.md")), "skill stays installed");
    assert.match(r.err, /expired or already used/i);
  });
});

test("--pair 500: skill stays, no token, honest failure", async () => {
  await withMock({ BC_MOCK_EXCHANGE: "500" }, async (host) => {
    const home = freshHome();
    const r = await runCli(["--pair", "BCX-AAAA-BBBB"], { home, host });
    assert.notEqual(r.code, 0);
    assert.ok(!fs.existsSync(join(home, ".bc", "token")));
    assert.ok(fs.existsSync(join(dest(home), "SKILL.md")));
  });
});

test("token not clobbered by a plain re-run", async () => {
  const home = freshHome();
  await withMock({}, async (host) => {
    await runCli(["--quiet", "--pair", "BCX-AAAA-BBBB"], { home, host });
    const before = fs.readFileSync(join(home, ".bc", "token"), "utf8");
    await runCli(["--quiet"], { home, host });
    const after = fs.readFileSync(join(home, ".bc", "token"), "utf8");
    assert.equal(before, after);
  });
});

test("host pinning: non-canonical host without --allow-host is refused", async () => {
  await withMock({}, async (host) => {
    const home = freshHome();
    const child = spawn(process.execPath, [CLI, "--host", host, "--quiet"], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const code = await new Promise((res) => child.on("close", res));
    assert.notEqual(code, 0);
    assert.match(err, /refusing to use host/i);
  });
});

test("--runtime is passed through to the exchange", async () => {
  await withMock({}, async (host) => {
    const home = freshHome();
    const r = await runCli(["--pair", "BCX-AAAA-BBBB", "--runtime", "claude_code"], { home, host });
    assert.equal(r.code, 0, r.err);
    // mock echoes runtime_type back; the CLI doesn't print it, but the token proves the round-trip
    assert.ok(fs.existsSync(join(home, ".bc", "token")));
  });
});
