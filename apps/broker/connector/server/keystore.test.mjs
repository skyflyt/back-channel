import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeyStore } from "./keystore.js";

function fakeFs(initialFiles = {}) {
  const files = new Map(Object.entries(initialFiles));
  return {
    files,
    existsSync: (p) => files.has(p),
    readFileSync: (p) => { if (!files.has(p)) throw new Error("ENOENT"); return files.get(p); },
    writeFileSync: (p, data) => files.set(p, data),
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    mkdirSync: () => {},
    chmodSync: () => {},
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
