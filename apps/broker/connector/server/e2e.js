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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function localToolResult(id, dataObj, isError = false) {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(dataObj) }], isError } };
}

function toolName(msg) {
  return msg?.method === "tools/call" ? msg.params?.name : null;
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

  const state = ctx.keystore.load();
  const entry = getOrCreateEntry(state, sessionId, role);
  ctx.keystore.save(state);

  try {
    await ctx.post({
      jsonrpc: "2.0", id: `hs-${sessionId}`, method: "tools/call",
      params: { name: "bc_send_message", arguments: { session_id: sessionId, role, frame: { type: "handshake.pubkey", pubkey: entry.publicKey } } },
    });
  } catch (e) {
    ctx.log(`handshake send failed for session ${sessionId}: ${e?.message ?? e}`);
  }
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

  let state = ctx.keystore.load();
  let entry = getOrCreateEntry(state, sessionId, role);
  ctx.keystore.save(state);

  if (!entry.peerPublicKey) {
    // We don't have the peer's key yet — make sure OUR pubkey is at least out
    // there, then give the handshake a short window to land.
    try {
      await ctx.post({
        jsonrpc: "2.0", id: `hs-${sessionId}`, method: "tools/call",
        params: { name: "bc_send_message", arguments: { session_id: sessionId, role, frame: { type: "handshake.pubkey", pubkey: entry.publicKey } } },
      });
    } catch (e) {
      ctx.log(`handshake send failed for session ${sessionId}: ${e?.message ?? e}`);
    }

    const attempts = ctx.handshakeWaitAttempts ?? HANDSHAKE_WAIT_ATTEMPTS;
    const intervalMs = ctx.handshakeWaitIntervalMs ?? HANDSHAKE_WAIT_INTERVAL_MS;
    for (let attempt = 0; attempt < attempts && !entry.peerPublicKey; attempt++) {
      let resp;
      try {
        resp = await ctx.post({
          jsonrpc: "2.0", id: `wait-${sessionId}-${attempt}`, method: "tools/call",
          params: { name: "bc_read_messages", arguments: { session_id: sessionId, role, cursor: 0, mark_read: false } },
        });
      } catch (e) {
        ctx.log(`handshake wait poll failed: ${e?.message ?? e}`);
        break;
      }
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
        message: "Encryption handshake with your peer hasn't completed yet — your message was NOT sent. Your own key is out there; retry bc_send_message in a few seconds once the peer has read it.",
      }, false),
    };
  }

  const sealed = seal(frame, Buffer.from(entry.sessionKey, "base64"));
  const mutated = { ...msg, params: { ...msg.params, arguments: { ...msg.params.arguments, frame: sealed } } };
  return { line: JSON.stringify(mutated) };
}
