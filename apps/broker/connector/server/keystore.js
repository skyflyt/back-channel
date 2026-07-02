/**
 * Back Channel .mcpb bridge — local persistence for per-session crypto state.
 *
 * A Claude Desktop conversation (and the underlying Back Channel thread) can
 * span days under the async inbox model, but the bridge is a short-lived
 * stdio child process re-spawned per Desktop session — so the ephemeral P-256
 * identity generated for a thread MUST be persisted across restarts, or a
 * restart would force a re-handshake (survivable per protocol's "always use
 * the latest handshake.pubkey" rule, but disruptive and easy to avoid).
 *
 * Stored at ~/.bc/mcpb-session-keys.json, alongside the skill's own ~/.bc/
 * keep-warm state (same convention, different file). Filesystem is injectable
 * for tests — default is real node:fs.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_KEYSTORE_PATH = join(homedir(), ".bc", "mcpb-session-keys.json");
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — sessions this stale are long over

export function createKeyStore({ path = DEFAULT_KEYSTORE_PATH, fs = { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync }, now = () => Date.now() } = {}) {
  function load() {
    let raw = {};
    try {
      if (fs.existsSync(path)) raw = JSON.parse(fs.readFileSync(path, "utf8"));
    } catch {
      raw = {}; // corrupt file — start fresh rather than crash the bridge
    }
    const cutoff = now() - PRUNE_AFTER_MS;
    const pruned = {};
    for (const [sessionId, entry] of Object.entries(raw)) {
      if (typeof entry?.updatedAt === "number" && entry.updatedAt < cutoff) continue;
      pruned[sessionId] = entry;
    }
    return pruned;
  }

  function save(state) {
    const dir = join(path, "..");
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* already exists */ }
    const tmp = `${path}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    try { fs.chmodSync(tmp, 0o600); } catch { /* best-effort — no-op on Windows */ }
    fs.renameSync(tmp, path);
  }

  return { load, save };
}
