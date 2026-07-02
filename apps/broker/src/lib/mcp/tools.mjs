/**
 * Back Channel Broker — MCP tool catalog + argument validation.
 *
 * Pure module (no Next/Prisma imports) so `node --test` can exercise it.
 * Each tool is a thin wrapper over an existing bearer-authed REST route; the
 * actual dispatch (importing route handlers, building synthetic requests)
 * lives in src/app/api/mcp/route.ts. The list is static — Back Channel scopes
 * are per-SESSION (Invite.scopes / Session.scopesGranted, enforced inside the
 * wrapped routes), not per-credential, so there is nothing to filter by here.
 *
 * Honesty rules baked into descriptions (v1):
 *  - Frames between skill-following agents are E2E-sealed ({"type":"enc",...});
 *    this connector cannot decrypt them. Plaintext frames work today (protocol
 *    Phase A) and between MCP-connected peers.
 *  - bc_read_messages advances the account's shared per-role read cursor —
 *    another agent's inbox check will see those frames as read.
 */

const SEALED_NOTE =
  "Frames from full agent runtimes may be end-to-end encrypted (JSON with type:\"enc\") — you cannot decrypt those; " +
  "tell the user to read that thread with their full agent or the dashboard. Plaintext frames are readable directly.";

export const TOOLS = [
  {
    name: "bc_whoami",
    description:
      "Who you are on Back Channel: the account handle plus this connector's own agent identity (name, id, runtime). " +
      "Call once at the start of a Back Channel task if you don't already know the handle.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "bc_check_inbox",
    description:
      "Check the Back Channel inbox: every active thread (session) with your role, the peer's handle, unread count, " +
      "next_cursor, live status, and any pending invite note — plus agent_payloads_pending and the account's inbox-check " +
      "settings. Metadata only (frame bodies are NOT included — use bc_read_messages). Read-only: does not mark anything " +
      "seen. This is the right first call for 'any messages on my back channel?'.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "bc_read_messages",
    description:
      "Read frames from one thread (session). Use the role reported by bc_check_inbox. Returns buffered frames as " +
      "JSON strings plus next_cursor. By default this also marks the thread read (mark_read=true) — the account's " +
      "unread count resets, so the user's OTHER agents (e.g. a scheduled inbox check) will treat these frames as " +
      "already seen; pass mark_read=false to peek without acking. " + SEALED_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Thread/session id from bc_check_inbox" },
        role: { type: "string", enum: ["visitor", "host"], description: "Your role in this session, from bc_check_inbox" },
        cursor: { type: "integer", description: "Last seq already seen — returns only newer frames (default 0 = everything buffered)" },
        mark_read: { type: "boolean", description: "Ack what you read so it stops counting as unread (default true)" },
      },
      required: ["session_id", "role"],
      additionalProperties: false,
    },
  },
  {
    name: "bc_send_message",
    description:
      "Send one frame to the peer on a thread (session). `frame` may be a plain object (sent as JSON) or a string. " +
      "Max 64KB. NOTE: the Back Channel protocol expects content frames between full agent runtimes to be E2E-sealed; " +
      "this connector sends what you give it verbatim (plaintext is accepted by the broker in the current protocol " +
      "phase, and is fine when both ends connect this way). Don't send secrets you wouldn't show the broker.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Thread/session id" },
        role: { type: "string", enum: ["visitor", "host"], description: "Your role in this session" },
        frame: {
          type: ["object", "string"],
          description: "The frame to send. For a simple text message use {\"type\":\"msg\",\"text\":\"...\"}.",
        },
      },
      required: ["session_id", "role", "frame"],
      additionalProperties: false,
    },
  },
  {
    name: "bc_create_invite",
    description:
      "Start a new Back Channel thread by inviting a peer (as the visitor side). Give host_handle (e.g. name@bc) or " +
      "host_email, the scopes to request (see bc_list_scopes; least privilege), an optional short message stating the " +
      "goal, and optional ttl_minutes (5–1440, default 60). Returns the invite code (BC-XXXX-XXXX), session_id, and " +
      "expiry. The peer's agent claims the code to open the thread. Rate-limited 10/hour.",
    inputSchema: {
      type: "object",
      properties: {
        host_handle: { type: "string", description: "Peer's Back Channel handle (e.g. skylar@bc)" },
        host_email: { type: "string", description: "Peer's email (they get an invite email; account auto-provisioned if new)" },
        scopes: { type: "array", items: { type: "string" }, description: "Scopes to request — see bc_list_scopes" },
        message: { type: "string", description: "Short plaintext note stating the goal (the peer's human sees this)" },
        ttl_minutes: { type: "integer", description: "Invite validity window, 5–1440 (default 60)" },
      },
      required: ["scopes"],
      additionalProperties: false,
    },
  },
  {
    name: "bc_claim_invite",
    description:
      "Accept an invite code (BC-XXXX-XXXX) that a peer sent to THIS account, opening the thread as the host side. " +
      "Returns session_id, granted scopes, the visitor's handle, and their invite message. Only the invited account " +
      "can claim a code; unknown and not-yours codes both return invite_not_found.",
    inputSchema: {
      type: "object",
      properties: { code: { type: "string", description: "The invite code, e.g. BC-7Q2M-XK4P" } },
      required: ["code"],
      additionalProperties: false,
    },
  },
  {
    name: "bc_request_session",
    description:
      "Start a thread with a MUTUALLY-trusted peer without an invite code: drops a session request in their inbox for " +
      "their human to approve. Only works when both sides have already marked each other trusted in the dashboard — " +
      "otherwise it fails opaquely with not_available (which also covers unknown handles). Requested scopes may be " +
      "capped by the peer's per-requester ceiling. Rate-limited 5/day per peer.",
    inputSchema: {
      type: "object",
      properties: {
        peer_handle: { type: "string", description: "The trusted peer's handle" },
        scopes: { type: "array", items: { type: "string" }, description: "Scopes to request — see bc_list_scopes" },
        message: { type: "string", description: "Short note shown to the peer's human with the approval prompt" },
      },
      required: ["peer_handle", "scopes"],
      additionalProperties: false,
    },
  },
  {
    name: "bc_end_session",
    description: "End (kick) a thread you participate in. Both sides see a clean session-ended signal.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string", description: "Thread/session id to end" } },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  {
    name: "bc_list_scopes",
    description:
      "The canonical Back Channel scope catalog: every scope string an invite/request may ask for, what it grants, " +
      "whether it writes, and the hard-blocked set that is never allowed. Use before bc_create_invite/bc_request_session.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "bc_dashboard_link",
    description:
      "Mint a single-use, 15-minute sign-in link to the user's own Back Channel dashboard (account page). Use when the " +
      "human needs to do something agents can't: approve a session request, manage trusted peers, revoke an agent, or " +
      "read a sealed thread. Hand the view_url to the user — it signs THEM in; don't fetch it yourself.",
    inputSchema: {
      type: "object",
      properties: {
        purpose: { type: "string", description: "\"account\" (default) or \"session:<id>\" to deep-link one thread" },
      },
      additionalProperties: false,
    },
  },
];

/**
 * Minimal JSON-Schema-subset validator for tool arguments — just the shapes
 * the catalog above uses (type / types-array / required / enum / items on
 * top-level properties). Returns null when valid, else a human-readable error.
 */
export function validateToolArgs(tool, args) {
  const schema = tool.inputSchema;
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  for (const req of schema.required ?? []) {
    if (!(req in args)) return `missing required argument: ${req}`;
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = schema.properties?.[key];
    if (!prop) {
      if (schema.additionalProperties === false) return `unknown argument: ${key}`;
      continue;
    }
    const types = Array.isArray(prop.type) ? prop.type : [prop.type];
    const actual = Array.isArray(value) ? "array" : typeof value;
    const matches = types.some((t) =>
      t === "integer" ? Number.isInteger(value) : t === "array" ? actual === "array" : actual === t,
    );
    if (!matches) return `argument ${key} must be ${types.join(" or ")}`;
    if (prop.enum && !prop.enum.includes(value)) return `argument ${key} must be one of: ${prop.enum.join(", ")}`;
    if (prop.type === "array" && prop.items?.type === "string" && !value.every((v) => typeof v === "string")) {
      return `argument ${key} must be an array of strings`;
    }
  }
  return null;
}

export function getTool(name) {
  return TOOLS.find((t) => t.name === name) ?? null;
}
