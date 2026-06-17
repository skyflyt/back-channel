/**
 * Back Channel — Broker transport (Phase 3).
 *
 * Connects to the hosted Broker's relay endpoint and exchanges encrypted
 * frames with the peer (paired by the Broker on sessionId). Same protocol
 * as the direct WebSocket transport — the Broker just routes between two
 * agents that both connect to it.
 *
 *   const transport = await createBrokerTransport({
 *     relayUrl: "wss://backchannel.app/relay/abc-123?role=visitor&token=abc-123",
 *   });
 *
 * The relayUrl typically comes from the Broker's API response:
 *   - POST /api/invites returns `relay_url` for the visitor
 *   - POST /api/invites/:code/claim returns `relay_url` for the host
 *
 * Both ends perform an ECDH handshake (the broker forwards the plaintext
 * pubkey exchange but never sees the content afterward — AES-GCM encrypted).
 */

import { WebSocket } from "ws";
import { newEphemeralKeypair, deriveSessionKey } from "../crypto/session-key.js";
import { seal, open, type SealedEnvelope } from "../crypto/envelope.js";
import type { BCMessage } from "../messages.js";
import type { MessageHandler, Transport } from "./in-memory.js";

interface PendingRequest {
  resolve: (msg: BCMessage | void) => void;
  reject: (e: Error) => void;
}

interface HandshakeFrame {
  readonly kind: "handshake";
  readonly publicKey: string;
}

function isHandshake(obj: unknown): obj is HandshakeFrame {
  return (
    !!obj &&
    typeof obj === "object" &&
    (obj as { kind?: unknown }).kind === "handshake" &&
    typeof (obj as { publicKey?: unknown }).publicKey === "string"
  );
}

export interface BrokerTransportOptions {
  /**
   * Full relay URL including query params, e.g.
   *   "wss://backchannel.app/relay/<sessionId>?role=visitor&token=<token>"
   */
  readonly relayUrl: string;
  /** Optional override of how long to wait for handshake (default 30s). */
  readonly handshakeTimeoutMs?: number;
}

/**
 * Connect to the Broker relay and return a Transport ready to carry BCMessage
 * frames. Resolves only after the ECDH handshake completes — i.e. once the
 * peer has also connected and exchanged keys.
 */
export function createBrokerTransport(
  opts: BrokerTransportOptions,
): Promise<Transport & { close: () => Promise<void> }> {
  return new Promise((resolveTransport, rejectTransport) => {
    const kp = newEphemeralKeypair();
    let sessionKey: Buffer | null = null;
    let handler: MessageHandler | null = null;
    const pending = new Map<string, PendingRequest>();

    const ws = new WebSocket(opts.relayUrl);

    const timeoutMs = opts.handshakeTimeoutMs ?? 30_000;
    const timeout = setTimeout(() => {
      if (!sessionKey) {
        rejectTransport(new Error(`Broker handshake timed out after ${timeoutMs}ms`));
        try { ws.close(); } catch {}
      }
    }, timeoutMs);

    ws.on("error", (e) => {
      clearTimeout(timeout);
      for (const p of pending.values()) p.reject(e);
      if (!sessionKey) rejectTransport(e);
    });

    ws.on("open", () => {
      // Send our handshake immediately. The Broker will buffer or forward to
      // the peer when both sides are present.
      ws.send(JSON.stringify({ kind: "handshake", publicKey: kp.publicKey }));
    });

    ws.on("message", async (data) => {
      const raw = typeof data === "string" ? data : (data as Buffer).toString("utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }

      if (isHandshake(parsed)) {
        if (sessionKey) return; // already handshook
        sessionKey = deriveSessionKey(kp, parsed.publicKey);
        clearTimeout(timeout);
        resolveTransport(buildTransport());
        return;
      }

      if (!sessionKey) return;

      let msg: BCMessage;
      try {
        msg = open<BCMessage>(parsed as SealedEnvelope, sessionKey);
      } catch {
        return; // tag mismatch / bad ciphertext / wrong key
      }

      const respondsTo = (msg as unknown as { requestId?: string }).requestId;
      if (respondsTo && pending.has(respondsTo)) {
        const p = pending.get(respondsTo)!;
        pending.delete(respondsTo);
        p.resolve(msg);
        return;
      }

      if (handler) {
        const response = await handler(msg);
        if (response && sessionKey) {
          ws.send(JSON.stringify(seal(response, sessionKey)));
        }
      }
    });

    ws.on("close", () => {
      clearTimeout(timeout);
      for (const p of pending.values()) p.reject(new Error("Socket closed"));
      pending.clear();
    });

    function buildTransport(): Transport & { close: () => Promise<void> } {
      return {
        async send(msg: BCMessage) {
          if (!sessionKey) throw new Error("Not connected (no session key)");
          if (ws.readyState !== WebSocket.OPEN) throw new Error("Socket not open");
          return new Promise<BCMessage | void>((resolve, reject) => {
            pending.set(msg.id, { resolve, reject });
            ws.send(JSON.stringify(seal(msg, sessionKey!)));
            if (msg.type === "session.end") {
              setTimeout(() => {
                if (pending.has(msg.id)) {
                  pending.delete(msg.id);
                  resolve();
                }
              }, 50);
            }
          });
        },
        onMessage(h: MessageHandler) {
          handler = h;
        },
        async close() {
          ws.close();
        },
      };
    }
  });
}
