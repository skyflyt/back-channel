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
 *
 * Exchange-code bootstrap: the same "token" user_config field also accepts a
 * one-time BCX-XXXX-XXXX code from the dashboard (see manifest.json). On the
 * FIRST forwarded message, if the configured value looks like a code (not a
 * bc_ key), we redeem it against POST /api/auth/exchange, persist the minted
 * bc_ key via the keystore (so a restart doesn't need the code again — codes
 * are single-use), and swap it in before anything is forwarded. A used/
 * expired/unknown code gets the SAME opaque 410 from the server, which we
 * turn into one plain-language local error (never forwarded, nothing to
 * retry with the same code).
 */

import { createKeyStore } from "./keystore.js";
import { prepareOutgoing, processIncoming, afterSessionEstablished } from "./e2e.js";

const DEFAULT_TIMEOUT_MS = 25_000;
const EXCHANGE_CODE_RE = /^BCX-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const RESOLVED_TOKEN_KEY = "__resolved_bc_token__"; // keystore entry name — distinct from any session_id

/** True if the configured value is a one-time exchange code rather than a real bc_ key. */
export function looksLikeExchangeCode(value) {
  return EXCHANGE_CODE_RE.test(String(value || "").trim().toUpperCase());
}

/**
 * Redeem a BCX-… exchange code for a real bc_ key. Talks to the exchange
 * endpoint at the given mcpUrl's origin (mcpUrl is normally .../api/mcp, so
 * the exchange endpoint is a sibling path on the same host). Returns the
 * minted key on success; throws a friendly Error otherwise (410 = the
 * uniform "invalid, already-used, or expired" response — same message for
 * all three, matching the server's opaque-failure design).
 */
export async function redeemExchangeCode(code, { mcpUrl, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const exchangeUrl = new URL("/api/auth/exchange", mcpUrl).toString();
  let res;
  try {
    res = await fetchImpl(exchangeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: code.trim().toUpperCase() }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error("Couldn't reach back-channel.app to redeem your connect code — check your internet connection and restart Claude Desktop to retry.");
  }
  if (res.status === 410) {
    throw new Error("That connect code has already been used, expired, or doesn't exist — mint a fresh one at back-channel.app → Account → Connect a new agent, then update the extension settings.");
  }
  const text = (await res.text().catch(() => "")).trim();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!res.ok || !body?.api_key) {
    throw new Error(`Couldn't redeem your connect code (Back Channel said HTTP ${res.status}) — try generating a fresh one at back-channel.app → Account → Connect a new agent.`);
  }
  return body.api_key;
}

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
  let resolvedToken = (token || "").trim();
  let exchangeError = null; // set once if code redemption fails; surfaced to every request until fixed

  /** Resolve `resolvedToken` to a real bc_ key exactly once, redeeming an exchange
   * code (and persisting the result) on the first call if one was configured. */
  async function ensureToken() {
    if (!resolvedToken || !looksLikeExchangeCode(resolvedToken) || exchangeError) return;
    const state = keystore.load();
    const cached = state[RESOLVED_TOKEN_KEY]?.bcToken;
    if (cached) {
      resolvedToken = cached;
      return;
    }
    try {
      const apiKey = await redeemExchangeCode(resolvedToken, { mcpUrl: url, fetchImpl, timeoutMs });
      state[RESOLVED_TOKEN_KEY] = { bcToken: apiKey, updatedAt: Date.now() };
      keystore.save(state);
      resolvedToken = apiKey;
      log("exchange code redeemed — connected");
    } catch (e) {
      exchangeError = e?.message || "Couldn't redeem your Back Channel connect code.";
      log(`exchange code redemption failed: ${exchangeError}`);
    }
  }

  const writeLine = (obj) => {
    stdout.write(JSON.stringify(obj) + "\n");
  };

  const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  /** Raw POST + JSON-parsed response, no stdout writes — used for the bridge's
   * own internal calls (handshake sends, short handshake-wait polls). */
  async function post(msgObj) {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${resolvedToken}` },
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

    if (!resolvedToken) {
      log("no token configured");
      if (!isNotification) writeLine(rpcError(id, -32001, "No Back Channel token configured — open the extension settings and paste the token from back-channel.app → Account → Connect a new agent."));
      return;
    }

    if (looksLikeExchangeCode(resolvedToken)) await ensureToken();
    if (exchangeError) {
      if (!isNotification) writeLine(rpcError(id, -32001, exchangeError));
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
        headers: { "content-type": "application/json", authorization: `Bearer ${resolvedToken}` },
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
      // Clear any cached exchange-code result: if the user pastes a fresh code
      // into settings, a stale resolved key must not shadow it on next start.
      try {
        const state = keystore.load();
        if (state[RESOLVED_TOKEN_KEY]) {
          delete state[RESOLVED_TOKEN_KEY];
          keystore.save(state);
        }
      } catch { /* best-effort cleanup */ }
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
