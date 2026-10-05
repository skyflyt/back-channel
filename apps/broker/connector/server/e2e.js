/**
 * Back Channel .mcpb bridge — E2E encryption for bc_send_message / bc_read_messages.
 *
 * The broker (POST /api/mcp) forwards frames verbatim and stays content-blind
 * by design — it never holds a session key. All sealing/unsealing therefore
 * has to happen HERE, locally, before a frame leaves the machine and after it
 * arrives. This module intercepts exactly four tool calls:
 *   - bc_create_invite / bc_claim_invite: on success, fire off our own
 *     handshake.pubkey (best-effort, matches skill guidance to send yours
 *     first without waiting for the peer's).
 *   - bc_send_message: seal `frame` before it's forwarded (control frames —
 *     handshake.pubkey and friends — are never sealed).
 *   - bc_read_messages: after the broker responds, decrypt any `enc` frames
 *     and absorb any `handshake.pubkey` frames into the local session key.
 * Everything else (initialize, ping, tools/list, other tools) is untouched —
 * see lib.js, which only calls into here for these four tool names.
 */

import { newEphemeralKeypair, loadKeypair, deriveSessionKey, seal, open, PLAINTEXT_CONTROL_TYPES } from "./crypto.js";

const HANDSHAKE_WAIT_ATTEMPTS = 3;
const HANDSHAKE_WAIT_INTERVAL_MS = 1000;

// Tools addressed to one thread, and every spelling of its id we accept. A
// field report had bc_read_messages failing with "session_id missing" on every
// call from a client that believed it was sending one — the argument was lost
// or renamed before it reached this process, and `session_id` is a name some
// hosts keep for their own routing. Keep in sync with src/lib/mcp/tools.mjs.
const THREAD_TOOLS = new Set(["bc_read_messages", "bc_send_message", "bc_end_session"]);
const THREAD_ID_ALIASES = ["thread_id", "conversation_id", "sessionId", "threadId", "conversationId", "id"];
export const MISSING_THREAD_ID =
  "missing thread id: pass session_id — the session_id of the thread, from bc_check_inbox. " +
  "If you did pass it and still see this, your client dropped it in transit: resend the same value as thread_id instead.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function localToolResult(id, dataObj, isError = false) {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(dataObj) }], isError } };
}

function toolName(msg) {
  return msg?.method === "tools/call" ? msg.params?.name : null;
}

/**
 * Fold whichever spelling of the thread id the caller used into `session_id`,
 * so the keystore is keyed by the real id and the broker always receives the
 * canonical name (which also keeps a new bridge working against an older
 * broker). Returns { msg } — the same object when nothing needed changing, so
 * an untouched call is still forwarded byte-for-byte — or { error } when a
 * per-thread tool arrived with no usable id at all.
 */
export function canonicalizeThreadCall(msg) {
  if (!THREAD_TOOLS.has(toolName(msg))) return { msg };
  const args = msg.params?.arguments;
  if (typeof args !== "object" || args === null || Array.isArray(args)) return { error: MISSING_THREAD_ID };
  const nonEmpty = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  let id = nonEmpty(args.session_id);
  const usedAlias = THREAD_ID_ALIASES.some((a) => a in args);
  if (id && id === args.session_id && !usedAlias) return { msg };
  const rest = { ...args };
  for (const alias of THREAD_ID_ALIASES) {
    if (!(alias in rest)) continue;
    id ??= nonEmpty(rest[alias]);
    delete rest[alias];
  }
  if (!id) return { error: MISSING_THREAD_ID };
  return { msg: { ...msg, params: { ...msg.params, arguments: { ...rest, session_id: id } } } };
}

/** Why a bridge-internal tools/call failed, as text — or null if it succeeded. */
function failureDetail(resp) {
  if (resp?.error) return String(resp.error.message ?? "request rejected");
  if (resp?.result?.isError) return String(resp.result.content?.[0]?.text ?? "request failed");
  return null;
}

/** The end reason if a tools/call result says the thread has ended, else null. */
function endedReason(resp) {
  try {
    const data = JSON.parse(resp?.result?.content?.[0]?.text ?? "");
    return data?.ended ? String(data.end_reason ?? "ended") : null;
  } catch {
    return null;
  }
}

function getOrCreateEntry(state, sessionId, role) {
  let entry = state[sessionId];
  if (!entry) {
    const kp = newEphemeralKeypair();
    entry = { role, privateKey: kp.privateKey, publicKey: kp.publicKey, peerPublicKey: null, sessionKey: null, updatedAt: Date.now() };
    state[sessionId] = entry;
  }
  return entry;
}

function sessionKeyBuffer(entry) {
  return entry?.sessionKey ? Buffer.from(entry.sessionKey, "base64") : null;
}

/**
 * Publish our handshake.pubkey on a thread and record that it landed
 * (`pubkeySentAt`). Returns null on success, else why it failed. Never throws.
 *
 * The flag exists because "we hold a session key" does not imply "the peer has
 * our pubkey": a thread opened outside create/claim (bc_request_session, the
 * dashboard composer) gets its keypair on the first READ, which derives the
 * session key from the peer's pubkey without ever sending ours — and the
 * create/claim send is best-effort and can fail silently. Either way the next
 * send would seal under a key the peer cannot derive. Entries written before
 * this flag existed simply re-send once; the same pubkey derives the same key.
 */
async function publishOwnKey(sessionId, role, ctx) {
  const state = ctx.keystore.load();
  const entry = getOrCreateEntry(state, sessionId, role);
  ctx.keystore.save(state); // persist the keypair BEFORE it leaves the machine

  let resp;
  try {
    resp = await ctx.post({
      jsonrpc: "2.0", id: `hs-${sessionId}`, method: "tools/call",
      params: { name: "bc_send_message", arguments: { session_id: sessionId, role, frame: { type: "handshake.pubkey", pubkey: entry.publicKey } } },
    });
  } catch (e) {
    ctx.log(`handshake send failed for session ${sessionId}: ${e?.message ?? e}`);
    return `couldn't reach Back Channel (${e?.message ?? e})`;
  }
  const failed = failureDetail(resp);
  if (failed) {
    ctx.log(`handshake send rejected for session ${sessionId}: ${failed}`);
    return failed;
  }
  const ended = endedReason(resp);
  if (ended) return `this thread has ended (${ended})`;

  const fresh = ctx.keystore.load();
  if (fresh[sessionId]) {
    fresh[sessionId].pubkeySentAt = Date.now();
    ctx.keystore.save(fresh);
  }
  return null;
}

/** Best-effort: send our handshake.pubkey for a session we just created/claimed. Never throws. */
export async function afterSessionEstablished(msg, respObj, ctx) {
  const name = toolName(msg);
  if (name !== "bc_create_invite" && name !== "bc_claim_invite") return;
  if (respObj?.error || respObj?.result?.isError) return; // the call itself failed — nothing to establish

  let data;
  try { data = JSON.parse(respObj?.result?.content?.[0]?.text ?? ""); } catch { return; }
  const sessionId = data?.session_id;
  if (!sessionId) return;
  const role = name === "bc_create_invite" ? "visitor" : "host";

  await publishOwnKey(sessionId, role, ctx); // a failure here is retried by the first bc_send_message
}

/** Absorb any handshake.pubkey / decrypt any enc frames in a bc_read_messages response. Mutates and returns respObj. */
export async function processIncoming(msg, respObj, ctx) {
  if (toolName(msg) !== "bc_read_messages") return respObj;
  if (respObj?.error || respObj?.result?.isError) return respObj;

  const result = respObj.result;
  const text = result?.content?.[0]?.text;
  let data;
  try { data = JSON.parse(text); } catch { return respObj; }
  if (!Array.isArray(data.frames)) return respObj;

  const { session_id: sessionId, role } = msg.params.arguments;
  const state = ctx.keystore.load();
  let mutated = false;

  data.frames = data.frames.map((frameStr) => {
    let parsed;
    try { parsed = JSON.parse(frameStr); } catch { return frameStr; }

    if (parsed?.type === "handshake.pubkey" && typeof parsed.pubkey === "string") {
      const entry = getOrCreateEntry(state, sessionId, role);
      // "always use the LAST one and re-derive" (skill/REFERENCE.md) — overwrite
      // even if we already had a peer key, in case of a handshake.replaced.
      if (entry.peerPublicKey !== parsed.pubkey) {
        entry.peerPublicKey = parsed.pubkey;
        const { handle } = loadKeypair(entry.privateKey);
        entry.sessionKey = Buffer.from(deriveSessionKey(handle, parsed.pubkey)).toString("base64");
        entry.updatedAt = Date.now();
        mutated = true;
      }
      return JSON.stringify({ type: "handshake.pubkey", status: "received" });
    }

    if (parsed?.type === "enc") {
      const key = sessionKeyBuffer(state[sessionId]);
      if (!key) return JSON.stringify({ type: "enc_undecryptable", reason: "encryption handshake not complete yet — try again shortly" });
      try {
        return JSON.stringify(open(parsed, key));
      } catch {
        return JSON.stringify({ type: "enc_undecryptable", reason: "decryption failed — wrong session key or corrupted frame" });
      }
    }

    return frameStr;
  });

  if (mutated) ctx.keystore.save(state);
  result.content[0].text = JSON.stringify(data);
  return respObj;
}

/**
 * Seal an outgoing bc_send_message frame. Returns either { line } — the
 * (possibly mutated) JSON to actually forward — or { shortCircuitResponse } —
 * a fully-formed response to write locally instead of forwarding at all
 * (used when no session key is available yet and the short wait doesn't
 * produce one).
 */
export async function prepareOutgoing(msg, ctx) {
  if (toolName(msg) !== "bc_send_message") return { line: JSON.stringify(msg) };

  const { session_id: sessionId, role, frame } = msg.params.arguments;
  if (typeof frame !== "object" || frame === null || PLAINTEXT_CONTROL_TYPES.has(frame.type)) {
    return { line: JSON.stringify(msg) }; // control frames (incl. our own handshake.pubkey) ride plaintext
  }

  // A real failure (bad id, wrong role, ended thread, revoked token, network)
  // must never be reported as "handshake pending — retry": the caller retries
  // forever and is told the peer is the holdup when the peer already answered.
  const notSent = (reason) => ({
    shortCircuitResponse: localToolResult(msg.id, {
      sent: false,
      error: "send_failed",
      message: `Your message was NOT sent — ${reason}. Retrying unchanged will fail the same way.`,
    }, true),
  });
  if (typeof sessionId !== "string" || !sessionId) return notSent(MISSING_THREAD_ID);
  if (role !== "visitor" && role !== "host") return notSent("role must be 'visitor' or 'host' — use the role bc_check_inbox reports for this thread");

  let state = ctx.keystore.load();
  let entry = state[sessionId];

  // The peer can only derive the session key from OUR pubkey, so it has to be
  // out there before anything is sealed — whether or not we already hold theirs.
  if (!entry?.pubkeySentAt) {
    const failed = await publishOwnKey(sessionId, role, ctx);
    if (failed) return notSent(`couldn't start the encryption handshake on this thread: ${failed}`);
    state = ctx.keystore.load();
    entry = state[sessionId];
  }

  if (!entry?.peerPublicKey) {
    // Our key is out; give the peer's a short window to land.
    const attempts = ctx.handshakeWaitAttempts ?? HANDSHAKE_WAIT_ATTEMPTS;
    const intervalMs = ctx.handshakeWaitIntervalMs ?? HANDSHAKE_WAIT_INTERVAL_MS;
    for (let attempt = 0; attempt < attempts && !entry?.peerPublicKey; attempt++) {
      let resp;
      try {
        resp = await ctx.post({
          jsonrpc: "2.0", id: `wait-${sessionId}-${attempt}`, method: "tools/call",
          params: { name: "bc_read_messages", arguments: { session_id: sessionId, role, cursor: 0, mark_read: false } },
        });
      } catch (e) {
        ctx.log(`handshake wait poll failed: ${e?.message ?? e}`);
        return notSent(`couldn't read this thread to finish the encryption handshake (${e?.message ?? e})`);
      }
      const failed = failureDetail(resp);
      if (failed) {
        ctx.log(`handshake wait poll rejected for session ${sessionId}: ${failed}`);
        return notSent(`couldn't read this thread to finish the encryption handshake: ${failed}`);
      }
      const ended = endedReason(resp);
      if (ended) return notSent(`this thread has ended (${ended})`);
      await processIncoming(
        { method: "tools/call", params: { name: "bc_read_messages", arguments: { session_id: sessionId, role } } },
        resp, ctx,
      );
      state = ctx.keystore.load();
      entry = state[sessionId];
      if (entry?.peerPublicKey) break;
      if (attempt < attempts - 1) await sleep(intervalMs);
    }
  }

  if (!entry?.sessionKey) {
    return {
      shortCircuitResponse: localToolResult(msg.id, {
        handshake_pending: true,
        message: "Your message was NOT sent. This thread is reachable and your encryption key is posted on it, but the peer's agent hasn't posted its key yet — nothing is wrong on your side. Try bc_send_message again after the peer's agent has next been active on this thread.",
      }, false),
    };
  }

  const sealed = seal(frame, Buffer.from(entry.sessionKey, "base64"));
  const mutated = { ...msg, params: { ...msg.params, arguments: { ...msg.params.arguments, frame: sealed } } };
  return { line: JSON.stringify(mutated) };
}
