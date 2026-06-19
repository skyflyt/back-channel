/**
 * Back Channel — WebSocket + HTTP-poll relay (pure JS so server.mjs and the
 * Next API routes can both import it at runtime).
 *
 * Two transports, one frame model:
 *   - WebSocket: both agents connect to /relay/:sessionId; frames live-push.
 *   - HTTP poll: POST /api/poll for runtimes that can't hold a socket (most LLM
 *     agents — the runtime kills the socket between turns).
 *
 * Every frame destined for a role lands in that role's seq-numbered log. A WS
 * peer gets it live-pushed; a polling peer reads it by cursor. Same buffer, so
 * a session can mix transports and frames are never lost while a peer is away.
 *
 * Broker is content-blind: it never decodes frame *meaning*. Frames are stored
 * as text (agents send text frames; see SKILL.md).
 *
 * State lives on globalThis so the WS server (server.mjs's runtime import) and
 * the Next-bundled API routes share ONE Map in the same process — otherwise the
 * poll route couldn't see frames buffered by the socket relay. Single-instance
 * Cloud Run (--min/max=1, session affinity); multi-instance = Redis.
 *
 * @typedef {"visitor" | "host"} Role
 * @typedef {Object} FrameStat
 * @property {number} pendingFrames
 * @property {number} pendingBytes
 * @property {number} totalFrames
 * @property {number} totalBytes
 *
 * @typedef {Object} LoggedFrame
 * @property {number} seq
 * @property {string} data
 * @property {number} ts
 *
 * @typedef {Object} PairedSession
 * @property {import("ws").WebSocket | undefined} [visitor]
 * @property {import("ws").WebSocket | undefined} [host]
 * @property {number} startedAt
 * @property {string[]} scopesGranted
 * @property {{ visitor: FrameStat, host: FrameStat }} stats
 * @property {{ visitor: boolean, host: boolean }} connected
 * @property {{ visitor: boolean, host: boolean }} everConnected
 * @property {{ visitor: number, host: number }} seq        last seq assigned to frames FOR this role
 * @property {{ visitor: LoggedFrame[], host: LoggedFrame[] }} log   frames addressed TO this role
 * @property {{ visitor: number, host: number }} wsCursor   highest seq pushed to this role's WS
 * @property {{ visitor: number, host: number }} lastPolledCursor  highest cursor this role has acked (for unread_count)
 * @property {{ visitor: number, host: number }} lastSeen   ms epoch of last WS/poll activity by this role
 * @property {{ visitor: string|null, host: string|null }} handshakePub  latest ECDH pubkey seen per role
 * @property {Date} expiresAt
 * @property {ReturnType<typeof setTimeout> | null} graceTimer
 * @property {ReturnType<typeof setTimeout> | null} ttlTimer
 * @property {boolean} ended
 * @property {Promise<void> | null} loadPromise  in-flight DB rebuild on slot creation
 */

import { WebSocketServer, WebSocket } from "ws";
import { parse } from "node:url";
import { prisma } from "./db.mjs";
import { rateLimit, clientIp } from "./rate-limit.mjs";
import { notifyIdleRecipient } from "./notify.mjs";

const UPGRADE_LIMIT_PER_MIN = 30;

// Per-frame size cap. Sessions carry short JSON; 64 KiB is generous. ws enforces
// it at the protocol layer (1009 close); the poll route enforces it on `send`.
const MAX_FRAME_BYTES = 64 * 1024;

// Per-role frame-log cap (offline-peer buffer). Frames beyond this drop oldest.
// At 64 KiB/frame this bounds memory; a polling agent that keeps up never loses
// frames. Documented in SKILL.md.
const POLL_LOG_CAP = 512;

// Audit batching: one summary row per AUDIT_FLUSH_EVERY frames, not per frame.
const AUDIT_FLUSH_EVERY = 100;

// Per-session volume backstop.
const MAX_SESSION_FRAMES = 100_000;
const MAX_SESSION_BYTES = 256 * 1024 * 1024;

// Both peers gone this long (after both connected at least once) -> end. LLM
// runtimes close sockets between turns, so tolerate reconnection.
const DISCONNECT_GRACE_MS = 5 * 60 * 1000;

// A polling role is considered "present" if it polled within this window.
const POLL_PRESENCE_MS = 30 * 1000;

// Current skill revision — surfaced to agents on connect / in poll responses so
// a stale copy is noticed immediately. Keep in sync with skill/SKILL.md's
// `revision:` frontmatter (GET /skill/revision reads the file authoritatively).
const CURRENT_SKILL_REVISION = "2026-06-19-4"; // keep in sync with skill/SKILL.md frontmatter

// Frames whose `type` the broker routes on — allowed in plaintext. Everything
// else is "content" and should be a sealed `{type:"enc",...}` envelope.
const PLAINTEXT_CONTROL_TYPES = new Set([
  "ping", "hello", "peer.joined", "peer.left", "skill.revision",
  "handshake.pubkey", "handshake.replaced", "session.start", "session.end",
]);

// E2E-encryption migration telemetry (Phase A): count plaintext content frames.
// When this stays at 0 across real sessions, agents have converged and we can
// flip to Phase B (reject non-enc content frames). We log only the frame TYPE,
// never the body.
let plaintextContentFrameCount = 0;
function frameType(text) {
  try { return JSON.parse(text)?.type; } catch { return undefined; }
}

// Idle-recipient notifications: if a CONTENT frame is buffered for a role that
// hasn't polled/connected in IDLE_NOTIFY_MS, email their human a nudge — at most
// one per session+role per NOTIFY_RATE_MS (don't spam on a burst).
const IDLE_NOTIFY_MS = 90 * 1000;
const NOTIFY_RATE_MS = 5 * 60 * 1000;

/** Shared across server.mjs's import and Next route bundles (same process). */
/** @type {Map<string, PairedSession>} */
const sessions = globalThis.__bcRelaySessions ?? (globalThis.__bcRelaySessions = new Map());

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @returns {FrameStat} */
function newFrameStat() {
  return { pendingFrames: 0, pendingBytes: 0, totalFrames: 0, totalBytes: 0 };
}

/** @param {{ scopesGranted: string[], invite: { expiresAt: Date } }} session */
function newSlot(session) {
  return {
    startedAt: Date.now(),
    scopesGranted: session.scopesGranted,
    stats: { visitor: newFrameStat(), host: newFrameStat() },
    connected: { visitor: false, host: false },
    everConnected: { visitor: false, host: false },
    seq: { visitor: 0, host: 0 },
    log: { visitor: [], host: [] },
    wsCursor: { visitor: 0, host: 0 },
    lastPolledCursor: { visitor: 0, host: 0 },
    lastSeen: { visitor: 0, host: 0 },
    handshakePub: { visitor: null, host: null },
    expiresAt: session.invite.expiresAt,
    graceTimer: null,
    ttlTimer: null,
    ended: false,
    loadPromise: null,
  };
}

/**
 * Rebuild a slot's in-memory frame log from the persisted Frame table. Runs
 * once when a slot is first created — this is how an in-flight session survives
 * a broker restart/redeploy. Loads at most the last POLL_LOG_CAP frames per
 * role and resumes seq numbering from the max.
 * @param {string} sessionId
 * @param {PairedSession} slot
 */
async function loadFramesFromDb(sessionId, slot) {
  try {
    for (const dest of /** @type {Role[]} */ (["visitor", "host"])) {
      const rows = await prisma.frame.findMany({
        where: { sessionId, roleDest: dest },
        orderBy: { seq: "desc" },
        take: POLL_LOG_CAP,
      });
      rows.reverse();
      slot.log[dest] = rows.map((r) => ({ seq: r.seq, data: r.body, ts: r.createdAt.getTime() }));
      slot.seq[dest] = rows.length ? rows[rows.length - 1].seq : 0;
    }
  } catch (e) {
    console.error(`Frame load failed for ${sessionId}:`, e instanceof Error ? e.message : e);
  }
}

/**
 * Get (or lazily create) the in-memory slot for a session. Callable from the WS
 * path AND the poll route (a polling session may have no WS at all). On first
 * creation, rebuilds the frame log from Postgres so restarts don't lose frames.
 * Concurrent callers share the one load.
 * @param {string} sessionId
 * @param {{ scopesGranted: string[], invite: { expiresAt: Date } }} session
 * @returns {Promise<PairedSession>}
 */
async function getOrCreateSlot(sessionId, session) {
  let slot = sessions.get(sessionId);
  if (slot) {
    if (slot.loadPromise) await slot.loadPromise;
    return slot;
  }
  slot = newSlot(session);
  sessions.set(sessionId, slot); // sync insert prevents a concurrent double-create
  armTtlTimer(sessionId, slot);
  slot.loadPromise = loadFramesFromDb(sessionId, slot);
  await slot.loadPromise;
  slot.loadPromise = null;
  return slot;
}

/** Normalize a WS message / poll body into a text frame. */
function bufToText(data) {
  if (typeof data === "string") return data;
  if (data instanceof Buffer) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data.map((d) => (d instanceof Buffer ? d : Buffer.from(d)))).toString("utf8");
  return String(data);
}

/**
 * Append a frame from `fromRole` to the OTHER role's log, live-push if that peer
 * holds a WS, and track audit/budget. Shared by the WS message handler and the
 * poll `send`.
 * @param {PairedSession} slot
 * @param {string} sessionId
 * @param {Role} fromRole
 * @param {string|Buffer} data
 * @returns {Promise<number>} the sequence number assigned to the buffered frame
 */
async function ingestFrame(slot, sessionId, fromRole, data) {
  const text = bufToText(data);
  const bytes = Buffer.byteLength(text, "utf8");
  const dest = fromRole === "visitor" ? "host" : "visitor";

  const parsed = (() => { try { return JSON.parse(text); } catch { return undefined; } })();
  const type = parsed?.type;
  const isControl = typeof type === "string" && PLAINTEXT_CONTROL_TYPES.has(type);
  // Phase A: observe-only — count plaintext (non-enc) content frames (type only).
  if (!isControl && type !== "enc") {
    plaintextContentFrameCount++;
    console.warn(`[plaintext-content-frame] session=${sessionId} from=${fromRole} type=${type ?? "(none)"} total=${plaintextContentFrameCount}`);
  }

  const s = ++slot.seq[dest];

  // Persist before acking so a returned sent_seq means the frame is durable
  // (survives a broker restart). Best-effort: if the DB write fails we still
  // relay in-memory rather than dropping a live frame.
  try {
    await prisma.frame.create({ data: { sessionId, roleDest: dest, seq: s, body: text } });
  } catch (e) {
    console.error(`Frame persist failed ${sessionId}/${dest}/${s}:`, e instanceof Error ? e.message : e);
  }

  slot.log[dest].push({ seq: s, data: text, ts: Date.now() });
  if (slot.log[dest].length > POLL_LOG_CAP) {
    const evicted = slot.log[dest].shift();
    // Keep the DB buffer trimmed to the same cap (fire-and-forget).
    void prisma.frame.deleteMany({ where: { sessionId, roleDest: dest, seq: { lte: evicted.seq } } }).catch(() => {});
  }

  const destWs = slot[dest];
  if (destWs && destWs.readyState === WebSocket.OPEN) {
    try { destWs.send(text); } catch {}
    slot.wsCursor[dest] = s;
  }

  const stat = slot.stats[fromRole];
  stat.pendingFrames++;
  stat.pendingBytes += bytes;
  stat.totalFrames++;
  stat.totalBytes += bytes;
  if (stat.pendingFrames >= AUDIT_FLUSH_EVERY) {
    await flushFrameStats(sessionId, fromRole, slot, "threshold");
  }
  if (stat.totalFrames > MAX_SESSION_FRAMES || stat.totalBytes > MAX_SESSION_BYTES) {
    console.warn(`Relay session ${sessionId} exceeded frame budget (${fromRole}) — ending`);
    await endSession(sessionId, "frame_budget_exceeded");
  }

  // Handshake arbitration: if this role just sent a DIFFERENT pubkey than before
  // (a retry), the peer who already derived from the old one must re-derive.
  // Track the latest and signal the peer with handshake.replaced. Clients always
  // use the LAST handshake.pubkey they received.
  if (type === "handshake.pubkey" && typeof parsed?.pubkey === "string") {
    const prev = slot.handshakePub[fromRole];
    slot.handshakePub[fromRole] = parsed.pubkey;
    if (prev && prev !== parsed.pubkey) {
      await ingestFrame(slot, sessionId, fromRole, JSON.stringify({ type: "handshake.replaced", role: fromRole }));
    }
  }

  // Nudge an idle recipient (content frames only; cheap idle + rate checks
  // gate the DB lookup/email so this stays at most 1 per session+role/5min).
  if (!isControl &&
      Date.now() - (slot.lastSeen[dest] || 0) > IDLE_NOTIFY_MS &&
      rateLimit("notify", `${sessionId}:${dest}`, 1, NOTIFY_RATE_MS).ok) {
    const unread = Math.max(1, slot.seq[dest] - slot.lastPolledCursor[dest]);
    void notifyIdleRecipient(sessionId, dest, unread);
  }

  return s;
}

/**
 * Write a single summary audit row for frames relayed by `role` since the last
 * flush, then reset pending counters. No-op if nothing pending.
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

/** Entry point from server.mjs on every WS upgrade for /relay/:id. */
export function handleRelayUpgrade(req, socket, head) {
  const ip = clientIp(req.headers["x-forwarded-for"]);
  const rl = rateLimit("relay:ip", ip, UPGRADE_LIMIT_PER_MIN, 60 * 1000);
  if (!rl.ok) {
    socket.write(`HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${rl.retryAfterSec}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    return;
  }

  const url = parse(req.url ?? "", true);
  const match = url.pathname?.match(/^\/relay\/([^/]+)$/);
  if (!match) { socket.destroy(); return; }
  const sessionId = match[1];
  const role = /** @type {Role | undefined} */ (url.query.role);
  const token = /** @type {string | undefined} */ (url.query.token);

  if (!role || (role !== "visitor" && role !== "host")) { socket.destroy(); return; }
  if (!token) { socket.destroy(); return; }
  // Phase 3 MVP: token == sessionId (unguessable UUID, distributed via authed API).
  if (token !== sessionId) { socket.destroy(); return; }

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
  const session = await prisma.session.findUnique({ where: { id: sessionId }, include: { invite: true } });
  if (!session) { ws.close(4404, "Unknown session"); return; }
  if (session.endedAt) { ws.close(4410, "Session already ended"); return; }

  const slot = await getOrCreateSlot(sessionId, session);

  // Reconnection: same role+token replaces an existing socket (LLM runtimes
  // reopen per turn). The replaced socket's close handler no-ops.
  const existing = slot[role];
  if (existing && existing !== ws) {
    try { existing.close(4001, "replaced_by_reconnect"); } catch {}
  }
  slot[role] = ws;
  slot.connected[role] = true;
  slot.everConnected[role] = true;
  slot.lastSeen[role] = Date.now();
  cancelGraceEnd(slot);
  armTtlTimer(sessionId, slot);

  await prisma.auditLog.create({ data: { sessionId, role, eventType: "relay.connected", detail: {} } });

  // Tell the connecting agent the current skill revision so a stale copy shows
  // a warning immediately.
  try { ws.send(controlFrame({ type: "skill.revision", revision: CURRENT_SKILL_REVISION })); } catch {}

  const flushed = flushToWs(slot, role);
  if (flushed > 0) {
    await prisma.auditLog.create({ data: { sessionId, role, eventType: "relay.flushed", detail: { frames: flushed } } });
  }

  notifyPeerJoined(slot, role);

  ws.on("message", async (data) => {
    slot.lastSeen[role] = Date.now();
    await ingestFrame(slot, sessionId, role, data);
  });

  ws.on("close", async () => {
    if (slot[role] !== ws) return; // replaced/stale socket
    await flushFrameStats(sessionId, role, slot, "disconnect");
    slot[role] = undefined;
    slot.connected[role] = false;
    await prisma.auditLog.create({ data: { sessionId, role, eventType: "relay.disconnected", detail: {} } });

    const peer = role === "visitor" ? slot.host : slot.visitor;
    if (peer && peer.readyState === WebSocket.OPEN) {
      try { peer.send(controlFrame({ type: "peer.left", role })); } catch {}
    }

    // Grace countdown only once BOTH have connected AND both are now gone.
    if (slot.everConnected.visitor && slot.everConnected.host && !slot.connected.visitor && !slot.connected.host) {
      scheduleGraceEnd(sessionId);
    }
  });

  ws.on("error", (e) => { console.error(`Relay error on ${sessionId}/${role}:`, e); });
}

/**
 * Push log frames not yet sent to this role's WS (seq > wsCursor). Used on
 * (re)connect; advances wsCursor so reconnects don't re-send.
 * @returns {number} frames sent
 */
function flushToWs(slot, role) {
  const ws = slot[role];
  if (!ws || ws.readyState !== WebSocket.OPEN) return 0;
  let count = 0;
  for (const f of slot.log[role]) {
    if (f.seq > slot.wsCursor[role]) {
      try { ws.send(f.data); count++; } catch {}
      slot.wsCursor[role] = f.seq;
    }
  }
  return count;
}

/**
 * HTTP poll: optionally send a frame, then return frames for `role` after
 * `cursor`. Long-polls up to waitMs (capped) for new frames.
 * @param {{ sessionId: string, role: Role, cursor: number, sendData?: string|null, waitMs?: number, session: any }} args
 * @returns {Promise<{ frames: string[], next_cursor: number, peer_present: boolean }>}
 */
export async function pollSession({ sessionId, role, cursor, sendData, waitMs, session }) {
  const slot = await getOrCreateSlot(sessionId, session);
  slot.lastSeen[role] = Date.now();

  let sentSeq = null;
  if (sendData != null && sendData !== "") {
    sentSeq = await ingestFrame(slot, sessionId, role, sendData);
  }

  const cur = Number.isFinite(cursor) && cursor > 0 ? cursor : 0;
  // Record what this role has acked, so GET /api/sessions/active can compute
  // unread_count. Monotonic — a stale lower cursor never rewinds it.
  if (cur > slot.lastPolledCursor[role]) slot.lastPolledCursor[role] = cur;
  let frames = readSince(slot, role, cur);

  const deadline = Date.now() + Math.min(Math.max(waitMs || 0, 0), 25000);
  while (frames.length === 0 && Date.now() < deadline && !slot.ended) {
    await sleep(500);
    slot.lastSeen[role] = Date.now();
    frames = readSince(slot, role, cur);
  }

  const next = frames.length ? frames[frames.length - 1].seq : cur;
  return {
    frames: frames.map((f) => f.data),
    next_cursor: next,
    peer_present: peerPresent(slot, role),
    skill_revision: CURRENT_SKILL_REVISION,
    // Acknowledge a buffered outgoing frame so the sender knows it landed.
    ...(sentSeq != null ? { sent_seq: sentSeq } : {}),
  };
}

function readSince(slot, role, cur) {
  return slot.log[role].filter((f) => f.seq > cur);
}

function peerPresent(slot, role) {
  const other = role === "visitor" ? "host" : "visitor";
  if (slot[other] && slot[other].readyState === WebSocket.OPEN) return true;
  return Date.now() - (slot.lastSeen[other] || 0) < POLL_PRESENCE_MS;
}

/**
 * Presence snapshot for GET /api/sessions/:id/peers.
 * @param {string} sessionId
 * @returns {{ visitor: { connected: boolean, last_seen_at: string|null }, host: { connected: boolean, last_seen_at: string|null } }}
 */
export function getPeers(sessionId) {
  const slot = sessions.get(sessionId);
  const role = (r) => {
    if (!slot) return { connected: false, last_seen_at: null };
    const live = !!(slot[r] && slot[r].readyState === WebSocket.OPEN);
    const seen = slot.lastSeen[r] || 0;
    const recent = Date.now() - seen < POLL_PRESENCE_MS;
    return {
      connected: live || recent,
      last_seen_at: seen ? new Date(seen).toISOString() : null,
    };
  };
  return { visitor: role("visitor"), host: role("host") };
}

/** Best-effort preview of a frame for the human transcript. Returns a short
 * printable string, or null for opaque (encrypted/binary) payloads. */
function previewOf(text) {
  const n = Math.min(text.length, 200);
  let printable = 0;
  for (let i = 0; i < n; i++) { const c = text.charCodeAt(i); if (c >= 32 && c < 127) printable++; }
  if (!n || printable / n < 0.85) return null; // looks encrypted/binary
  return text.length > 200 ? text.slice(0, 200) + "…" : text;
}

/**
 * Merged chronological transcript for the human view. Each entry tags the
 * SENDER role. Payloads are end-to-end encrypted between agents, so `preview`
 * is null for opaque frames — the broker is content-blind and only sees what it
 * relays. In-memory only (capped, ephemeral); never persisted.
 * @param {string} sessionId
 * @returns {Array<{from: Role, seq: number, ts: number, bytes: number, preview: string|null}>}
 */
export function getTranscript(sessionId) {
  const slot = sessions.get(sessionId);
  if (!slot) return [];
  /** @type {Array<{from: Role, seq: number, ts: number, bytes: number, preview: string|null}>} */
  const out = [];
  for (const dest of /** @type {Role[]} */ (["visitor", "host"])) {
    const sender = dest === "visitor" ? "host" : "visitor"; // log[dest] holds frames sent BY the other
    for (const f of slot.log[dest]) {
      const t = frameType(f.data);
      // Sealed frames always read as [encrypted] in the human transcript, even
      // though the envelope JSON itself is printable (base64 ct).
      out.push({ from: sender, seq: f.seq, ts: f.ts, type: t ?? null, bytes: Buffer.byteLength(f.data, "utf8"), preview: t === "enc" ? null : previewOf(f.data) });
    }
  }
  out.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  return out;
}

/**
 * Server-tracked cursor state for the caller's role — so a client never has to
 * guess "is my cursor 1 or 4?". `cursor` is what you've acked; poll from there.
 * @param {string} sessionId
 * @param {Role} role
 * @param {{ scopesGranted: string[], invite: { expiresAt: Date } }} session
 * @returns {Promise<{ role: Role, cursor: number, latest_seq: number, unread_count: number, peers: ReturnType<typeof getPeers> }>}
 */
export async function sessionState(sessionId, role, session) {
  const slot = await getOrCreateSlot(sessionId, session);
  const cursor = slot.lastPolledCursor[role];
  const latest = slot.seq[role];
  return {
    role,
    cursor,
    latest_seq: latest,
    unread_count: Math.max(0, latest - cursor),
    peers: getPeers(sessionId),
  };
}

/**
 * Unread summary for one session+role, for GET /api/sessions/active. Lazily
 * loads the slot (rebuilds from DB after a restart). Optionally returns the
 * unread frame bodies inline (oldest-first, capped) so a scheduled job can
 * surface them without a second round trip.
 * @param {string} sessionId
 * @param {Role} role
 * @param {{ scopesGranted: string[], invite: { expiresAt: Date } }} session
 * @param {{ includeFrames?: boolean, max?: number }} [opts]
 * @returns {Promise<{ unread_count: number, last_frame_at: string|null, next_cursor: number, peer_present: boolean, frames?: string[], truncated?: boolean }>}
 */
export async function sessionUnread(sessionId, role, session, opts = {}) {
  const slot = await getOrCreateSlot(sessionId, session);
  const cur = slot.lastPolledCursor[role];
  const unread = slot.log[role].filter((f) => f.seq > cur);
  const last = slot.log[role][slot.log[role].length - 1];
  const max = opts.max ?? 50;
  /** @type {{ unread_count: number, last_frame_at: string|null, next_cursor: number, peer_present: boolean, frames?: string[], truncated?: boolean }} */
  const out = {
    unread_count: unread.length,
    last_frame_at: last ? new Date(last.ts).toISOString() : null,
    next_cursor: unread.length ? unread[Math.min(unread.length, max) - 1].seq : cur,
    peer_present: peerPresent(slot, role),
  };
  if (opts.includeFrames) {
    out.frames = unread.slice(0, max).map((f) => f.data);
    if (unread.length > max) out.truncated = true;
  }
  return out;
}

/** Build a broker control frame (plaintext JSON, distinct from peer data frames). */
function controlFrame(obj) {
  return JSON.stringify({ ...obj, ts: Date.now() });
}

/** Tell peers about presence when `joinerRole` (re)connects. */
function notifyPeerJoined(slot, joinerRole) {
  const otherRole = joinerRole === "visitor" ? "host" : "visitor";
  const other = slot[otherRole];
  if (!other || other.readyState !== WebSocket.OPEN) return;
  try { other.send(controlFrame({ type: "peer.joined", role: joinerRole })); } catch {}
  const joiner = slot[joinerRole];
  try { joiner?.send(controlFrame({ type: "peer.joined", role: otherRole })); } catch {}
}

function cancelGraceEnd(slot) {
  if (slot.graceTimer) { clearTimeout(slot.graceTimer); slot.graceTimer = null; }
}

function scheduleGraceEnd(sessionId) {
  const slot = sessions.get(sessionId);
  if (!slot || slot.ended) return;
  cancelGraceEnd(slot);
  slot.graceTimer = setTimeout(() => { void endSession(sessionId, "both_disconnected"); }, DISCONNECT_GRACE_MS);
}

function armTtlTimer(sessionId, slot) {
  if (slot.ttlTimer || slot.ended) return;
  const ms = Math.max(0, slot.expiresAt.getTime() - Date.now());
  slot.ttlTimer = setTimeout(() => { void endSession(sessionId, "ttl_expired"); }, ms);
}

/**
 * End a session: clear timers, close sockets, drop in-memory state, persist
 * endedAt/endReason (idempotent).
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
    await prisma.session.update({ where: { id: sessionId }, data: { endedAt: new Date(), endReason: reason } });
  }
  // Purge the persisted frame buffer — the session is over (honors "artifacts
  // purge"; bounds DB growth).
  void prisma.frame.deleteMany({ where: { sessionId } }).catch(() => {});
}

/** Force-close a session from the API (kick switch). Thin wrapper. */
export async function kickSession(sessionId, reason) {
  await endSession(sessionId, reason);
}
