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
 * @typedef {Object} FrameStat
 * @property {number} pendingFrames  frames relayed since the last audit flush
 * @property {number} pendingBytes   bytes relayed since the last audit flush
 * @property {number} totalFrames    frames relayed over the whole session
 * @property {number} totalBytes     bytes relayed over the whole session
 *
 * @typedef {Object} PairedSession
 * @property {import("ws").WebSocket | undefined} [visitor]
 * @property {import("ws").WebSocket | undefined} [host]
 * @property {Array<{from: Role, data: unknown}>} buffer
 * @property {number} startedAt
 * @property {string[]} scopesGranted
 * @property {{ visitor: FrameStat, host: FrameStat }} stats
 * @property {{ visitor: boolean, host: boolean }} connected     currently connected
 * @property {{ visitor: boolean, host: boolean }} everConnected connected at least once
 * @property {Date} expiresAt   invite TTL deadline (hard-end backstop)
 * @property {ReturnType<typeof setTimeout> | null} graceTimer   both-disconnected countdown
 * @property {ReturnType<typeof setTimeout> | null} ttlTimer     TTL backstop
 * @property {boolean} ended
 */

import { WebSocketServer, WebSocket } from "ws";
import { parse } from "node:url";
import { prisma } from "./db.mjs";
import { rateLimit, clientIp } from "./rate-limit.mjs";

const MAX_BUFFER_FRAMES = 64;
const UPGRADE_LIMIT_PER_MIN = 30;

// #2 — per-frame size cap. Sessions carry short JSON between config-suggesting
// agents; 64 KiB is generous. ws enforces this at the protocol layer and closes
// an offending connection with code 1009 ("message too big") before the frame
// ever reaches our message handler.
const MAX_FRAME_BYTES = 64 * 1024;

// #1 — don't write one AuditLog row per relayed frame (that was a DB-write
// amplification vector). Aggregate counts in memory and flush one summary row
// per role every AUDIT_FLUSH_EVERY frames, plus a final summary on disconnect.
const AUDIT_FLUSH_EVERY = 100;

// Per-session backstop: cap total relayed volume so a sustained flood can't run
// up bandwidth/CPU indefinitely. Generous enough that legit sessions (≤60 min,
// short messages) never hit it.
const MAX_SESSION_FRAMES = 100_000;
const MAX_SESSION_BYTES = 256 * 1024 * 1024;

// Session-lifecycle grace. We only end a session for "both disconnected" once
// BOTH peers have connected at least once AND both are simultaneously gone for
// this long. LLM agent runtimes routinely close their socket between user turns
// and reconnect to the same session_id, so the window must tolerate that.
const DISCONNECT_GRACE_MS = 5 * 60 * 1000;

/** @type {Map<string, PairedSession>} */
const sessions = new Map();

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

/** @returns {FrameStat} */
function newFrameStat() {
  return { pendingFrames: 0, pendingBytes: 0, totalFrames: 0, totalBytes: 0 };
}

/**
 * Write a single summary audit row for the frames relayed by `role` since the
 * last flush, then reset the pending counters. No-op if nothing is pending.
 * @param {string} sessionId
 * @param {Role} role
 * @param {PairedSession} slot
 * @param {string} reason  why we're flushing ("threshold" | "disconnect")
 */
async function flushFrameStats(sessionId, role, slot, reason) {
  const stat = slot.stats[role];
  if (!stat || stat.pendingFrames === 0) return;
  const frames = stat.pendingFrames;
  const bytes = stat.pendingBytes;
  stat.pendingFrames = 0;
  stat.pendingBytes = 0;
  await prisma.auditLog.create({
    data: { sessionId, role, eventType: "relay.frames", detail: { frames, bytes, reason } },
  });
}

/**
 * Entry point called from server.mjs on every WebSocket upgrade for /relay/:id.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:stream").Duplex} socket
 * @param {Buffer} head
 */
export function handleRelayUpgrade(req, socket, head) {
  // Cap upgrade attempts per IP. Each attempt below triggers a DB lookup, and
  // an unauthenticated caller can spray guessed session IDs; this bounds the
  // load. Legit clients connect once (visitor + host) per session.
  const ip = clientIp(req.headers["x-forwarded-for"]);
  const rl = rateLimit("relay:ip", ip, UPGRADE_LIMIT_PER_MIN, 60 * 1000);
  if (!rl.ok) {
    socket.write(
      `HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${rl.retryAfterSec}\r\nConnection: close\r\n\r\n`,
    );
    socket.destroy();
    return;
  }

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
    stats: { visitor: newFrameStat(), host: newFrameStat() },
    connected: { visitor: false, host: false },
    everConnected: { visitor: false, host: false },
    expiresAt: session.invite.expiresAt,
    graceTimer: null,
    ttlTimer: null,
    ended: false,
  };

  // Reconnection support: an LLM agent runtime closes its socket between turns
  // and reconnects to the same session_id with the same role+token. If this
  // role already holds a socket (live or a not-yet-cleaned-up stale one),
  // REPLACE it instead of rejecting as a duplicate. The old socket's close
  // handler no-ops because slot[role] no longer points at it.
  const existing = slot[role];
  if (existing && existing !== ws) {
    try { existing.close(4001, "replaced_by_reconnect"); } catch {}
  }
  slot[role] = ws;
  slot.connected[role] = true;
  slot.everConnected[role] = true;
  sessions.set(sessionId, slot);

  // A peer just (re)connected: cancel any pending both-disconnected countdown,
  // and arm the TTL backstop so a one-sided session can't linger past invite TTL.
  cancelGraceEnd(slot);
  armTtlTimer(sessionId, slot);

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

  // Async presence signal so an idle peer learns the other side is live without
  // waiting for a data frame.
  notifyPeerJoined(slot, role);

  ws.on("message", async (data) => {
    // Frames larger than MAX_FRAME_BYTES never get here — ws rejects them at
    // the protocol layer (1009) thanks to maxPayload.
    const bytes = dataByteLength(data);
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

    // #1 — aggregate in memory instead of one DB row per frame; flush a summary
    // every AUDIT_FLUSH_EVERY frames (and again on disconnect).
    const stat = slot.stats[role];
    stat.pendingFrames++;
    stat.pendingBytes += bytes;
    stat.totalFrames++;
    stat.totalBytes += bytes;
    if (stat.pendingFrames >= AUDIT_FLUSH_EVERY) {
      await flushFrameStats(sessionId, role, slot, "threshold");
    }

    // Per-session backstop — kill a session that blows past the volume budget.
    if (stat.totalFrames > MAX_SESSION_FRAMES || stat.totalBytes > MAX_SESSION_BYTES) {
      console.warn(`Relay session ${sessionId} exceeded frame budget (${role}: ${stat.totalFrames} frames, ${stat.totalBytes} bytes) — kicking`);
      await kickSession(sessionId, "frame_budget_exceeded");
    }
  });

  ws.on("close", async () => {
    // Ignore the close event of a socket we already replaced on reconnect.
    if (slot[role] !== ws) return;

    // Flush any frames counted since the last threshold flush so the audit log
    // reflects the full session even if it ended mid-window.
    await flushFrameStats(sessionId, role, slot, "disconnect");
    slot[role] = undefined;
    slot.connected[role] = false;
    await prisma.auditLog.create({
      data: { sessionId, role, eventType: "relay.disconnected", detail: {} },
    });

    // Tell the surviving peer this side dropped — but keep THEM connected so the
    // dropped side can reconnect to the same session. (Previously we force-closed
    // the peer here, which tore the whole session down on any single disconnect.)
    const peer = role === "visitor" ? slot.host : slot.visitor;
    if (peer && peer.readyState === WebSocket.OPEN) {
      try { peer.send(controlFrame({ type: "peer.left", role })); } catch {}
    }

    // Only start the end-session countdown once BOTH peers have connected at
    // least once AND both are now simultaneously disconnected. A reconnect
    // (above) cancels it. Sessions that only ever had one peer connect are NOT
    // ended here — they end at the TTL backstop instead.
    if (
      slot.everConnected.visitor && slot.everConnected.host &&
      !slot.connected.visitor && !slot.connected.host
    ) {
      scheduleGraceEnd(sessionId);
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

/** Build a broker control frame (plaintext JSON, distinct from peer data frames). */
function controlFrame(obj) {
  return JSON.stringify({ ...obj, ts: Date.now() });
}

/**
 * Notify peers about presence when `joinerRole` (re)connects: tell the
 * already-present peer the joiner is live, and tell the joiner the other side
 * is already here. No-op if the other side isn't connected.
 * @param {PairedSession} slot
 * @param {Role} joinerRole
 */
function notifyPeerJoined(slot, joinerRole) {
  const otherRole = joinerRole === "visitor" ? "host" : "visitor";
  const other = slot[otherRole];
  if (!other || other.readyState !== WebSocket.OPEN) return;
  try { other.send(controlFrame({ type: "peer.joined", role: joinerRole })); } catch {}
  const joiner = slot[joinerRole];
  try { joiner?.send(controlFrame({ type: "peer.joined", role: otherRole })); } catch {}
}

/** Cancel a pending both-disconnected grace countdown. */
function cancelGraceEnd(slot) {
  if (slot.graceTimer) { clearTimeout(slot.graceTimer); slot.graceTimer = null; }
}

/**
 * Arm the both-disconnected grace countdown. After DISCONNECT_GRACE_MS with both
 * peers still gone, the session ends. Reconnecting cancels it.
 * @param {string} sessionId
 */
function scheduleGraceEnd(sessionId) {
  const slot = sessions.get(sessionId);
  if (!slot || slot.ended) return;
  cancelGraceEnd(slot);
  slot.graceTimer = setTimeout(() => { void endSession(sessionId, "both_disconnected"); }, DISCONNECT_GRACE_MS);
}

/**
 * Arm the TTL backstop (once) so a session ends at the invite's expiry even if a
 * peer lingers or the other side never connects — prevents one-sided leaks.
 * @param {string} sessionId
 * @param {PairedSession} slot
 */
function armTtlTimer(sessionId, slot) {
  if (slot.ttlTimer || slot.ended) return;
  const ms = Math.max(0, slot.expiresAt.getTime() - Date.now());
  slot.ttlTimer = setTimeout(() => { void endSession(sessionId, "ttl_expired"); }, ms);
}

/**
 * End a session: clear timers, close both sockets, drop in-memory state, and
 * persist endedAt/endReason (idempotent — first writer wins).
 * @param {string} sessionId
 * @param {string} reason
 */
export async function endSession(sessionId, reason) {
  const slot = sessions.get(sessionId);
  if (slot) {
    if (slot.ended) return;
    slot.ended = true;
    cancelGraceEnd(slot);
    if (slot.ttlTimer) { clearTimeout(slot.ttlTimer); slot.ttlTimer = null; }
    try { slot.visitor?.close(4000, reason); } catch {}
    try { slot.host?.close(4000, reason); } catch {}
    sessions.delete(sessionId);
  }
  const fresh = await prisma.session.findUnique({ where: { id: sessionId } });
  if (fresh && !fresh.endedAt) {
    await prisma.session.update({
      where: { id: sessionId },
      data: { endedAt: new Date(), endReason: reason },
    });
  }
}

/**
 * Force-close a session from the API (kick switch). Thin wrapper over endSession.
 * @param {string} sessionId
 * @param {string} reason
 */
export async function kickSession(sessionId, reason) {
  await endSession(sessionId, reason);
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
