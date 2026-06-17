/**
 * Back Channel — Protocol message types.
 *
 * The wire format is JSON. These types define what each message looks like.
 * Phase 1 transport is in-memory; later phases will encode/decode the same shapes
 * over WebSocket via the Broker.
 */

import type { Scope } from "./scopes.js";

/** Unique session identifier, generated when an invite is accepted. */
export type SessionId = string;

/** Unique message identifier within a session. */
export type MessageId = string;

/**
 * Capability descriptor — what the host advertises it can do under a given scope.
 * The visitor sees these after capability discovery.
 */
export interface Capability {
  /** Stable name, e.g., "config.read-file" */
  readonly name: string;
  /** Human-readable description shown in the host UI and audit log. */
  readonly description: string;
  /** Scope this capability requires. If the visitor doesn't have it, the capability is hidden. */
  readonly scope: Scope;
  /** Arguments the capability accepts. */
  readonly args?: ReadonlyArray<CapabilityArg>;
  /** If true, the host gates every invocation behind human approval. */
  readonly requiresApproval: boolean;
}

export interface CapabilityArg {
  readonly name: string;
  readonly type: "string" | "number" | "boolean" | "object";
  readonly required: boolean;
  readonly description: string;
}

/**
 * A session invitation. Created by the host, claimed by the visitor.
 * In Phase 1 these are passed directly; in Phase 3+ they ride through the Broker.
 */
export interface SessionInvite {
  readonly sessionId: SessionId;
  readonly hostId: string;
  readonly visitorId: string;
  readonly scopes: ReadonlyArray<Scope>;
  readonly expiresAt: Date;
  readonly message?: string;
}

/** Base shape for every message on the wire. */
export interface BCMessageBase {
  readonly id: MessageId;
  readonly sessionId: SessionId;
  readonly ts: string; // ISO timestamp
}

export interface CapabilitiesRequest extends BCMessageBase {
  readonly type: "capabilities.request";
}

export interface CapabilitiesResponse extends BCMessageBase {
  readonly type: "capabilities.response";
  readonly capabilities: ReadonlyArray<Capability>;
}

export interface InvokeRequest extends BCMessageBase {
  readonly type: "invoke.request";
  readonly capability: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface InvokeResponse extends BCMessageBase {
  readonly type: "invoke.response";
  readonly requestId: MessageId;
  readonly status: "ok" | "denied" | "rejected" | "error";
  readonly result?: unknown;
  readonly error?: string;
}

export interface SessionEnd extends BCMessageBase {
  readonly type: "session.end";
  readonly reason: "natural" | "kicked_by_host" | "kicked_by_visitor" | "timeout" | "error";
}

/** Union of every message a visitor or host can send. */
export type BCMessage =
  | CapabilitiesRequest
  | CapabilitiesResponse
  | InvokeRequest
  | InvokeResponse
  | SessionEnd;

/** Approval request shown to the host human. Not transmitted on wire — local UI only. */
export interface ApprovalRequest {
  readonly sessionId: SessionId;
  readonly visitorId: string;
  readonly capability: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly description: string;
}

/** Utility: make a new message id. */
export function newMessageId(): MessageId {
  // Cheap unique id — replace with proper UUID before MVP
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Utility: make a new session id. */
export function newSessionId(): SessionId {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}
