import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const runtime = "nodejs";
export const dynamic = "force-static";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function GET() {
  // Skill lives at repo-root/skill/SKILL.md — relative to the broker app dir is ../../skill/SKILL.md
  // After `next build`, the file gets bundled via the public-asset path. We use a runtime read.
  const candidates = [
    join(process.cwd(), "..", "..", "skill", "SKILL.md"),
    join(process.cwd(), "skill", "SKILL.md"),
    join(__dirname, "..", "..", "..", "..", "..", "skill", "SKILL.md"),
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

  return new NextResponse("# Back Channel Skill\n\nNot bundled. See https://github.com/skyflyt/back-channel/blob/main/skill/SKILL.md", {
    status: 404,
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
