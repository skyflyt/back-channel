/**
 * Back Channel — WebSocket transport (Phase 2).
 *
 * Same Transport interface as the in-memory transport, but messages cross
 * a real network connection. Two factories:
 *
 *   - createWebSocketHostTransport(port)     → host listens
 *   - createWebSocketVisitorTransport(url)   → visitor connects
 *
 * On connect, both sides perform an ECDH handshake to derive a session key,
 * then all subsequent messages are AES-256-GCM encrypted envelopes.
 *
 * Phase 2 limitations (to be resolved in Phase 3):
 *  - Public keys are not authenticated against the Broker. A network MITM
 *    could substitute keys. This is fine for a single-machine demo and
 *    acceptable on a trusted LAN. NOT acceptable on the open internet.
 *  - No JWT-style session auth — anyone who can reach the WS port can attempt
 *    a handshake. The Broker in Phase 3 enforces who connects to what session.
 */

import { WebSocketServer, WebSocket } from "ws";
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
  readonly publicKey: string; // base64
}

function isHandshake(obj: unknown): obj is HandshakeFrame {
  return (
    !!obj &&
    typeof obj === "object" &&
    (obj as { kind?: unknown }).kind === "handshake" &&
    typeof (obj as { publicKey?: unknown }).publicKey === "string"
  );
}

/** Create a host-side transport that listens on `port` and accepts ONE visitor. */
export function createWebSocketHostTransport(port: number): Promise<Transport & { close: () => Promise<void> }> {
  return new Promise((resolveTransport, rejectTransport) => {
    const kp = newEphemeralKeypair();
    let sessionKey: Buffer | null = null;
    let handler: MessageHandler | null = null;
    const pending = new Map<string, PendingRequest>();
    let socket: WebSocket | null = null;

    const wss = new WebSocketServer({ port });
    wss.once("listening", () => {
      // attached on first client
    });
    wss.on("error", (e) => rejectTransport(e));

    wss.on("connection", (ws) => {
      if (socket) {
        ws.close(1013, "Host already has one visitor; closing extra connection");
        return;
      }
      socket = ws;

      // Send our handshake immediately
      ws.send(JSON.stringify({ kind: "handshake", publicKey: kp.publicKey }));

      ws.on("message", async (data) => {
        const raw = typeof data === "string" ? data : data.toString("utf8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return;
        }

        if (isHandshake(parsed)) {
          sessionKey = deriveSessionKey(kp, parsed.publicKey);
          resolveTransport(buildTransport());
          return;
        }

        if (!sessionKey) {
          // ignore pre-handshake encrypted frames (shouldn't happen)
          return;
        }

        let msg: BCMessage;
        try {
          msg = open<BCMessage>(parsed as SealedEnvelope, sessionKey);
        } catch (e) {
          // tag mismatch / replay / bad ciphertext — drop silently
          return;
        }

        // Is this a response to one of our outgoing requests?
        const respondsTo = (msg as unknown as { requestId?: string }).requestId;
        if (respondsTo && pending.has(respondsTo)) {
          const p = pending.get(respondsTo)!;
          pending.delete(respondsTo);
          p.resolve(msg);
          return;
        }

        // Otherwise it's an incoming request — call the handler
        if (handler) {
          const response = await handler(msg);
          if (response) {
            ws.send(JSON.stringify(seal(response, sessionKey)));
          }
        }
      });

      ws.on("close", () => {
        for (const p of pending.values()) p.reject(new Error("Socket closed"));
        pending.clear();
        socket = null;
      });
    });

    function buildTransport(): Transport & { close: () => Promise<void> } {
      return {
        async send(msg: BCMessage) {
          if (!socket || !sessionKey) throw new Error("Not connected");
          // Host-initiated sends are usually session.end or unsolicited events
          // — we don't expect responses for now, but still register pending in
          // case we want bidirectional request/response later.
          return new Promise<BCMessage | void>((resolve, reject) => {
            pending.set(msg.id, { resolve, reject });
            socket!.send(JSON.stringify(seal(msg, sessionKey!)));
            // For Phase 2: host's `send` resolves immediately (fire-and-forget).
            // If we ever need host-initiated request/response, we'd wait for matching response.
            setTimeout(() => {
              if (pending.has(msg.id)) {
                pending.delete(msg.id);
                resolve();
              }
            }, 0);
          });
        },
        onMessage(h: MessageHandler) {
          handler = h;
        },
        async close() {
          if (socket) socket.close();
          wss.close();
        },
      };
    }
  });
}


/** Create a visitor-side transport that connects to `url`. */
export function createWebSocketVisitorTransport(url: string): Promise<Transport & { close: () => Promise<void> }> {
  return new Promise((resolveTransport, rejectTransport) => {
    const kp = newEphemeralKeypair();
    let sessionKey: Buffer | null = null;
    let handler: MessageHandler | null = null;
    const pending = new Map<string, PendingRequest>();

    const ws = new WebSocket(url);

    ws.on("error", (e) => {
      for (const p of pending.values()) p.reject(e);
      rejectTransport(e);
    });

    ws.on("open", () => {
      // Wait for host's handshake first
    });

    ws.on("message", async (data) => {
      const raw = typeof data === "string" ? data : data.toString("utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }

      if (isHandshake(parsed)) {
        sessionKey = deriveSessionKey(kp, parsed.publicKey);
        // Send our handshake back
        ws.send(JSON.stringify({ kind: "handshake", publicKey: kp.publicKey }));
        resolveTransport(buildTransport());
        return;
      }

      if (!sessionKey) return;

      let msg: BCMessage;
      try {
        msg = open<BCMessage>(parsed as SealedEnvelope, sessionKey);
      } catch {
        return;
      }

      // Response to one of our outgoing requests?
      const respondsTo = (msg as unknown as { requestId?: string }).requestId;
      if (respondsTo && pending.has(respondsTo)) {
        const p = pending.get(respondsTo)!;
        pending.delete(respondsTo);
        p.resolve(msg);
        return;
      }

      // The visitor doesn't typically receive unsolicited requests in Phase 2.
      // But if it does, hand them to the handler.
      if (handler) {
        const response = await handler(msg);
        if (response && sessionKey) {
          ws.send(JSON.stringify(seal(response, sessionKey)));
        }
      } else {
        // Visitor's normal request/response: this is the response to invoke/capabilities.
        // We expect the response to carry the matching id pattern. If it doesn't
        // match any pending id and there's no handler, drop it.
      }
    });

    ws.on("close", () => {
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
            // Visitor's `send` for capabilities/invoke MUST wait for a response.
            // session.end is the exception — host doesn't respond, so resolve after a short tick.
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
