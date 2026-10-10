// SessionStart hook entry point (Claude Code and Codex both run this file via
// hooks/hooks.json). All logic is in ../server/session-start.js so tests can
// import it; this file only wires the real environment and guarantees the one
// property a session-start hook must have: it cannot fail and it cannot hang.
import { readFileSync } from "node:fs";
import { sessionStartNote, hookHost } from "../server/session-start.js";
import { createKeyStore, resolveKeystorePath } from "../server/keystore.js";
import { DEFAULT_TOKEN_FILE } from "../server/lib.js";

// Belt and braces over the fetch timeout: whatever happens, be gone in 6s.
setTimeout(() => process.exit(0), 6_000).unref();

try {
  const env = process.env;
  // Read-only: the host is a guess from the environment (hookHost), so the hook
  // never takes over the shared keystore — only the bridge, which is told its
  // host by its manifest, does that.
  const keystore = createKeyStore({ path: resolveKeystorePath({ explicitPath: env.BC_KEYSTORE_PATH, host: hookHost(env), adoptShared: false }) });
  const tokenFile = env.BC_TOKEN_FILE || DEFAULT_TOKEN_FILE;
  const readTokenFile = () => {
    try {
      return readFileSync(tokenFile, "utf8").trim();
    } catch {
      return "";
    }
  };
  const line = await sessionStartNote({ env, keystore, readTokenFile });
  if (line) process.stdout.write(line + "\n");
} catch {
  // Silence is the contract. Nothing useful can be said to a user from here.
}
process.exit(0);
