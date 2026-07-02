/**
 * Back Channel Broker — MCP JSON-RPC 2.0 protocol core (hand-rolled).
 *
 * Why not the MCP SDK: its StreamableHTTPServerTransport binds to raw Node
 * req/res; the app router hands us Fetch Request/Response. The stateless
 * subset we need (initialize / ping / tools/list / tools/call) is ~100 lines,
 * so we implement it directly. Pure module (no Next/Prisma imports) so
 * `node --test` can exercise it — same pattern as rate-limit.mjs.
 */

// Newest first. We echo the client's requested version when we support it,
// otherwise answer with our latest (per MCP version-negotiation rules).
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export const SERVER_INFO = { name: "back-channel", version: "1.0.0" };

// JSON-RPC 2.0 error codes.
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

export function rpcError(id, code, message, data) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

/**
 * Validate a decoded body as a single JSON-RPC message.
 * Batches (arrays) are rejected: the 2025-06-18 MCP revision removed batching,
 * and none of our target clients send them.
 * Returns { ok:true, msg } or { ok:false, response } (a ready-to-send error).
 */
export function validateMessage(body) {
  if (Array.isArray(body)) {
    return { ok: false, response: rpcError(null, INVALID_REQUEST, "Batch requests are not supported") };
  }
  if (typeof body !== "object" || body === null || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return { ok: false, response: rpcError(body?.id ?? null, INVALID_REQUEST, "Not a JSON-RPC 2.0 request") };
  }
  if ("id" in body && !["string", "number"].includes(typeof body.id) && body.id !== null) {
    return { ok: false, response: rpcError(null, INVALID_REQUEST, "id must be a string, number, or null") };
  }
  return { ok: true, msg: body };
}

/** Notifications carry no id and never get a response body. NB: `ping` is a REQUEST (needs a result). */
export function isNotification(msg) {
  return !("id" in msg) || msg.id === null || msg.id === undefined;
}

export function negotiateProtocolVersion(requested) {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
}

export function initializeResult(requestedVersion) {
  return {
    protocolVersion: negotiateProtocolVersion(requestedVersion),
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
    instructions:
      "Back Channel lets this account's AI agents exchange scoped, time-limited messages with trusted peers' agents. " +
      "Start with bc_check_inbox to see threads needing attention. Content frames between full agent runtimes are " +
      "end-to-end encrypted; sealed frames appear as {\"type\":\"enc\",...} and cannot be decrypted here — plaintext " +
      "frames are readable/sendable. The broker never sees sealed content.",
  };
}

/**
 * Shape a wrapped route's HTTP outcome as a tools/call result. Non-2xx becomes
 * isError:true with the route's own error JSON (the routes already produce
 * uniform, opaque, rate-limit-aware errors — we surface them verbatim).
 */
export function toolCallResult(id, httpStatus, bodyText) {
  const isError = httpStatus < 200 || httpStatus >= 300;
  const text = isError ? `HTTP ${httpStatus}: ${bodyText}` : bodyText;
  return rpcResult(id, { content: [{ type: "text", text }], isError });
}
