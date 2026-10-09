import { NextRequest, NextResponse } from "next/server";
import { DIGEST_SECRET_HEADER, digestSecretValid, runListsDigest } from "@/lib/lists-digest";

export const runtime = "nodejs";
// A run is bounded (src/lib/lists-digest.ts DIGEST_LIMITS); this is headroom, not a target.
export const maxDuration = 300;

/**
 * POST /api/lists/digest/run: send the Lists daily digests that are due now
 * (docs/lists.md, "Daily digest"). Cloud Scheduler calls it every hour.
 *
 * Authorized ONLY by the shared secret in `x-lists-digest-secret`, compared in
 * constant time against LISTS_DIGEST_SECRET. No cookie, no agent key. While
 * the secret is unset (or shorter than 32 characters) every call is refused,
 * with the same answer as a wrong secret. The response carries counts only.
 */
export async function POST(req: NextRequest) {
  if (!digestSecretValid(req.headers.get(DIGEST_SECRET_HEADER))) {
    if (!process.env.LISTS_DIGEST_SECRET) console.warn("[lists-digest] LISTS_DIGEST_SECRET is not set; refusing the run.");
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const run = await runListsDigest();
    return NextResponse.json(run, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[lists-digest] run failed:", e instanceof Error ? e.name : typeof e);
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
