/**
 * Back Channel — Localhost demo.
 *
 * Runs a Visitor and Host in the same process, talking through an in-memory
 * transport. The visitor:
 *   1. Discovers what capabilities are available under its granted scope
 *   2. Reads a fake config file via `config.read-file`
 *   3. Proposes a change via `config.suggest-change` (host human approves)
 *   4. Tries to invoke a capability outside its scope (should be denied)
 *   5. Ends the session
 *
 * Run with:  npm run demo
 */

import {
  ConsoleTranscript,
  HostAgent,
  VisitorAgent,
  createInMemoryTransportPair,
  newSessionId,
  type RegisteredCapability,
  type SessionInvite,
} from "../../src/index.js";

const fakeConfigFile = {
  name: "home-assistant.yaml",
  contents: [
    "# Home Assistant config (excerpt)",
    "homeassistant:",
    "  name: Home",
    "  latitude: <REDACTED>",
    "  longitude: <REDACTED>",
    "automation: !include automations.yaml",
    "logger:",
    "  default: warning",
  ].join("\n"),
};

const proposedChanges: Array<{ at: string; description: string; diff: string }> = [];

const capabilities: RegisteredCapability[] = [
  {
    name: "config.list-files",
    description: "List the names of available config files on the host system.",
    scope: "config.read",
    requiresApproval: false,
    async handler() {
      return [fakeConfigFile.name];
    },
  },
  {
    name: "config.read-file",
    description: "Read a single config file (secrets redacted before return).",
    scope: "config.read",
    requiresApproval: false,
    args: [
      { name: "filename", type: "string", required: true, description: "Name of the file to read" },
    ],
    async handler(args) {
      const filename = String(args.filename);
      if (filename !== fakeConfigFile.name) {
        throw new Error(`File not found: ${filename}`);
      }
      return { filename, contents: fakeConfigFile.contents };
    },
  },
  {
    name: "config.suggest-change",
    description: "Propose a change to a config file. Host human reviews + approves.",
    scope: "config.suggest",
    requiresApproval: true,
    args: [
      { name: "filename", type: "string", required: true, description: "Target file" },
      { name: "description", type: "string", required: true, description: "Why this change" },
      { name: "diff", type: "string", required: true, description: "Unified diff format" },
    ],
    async handler(args) {
      const change = {
        at: new Date().toISOString(),
        description: String(args.description),
        diff: String(args.diff),
      };
      proposedChanges.push(change);
      return { accepted: true, changeId: `chg_${proposedChanges.length}` };
    },
  },
];

async function autoApprove(req: {
  capability: string;
  description: string;
  args: Readonly<Record<string, unknown>>;
}): Promise<boolean> {
  console.log("");
  console.log("👤 APPROVAL PROMPT (auto-approving for demo)");
  console.log(`   Capability: ${req.capability}`);
  console.log(`   Description: ${req.description}`);
  console.log(`   Args: ${JSON.stringify(req.args)}`);
  console.log("   → APPROVED");
  console.log("");
  return true;
}

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Back Channel — Localhost Demo");
  console.log("═══════════════════════════════════════════════════════\n");

  const invite: SessionInvite = {
    sessionId: newSessionId(),
    hostId: "steve@example",
    visitorId: "skylar@example",
    scopes: ["config.read", "config.suggest"],
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    message: "Hey Skylar, can you take a look at why my HA config isn't loading?",
  };

  const transports = createInMemoryTransportPair();

  const hostTranscript = new ConsoleTranscript("HOST   ");
  const host = new HostAgent({
    hostId: invite.hostId,
    transport: transports.host,
    capabilities,
    approve: autoApprove,
    transcript: hostTranscript,
  });
  await host.accept(invite);

  const visitorTranscript = new ConsoleTranscript("VISITOR");
  const visitor = new VisitorAgent({
    visitorId: invite.visitorId,
    transport: transports.visitor,
    transcript: visitorTranscript,
  });
  await visitor.openSession(invite);

  console.log("\n── Step 1: Capability discovery ─────────────────────");
  const caps = await visitor.discoverCapabilities();
  console.log(`\nVisitor sees ${caps.length} capabilities under granted scopes:`);
  for (const c of caps) {
    console.log(`  • ${c.name}  (${c.scope}${c.requiresApproval ? ", needs approval" : ""})`);
    console.log(`      ${c.description}`);
  }

  console.log("\n── Step 2: Read a config file ───────────────────────");
  const file = await visitor.invoke<{ filename: string; contents: string }>(
    "config.read-file",
    { filename: "home-assistant.yaml" },
  );
  console.log(`\nGot ${file.filename}:`);
  console.log(file.contents.split("\n").map((l) => "  | " + l).join("\n"));

  console.log("\n── Step 3: Propose a change ─────────────────────────");
  const result = await visitor.invoke<{ accepted: boolean; changeId: string }>(
    "config.suggest-change",
    {
      filename: "home-assistant.yaml",
      description: "Bump default log level from warning to info for easier debugging.",
      diff: "-  default: warning\n+  default: info",
    },
  );
  console.log(`\nHost accepted the change: ${result.changeId}`);

  console.log("\n── Step 4: Try an out-of-scope capability ──────────");
  try {
    await visitor.invoke("automation.delete-all", { confirm: true });
    console.log("UNEXPECTED: capability was allowed.");
  } catch (e) {
    console.log(`\nDenied as expected: ${(e as Error).message}`);
  }

  console.log("\n── Step 5: End session ──────────────────────────────");
  await visitor.endSession("natural");

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  Demo complete.");
  console.log("  Host transcript entries:    " + hostTranscript.list().length);
  console.log("  Visitor transcript entries: " + visitorTranscript.list().length);
  console.log("  Pending change proposals:   " + proposedChanges.length);
  console.log("═══════════════════════════════════════════════════════");
}

main().catch((e) => {
  console.error("Demo failed:", e);
  process.exit(1);
});
