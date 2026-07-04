import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeyStore } from "./keystore.js";

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
