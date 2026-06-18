// Type-only shim — TS API routes import these symbols at build time.
// The runtime implementation lives in rate-limit.mjs (shared with relay.mjs).
// Mirrors the relay.ts / relay.mjs split.
export { rateLimit, clientIp } from "./rate-limit.mjs";
