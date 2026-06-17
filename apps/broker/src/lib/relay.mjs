/**
 * Back Channel — WebSocket relay (pure JS so server.mjs can import at runtime).
 *
 * Both agents connect to /relay/:sessionId. Whoever arrives first holds an
 * open WS; the Broker BUFFERS any frames they send for the not-yet-present
 * peer. When the peer arrives, buffered frames are flushed in order, then
 * normal forwarding begins.
 *
 * Broker is content-blind: it never decodes frame contents. The ECDH
 * handshake between the two agents happens through the relay (handshake
 * frames are forwarded plaintext on the wire; both ends derive the same
 * session key; subsequent frames are AES-GCM ciphertext).
 *
 * Phase 3 MVP runs single-instance (--min/max=1) so pairing + buffer state
 * lives in process memory. Multi-instance upgrade = Redis pub/sub.
 *
 * @typedef {"visitor" | "host"} Role
 * @typedef {Object} PairedSession
 * @property {import("ws").WebSocket | undefined} [visitor]
 * @property {import("ws").WebSocket | undefined} [host]
 * @property {Array<{from: Role, data: unknown}>} buffer
 * @property {number} startedAt
 * @property {string[]} scopesGranted
 */

import { WebSocketServer, WebSocket } from "ws";
import { parse } from "node:url";
import { prisma } from "./db.mjs";

const MAX_BUFFER_FRAMES = 64;

/** @type {Map<string, PairedSession>} */
const sessions = new Map();

const wss = new WebSocketServer({ noServer: true });

/**
 * Entry point called from server.mjs on every WebSocket upgrade for /relay/:id.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:stream").Duplex} socket
 * @param {Buffer} head
 */
export function handleRelayUpgrade(req, socket, head) {
  const url = parse(req.url ?? "", true);
  const match = url.pathname?.match(/^\/relay\/([^/]+)$/);
  if (!match) {
    socket.destroy();
    return;
  }
  const sessionId = match[1];
  const role = /** @type {Role | undefined} */ (url.query.role);
  const token = /** @type {string | undefined} */ (url.query.token);

  if (!role || (role !== "visitor" && role !== "host")) {
    socket.destroy();
    return;
  }
  if (!token) {
    socket.destroy();
    return;
  }

  // Phase 3 MVP: token == sessionId (unguessable UUID, distributed only via authed API).
  // Phase 3.1: separate visitor/host tokens, signed against registered agent pubkey.
  if (token !== sessionId) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    void attachToSession(sessionId, role, ws);
  });
}

/**
 * @param {string} sessionId
 * @param {Role} role
 * @param {import("ws").WebSocket} ws
 */
async function attachToSession(sessionId, role, ws) {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { invite: true },
  });
  if (!session) {
    ws.close(4404, "Unknown session");
    return;
  }
  if (session.endedAt) {
    ws.close(4410, "Session already ended");
    return;
  }

  const slot = sessions.get(sessionId) ?? {
    startedAt: Date.now(),
    scopesGranted: session.scopesGranted,
    buffer: [],
  };
  if (slot[role]) {
    ws.close(4409, `${role} already connected`);
    return;
  }
  slot[role] = ws;
  sessions.set(sessionId, slot);

  await prisma.auditLog.create({
    data: { sessionId, role, eventType: "relay.connected", detail: {} },
  });

  // If peer is already present, flush any buffered frames intended for me
  const flushedToMe = flushBufferTo(slot, role);
  if (flushedToMe > 0) {
    await prisma.auditLog.create({
      data: { sessionId, role, eventType: "relay.flushed", detail: { frames: flushedToMe } },
    });
  }

  ws.on("message", async (data) => {
    const peer = role === "visitor" ? slot.host : slot.visitor;
    if (peer && peer.readyState === WebSocket.OPEN) {
      peer.send(data);
    } else {
      // Peer not connected yet — buffer (capped)
      if (slot.buffer.length >= MAX_BUFFER_FRAMES) {
        // Drop oldest to avoid unbounded growth
        slot.buffer.shift();
      }
      slot.buffer.push({ from: role, data });
    }
    await prisma.auditLog.create({
      data: {
        sessionId,
        role,
        eventType: peer ? "relay.frame" : "relay.frame.buffered",
        detail: { bytes: dataByteLength(data) },
      },
    });
  });

  ws.on("close", async () => {
    slot[role] = undefined;
    await prisma.auditLog.create({
      data: { sessionId, role, eventType: "relay.disconnected", detail: {} },
    });
    if (!slot.visitor && !slot.host) {
      sessions.delete(sessionId);
      const fresh = await prisma.session.findUnique({ where: { id: sessionId } });
      if (fresh && !fresh.endedAt) {
        await prisma.session.update({
          where: { id: sessionId },
          data: { endedAt: new Date(), endReason: "both_disconnected" },
        });
      }
    } else {
      // Other side still connected — notify them so they can clean up
      const peer = role === "visitor" ? slot.host : slot.visitor;
      try { peer?.close(4000, "peer_disconnected"); } catch {}
    }
  });

  ws.on("error", (e) => {
    console.error(`Relay error on ${sessionId}/${role}:`, e);
  });
}

/**
 * Flush buffered frames addressed to the just-arrived peer.
 * @param {PairedSession} slot
 * @param {Role} arrivingRole
 * @returns {number} frames delivered
 */
function flushBufferTo(slot, arrivingRole) {
  // Frames in buffer were sent by the OTHER role, addressed to this newly-arriving one
  const ws = slot[arrivingRole];
  if (!ws || ws.readyState !== WebSocket.OPEN) return 0;
  const targetSenderRole = arrivingRole === "visitor" ? "host" : "visitor";
  let count = 0;
  const remaining = [];
  for (const f of slot.buffer) {
    if (f.from === targetSenderRole) {
      ws.send(f.data);
      count++;
    } else {
      remaining.push(f);
    }
  }
  slot.buffer = remaining;
  return count;
}

/**
 * Force-close a session from the API (kick switch).
 * @param {string} sessionId
 * @param {string} reason
 */
export async function kickSession(sessionId, reason) {
  const slot = sessions.get(sessionId);
  if (!slot) return;
  try { slot.visitor?.close(4000, reason); } catch {}
  try { slot.host?.close(4000, reason); } catch {}
  sessions.delete(sessionId);
  await prisma.session.update({
    where: { id: sessionId },
    data: { endedAt: new Date(), endReason: reason },
  });
}

/**
 * @param {unknown} data
 * @returns {number}
 */
function dataByteLength(data) {
  if (typeof data === "string") return Buffer.byteLength(data, "utf8");
  if (data instanceof Buffer) return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((n, b) => n + (b instanceof Buffer ? b.length : 0), 0);
  return 0;
}
