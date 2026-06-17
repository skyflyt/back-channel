/**
 * Back Channel — In-memory transport (Phase 1).
 *
 * For the local POC, the visitor and host run in the same process. They
 * communicate by passing message objects through this transport instead
 * of a network. Phase 2 will swap this for a WebSocket transport with the
 * same interface.
 */

import type { BCMessage } from "../messages.js";

export type MessageHandler = (msg: BCMessage) => Promise<BCMessage | void>;

export interface Transport {
  /** Send a message to the peer. Returns the response (if any) for request-response patterns. */
  send(msg: BCMessage): Promise<BCMessage | void>;
  /** Register a handler for messages received from the peer. */
  onMessage(handler: MessageHandler): void;
  /** Tear down the transport. */
  close(): Promise<void>;
}

/**
 * Creates a connected pair of in-memory transports — the visitor side and the host side.
 * Messages sent on one show up on the other.
 */
export function createInMemoryTransportPair(): { visitor: Transport; host: Transport } {
  let visitorHandler: MessageHandler | null = null;
  let hostHandler: MessageHandler | null = null;

  const visitor: Transport = {
    async send(msg) {
      if (!hostHandler) throw new Error("Host has no handler registered");
      return await hostHandler(msg);
    },
    onMessage(handler) {
      visitorHandler = handler;
    },
    async close() {
      visitorHandler = null;
    },
  };

  const host: Transport = {
    async send(msg) {
      if (!visitorHandler) throw new Error("Visitor has no handler registered");
      return await visitorHandler(msg);
    },
    onMessage(handler) {
      hostHandler = handler;
    },
    async close() {
      hostHandler = null;
    },
  };

  return { visitor, host };
}
