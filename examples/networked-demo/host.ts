/**
 * Networked demo — HOST side.
 *
 * Runs in its own Node process, listens for a visitor on port 7878.
 *
 * Run:
 *   npm run demo:net:host
 *
 * Then in another terminal:
 *   npm run demo:net:visitor
 */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import {
  ConsoleTranscript,
  HostAgent,
  createWebSocketHostTransport,
  newSessionId,
  type RegisteredCapability,
  type SessionInvite,
} from "../../src/index.js";

const PORT = 7878;

// ---------------------------------------------------------------------------
// Fake host state
// ---------------------------------------------------------------------------
const fakeConfigFile = {
  name: "home-assistant.yaml",
  contents: [
    "homeassistant:",
    "  name: Home",
    "  latitude: <REDACTED>",
    "automation: !include automations.yaml",
    "logger:",
    "  default: warning",
  ].join("\n"),
};

const proposedChanges: Array<{ at: string; description: string; diff: string }> = [];

const capabilities: RegisteredCapability[] = [
  {
    name: "config.list-files",
    description: "List config files on the host.",
    scope: "config.read",
    requiresApproval: false,
    async handler() {
      return [fakeConfigFile.name];
    },
  },
  {
    name: "config.read-file",
    description: "Read a config file (secrets redacted).",
    scope: "config.read",
    requiresApproval: false,
    args: [{ name: "filename", type: "string", required: true, description: "Target file" }],
    async handler(args) {
      const f = String(args.filename);
      if (f !== fakeConfigFile.name) throw new Error(`File not found: ${f}`);
      return { filename: f, contents: fakeConfigFile.contents };
    },
  },
  {
    name: "config.suggest-change",
    description: "Propose a change. Host human approves.",
    scope: "config.suggest",
    requiresApproval: true,
    args: [
      { name: "filename", type: "string", required: true, description: "Target file" },
      { name: "description", type: "string", required: true, description: "Why" },
      { name: "diff", type: "string", required: true, description: "Unified diff" },
    ],
    async handler(args) {
      proposedChanges.push({
        at: new Date().toISOString(),
        description: String(args.description),
        diff: String(args.diff),
      });
      return { accepted: true, changeId: `chg_${proposedChanges.length}` };
    },
  },
];

// ---------------------------------------------------------------------------
// Real CLI approval prompt
// ---------------------------------------------------------------------------
const rl = createInterface({ input, output });

async function approve(req: {
  capability: string;
  description: string;
  args: Readonly<Record<string, unknown>>;
}): Promise<boolean> {
  console.log("\n────────────────────────────────────────────");
  console.log("APPROVAL PROMPT — VISITOR WANTS TO:");
  console.log("  Capability:  " + req.capability);
  console.log("  Description: " + req.description);
  console.log("  Args:        " + JSON.stringify(req.args));
  const answer = (await rl.question("Approve? (y/n) ")).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Back Channel — Host (networked)");
  console.log("═══════════════════════════════════════════════════════");
  console.log("Listening on ws://localhost:" + PORT);
  console.log("Run the visitor in another terminal:  npm run demo:net:visitor");
  console.log("");

  // For the demo, host and visitor agree on the invite out-of-band.
  // The visitor side hardcodes the same values.
  const invite: SessionInvite = {
    sessionId: "demo-session-shared",
    hostId: "steve@example",
    visitorId: "skylar@example",
    scopes: ["config.read", "config.suggest"],
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    message: "Skylar's agent is checking the HA config",
  };

  const transport = await createWebSocketHostTransport(PORT);
  console.log("Visitor connected. Handshake complete (ECDH).\n");

  const transcript = new ConsoleTranscript("HOST   ");
  const host = new HostAgent({
    hostId: invite.hostId,
    transport,
    capabilities,
    approve,
    transcript,
  });
  await host.accept(invite);

  // Stay alive until the visitor ends the session.
  // The transport's close handler will fire when the WS drops.
  process.on("SIGINT", async () => {
    await transport.close();
    rl.close();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error("Host failed:", e);
  process.exit(1);
});
