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
 */

const DEFAULT_TIMEOUT_MS = 25_000;

export function createBridge({
  url,
  token,
  stdin = process.stdin,
  stdout = process.stdout,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  log = (...a) => console.error("[back-channel]", ...a),
} = {}) {
  let buffer = "";
  let chain = Promise.resolve(); // serialize forwards: order in = order out

  const writeLine = (obj) => {
    stdout.write(JSON.stringify(obj) + "\n");
  };

  const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

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

    let res;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: line,
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
    try {
      writeLine(JSON.parse(text)); // re-serialize → guaranteed single line
    } catch {
      log(`non-JSON body with HTTP ${res.status}`);
      writeLine(rpcError(id, -32000, `Back Channel returned a malformed response (HTTP ${res.status}).`));
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
