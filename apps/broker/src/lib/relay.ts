// Type-only shim — API routes import these symbols at build time.
// At runtime, the same symbols come from relay.mjs via server.mjs.
export { kickSession } from "./relay.mjs";
