/**
 * Back Channel — Host agent.
 *
 * The "host" is the agent of the person being helped. It:
 * - Advertises capabilities filtered by the granted scopes.
 * - Enforces scope at every invocation.
 * - Routes write-tier capabilities through a human approval callback.
 * - Logs every event to the transcript.
 */

import {
  newMessageId,
  type BCMessage,
  type Capability,
  type InvokeRequest,
  type InvokeResponse,
  type SessionInvite,
} from "./messages.js";
import { type Scope, validateScopes } from "./scopes.js";
import {
  type Transcript,
  makeEvent,
} from "./transcript.js";
import type { Transport } from "./transport/in-memory.js";

/** A capability with its concrete handler. The host registers these. */
export interface RegisteredCapability extends Capability {
  /** Handler invoked when the visitor calls this capability AFTER any approval. */
  readonly handler: (args: Readonly<Record<string, unknown>>) => Promise<unknown>;
}

/** Approval callback. Resolves true to allow, false to reject. */
export type ApproveFn = (req: {
  capability: string;
  description: string;
  args: Readonly<Record<string, unknown>>;
}) => Promise<boolean>;

export interface HostAgentOptions {
  /** Identifier this host advertises to the visitor. */
  readonly hostId: string;
  /** Transport carrying messages to/from the visitor. */
  readonly transport: Transport;
  /** Capabilities the host CAN expose (subject to scope filtering). */
  readonly capabilities: ReadonlyArray<RegisteredCapability>;
  /** Approval callback for write-tier invocations. */
  readonly approve: ApproveFn;
  /** Transcript logger. */
  readonly transcript: Transcript;
}

export class HostAgent {
  private session: SessionInvite | null = null;
  private readonly capabilitiesByName: Map<string, RegisteredCapability>;

  constructor(private readonly opts: HostAgentOptions) {
    this.capabilitiesByName = new Map(opts.capabilities.map((c) => [c.name, c]));
    opts.transport.onMessage(this.handleMessage.bind(this));
  }

  /** Accept a session invite and start serving. */
  async accept(invite: SessionInvite): Promise<void> {
    validateScopes(invite.scopes);
    this.session = invite;
    this.opts.transcript.log(
      makeEvent({
        sessionId: invite.sessionId,
        role: "host",
        kind: "session.start",
        detail: { visitorId: invite.visitorId, scopes: [...invite.scopes] },
      }),
    );
  }

  /** Get the capabilities this session has access to (scope-filtered). */
  private visibleCapabilities(): ReadonlyArray<Capability> {
    if (!this.session) return [];
    const granted = new Set<Scope>(this.session.scopes);
    return this.opts.capabilities
      .filter((c) => granted.has(c.scope))
      .map(({ handler, ...c }) => c);
  }

  private async handleMessage(msg: BCMessage): Promise<BCMessage | void> {
    if (!this.session) {
      throw new Error("Host received message before session.accept()");
    }
    switch (msg.type) {
      case "capabilities.request":
        return this.handleCapabilitiesRequest(msg.id);
      case "invoke.request":
        return this.handleInvokeRequest(msg);
      case "session.end":
        this.opts.transcript.log(
          makeEvent({
            sessionId: this.session.sessionId,
            role: "host",
            kind: "session.end",
            detail: { reason: msg.reason, initiator: "visitor" },
          }),
        );
        this.session = null;
        return;
      default:
        return;
    }
  }

  private handleCapabilitiesRequest(_requestId: string): BCMessage {
    const caps = this.visibleCapabilities();
    this.opts.transcript.log(
      makeEvent({
        sessionId: this.session!.sessionId,
        role: "host",
        kind: "capabilities.advertised",
        detail: { count: caps.length, names: caps.map((c) => c.name) },
      }),
    );
    return {
      id: newMessageId(),
      sessionId: this.session!.sessionId,
      ts: new Date().toISOString(),
      type: "capabilities.response",
      capabilities: caps,
    };
  }

  private async handleInvokeRequest(req: InvokeRequest): Promise<InvokeResponse> {
    const session = this.session!;
    const cap = this.capabilitiesByName.get(req.capability);

    if (!cap) {
      this.opts.transcript.log(
        makeEvent({
          sessionId: session.sessionId,
          role: "host",
          kind: "scope.denied",
          detail: { capability: req.capability, reason: "unknown_capability" },
        }),
      );
      return this.respond(req, "denied", undefined, "Unknown capability");
    }

    if (!session.scopes.includes(cap.scope)) {
      this.opts.transcript.log(
        makeEvent({
          sessionId: session.sessionId,
          role: "host",
          kind: "scope.denied",
          detail: { capability: req.capability, required_scope: cap.scope },
        }),
      );
      return this.respond(req, "denied", undefined, `Scope "${cap.scope}" not granted`);
    }

    this.opts.transcript.log(
      makeEvent({
        sessionId: session.sessionId,
        role: "host",
        kind: "invoke.requested",
        detail: { capability: req.capability, args: req.args },
      }),
    );

    if (cap.requiresApproval) {
      const ok = await this.opts.approve({
        capability: cap.name,
        description: cap.description,
        args: req.args,
      });
      if (!ok) {
        this.opts.transcript.log(
          makeEvent({
            sessionId: session.sessionId,
            role: "host",
            kind: "invoke.rejected_by_human",
            detail: { capability: req.capability },
          }),
        );
        return this.respond(req, "rejected", undefined, "Rejected by host");
      }
      this.opts.transcript.log(
        makeEvent({
          sessionId: session.sessionId,
          role: "host",
          kind: "invoke.approved",
          detail: { capability: req.capability },
        }),
      );
    }

    try {
      const result = await cap.handler(req.args);
      this.opts.transcript.log(
        makeEvent({
          sessionId: session.sessionId,
          role: "host",
          kind: "invoke.completed",
          detail: { capability: req.capability },
        }),
      );
      return this.respond(req, "ok", result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.opts.transcript.log(
        makeEvent({
          sessionId: session.sessionId,
          role: "host",
          kind: "invoke.errored",
          detail: { capability: req.capability, error: msg },
        }),
      );
      return this.respond(req, "error", undefined, msg);
    }
  }

  private respond(
    req: InvokeRequest,
    status: InvokeResponse["status"],
    result?: unknown,
    error?: string,
  ): InvokeResponse {
    return {
      id: newMessageId(),
      sessionId: req.sessionId,
      ts: new Date().toISOString(),
      type: "invoke.response",
      requestId: req.id,
      status,
      result,
      error,
    };
  }
}
