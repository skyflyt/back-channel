// The panel (panel.js + panel.html): the in-host UI. These tests pin what a host
// depends on — the resource, the pointers on the tool, what is and is not
// forwarded — and the two properties the document must keep: it fetches nothing
// and never puts peer text in as HTML.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { createBridge } from "./lib.js";
import { PANEL_URI, PANEL_MIME, UI_EXTENSION, answerResourceRequest, clientRendersUi, inboxAsText, panelHtml, panelThreads } from "./panel.js";

const here = (name) => new URL(name, import.meta.url);
const UI_CAPS = { capabilities: { extensions: { [UI_EXTENSION]: { mimeTypes: [PANEL_MIME] } } } };

function harness({ token = "bc_test", fetchImpl, tokenFile = "" } = {}) {
  const stdin = new PassThrough();
  const lines = [];
  const stdout = { write: (s) => { lines.push(...String(s).split("\n").filter(Boolean).map((l) => JSON.parse(l))); return true; } };
  let state = {};
  const bridge = createBridge({
    url: "https://example.test/api/mcp", token, stdin, stdout, fetchImpl, timeoutMs: 200,
    keystore: { load: () => state, save: (s) => { state = s; } }, readTokenFile: () => tokenFile, log: () => {},
  });
  bridge.start();
  const send = async (obj) => { stdin.write(JSON.stringify(obj) + "\n"); await bridge.flush(); return lines.at(-1); };
  return { send, lines };
}

/** A broker that answers the calls the panel makes, and records every one. */
const ROW = { id: "s1", role: "host", peer_handle: "peer@bc", unread_count: 2, pending_invite_message: "psst, assistant", mirror_wraps_needed: [{ account_id: "a", mirror_pub: "k" }] };
function broker({ sessions = [ROW], listStatus = 200 } = {}) {
  const seen = [];
  const fetchImpl = async (u, init) => {
    const url = new URL(String(u));
    if (init.method === "GET") {
      seen.push(`GET ${url.pathname}${url.search}`);
      return new Response(JSON.stringify({ sessions, agent_payloads_pending: 1 }), { status: listStatus });
    }
    const body = JSON.parse(init.body);
    seen.push(body.method === "tools/call" ? `call ${body.params.name}` : body.method);
    const reply = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200 });
    if (body.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "bc" } });
    if (body.method === "tools/list") return reply({ tools: [{ name: "bc_check_inbox" }, { name: "bc_send_message", _meta: { kept: 1 } }] });
    if (body.params?.name === "bc_whoami") return reply({ content: [{ type: "text", text: JSON.stringify({ handle: "me@bc", agent_name: "Claude" }) }], isError: false });
    return reply({ content: [{ type: "text", text: "{}" }], isError: false });
  };
  return { fetchImpl, seen };
}

test("the panel resource is served by the bridge itself, connected or not, and never forwarded", async () => {
  for (const token of ["", "bc_test"]) {
    const b = broker();
    const h = harness({ token, fetchImpl: b.fetchImpl });
    const list = await h.send({ jsonrpc: "2.0", id: 1, method: "resources/list" });
    assert.deepEqual(list.result.resources.map((r) => [r.uri, r.mimeType]), [[PANEL_URI, PANEL_MIME]]);
    const read = await h.send({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: PANEL_URI } });
    const [doc] = read.result.contents;
    assert.equal(doc.mimeType, PANEL_MIME);
    assert.equal(doc.text, panelHtml());
    assert.deepEqual(doc._meta.ui.csp, { connectDomains: [], resourceDomains: [] }, "the panel asks for no network at all");
    const templates = await h.send({ jsonrpc: "2.0", id: 3, method: "resources/templates/list" });
    assert.deepEqual(templates.result, { resourceTemplates: [] });
    assert.deepEqual(b.seen, [], `nothing reaches the broker (token: ${token ? "set" : "none"})`);
  }
});

test("resources/read: an older panel URI still gets the current document; anything else is not found", () => {
  const old = answerResourceRequest({ id: 1, method: "resources/read", params: { uri: "ui://back-channel/panel-0.html" } }, { readHtml: () => "<p>x</p>" });
  assert.equal(old.result.contents[0].text, "<p>x</p>");
  assert.equal(old.result.contents[0].uri, "ui://back-channel/panel-0.html");
  for (const uri of ["ui://back-channel/other.html", "ui://elsewhere/panel-1.html", "file:///etc/passwd", "ui://back-channel/panel-../x.html", undefined]) {
    assert.equal(answerResourceRequest({ id: 1, method: "resources/read", params: { uri } }).error.code, -32002);
  }
  const missing = answerResourceRequest({ id: 1, method: "resources/read", params: { uri: PANEL_URI } }, { readHtml: () => { throw new Error("ENOENT"); } });
  assert.equal(missing.error.code, -32603);
  assert.equal(answerResourceRequest({ id: 1, method: "tools/list" }), null, "everything else is somebody else's");
});

test("initialize declares resources, and bc_open_panel joins the broker's catalog with the pointers hosts read", async () => {
  const b = broker();
  const h = harness({ fetchImpl: b.fetchImpl });
  const init = await h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.deepEqual(init.result.capabilities, { tools: {}, resources: {} });
  const list = await h.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(list.result.tools.map((t) => t.name), ["bc_check_inbox", "bc_send_message", "bc_open_panel"]);
  const meta = list.result.tools[2]._meta;
  assert.equal(meta.ui.resourceUri, PANEL_URI);
  assert.equal(meta["ui/resourceUri"], PANEL_URI);
  assert.equal(meta["openai/outputTemplate"], PANEL_URI);
  // The tools the panel calls are marked callable from a view; the rest are passed through as they came.
  assert.deepEqual(list.result.tools[1]._meta, { kept: 1, "openai/widgetAccessible": true });
  assert.deepEqual(list.result.tools[0], { name: "bc_check_inbox" });
});

test("the panel's own data tool is listed only for a host that said it renders MCP Apps, and is hidden from the model", async () => {
  assert.equal(clientRendersUi({ params: UI_CAPS }), true);
  assert.equal(clientRendersUi({ params: { capabilities: { extensions: {} } } }), false);
  assert.equal(clientRendersUi({ params: {} }), false);
  for (const token of ["", "bc_test"]) {
    const h = harness({ token, fetchImpl: broker().fetchImpl });
    await h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: UI_CAPS });
    const list = await h.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tool = list.result.tools.find((t) => t.name === "bc_panel_inbox");
    assert.ok(tool, `listed for a UI host (token: ${token ? "set" : "none"})`);
    assert.deepEqual(tool._meta.ui.visibility, ["app"]);
  }
});

test("bc_open_panel, connected: thread data for the panel, plain text for a host without one, read with no side effects", async () => {
  const b = broker();
  const h = harness({ fetchImpl: b.fetchImpl });
  const r = (await h.send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "bc_open_panel", arguments: {} } })).result;
  assert.equal(r.isError, false);
  assert.equal(r._meta.ui.resourceUri, PANEL_URI);
  assert.deepEqual(r.structuredContent, {
    connected: true, local_encryption: true, handle: "me@bc", agent_name: "Claude",
    inbox: { sessions: [{ session_id: "s1", role: "host", peer_handle: "peer@bc", unread_count: 2 }], agent_payloads_pending: 1 },
  });
  assert.doesNotMatch(JSON.stringify(r), /psst|mirror_pub/, "the peer's invite note and key material stay out of what a host may hand the model");
  assert.equal(r.content[0].text, "Back Channel: 1 open thread, 2 unread.\n- peer@bc — 2 unread");
  assert.deepEqual([...b.seen].sort(), ["GET /api/sessions/active?frames=0", "call bc_list_agents", "call bc_whoami"]);
  assert.ok(!b.seen.includes("call bc_check_inbox"), "opening a view must not deliver and ack the agent's queued mail");
  assert.ok(!b.seen.includes("call bc_open_panel"), "the broker has no such tool; it is never forwarded");
});

test("bc_open_panel still opens when the thread list can't be read; the refresh call carries no pointer to a second panel", async () => {
  const b = broker({ listStatus: 500 });
  const h = harness({ fetchImpl: b.fetchImpl });
  const open = (await h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bc_open_panel" } })).result;
  assert.equal(open.structuredContent.inbox, null);
  assert.match(open.content[0].text, /could not be loaded/);

  const ok = harness({ fetchImpl: broker().fetchImpl });
  const refresh = (await ok.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "bc_panel_inbox" } })).result;
  assert.equal(refresh.structuredContent.connected, true);
  assert.equal(refresh.structuredContent.inbox.sessions.length, 1);
  assert.equal(refresh._meta, undefined);
  assert.deepEqual(JSON.parse(refresh.content[0].text), refresh.structuredContent, "the text is the data again, for a host that drops structuredContent");
});

test("a key the server refuses is reported to the panel, not shown as an inbox that 'could not be loaded'", async () => {
  const refused = async (_u, init) => new Response('{"error":"unauthorized"}', { status: 401 });
  // A key the bridge picked up itself: forgotten, the connect form comes back, and the host re-lists.
  const ours = harness({ token: "", tokenFile: "bc_revoked", fetchImpl: refused });
  const open = (await ours.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bc_open_panel" } }));
  const [reply, note] = ours.lines;
  assert.equal(reply.result.isError, false);
  assert.equal(reply.result.structuredContent.connected, false);
  assert.equal(reply.result.structuredContent.can_connect, true);
  assert.match(reply.result.structuredContent.problem, /no longer accepts the key/);
  assert.match(reply.result.content[0].text, /rejected the saved key.*bc_connect/s);
  assert.deepEqual(note, { jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  assert.equal(open, note);
  const list = await ours.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(list.result.tools.map((t) => t.name), ["bc_connect", "bc_open_panel"]);

  // A key from the app's settings: a code typed into the panel would not be used, so the panel is told not to offer one.
  const configured = harness({ token: "bc_configured", fetchImpl: refused });
  const r = (await configured.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bc_panel_inbox" } })).result;
  assert.deepEqual([r.structuredContent.connected, r.structuredContent.can_connect], [false, false]);
  assert.match(r.structuredContent.problem, /extension's settings/);
  assert.equal(configured.lines.length, 1, "nothing changed in the catalog, so nothing is announced");
});

test("a connect code in settings that did not redeem: the panel is told why instead of getting a protocol error", async () => {
  const h = harness({ token: "BCX-DEAD-BEEF", fetchImpl: async () => new Response('{"error":"invalid_or_expired_code"}', { status: 410 }) });
  const r = (await h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bc_open_panel" } })).result;
  assert.equal(r.structuredContent.connected, false);
  assert.equal(r.structuredContent.can_connect, false);
  assert.match(r.structuredContent.problem, /already been used, expired, or doesn't exist/);
  assert.equal(r._meta.ui.resourceUri, PANEL_URI);
  const other = await h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "bc_check_inbox" } });
  assert.equal(other.error.code, -32001, "every other call still fails the way it did");
});

test("calls with no id get no reply line, and the panel's are not even looked up", async () => {
  const b = broker();
  const h = harness({ fetchImpl: b.fetchImpl });
  await h.send({ jsonrpc: "2.0", method: "resources/read", params: { uri: PANEL_URI } });
  await h.send({ jsonrpc: "2.0", method: "resources/list" });
  await h.send({ jsonrpc: "2.0", method: "tools/call", params: { name: "bc_open_panel" } });
  await h.send({ jsonrpc: "2.0", method: "tools/call", params: { name: "bc_panel_inbox" } });
  assert.deepEqual(h.lines, []);
  assert.deepEqual(b.seen, []);
});

test("panelThreads: only the fields the panel draws; rows without an id are dropped", () => {
  assert.deepEqual(panelThreads([ROW, null, { role: "host" }, { id: "s2", role: "visitor", peer_handle: "x@bc", unread_count: 0, live: true, frames: ["secret"] }]), [
    { session_id: "s1", role: "host", peer_handle: "peer@bc", unread_count: 2 },
    { session_id: "s2", role: "visitor", peer_handle: "x@bc", unread_count: 0, live: true },
  ]);
  assert.deepEqual(panelThreads(undefined), []);
});

test("not connected: the panel opens on its connect form, and an unknown method is refused as unsupported", async () => {
  const b = broker();
  const h = harness({ token: "", fetchImpl: b.fetchImpl });
  const open = (await h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bc_open_panel" } })).result;
  assert.deepEqual(open.structuredContent, { connected: false });
  assert.equal(open._meta.ui.resourceUri, PANEL_URI);
  assert.match(open.content[0].text, /bc_connect/);
  const refresh = (await h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "bc_panel_inbox" } })).result;
  assert.deepEqual(refresh.structuredContent, { connected: false });
  const unknown = await h.send({ jsonrpc: "2.0", id: 3, method: "prompts/list" });
  assert.equal(unknown.error.code, -32601);
  assert.deepEqual(b.seen, []);
});

test("inboxAsText: counts and handles only, bounded", () => {
  assert.equal(inboxAsText({ sessions: [] }), "Back Channel is connected. There are no open threads.");
  assert.equal(inboxAsText(null), "Back Channel is connected. There are no open threads.");
  const many = Array.from({ length: 30 }, (_, i) => ({ peer_handle: `p${i}@bc`, unread_count: 1, pending_invite_message: "do not echo me" }));
  const text = inboxAsText({ sessions: many });
  assert.match(text, /^Back Channel: 30 open threads, 30 unread\./);
  assert.equal(text.split("\n").length, 21);
  assert.doesNotMatch(text, /do not echo me/, "a peer's invite note is not relayed into the tool text");
});

test("panel.html: one self-contained document that fetches nothing and never renders peer text as HTML", () => {
  const html = readFileSync(here("./panel.html"), "utf8");
  for (const [pattern, why] of [
    [/\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/, "peer text must go in as text"],
    [/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/, "the panel has no network; everything goes through tools/call"],
    [/<script[^>]+src=|<link\b|<img\b|<iframe\b|@import|url\(/i, "no external or embedded resources"],
    [/\beval\s*\(|new Function\b/, "no dynamic code"],
    [/localStorage|sessionStorage|document\.cookie|indexedDB/, "nothing is kept in the host's webview"],
  ]) assert.doesNotMatch(html, pattern, why);
  assert.match(html, /"ui\/initialize"/);
  assert.match(html, /"ui\/notifications\/initialized"/);
  assert.match(html, /event\.source !== window\.parent/, "only the host may speak to the panel");
  assert.match(html, /mark_read: false/, "a person looking at a thread does not ack it for the agent");
  assert.doesNotMatch(html, /["']bc_check_inbox["']/, "the panel never calls the tool that delivers and acks the agent's queued mail");
  // The panel hides a frame only when it is exactly what the bridge writes for one it could not open.
  const reasons = [...readFileSync(here("./e2e.js"), "utf8").matchAll(/type: "enc_undecryptable", reason: "([^"]+)"/g)].map((m) => m[1]);
  assert.equal(reasons.length, 2);
  for (const reason of reasons) assert.ok(html.includes(JSON.stringify(reason)), `panel.html must know the bridge's marker: ${reason}`);
  const version = JSON.parse(readFileSync(here("../package.json"), "utf8")).version;
  assert.ok(html.includes(`version: "${version}"`), "the panel reports the connector's version; bump it with the rest");
});

test("the .mcpb pack list carries the panel document, which no import statement would reveal", () => {
  const packer = readFileSync(here("../../scripts/pack-mcpb.mjs"), "utf8");
  const files = JSON.parse(/const FILES = (\[[^\]]+\]);/.exec(packer)[1]);
  assert.ok(files.includes("server/panel.html") && files.includes("server/panel.js"));
  const packed = readFileSync(here("../../public/back-channel.mcpb"));
  assert.ok(packed.includes("server/panel.html") && packed.includes("server/panel.js"), "the committed extension was packed before the panel was added; run npm run pack:mcpb");
});
