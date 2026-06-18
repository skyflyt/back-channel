// Type-only shim — API routes import these symbols at build time.
// At runtime, the same symbols come from relay.mjs via server.mjs (state is
// shared through globalThis, so the route bundle and the WS server see one Map).
export { kickSession, pollSession, getPeers, getTranscript, sessionUnread } from "./relay.mjs";
