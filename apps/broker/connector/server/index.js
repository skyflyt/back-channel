// Back Channel .mcpb entry point.
//
// UNCONDITIONAL on purpose: Claude Desktop's bundled Node invokes this through
// a wrapper, so `process.argv[1]` is NOT this file — any
// `import.meta.url === pathToFileURL(argv[1])` "is main module" guard evaluates
// false, the process idles doing nothing, and Desktop shows "Unable to connect".
// All logic lives in lib.js so tests import that, never this.
import { createBridge } from "./lib.js";
import { createKeyStore } from "./keystore.js";

// BC_KEYSTORE_PATH: override where per-session E2E identities are persisted.
// Useful for running more than one bridge identity on the same machine (e.g.
// testing both sides of a conversation locally) — normally left unset, which
// defaults to ~/.bc/mcpb-session-keys.json.
const keystore = process.env.BC_KEYSTORE_PATH ? createKeyStore({ path: process.env.BC_KEYSTORE_PATH }) : undefined;

createBridge({
  url: process.env.BC_MCP_URL || "https://back-channel.app/api/mcp",
  token: (process.env.BC_TOKEN || "").trim(),
  ...(keystore ? { keystore } : {}),
}).start();
