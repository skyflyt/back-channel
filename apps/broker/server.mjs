/**
 * Back Channel — custom Next.js server with WebSocket upgrade handling.
 *
 * Why a custom server: Next.js doesn't natively expose the raw HTTP server
 * for WebSocket upgrade handling. We need that for the /relay/:sessionId
 * endpoint which pairs visitor + host connections per session and relays
 * encrypted frames between them.
 *
 * Cloud Run notes:
 *   - PORT is provided by the runtime (defaults 8080).
 *   - WebSocket upgrade requests on Cloud Run hit /relay/* and are forwarded
 *     to this server normally — no special config needed beyond enabling
 *     `--session-affinity` if we move past single-instance.
 */

import { createServer } from "node:http";
import { parse } from "node:url";
import next from "next";
import { handleRelayUpgrade } from "./src/lib/relay.mjs";

const dev = process.env.NODE_ENV !== "production";
const port = parseInt(process.env.PORT ?? "8080", 10);
const hostname = "0.0.0.0";

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

await app.prepare();

const server = createServer(async (req, res) => {
  try {
    const parsedUrl = parse(req.url ?? "/", true);
    await handle(req, res, parsedUrl);
  } catch (err) {
    console.error("Request error:", err);
    res.statusCode = 500;
    res.end("internal error");
  }
});

// Handle WebSocket upgrade requests
server.on("upgrade", (req, socket, head) => {
  const { pathname } = parse(req.url ?? "/", true);
  if (pathname?.startsWith("/relay/")) {
    handleRelayUpgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});

server.listen(port, hostname, () => {
  console.log(`Back Channel broker ready on http://${hostname}:${port}`);
});

