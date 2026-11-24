import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { HOLD_MS, WORKER_FRESH_MS, VaultBridgeError, _resetVaultBridge, ask, collect, deliver, nextRequest, workerOnline } from "./vault-bridge.mjs";

beforeEach(() => { _resetVaultBridge(); mock.timers.reset(); });

test("a worker counts as online only while it keeps polling", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  assert.equal(workerOnline("a"), false);
  await nextRequest("a", "w", 0);
  assert.equal(workerOnline("a"), true);
  mock.timers.tick(WORKER_FRESH_MS + 1);
  assert.equal(workerOnline("a"), false);
  assert.throws(() => ask("a", "chat", "read", { path: "x" }), (e) => e instanceof VaultBridgeError && e.code === "vault_offline");
});

test("unanswered and uncollected reads are dropped after the hold time", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  await nextRequest("a", "w", 0);
  const id = ask("a", "chat", "read", { path: "x" });
  const handed = await nextRequest("a", "w", 0);
  assert.equal(handed.id, id);
  assert.deepEqual(deliver("a", "w", id, { ok: true, result: { text: "t" } })?.id, id);
  assert.deepEqual(await collect("a", "chat", id, 0), { answer: { ok: true, result: { text: "t" } } });
  assert.equal(await collect("a", "chat", id, 0), null, "handed out once");
  const late = ask("a", "chat", "status", {});
  mock.timers.tick(HOLD_MS + 1);
  await nextRequest("a", "w", 0);
  assert.equal(await collect("a", "chat", late, 0), null, "expired");
  assert.equal(deliver("a", "w", late, { ok: true, result: {} }), null);
});

test("a request goes to one parked poll; a newer poll from the same worker ends the older", async () => {
  await nextRequest("a", "w", 0);
  const older = nextRequest("a", "w", 5000);
  const newer = nextRequest("a", "w", 5000);
  assert.equal(await older, null);
  const id = ask("a", "chat", "list", {});
  assert.equal((await newer).id, id);
});
