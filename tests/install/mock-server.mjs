// Mock Back Channel broker for install-CLI tests. Zero deps (Node stdlib).
// Behavior is driven by env vars so a test harness can script scenarios:
//
//   BC_MOCK_PORT          port to listen on (default 0 = ephemeral; prints chosen port)
//   BC_MOCK_SKILL_STATUS  HTTP status for GET /skill           (default 200)
//   BC_MOCK_SKILL_BODY    'valid' | 'errorpage' | 'empty'      (default valid)
//   BC_MOCK_REF_STATUS    HTTP status for GET /skill/reference (default 200)
//   BC_MOCK_REVISION      revision string served everywhere    (default 2026-06-25-4)
//   BC_MOCK_VERSION       version string                       (default 0.5.14)
//   BC_MOCK_EXCHANGE      'ok' | '410' | '429' | '500'         (default ok)
//   BC_MOCK_API_KEY       api_key returned on exchange ok      (default bc_TESTKEY...)
//   BC_MOCK_AGENT_NAME    agent_name returned on exchange ok   (default "Test agent")
//
// On start it prints `LISTENING <port>` to stdout so callers can capture the port.

import { createServer } from "node:http";

const env = process.env;
const REVISION = env.BC_MOCK_REVISION || "2026-06-25-4";
const VERSION = env.BC_MOCK_VERSION || "0.5.14";
const API_KEY = env.BC_MOCK_API_KEY || "bc_TESTKEYabcdefghijklmnopqrstuvwxyz012345";
const AGENT_NAME = env.BC_MOCK_AGENT_NAME ?? "Test agent";

const SKILL_VALID = `---
name: back-channel
description: test skill fixture
version: ${VERSION}
revision: ${REVISION}
license: MIT
---

# Back Channel — Skill (test fixture)
Body content here.
`;

const SKILL_ERRORPAGE = `# Back Channel Skill

Not bundled. See https://github.com/skyflyt/back-channel/blob/main/skill/SKILL.md
`;

const REFERENCE_VALID = `# Back Channel Reference (test fixture)

Full API reference body.
`;

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

const server = createServer(async (req, res) => {
  const url = req.url || "/";
  const send = (status, body, type = "text/markdown; charset=utf-8") => {
    res.writeHead(status, { "Content-Type": type });
    res.end(body);
  };

  if (req.method === "GET" && url === "/skill") {
    const status = Number(env.BC_MOCK_SKILL_STATUS || 200);
    const kind = env.BC_MOCK_SKILL_BODY || "valid";
    if (status !== 200) return send(status, SKILL_ERRORPAGE);
    if (kind === "errorpage") return send(200, SKILL_ERRORPAGE);
    if (kind === "empty") return send(200, "");
    return send(200, SKILL_VALID);
  }

  if (req.method === "GET" && url === "/skill/reference") {
    const status = Number(env.BC_MOCK_REF_STATUS || 200);
    if (status !== 200) return send(status, "# Back Channel Reference\n\nNot bundled.");
    return send(200, REFERENCE_VALID);
  }

  if (req.method === "GET" && url.startsWith("/skill/revision")) {
    return send(
      200,
      JSON.stringify({ revision: REVISION, version: VERSION, changes: [] }),
      "application/json",
    );
  }

  if (req.method === "POST" && url === "/api/auth/exchange") {
    const raw = await readBody(req);
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch { return send(400, JSON.stringify({ error: "invalid_json" }), "application/json"); }
    const mode = env.BC_MOCK_EXCHANGE || "ok";
    if (mode === "410") return send(410, JSON.stringify({ error: "invalid_or_expired_code" }), "application/json");
    if (mode === "429") {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1800" });
      return res.end(JSON.stringify({ error: "rate_limited" }));
    }
    if (mode === "500") return send(500, JSON.stringify({ error: "server_error" }), "application/json");
    return send(
      200,
      JSON.stringify({ api_key: API_KEY, handle: "tester@bc", agent_id: "agt_test123", agent_name: AGENT_NAME, _echo_runtime: parsed.runtime_type }),
      "application/json",
    );
  }

  send(404, JSON.stringify({ error: "not_found" }), "application/json");
});

const port = Number(env.BC_MOCK_PORT || 0);
server.listen(port, "127.0.0.1", () => {
  const actual = server.address().port;
  process.stdout.write(`LISTENING ${actual}\n`);
});

// Graceful shutdown so the harness can stop us.
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));
