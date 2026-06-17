/**
 * Back Channel — Visitor agent.
 *
 * The "visitor" is the agent of the person helping. It:
 * - Accepts a session invite.
 * - Discovers what capabilities the host is offering (scope-filtered).
 * - Invokes capabilities and handles approval/denial responses.
 * - Logs every event to its own transcript.
 */

import {
  newMessageId,
  type BCMessage,
  type Capability,
  type InvokeResponse,
  type SessionInvite,
} from "./messages.js";
import { type Transcript, makeEvent } from "./transcript.js";
import type { Transport } from "./transport/in-memory.js";

export interface VisitorAgentOptions {
  readonly visitorId: string;
  readonly transport: Transport;
  readonly transcript: Transcript;
}

export class VisitorAgent {
  private session: SessionInvite | null = null;
  private capabilities: ReadonlyArray<Capability> = [];

  constructor(private readonly opts: VisitorAgentOptions) {
    opts.transport.onMessage(this.handleMessage.bind(this));
  }

  /** Accept a session and prepare to talk to the host. */
  async openSession(invite: SessionInvite): Promise<void> {
    this.session = invite;
    this.opts.transcript.log(
      makeEvent({
        sessionId: invite.sessionId,
        role: "visitor",
        kind: "session.start",
        detail: { hostId: invite.hostId, scopes: [...invite.scopes] },
      }),
    );
  }

  /** Ask the host what capabilities are available. */
  async discoverCapabilities(): Promise<ReadonlyArray<Capability>> {
    const session = this.requireSession();
    this.opts.transcript.log(
      makeEvent({
        sessionId: session.sessionId,
        role: "visitor",
        kind: "capabilities.requested",
        detail: {},
      }),
    );
    const request: BCMessage = {
      id: newMessageId(),
      sessionId: session.sessionId,
      ts: new Date().toISOString(),
      type: "capabilities.request",
    };
    const resp = await this.opts.transport.send(request);
    if (!resp || resp.type !== "capabilities.response") {
      throw new Error(`Unexpected response to capabilities.request: ${resp?.type ?? "none"}`);
    }
    this.capabilities = resp.capabilities;
    return this.capabilities;
  }

  /** Invoke a host capability. Returns the result on success, throws on denial/error. */
  async invoke<T = unknown>(
    capability: string,
    args: Readonly<Record<string, unknown>> = {},
  ): Promise<T> {
    const session = this.requireSession();
    const request: BCMessage = {
      id: newMessageId(),
      sessionId: session.sessionId,
      ts: new Date().toISOString(),
      type: "invoke.request",
      capability,
      args,
    };
    this.opts.transcript.log(
      makeEvent({
        sessionId: session.sessionId,
        role: "visitor",
        kind: "invoke.requested",
        detail: { capability, args },
      }),
    );
    const resp = await this.opts.transport.send(request);
    if (!resp || resp.type !== "invoke.response") {
      throw new Error(`Unexpected response to invoke.request: ${resp?.type ?? "none"}`);
    }
    const r = resp as InvokeResponse;
    switch (r.status) {
      case "ok":
        this.opts.transcript.log(
          makeEvent({
            sessionId: session.sessionId,
            role: "visitor",
            kind: "invoke.completed",
            detail: { capability },
          }),
        );
        return r.result as T;
      case "denied":
        this.opts.transcript.log(
          makeEvent({
            sessionId: session.sessionId,
            role: "visitor",
            kind: "scope.denied",
            detail: { capability, error: r.error },
          }),
        );
        throw new Error(`Capability "${capability}" denied: ${r.error ?? "no detail"}`);
      case "rejected":
        this.opts.transcript.log(
          makeEvent({
            sessionId: session.sessionId,
            role: "visitor",
            kind: "invoke.rejected_by_human",
            detail: { capability },
          }),
        );
        throw new Error(`Capability "${capability}" rejected by host`);
      case "error":
        this.opts.transcript.log(
          makeEvent({
            sessionId: session.sessionId,
            role: "visitor",
            kind: "invoke.errored",
            detail: { capability, error: r.error },
          }),
        );
        throw new Error(`Capability "${capability}" errored: ${r.error}`);
    }
  }

  /** End the session politely. */
  async endSession(reason: "natural" | "kicked_by_visitor" = "natural"): Promise<void> {
    const session = this.session;
    if (!session) return;
    const msg: BCMessage = {
      id: newMessageId(),
      sessionId: session.sessionId,
      ts: new Date().toISOString(),
      type: "session.end",
      reason,
    };
    await this.opts.transport.send(msg);
    this.opts.transcript.log(
      makeEvent({
        sessionId: session.sessionId,
        role: "visitor",
        kind: "session.end",
        detail: { reason, initiator: "visitor" },
      }),
    );
    this.session = null;
  }

  private async handleMessage(_msg: BCMessage): Promise<void> {
    // Visitor doesn't currently receive unsolicited messages — phase 1 is pure request/response.
    return;
  }

  private requireSession(): SessionInvite {
    if (!this.session) throw new Error("No active session. Call openSession() first.");
    return this.session;
  }
}
