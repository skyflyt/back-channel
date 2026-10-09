/**
 * Back Channel bridge — the panel: an interactive view of the user's threads
 * that renders INSIDE the host (Claude, Codex) instead of in a browser tab.
 *
 * Mechanism: MCP Apps (SEP-1865, wire protocol "2026-01-26"). The bridge serves
 * one self-contained HTML document as a `ui://` resource and one tool,
 * bc_open_panel, whose `_meta.ui.resourceUri` points at it. A host that
 * supports MCP Apps renders the document in a sandboxed iframe; the document
 * talks to the host over postMessage and reaches Back Channel only by calling
 * this server's own tools through the host (`tools/call`). It never fetches
 * anything: the sandbox's default CSP is `connect-src 'none'`, which is
 * exactly what we want — every byte the panel shows came through the same
 * tools, the same key and the same local encryption as everything else.
 *
 * A host that does not support MCP Apps ignores the `_meta` and gets the
 * tool's text result, which is written to be useful on its own.
 *
 * Where it shows up (as of 2026-10): Codex in the ChatGPT desktop app, as a
 * sidebar and thread panel the user opens (the `openai/ui` entrypoints below);
 * Claude Desktop chat, as an inline card when the model calls the tool. The
 * Claude Code and Codex terminals are text only.
 *
 * Everything here is static and local. lib.js decides when to answer with it.
 */

import { readFileSync } from "node:fs";

// Hosts cache a UI by its URI, so the URI carries a version. Bump it whenever
// panel.html changes in a way an already-open host must not keep using; old
// URIs stay readable (isPanelUri) and simply get the current document.
export const PANEL_VERSION = "1";
export const PANEL_URI = `ui://back-channel/panel-${PANEL_VERSION}.html`;
export const PANEL_MIME = "text/html;profile=mcp-app";
export const UI_EXTENSION = "io.modelcontextprotocol/ui";

const isPanelUri = (uri) => typeof uri === "string" && /^ui:\/\/back-channel\/panel-[A-Za-z0-9.]+\.html$/.test(uri);

// The same pointer in the three spellings hosts read: the MCP Apps field, its
// deprecated flat form (still read by some hosts), and OpenAI's.
export const PANEL_META = {
  ui: { resourceUri: PANEL_URI },
  "ui/resourceUri": PANEL_URI,
  "openai/outputTemplate": PANEL_URI,
};

export const PANEL_TOOL = {
  name: "bc_open_panel",
  title: "Back Channel",
  description:
    "Open the Back Channel panel: an interactive view of the user's threads where they can read messages and reply themselves. " +
    "Use it when the user asks to see or open Back Channel, their inbox or their threads. In a host that cannot show the panel " +
    "this returns the same inbox as text. Takes no arguments.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  _meta: {
    ...PANEL_META,
    // Codex / ChatGPT: let the user open the panel themselves, from the sidebar or beside a thread.
    "openai/ui": { entrypoints: [{ type: "global" }, { type: "thread" }] },
    "openai/widgetAccessible": true,
  },
};

// The broker tools the panel calls on the user's behalf. OpenAI hosts only let
// a view call a tool that says so; MCP Apps hosts allow it by default.
const PANEL_CALLS = new Set(["bc_read_messages", "bc_send_message", "bc_dashboard_link", "bc_connect"]);
/** Mark the tools the panel calls as callable from a view. Returns a new list; other tools are untouched. */
export function markPanelCallable(tools) {
  return tools.map((t) => (t && PANEL_CALLS.has(t.name) ? { ...t, _meta: { ...t._meta, "openai/widgetAccessible": true } } : t));
}

// The only fields of a thread the panel is given. The broker's row also carries
// the peer's invite note (their words) and key-wrapping material; a host may
// hand `structuredContent` to the model, so the panel gets what it draws and no more.
const THREAD_FIELDS = ["role", "peer_handle", "unread_count", "last_frame_at", "peer_present", "live", "expires_at"];
/** The broker's session rows, cut down to what the panel shows. */
export function panelThreads(sessions) {
  if (!Array.isArray(sessions)) return [];
  return sessions.filter((s) => s && typeof s.id === "string").map((s) => {
    const out = { session_id: s.id };
    for (const k of THREAD_FIELDS) if (s[k] !== undefined) out[k] = s[k];
    return out;
  });
}

/**
 * The panel's own data source: the thread list, read without side effects.
 * (bc_check_inbox also hands over and marks delivered anything queued for the
 * agent — right for an agent checking its mail, wrong for a view refreshing
 * itself every few seconds.) App-only: `visibility: ["app"]` hides it from the
 * model, and lib.js lists it only for a host that said it renders MCP Apps,
 * because a host that ignores `_meta` would show it to the model as one more tool.
 */
export const PANEL_INBOX_TOOL = {
  name: "bc_panel_inbox",
  title: "Back Channel panel data",
  description: "Thread list for the Back Channel panel. Used by the panel itself; an agent should call bc_check_inbox instead.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  _meta: { ui: { visibility: ["app"] }, "openai/widgetAccessible": true },
};

let cachedHtml = null;
/** The panel document. Read once; a missing file is a packaging bug, reported as such. */
export function panelHtml() {
  cachedHtml ??= readFileSync(new URL("./panel.html", import.meta.url), "utf8");
  return cachedHtml;
}

const result = (id, value) => ({ jsonrpc: "2.0", id, result: value });
const error = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/**
 * Answer the resource methods the panel needs, or return null for anything
 * else. These never depend on being connected and are never forwarded: the
 * broker serves no resources.
 */
export function answerResourceRequest(msg, { readHtml = panelHtml } = {}) {
  switch (msg?.method) {
    case "resources/list":
      return result(msg.id, { resources: [{ uri: PANEL_URI, name: "Back Channel panel", mimeType: PANEL_MIME }] });
    case "resources/templates/list":
      return result(msg.id, { resourceTemplates: [] });
    case "resources/read": {
      const uri = msg.params?.uri;
      if (!isPanelUri(uri)) return error(msg.id, -32002, `Resource not found: ${String(uri).slice(0, 200)}`);
      let text;
      try {
        text = readHtml();
      } catch {
        return error(msg.id, -32603, "The Back Channel panel is missing from this install.");
      }
      return result(msg.id, {
        contents: [{
          uri,
          mimeType: PANEL_MIME,
          text,
          // No network at all: the panel does everything through tools/call.
          _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } }, "openai/widgetDescription": "Back Channel threads and messages" },
        }],
      });
    }
    default:
      return null;
  }
}

/** Did the host say, in `initialize`, that it renders MCP Apps? */
export function clientRendersUi(initializeMsg) {
  const ext = initializeMsg?.params?.capabilities?.extensions?.[UI_EXTENSION];
  return !!ext && typeof ext === "object";
}

/** Add what the panel needs to an `initialize` result (forwarded or local). */
export function declarePanel(initializeResult) {
  if (!initializeResult || typeof initializeResult !== "object") return;
  const caps = initializeResult.capabilities ?? {};
  initializeResult.capabilities = { ...caps, resources: caps.resources ?? {} };
}

/** The bc_open_panel result: text for hosts without the panel, data for the panel, and the pointer to it. */
export function panelToolResult(id, { text, data }) {
  return result(id, { content: [{ type: "text", text }], structuredContent: data, isError: false, _meta: PANEL_META });
}

/**
 * The bc_panel_inbox result. The text is the data again as JSON, for a host
 * that drops `structuredContent` on the way to the view. No pointer to the
 * panel: a data call must not open a second one.
 */
export function panelDataResult(id, data) {
  return result(id, { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: false });
}

/** A few plain lines about the inbox, for a host that shows text. Counts and handles only. */
export function inboxAsText(inbox) {
  const sessions = Array.isArray(inbox?.sessions) ? inbox.sessions : [];
  if (sessions.length === 0) return "Back Channel is connected. There are no open threads.";
  const unread = sessions.reduce((n, s) => n + (Number.isInteger(s.unread_count) ? s.unread_count : 0), 0);
  const lines = sessions.slice(0, 20).map((s) => `- ${String(s.peer_handle ?? "unknown")}${s.unread_count ? ` — ${s.unread_count} unread` : ""}`);
  return `Back Channel: ${sessions.length} open thread${sessions.length === 1 ? "" : "s"}, ${unread} unread.\n${lines.join("\n")}`;
}
