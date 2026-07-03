// Type-only shim - TS API routes import these symbols at build time.
// The runtime implementation lives in inbox-bus.mjs (shared with relay.mjs,
// which fires the doorbell from ingestFrame). Mirrors the relay.ts / relay.mjs
// and rate-limit.ts / rate-limit.mjs splits.
export {
  fireInboxEvent,
  setPendingCounter,
  currentEvent,
  subscribeSse,
  unsubscribeSse,
  waitForInbox,
  writeSseEvent,
  writeSseHeartbeat,
  heldStreamCount,
  MAX_WAIT_MS,
} from "./inbox-bus.mjs";
export type InboxKind = "frame" | "payload" | "invite";
export type InboxEvent = {
  pending_count: number;
  since: string;
  timestamp: string;
  kinds?: InboxKind[];
};