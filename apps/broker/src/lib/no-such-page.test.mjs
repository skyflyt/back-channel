import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { NO_SUCH_PAGE, hideRefusalMarkers } from "./no-such-page.mjs";

/** Serve one response written by `write(res)` through the real Node HTTP stack, and return what a client receives. */
async function served(write) {
  const server = createServer((_req, res) => write(hideRefusalMarkers(res)));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
    return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
  } finally {
    server.close();
  }
}
const MARKERS = ["x-middleware-rewrite", "x-nextjs-rewrite", "x-nextjs-rewritten-path", "x-nextjs-rewritten-query"];
const none = (h) => MARKERS.every((m) => !(m in h));

test("the refusal's rewrite markers never reach the client, however the headers were set", async () => {
  // setHeader, head sent implicitly by end() — how Next writes them.
  const implicit = await served((res) => {
    res.statusCode = 404;
    res.setHeader("x-middleware-rewrite", NO_SUCH_PAGE);
    res.setHeader("X-Nextjs-Rewritten-Path", NO_SUCH_PAGE);
    res.setHeader("x-nextjs-rewritten-query", "x=1");
    res.setHeader("x-kept", "yes");
    res.end("nope");
  });
  assert.ok(none(implicit.headers));
  assert.deepEqual([implicit.status, implicit.headers["x-kept"], implicit.body], [404, "yes", "nope"]);

  // A full URL rather than a path, as Next writes it for some requests.
  const absolute = await served((res) => { res.setHeader("x-middleware-rewrite", `https://back-channel.app${NO_SUCH_PAGE}`); res.end(); });
  assert.ok(none(absolute.headers));

  // Passed straight to writeHead: object, flat list, list of pairs, and with a status message.
  for (const headers of [
    { "X-Middleware-Rewrite": NO_SUCH_PAGE, "x-kept": "yes" },
    ["x-middleware-rewrite", NO_SUCH_PAGE, "x-kept", "yes"],
    [["x-nextjs-rewritten-path", NO_SUCH_PAGE], ["x-kept", "yes"]],
  ]) {
    const direct = await served((res) => { res.writeHead(404, headers); res.end(); });
    assert.ok(none(direct.headers), JSON.stringify(headers));
    assert.equal(direct.headers["x-kept"], "yes");
    const withMessage = await served((res) => { res.writeHead(404, "Not Found", headers); res.end(); });
    assert.ok(none(withMessage.headers));
  }

  // A data request: the path arrives wrapped, under a header of its own.
  for (const wrapped of [`/_next/data/BUILD123/_no-such-page.json`, `https://back-channel.app/_next/data/x/_no-such-page.json`]) {
    const data = await served((res) => { res.setHeader("x-middleware-rewrite", wrapped); res.setHeader("x-nextjs-rewrite", NO_SUCH_PAGE); res.end(); });
    assert.ok(none(data.headers), wrapped);
  }
  const dataOnly = await served((res) => { res.setHeader("x-nextjs-rewrite", NO_SUCH_PAGE); res.end(); });
  assert.ok(none(dataOnly.headers));

  // A marker set with setHeader, then a flat header list passed to writeHead: the list must stay flat.
  const flat = await served((res) => { res.setHeader("x-middleware-rewrite", NO_SUCH_PAGE); res.writeHead(404, ["x-kept", "yes", "x-nextjs-rewritten-path", NO_SUCH_PAGE, "x-also", "1"]); res.end(); });
  assert.ok(none(flat.headers));
  assert.deepEqual([flat.status, flat.headers["x-kept"], flat.headers["x-also"]], [404, "yes", "1"]);

  // One marker set each way.
  const mixed = await served((res) => { res.setHeader("x-nextjs-rewritten-path", NO_SUCH_PAGE); res.writeHead(404, { "x-middleware-rewrite": NO_SUCH_PAGE }); res.end(); });
  assert.ok(none(mixed.headers));
});

test("any other rewrite, and any other response, is left exactly as it was", async () => {
  const other = await served((res) => { res.setHeader("x-middleware-rewrite", "/somewhere-real"); res.setHeader("x-nextjs-rewritten-path", "/somewhere-real"); res.end("ok"); });
  assert.equal(other.headers["x-middleware-rewrite"], "/somewhere-real");
  assert.equal(other.headers["x-nextjs-rewritten-path"], "/somewhere-real");

  for (const lookalike of [`${NO_SUCH_PAGE}-not`, `/docs${NO_SUCH_PAGE}`, `/_next/data/x/y${NO_SUCH_PAGE}.json`]) {
    const r = await served((res) => { res.writeHead(200, { "x-middleware-rewrite": lookalike, "content-type": "text/plain" }); res.end("ok"); });
    assert.equal(r.headers["x-middleware-rewrite"], lookalike);
  }

  const plain = await served((res) => { res.writeHead(201, "Created", { "content-type": "application/json" }); res.end("{}"); });
  assert.deepEqual([plain.status, plain.headers["content-type"], plain.body], [201, "application/json", "{}"]);
  const bare = await served((res) => { res.writeHead(204); res.end(); });
  assert.equal(bare.status, 204);
});
