/**
 * Networked demo — VISITOR side.
 *
 * Connects to a host running on ws://localhost:7878.
 *
 * Run:
 *   npm run demo:net:visitor
 *
 * (Make sure the host is running first:  npm run demo:net:host)
 */

import {
  ConsoleTranscript,
  VisitorAgent,
  createWebSocketVisitorTransport,
  type SessionInvite,
} from "../../src/index.js";

const HOST_URL = "ws://localhost:7878";

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Back Channel — Visitor (networked)");
  console.log("═══════════════════════════════════════════════════════");
  console.log("Connecting to " + HOST_URL + " ...");

  const invite: SessionInvite = {
    sessionId: "demo-session-shared",
    hostId: "steve@example",
    visitorId: "skylar@example",
    scopes: ["config.read", "config.suggest"],
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    message: "Skylar's agent is checking the HA config",
  };

  const transport = await createWebSocketVisitorTransport(HOST_URL);
  console.log("Connected. Handshake complete (ECDH).\n");

  const transcript = new ConsoleTranscript("VISITOR");
  const visitor = new VisitorAgent({
    visitorId: invite.visitorId,
    transport,
    transcript,
  });
  await visitor.openSession(invite);

  console.log("\n── Step 1: Capability discovery ─────────────────────");
  const caps = await visitor.discoverCapabilities();
  console.log(`\nGot ${caps.length} capabilities:`);
  for (const c of caps) {
    console.log(`  • ${c.name} (${c.scope}${c.requiresApproval ? ", needs approval" : ""})`);
    console.log(`      ${c.description}`);
  }

  console.log("\n── Step 2: Read config file ─────────────────────────");
  const file = await visitor.invoke<{ filename: string; contents: string }>(
    "config.read-file",
    { filename: "home-assistant.yaml" },
  );
  console.log(`\nGot ${file.filename}:`);
  console.log(file.contents.split("\n").map((l) => "  | " + l).join("\n"));

  console.log("\n── Step 3: Propose a change (host will be prompted) ──");
  console.log("Sending change proposal... host needs to approve in their terminal.");
  try {
    const result = await visitor.invoke<{ accepted: boolean; changeId: string }>(
      "config.suggest-change",
      {
        filename: "home-assistant.yaml",
        description: "Bump log level from warning to info.",
        diff: "-  default: warning\n+  default: info",
      },
    );
    console.log(`\nApproved! changeId=${result.changeId}`);
  } catch (e) {
    console.log(`\nHost rejected: ${(e as Error).message}`);
  }

  console.log("\n── Step 4: End session ──────────────────────────────");
  await visitor.endSession("natural");

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  Visitor demo complete. The host will exit when you Ctrl-C it.");
  console.log("═══════════════════════════════════════════════════════");

  // Give the network a moment to flush
  await new Promise((r) => setTimeout(r, 200));
  await transport.close();
  process.exit(0);
}

main().catch((e) => {
  console.error("Visitor failed:", e);
  process.exit(1);
});
