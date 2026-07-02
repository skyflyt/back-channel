/**
 * Back Channel .mcpb bridge — zero-dependency stdio→HTTP adapter.
 *
 * Claude Desktop runs this as a local stdio MCP server; each newline-delimited
 * JSON-RPC message from stdin is POSTed to the remote /api/mcp with the user's
 * bearer token, and the response line is written back to stdout.
 *
 * Hard-won constraints (do not "clean up"):
 *  - stdin MUST be consumed with the flowing event API (.on("data")). Desktop
 *    runs extensions as an Electron utilityProcess where async iteration
 *    (`for await...of process.stdin`) never enters flowing mode and receives
 *    ZERO chunks — initialize may squeak through and then tools/list hangs.
 *  - Forwards are CHAINED so response order matches request order.
 *  - Every request is bounded by AbortSignal.timeout so one hung socket fails
 *    that one message instead of wedging the whole session.
 *  - console.error goes to Desktop's main.log ([UtilityProcess stderr]) — it is
 *    the only visibility we get in the field. Never log the token.
 *
 * E2E crypto for bc_send_message/bc_read_messages lives in e2e.js — this file
 * only calls prepareOutgoing/processIncoming/afterSessionEstablished around
 * the normal forward, so the transport plumbing above stays unchanged for
 * every other tool/method.
 */

import { createKeyStore } from "./keystore.js";
import { prepareOutgoing, processIncoming, afterSessionEstablished } from "./e2e.js";

const DEFAULT_TIMEOUT_MS = 25_000;

export function createBridge({
  url,
  token,
  stdin = process.stdin,
  stdout = process.stdout,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  keystore = createKeyStore(),
  log = (...a) => console.error("[back-channel]", ...a),
} = {}) {
  let buffer = "";
  let chain = Promise.resolve(); // serialize forwards: order in = order out

  const writeLine = (obj) => {
    stdout.write(JSON.stringify(obj) + "\n");
  };

  const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  /** Raw POST + JSON-parsed response, no stdout writes — used for the bridge's
   * own internal calls (handshake sends, short handshake-wait polls). */
  async function post(msgObj) {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(msgObj),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = (await res.text().catch(() => "")).trim();
    if (!text) throw new Error(`empty HTTP ${res.status}`);
    return JSON.parse(text);
  }
  const e2eCtx = { keystore, post, log };

  async function forwardOne(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      writeLine(rpcError(null, -32700, "Parse error: not valid JSON"));
      return;
    }
    const id = msg?.id;
    const isNotification = id === undefined || id === null;

    if (!token) {
      log("no token configured");
      if (!isNotification) writeLine(rpcError(id, -32001, "No Back Channel token configured — open the extension settings and paste the token from back-channel.app → Account → Connect a new agent."));
      return;
    }

    let outgoingLine = line;
    if (msg?.method === "tools/call" && msg.params?.name === "bc_send_message") {
      let prepared;
      try {
        prepared = await prepareOutgoing(msg, e2eCtx);
      } catch (e) {
        log(`e2e prepareOutgoing failed: ${e?.message ?? e}`);
        writeLine(rpcError(id, -32000, "Encryption step failed locally — see the connector logs."));
        return;
      }
      if (prepared.shortCircuitResponse) {
        writeLine(prepared.shortCircuitResponse);
        return;
      }
      outgoingLine = prepared.line;
    }

    let res;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: outgoingLine,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
      log(`forward failed (${msg?.method ?? "?"}):`, timedOut ? "timeout" : e?.message ?? e);
      if (!isNotification) {
        writeLine(rpcError(id, -32000, timedOut
          ? `Back Channel didn't answer within ${Math.round(timeoutMs / 1000)}s — it may be briefly unavailable; try again.`
          : "Can't reach back-channel.app — check your internet connection."));
      }
      return;
    }

    if (res.status === 401) {
      log("401 from server — bad/revoked token");
      if (!isNotification) writeLine(rpcError(id, -32001, "Back Channel rejected the token (revoked or mistyped). Generate a fresh one at back-channel.app → Account → Connect a new agent and update the extension settings."));
      return;
    }

    const text = (await res.text().catch(() => "")).trim();
    if (isNotification) return; // 202/empty by design — nothing to write

    if (!text) {
      log(`empty body with HTTP ${res.status} for request ${String(id)}`);
      writeLine(rpcError(id, -32000, `Back Channel returned an empty HTTP ${res.status} response — try again shortly.`));
      return;
    }
    let respObj;
    try {
      respObj = JSON.parse(text);
    } catch {
      log(`non-JSON body with HTTP ${res.status}`);
      writeLine(rpcError(id, -32000, `Back Channel returned a malformed response (HTTP ${res.status}).`));
      return;
    }

    const name = msg.method === "tools/call" ? msg.params?.name : null;
    if (name === "bc_read_messages") {
      try {
        respObj = await processIncoming(msg, respObj, e2eCtx);
      } catch (e) {
        log(`e2e processIncoming failed: ${e?.message ?? e}`); // fall through — better to show sealed frames than nothing
      }
    }
    writeLine(respObj);

    if (name === "bc_create_invite" || name === "bc_claim_invite") {
      afterSessionEstablished(msg, respObj, e2eCtx).catch((e) => log(`e2e afterSessionEstablished failed: ${e?.message ?? e}`));
    }
  }

  function onData(chunk) {
    buffer += chunk.toString("utf8");
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      // Chain, never parallel — JSON-RPC ids make order technically optional,
      // but Desktop's client is happiest with in-order replies.
      chain = chain.then(() => forwardOne(line)).catch((e) => log("unexpected bridge error:", e?.message ?? e));
    }
  }

  return {
    start() {
      stdin.on("data", onData);
      stdin.on("end", () => log("stdin closed — exiting"));
      stdin.resume(); // belt & braces: ensure flowing mode under utilityProcess
      log(`bridge up → ${url}`);
    },
    /** test hook: await all in-flight forwards */
    flush: () => chain,
  };
}
