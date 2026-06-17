/**
 * Back Channel — WebSocket relay (pure JS so server.mjs can import at runtime).
 *
 * The Broker holds zero plaintext: it routes encrypted frames between
 * visitor and host. Both agents connect to /relay/:sessionId; once both
 * sides are present, every frame received from one is forwarded to the
 * other unchanged.
 *
 * Phase 3 MVP runs single-instance (--min-instances=1 --max-instances=1)
 * so pairing state lives in process memory. Upgrade path: Redis pub/sub.
 *
 * @typedef {"visitor" | "host"} Role
 * @typedef {Object} PairedSession
 * @property {import("ws").WebSocket | undefined} [visitor]
 * @property {import("ws").WebSocket | undefined} [host]
 * @property {number} startedAt
 * @property {string[]} scopesGranted
 */

import { WebSocketServer, WebSocket } from "ws";
import { parse } from "node:url";
import { prisma } from "./db.mjs";

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

  ws.on("message", async (data) => {
    const peer = role === "visitor" ? slot.host : slot.visitor;
    if (!peer || peer.readyState !== WebSocket.OPEN) {
      return;
    }
    peer.send(data);
    await prisma.auditLog.create({
      data: {
        sessionId,
        role,
        eventType: "relay.frame",
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
      const peer = role === "visitor" ? slot.host : slot.visitor;
      try { peer?.close(4000, "peer_disconnected"); } catch {}
    }
  });

  ws.on("error", (e) => {
    console.error(`Relay error on ${sessionId}/${role}:`, e);
  });
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
