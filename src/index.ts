/**
 * Back Channel — Public API surface.
 *
 * import { HostAgent, VisitorAgent, ... } from "back-channel"
 */

export {
  HostAgent,
  type HostAgentOptions,
  type RegisteredCapability,
  type ApproveFn,
} from "./host.js";

export {
  VisitorAgent,
  type VisitorAgentOptions,
} from "./visitor.js";

export {
  type Scope,
  type BlockedScope,
  ALL_SCOPES,
  BLOCKED_SCOPES,
  READ_ONLY_SCOPES,
  SUGGEST_SCOPES,
  APPLY_SCOPES,
  SCOPE_PRESETS,
  isScope,
  isBlockedScope,
  validateScopes,
  hasApplyScope,
} from "./scopes.js";

export {
  type BCMessage,
  type BCMessageBase,
  type SessionInvite,
  type SessionId,
  type MessageId,
  type Capability,
  type CapabilityArg,
  type CapabilitiesRequest,
  type CapabilitiesResponse,
  type InvokeRequest,
  type InvokeResponse,
  type SessionEnd,
  type ApprovalRequest,
  newMessageId,
  newSessionId,
} from "./messages.js";

export {
  type Transcript,
  type TranscriptEvent,
  InMemoryTranscript,
  ConsoleTranscript,
  makeEvent,
} from "./transcript.js";

export {
  type Transport,
  type MessageHandler,
  createInMemoryTransportPair,
} from "./transport/in-memory.js";

export {
  createWebSocketHostTransport,
  createWebSocketVisitorTransport,
} from "./transport/websocket.js";

export {
  newEphemeralKeypair,
  deriveSessionKey,
  randomSessionKey,
  type EphemeralKeypair,
} from "./crypto/session-key.js";

export {
  seal,
  open as openEnvelope,
  type SealedEnvelope,
} from "./crypto/envelope.js";
