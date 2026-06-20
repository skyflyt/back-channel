import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const runtime = "nodejs";

// Set once per process start ≈ when this Cloud Run revision began serving.
const STARTED_AT = new Date().toISOString();
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * GET /api/version — public deploy/version probe. `build_id` is the Cloud Run
 * revision name (K_REVISION), which changes on EVERY deploy — so the pipeline
 * pusher can detect any deploy, not just skill-bumping ones (closes the monitor
 * blind spot). Also surfaces the skill revision/version for convenience.
 */
export async function GET() {
  let skill_revision: string | null = null;
  let version: string | null = null;
  const candidates = [
    join(process.cwd(), "..", "..", "skill", "SKILL.md"),
    join(process.cwd(), "skill", "SKILL.md"),
    join(__dirname, "..", "..", "..", "..", "..", "..", "skill", "SKILL.md"),
  ];
  for (const path of candidates) {
    try {
      const c = await readFile(path, "utf8");
      skill_revision = c.match(/^revision:\s*(.+)$/m)?.[1]?.trim() ?? null;
      version = c.match(/^version:\s*(.+)$/m)?.[1]?.trim() ?? null;
      break;
    } catch { /* try next */ }
  }
  return NextResponse.json(
    {
      service: process.env.K_SERVICE ?? null,
      build_id: process.env.K_REVISION ?? null, // Cloud Run revision — changes every deploy
      skill_revision,
      version,
      started_at: STARTED_AT,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
