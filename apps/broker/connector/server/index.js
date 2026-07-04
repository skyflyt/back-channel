// Back Channel .mcpb entry point.
//
// UNCONDITIONAL on purpose: Claude Desktop's bundled Node invokes this through
// a wrapper, so `process.argv[1]` is NOT this file — any
// `import.meta.url === pathToFileURL(argv[1])` "is main module" guard evaluates
// false, the process idles doing nothing, and Desktop shows "Unable to connect".
// All logic lives in lib.js so tests import that, never this.
import { createBridge } from "./lib.js";
import { createKeyStore } from "./keystore.js";

const log = (...a) => console.error("[back-channel]", ...a);

// M4 hardening (2026-07-03): read the bc_ token/exchange-code out of
// process.env exactly once, into this closure-scoped const, then scrub it
// from process.env immediately — so it doesn't linger in this process's
// environment block for the rest of the (long-lived, stdio) process
// lifetime, readable by anything that can inspect this process's env (e.g.
// /proc/<pid>/environ on Linux, other code running in-process, a future
// dependency that dumps process.env for diagnostics). Desktop sets it once
// at spawn time via manifest.json's mcp_config.env — createBridge() never
// re-reads process.env after this point, so deleting it here is safe.
const token = (process.env.BC_TOKEN || "").trim();
delete process.env.BC_TOKEN;

// BC_KEYSTORE_PATH: override where per-session E2E identities are persisted.
// Useful for running more than one bridge identity on the same machine (e.g.
// testing both sides of a conversation locally) — normally left unset, which
// defaults to ~/.bc/mcpb-session-keys.json.
const keystore = process.env.BC_KEYSTORE_PATH ? createKeyStore({ path: process.env.BC_KEYSTORE_PATH, log }) : createKeyStore({ log });

createBridge({
  url: process.env.BC_MCP_URL || "https://back-channel.app/api/mcp",
  token,
  log,
  keystore,
}).start();
