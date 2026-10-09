import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeyStore, resolveKeystorePath, hostKeystorePath, normalizeHostId } from "./keystore.js";

function fakeFs(initialFiles = {}) {
  const files = new Map(Object.entries(initialFiles));
  const modes = new Map();
  return {
    files,
    modes,
    existsSync: (p) => files.has(p),
    readFileSync: (p) => { if (!files.has(p)) throw new Error("ENOENT"); return files.get(p); },
    writeFileSync: (p, data, opts) => { files.set(p, data); if (opts && typeof opts === "object" && "mode" in opts) modes.set(p, opts.mode); },
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); if (modes.has(from)) { modes.set(to, modes.get(from)); modes.delete(from); } },
    mkdirSync: () => {},
    chmodSync: (p, mode) => { modes.set(p, mode); },
  };
}

test("load(): missing file returns empty state, no throw", () => {
  const store = createKeyStore({ path: "/x/keys.json", fs: fakeFs() });
  assert.deepEqual(store.load(), {});
});

test("load(): corrupt JSON returns empty state, no throw", () => {
  const store = createKeyStore({ path: "/x/keys.json", fs: fakeFs({ "/x/keys.json": "not json{{{" }) });
  assert.deepEqual(store.load(), {});
});

test("save() then load() round-trips state", () => {
  const fs = fakeFs();
  const nowMs = 1_700_000_000_000;
  const store = createKeyStore({ path: "/x/keys.json", fs, now: () => nowMs });
  const state = { "sess-1": { role: "visitor", privateKey: "abc", publicKey: "def", updatedAt: nowMs - 1000 } };
  store.save(state);
  assert.deepEqual(store.load(), state);
});

test("save() writes via tmp+rename, not a direct write (crash-safety)", () => {
  const fs = fakeFs();
  const store = createKeyStore({ path: "/x/keys.json", fs });
  store.save({ a: 1 });
  assert.equal(fs.files.has("/x/keys.json"), true);
  assert.equal([...fs.files.keys()].some((k) => k.includes(".tmp.")), false, "tmp file should be renamed away, not left behind");
});

test("load() prunes entries older than 30 days", () => {
  const nowMs = 1_700_000_000_000;
  const fresh = { updatedAt: nowMs - 1000 };
  const stale = { updatedAt: nowMs - 31 * 24 * 60 * 60 * 1000 };
  const fs = fakeFs({ "/x/keys.json": JSON.stringify({ fresh, stale }) });
  const store = createKeyStore({ path: "/x/keys.json", fs, now: () => nowMs });
  const loaded = store.load();
  assert.deepEqual(Object.keys(loaded), ["fresh"]);
});

test("load() keeps entries with no updatedAt (defensive: never silently drop unknown shape)", () => {
  const fs = fakeFs({ "/x/keys.json": JSON.stringify({ weird: { foo: 1 } }) });
  const store = createKeyStore({ path: "/x/keys.json", fs, now: () => Date.now() });
  assert.deepEqual(store.load(), { weird: { foo: 1 } });
});

// ── H2/M1/M2 hardening: atomic write, 0600 at create time, Windows ACL, surfaced errors ──

test("save(): tmp file is created with mode 0o600 AT CREATE TIME (no separate chmod race window) on POSIX", () => {
  const fs = fakeFs();
  const store = createKeyStore({ path: "/x/keys.json", fs, isWindows: false });
  store.save({ a: 1 });
  // The final path should carry 0o600 either via the create-time mode (carried
  // through rename) or the defensive post-rename chmod re-assert.
  assert.equal(fs.modes.get("/x/keys.json"), 0o600);
});

test("save(): on POSIX, writeFileSync is called with mode:0o600 in its options (not a bare string encoding)", () => {
  const seen = [];
  const fs = {
    existsSync: () => false,
    readFileSync: () => "{}",
    writeFileSync: (p, data, opts) => { seen.push(opts); },
    renameSync: () => {},
    mkdirSync: () => {},
    chmodSync: () => {},
  };
  const store = createKeyStore({ path: "/x/keys.json", fs, isWindows: false });
  store.save({ a: 1 });
  assert.equal(seen.length, 1);
  assert.equal(typeof seen[0], "object", "must pass an options object, not a bare encoding string");
  assert.equal(seen[0].mode, 0o600);
});

test("save(): on Windows, calls icacls to strip inheritance and grant only the current user Full control", () => {
  const fs = fakeFs();
  const calls = [];
  const store = createKeyStore({
    path: "C:/x/keys.json",
    fs,
    isWindows: true,
    execFileSyncImpl: (cmd, args) => { calls.push({ cmd, args }); },
  });
  store.save({ a: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "icacls");
  assert.equal(calls[0].args[0], "C:/x/keys.json");
  assert.ok(calls[0].args.includes("/inheritance:r"), "must strip inherited ACEs");
  assert.ok(calls[0].args.includes("/grant:r"), "must use /grant:r (replace) not /grant (append) for idempotency");
});

test("save(): icacls failure is logged, not thrown — a locked-but-imperfect file beats a bridge that won't start", () => {
  const fs = fakeFs();
  const logs = [];
  const store = createKeyStore({
    path: "C:/x/keys.json",
    fs,
    isWindows: true,
    execFileSyncImpl: () => { throw new Error("icacls.exe not found"); },
    log: (msg) => logs.push(msg),
  });
  assert.doesNotThrow(() => store.save({ a: 1 }));
  assert.ok(logs.some((l) => l.includes("icacls")), "failure should be logged");
  assert.equal(fs.files.get("C:/x/keys.json"), JSON.stringify({ a: 1 }, null, 2), "save still completes despite ACL failure");
});

test("save(): write failure is surfaced (thrown), not silently swallowed", () => {
  const fs = {
    existsSync: () => false,
    readFileSync: () => "{}",
    writeFileSync: () => { throw new Error("ENOSPC: no space left on device"); },
    renameSync: () => {},
    mkdirSync: () => {},
    chmodSync: () => {},
  };
  const logs = [];
  const store = createKeyStore({ path: "/x/keys.json", fs, log: (m) => logs.push(m) });
  assert.throws(() => store.save({ a: 1 }), /ENOSPC/);
  assert.ok(logs.some((l) => l.includes("ENOSPC")), "write failure must be logged, not swallowed");
});

test("save(): rename failure is surfaced (thrown), not silently swallowed", () => {
  const fs = fakeFs();
  fs.renameSync = () => { throw new Error("EPERM: rename blocked"); };
  const logs = [];
  const store = createKeyStore({ path: "/x/keys.json", fs, log: (m) => logs.push(m) });
  assert.throws(() => store.save({ a: 1 }), /EPERM/);
  assert.ok(logs.some((l) => l.includes("EPERM")), "rename failure must be logged, not swallowed");
});

test("save(): directory creation uses a restrictive mode (0700) intent, not world-readable default", () => {
  const seenMkdirOpts = [];
  const fs = fakeFs();
  const realMkdir = fs.mkdirSync;
  fs.mkdirSync = (dir, opts) => { seenMkdirOpts.push(opts); return realMkdir(dir, opts); };
  const store = createKeyStore({ path: "/x/keys.json", fs });
  store.save({ a: 1 });
  assert.equal(seenMkdirOpts.length, 1);
  assert.equal(seenMkdirOpts[0].mode, 0o700);
  assert.equal(seenMkdirOpts[0].recursive, true);
});

// ── one keystore per host (1.6.1): a second app on the machine must not become the first app's agent ──

const SHARED = join("/h", ".bc", "mcpb-session-keys.json");
const own = (host) => join("/h", ".bc", `${host}-session-keys.json`);
const PAIRED = JSON.stringify({ __resolved_bc_token__: { bcToken: "bc_first_app" } });

test("normalizeHostId: plain ids pass; placeholders, paths and junk are not ids", () => {
  for (const [v, want] of [["codex", "codex"], [" Claude-Code ", "claude-code"], ["claude-desktop", "claude-desktop"]]) assert.equal(normalizeHostId(v), want, v);
  for (const v of ["", undefined, null, "${user_config.host}", "../evil", "a/b", "a\\b", "-x", "x".repeat(33), "has space"]) assert.equal(normalizeHostId(v), "", String(v));
});

test("hostKeystorePath: sits next to the shared file, named for the host", () => {
  assert.equal(hostKeystorePath("codex", SHARED), own("codex"));
});

test("resolveKeystorePath: BC_KEYSTORE_PATH wins outright, even with a host named, and nothing is moved", () => {
  const fs = fakeFs({ [SHARED]: PAIRED });
  assert.equal(resolveKeystorePath({ explicitPath: "/custom/keys.json", host: "codex", sharedPath: SHARED, fs }), "/custom/keys.json");
  assert.equal(fs.files.get(SHARED), PAIRED);
});

test("resolveKeystorePath: no host named -> the shared file, exactly as before 1.6.1", () => {
  const fs = fakeFs({ [SHARED]: PAIRED });
  assert.equal(resolveKeystorePath({ sharedPath: SHARED, fs }), SHARED);
  assert.equal(fs.files.get(SHARED), PAIRED);
});

test("resolveKeystorePath: an unusable host id is logged and treated as no host", () => {
  const logs = [];
  const fs = fakeFs({ [SHARED]: PAIRED });
  assert.equal(resolveKeystorePath({ host: "${user_config.host}", sharedPath: SHARED, fs, log: (m) => logs.push(m) }), SHARED);
  assert.ok(logs.some((l) => l.includes("unusable host id")));
  assert.equal(fs.files.get(SHARED), PAIRED);
});

test("resolveKeystorePath: the first host to start takes the shared file over; it keeps its pairing", () => {
  const logs = [];
  const fs = fakeFs({ [SHARED]: PAIRED });
  assert.equal(resolveKeystorePath({ host: "codex", sharedPath: SHARED, fs, log: (m) => logs.push(m) }), own("codex"));
  assert.equal(fs.files.get(own("codex")), PAIRED);
  assert.equal(fs.files.has(SHARED), false, "the shared file is moved, not copied: a copy would leave the key for the next app to adopt");
  assert.ok(logs.some((l) => l.includes("took over the shared keystore")));
});

test("resolveKeystorePath: a second host finds the shared file gone and starts on its own, empty file", () => {
  const fs = fakeFs({ [SHARED]: PAIRED });
  resolveKeystorePath({ host: "codex", sharedPath: SHARED, fs });
  assert.equal(resolveKeystorePath({ host: "claude-code", sharedPath: SHARED, fs }), own("claude-code"));
  assert.equal(fs.files.has(own("claude-code")), false, "unpaired: it will offer bc_connect");
  assert.equal(fs.files.get(own("codex")), PAIRED, "and the first host's pairing is untouched");
});

test("resolveKeystorePath: a host that already has its own file never touches the shared one", () => {
  const mine = JSON.stringify({ __resolved_bc_token__: { bcToken: "bc_mine" } });
  const fs = fakeFs({ [SHARED]: PAIRED, [own("claude-code")]: mine });
  assert.equal(resolveKeystorePath({ host: "claude-code", sharedPath: SHARED, fs }), own("claude-code"));
  assert.equal(fs.files.get(own("claude-code")), mine);
  assert.equal(fs.files.get(SHARED), PAIRED);
});

test("resolveKeystorePath: losing the rename race (ENOENT) means another host has it — start unpaired, quietly", () => {
  const logs = [];
  const fs = { existsSync: (p) => p === SHARED, renameSync: () => { throw Object.assign(new Error("ENOENT: gone"), { code: "ENOENT" }); } };
  assert.equal(resolveKeystorePath({ host: "codex", sharedPath: SHARED, fs, log: (m) => logs.push(m) }), own("codex"));
  assert.deepEqual(logs, []);
});

test("resolveKeystorePath: any other rename failure stays on the shared file for this run, loudly", () => {
  const logs = [];
  const fs = { existsSync: (p) => p === SHARED, renameSync: () => { throw Object.assign(new Error("EPERM: in use"), { code: "EPERM" }); } };
  assert.equal(resolveKeystorePath({ host: "codex", sharedPath: SHARED, fs, log: (m) => logs.push(m) }), SHARED, "fail toward the old behaviour, never toward losing a pairing");
  assert.ok(logs.some((l) => l.includes("EPERM")));
});

test("resolveKeystorePath: adoptShared:false (the hook) resolves the host's path and never moves anything", () => {
  const fs = fakeFs({ [SHARED]: PAIRED });
  assert.equal(resolveKeystorePath({ host: "claude-code", adoptShared: false, sharedPath: SHARED, fs }), own("claude-code"));
  assert.equal(fs.files.get(SHARED), PAIRED);
  assert.equal(fs.files.has(own("claude-code")), false);
});

test("resolveKeystorePath on a real filesystem: Codex paired first, Claude Code installed second -> two agents, not one", () => {
  const dir = mkdtempSync(join(tmpdir(), "bc-keystore-"));
  const shared = join(dir, "mcpb-session-keys.json");
  writeFileSync(shared, PAIRED);
  const codex = createKeyStore({ path: resolveKeystorePath({ host: "codex", sharedPath: shared }) });
  const claudeCode = createKeyStore({ path: resolveKeystorePath({ host: "claude-code", sharedPath: shared }) });
  assert.equal(codex.load().__resolved_bc_token__?.bcToken, "bc_first_app");
  assert.equal(claudeCode.load().__resolved_bc_token__, undefined, "Claude Code must not inherit the Codex key");
  assert.equal(existsSync(shared), false);
  assert.equal(JSON.parse(readFileSync(join(dir, "codex-session-keys.json"), "utf8")).__resolved_bc_token__.bcToken, "bc_first_app");
});
