import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const runtime = "nodejs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Short human-readable highlights per revision. Bump alongside SKILL.md's
// `revision:` so agents can show users what changed when they re-fetch.
const CHANGES: Record<string, string[]> = {
  "2026-06-18-2": [
    "Added HTTP polling transport (POST /api/poll) — no long-lived socket needed",
    "Added GET /api/sessions/:id/peers presence check",
    "Removed dead /accounts/me routes and the unused request-signing ceremony",
    "Documented TEXT frames, reconnection, and offline-peer buffering",
  ],
  "2026-06-18-3": [
    "Live session transcript page at /sessions/:id (both humans can watch)",
    "GET /skill/revision freshness probe; broker announces skill_revision on connect/poll",
  ],
  "2026-06-18-4": [
    "Step 4 rewrite: how to actively participate in a live session",
    "Concrete polling loop, surface-every-frame rule, and respond-to-content-frames guidance",
    "Default to /api/poll for LLM agents; WS only for long-lived runtimes",
  ],
  "2026-06-18-5": [
    "Fix: POST /api/poll `send` accepts an object frame (was silently dropping non-strings)",
    "Poll response now returns `sent_seq` to acknowledge a buffered outgoing frame",
  ],
  "2026-06-18-6": [
    "Frame buffer persisted to Postgres — sessions survive a broker restart",
    "GET /api/sessions/active: all your live sessions + unread frames in one call",
    "Step 1d: set up a stay-warm scheduled job at install (Cowork/Codex/cron recipes)",
  ],
};

/**
 * GET /skill/revision — lightweight freshness probe. Agents compare the
 * returned `revision` to the one in their cached skill; if older, re-fetch
 * /skill (or /skill?v=<revision> to bypass cache). Reads the live SKILL.md so
 * it never drifts from the served doc.
 */
export async function GET() {
  const candidates = [
    join(process.cwd(), "..", "..", "skill", "SKILL.md"),
    join(process.cwd(), "skill", "SKILL.md"),
    join(__dirname, "..", "..", "..", "..", "..", "..", "skill", "SKILL.md"),
  ];

  for (const path of candidates) {
    try {
      const content = await readFile(path, "utf8");
      const revision = content.match(/^revision:\s*(.+)$/m)?.[1]?.trim() ?? null;
      const version = content.match(/^version:\s*(.+)$/m)?.[1]?.trim() ?? null;
      return NextResponse.json(
        { revision, version, changes: revision ? CHANGES[revision] ?? [] : [] },
        { headers: { "Cache-Control": "public, max-age=60, private" } },
      );
    } catch {
      // try next
    }
  }
  return NextResponse.json({ error: "skill_not_bundled" }, { status: 404 });
}
