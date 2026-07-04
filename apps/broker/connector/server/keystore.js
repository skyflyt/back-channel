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
 *
 * SECURITY (2026-07-03 hardening — H2/M1/M2 from the security pass):
 *   This file holds live bc_ bearer material (session ECDH private keys, and
 *   transiently the resolved bc_ token itself for exchange-code bootstrap).
 *   We evaluated OS-native secret storage (macOS Keychain / Windows Credential
 *   Manager / libsecret via a library such as keytar or @napi-rs/keyring) and
 *   deliberately did NOT adopt one:
 *     - The .mcpb is packed by scripts/pack-mcpb.mjs, a hand-rolled, zero-dep,
 *       fixed-file-list STORE-zip (see FILES array there) with no node_modules
 *       and no mechanism to ship per-platform prebuilt native (.node) addons.
 *       A native keychain module needs a prebuilt binary per OS/arch/ABI, and
 *       Claude Desktop's bundled Node/Electron ABI is not one we control or
 *       pin — a mismatched prebuild fails to `require()`, and per index.js's
 *       own docs, ANY startup exception here shows the user a bare "Unable to
 *       connect" with no actionable message. That failure mode is worse than
 *       a hardened file store on every platform we support (manifest.json
 *       lists darwin/win32/linux, incl. headless Linux with no libsecret).
 *     - keytar itself is unmaintained (archived) upstream — exactly the kind
 *       of dependency this hardening pass should avoid pulling in, not add.
 *   Given the packaging constraint, the correct fix is to hardern the file
 *   store itself rather than to swap storage backends:
 *     - atomic write: content is written to a per-process tmp file created
 *       with mode 0o600 from the FIRST syscall (not chmod'd after the fact —
 *       closes the M2 create-then-chmod race) and renamed into place.
 *     - POSIX (macOS/Linux): 0600 on both the tmp file and, defensively, the
 *       final path after rename (rename preserves the source file's mode, so
 *       this is normally a no-op — kept as a belt-and-braces re-assert).
 *     - Windows (M1): chmod is a documented no-op, so we additionally shell
 *       out to `icacls` to reset the ACL to a single Full-Control grant for
 *       the current user and strip inherited entries — see hardenWindowsAcl
 *       below. This is best-effort but no longer silently swallowed: failures
 *       are reported to the caller-supplied `log`, not dropped.
 *     - the ~/.bc directory itself is created with the same 0600-equivalent
 *       intent (0700 on POSIX; ACL'd on Windows) since a world-readable
 *       parent dir can still expose file contents via some backup/AV tooling.
 *     - write failures (ENOSPC, EACCES, etc.) are no longer swallowed by an
 *       empty catch — they're logged loudly and rethrown, since a silently
 *       failed save means the caller believes state persisted when it did
 *       not (e.g. a freshly-redeemed bc_ key that then evaporates on restart).
 *   If a future revision of pack-mcpb.mjs grows the ability to ship prebuilt
 *   native addons per-platform, OS keychain storage should be revisited as an
 *   opportunistic upgrade layered ON TOP of this hardened file store (try
 *   keychain first, fall back to the hardened file path and log which one is
 *   active) — the interface below (`load`/`save`) is intentionally storage-
 *   agnostic so that swap is additive, not a rewrite.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";

export const DEFAULT_KEYSTORE_PATH = join(homedir(), ".bc", "mcpb-session-keys.json");
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — sessions this stale are long over
const IS_WINDOWS = process.platform === "win32";

/**
 * Best-effort Windows ACL lockdown (M1): chmod(0o600) is a documented no-op
 * on Windows, so on this platform we shell out to icacls to:
 *   1. strip inherited ACEs (/inheritance:r)
 *   2. grant the CURRENT user Full control, and nobody else (/grant:r "%USERNAME%":F)
 * `/grant:r` (not `/grant`) REPLACES the explicit ACL rather than appending,
 * so this is idempotent across repeated saves. Failures are reported via the
 * injected `log`, never thrown — a locked-down-but-imperfect file beats a
 * bridge that refuses to start because icacls.exe wasn't on PATH.
 */
function hardenWindowsAcl(path, { execFileSyncImpl = execFileSync, log = () => {} } = {}) {
  try {
    const user = userInfo().username || process.env.USERNAME;
    if (!user) {
      log("keystore: could not resolve current username — skipping icacls ACL hardening");
      return;
    }
    execFileSyncImpl("icacls", [path, "/inheritance:r", "/grant:r", `${user}:F`], { stdio: "ignore", windowsHide: true });
  } catch (e) {
    // Best-effort: file still exists and is writable by the owning account by
    // default NTFS inheritance — this only narrows further. Never fatal.
    log(`keystore: icacls ACL hardening failed (continuing with default NTFS ACL): ${e?.message ?? e}`);
  }
}

export function createKeyStore({
  path = DEFAULT_KEYSTORE_PATH,
  fs = { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync },
  execFileSyncImpl = execFileSync,
  now = () => Date.now(),
  log = () => {}, // caller-supplied logger (lib.js wires this to console.error via its own `log`)
  isWindows = IS_WINDOWS,
} = {}) {
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
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (e) {
      if (e?.code !== "EEXIST") log(`keystore: could not create ${dir}: ${e?.message ?? e}`);
      /* EEXIST (or a platform ignoring `mode` on mkdir) is fine — directory is there either way */
    }

    const tmp = `${path}.tmp.${process.pid}`;
    try {
      // mode is set AT CREATE TIME (O_CREAT with 0o600), not chmod'd after the
      // fact — closes the M2 create-then-chmod window where a narrow race (or
      // a crash between the two calls) could leave a world-readable file.
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
    } catch (e) {
      log(`keystore: write failed for ${tmp}: ${e?.message ?? e}`);
      throw e; // surface — a caller that thinks save() succeeded when it didn't is worse than a thrown error
    }

    if (!isWindows) {
      try {
        fs.chmodSync(tmp, 0o600);
      } catch (e) {
        // POSIX chmod failing here is unusual (we just created the file) but
        // not fatal — the create-time mode above already applied 0600.
        log(`keystore: chmod 0600 failed for ${tmp} (create-time mode already applied): ${e?.message ?? e}`);
      }
    }

    try {
      fs.renameSync(tmp, path);
    } catch (e) {
      log(`keystore: rename ${tmp} -> ${path} failed: ${e?.message ?? e}`);
      throw e; // surface — caller must not assume state persisted
    }

    if (isWindows) {
      // M1: chmod is a no-op on Windows — apply an explicit ACL instead.
      hardenWindowsAcl(path, { execFileSyncImpl, log });
    } else {
      // Defensive re-assert: rename() preserves the source inode's mode, so
      // this is normally redundant with the create-time mode above, but it's
      // cheap insurance against any fs/rename edge case that doesn't.
      try {
        fs.chmodSync(path, 0o600);
      } catch (e) {
        log(`keystore: post-rename chmod 0600 failed for ${path}: ${e?.message ?? e}`);
      }
    }
  }

  return { load, save };
}
