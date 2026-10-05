// Back Channel bridge entry point — the same file runs as the Claude Desktop
// extension (.mcpb), the Claude Code plugin's MCP server, and the Codex
// plugin's MCP server.
//
// UNCONDITIONAL on purpose: Claude Desktop's bundled Node invokes this through
// a wrapper, so `process.argv[1]` is NOT this file — any
// `import.meta.url === pathToFileURL(argv[1])` "is main module" guard evaluates
// false, the process idles doing nothing, and Desktop shows "Unable to connect".
// All logic lives in lib.js so tests import that, never this.
import { readFileSync } from "node:fs";
import { createBridge, DEFAULT_TOKEN_FILE } from "./lib.js";
import { createKeyStore } from "./keystore.js";

const log = (...a) => console.error("[back-channel]", ...a);

// M4 hardening (2026-07-03): read the bc_ token/exchange-code out of
// process.env exactly once, into this closure-scoped const, then scrub it
// from process.env immediately — so it doesn't linger in this process's
// environment block for the rest of the (long-lived, stdio) process
// lifetime, readable by anything that can inspect this process's env (e.g.
// /proc/<pid>/environ on Linux, other code running in-process, a future
// dependency that dumps process.env for diagnostics). The host sets it once
// at spawn time (manifest.json's mcp_config.env, or a plugin's MCP config) —
// createBridge() never re-reads process.env after this point, so deleting it
// here is safe.
const token = (process.env.BC_TOKEN || "").trim();
delete process.env.BC_TOKEN;

// BC_KEYSTORE_PATH: override where per-session E2E identities are persisted.
// Useful for running more than one bridge identity on the same machine (e.g.
// testing both sides of a conversation locally) — normally left unset, which
// defaults to ~/.bc/mcpb-session-keys.json.
const keystore = process.env.BC_KEYSTORE_PATH ? createKeyStore({ path: process.env.BC_KEYSTORE_PATH, log }) : createKeyStore({ log });

// With no token configured, fall back to the key `npx backchannel-cli --pair`
// stored (~/.bc/token; BC_TOKEN_FILE overrides). Absent/unreadable = unpaired,
// and the bridge then comes up offering bc_connect instead of failing.
const tokenFile = process.env.BC_TOKEN_FILE || DEFAULT_TOKEN_FILE;
const readTokenFile = () => {
  try {
    return readFileSync(tokenFile, "utf8").trim();
  } catch {
    return "";
  }
};

// A host that leaves the endpoint option unset may pass its own placeholder
// (`${user_config.mcp_url}`) rather than nothing — anything that isn't an
// http(s) URL counts as unset.
const configuredUrl = (process.env.BC_MCP_URL || "").trim();

createBridge({
  url: /^https?:\/\//i.test(configuredUrl) ? configuredUrl : "https://back-channel.app/api/mcp",
  token,
  log,
  keystore,
  readTokenFile,
}).start();
