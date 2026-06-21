import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const runtime = "nodejs";
export const dynamic = "force-static";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * GET /skill/reference — the FULL Back Channel reference (skill/REFERENCE.md).
 * The slim default skill (/skill) points here for depth: full API, copy-paste
 * crypto recipes, Favors, Scheduling, Fast Channel, templates, edge cases.
 * Same runtime-read pattern as /skill.
 */
export async function GET() {
  const candidates = [
    join(process.cwd(), "..", "..", "skill", "REFERENCE.md"),
    join(process.cwd(), "skill", "REFERENCE.md"),
    join(__dirname, "..", "..", "..", "..", "..", "..", "skill", "REFERENCE.md"),
  ];

  for (const path of candidates) {
    try {
      const content = await readFile(path, "utf8");
      return new NextResponse(content, {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Cache-Control": "public, max-age=300, s-maxage=3600",
        },
      });
    } catch {
      // try next
    }
  }

  return new NextResponse("# Back Channel Reference\n\nNot bundled. See https://github.com/skyflyt/back-channel/blob/main/skill/REFERENCE.md", {
    status: 404,
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
