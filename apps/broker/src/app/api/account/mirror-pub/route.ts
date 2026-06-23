import { NextRequest, NextResponse } from "next/server";
import { getAccountFromAuth } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * GET /api/account/mirror-pub — bearer (agent). Returns the caller's own user's
 * mirror public key + version so the agent can HPKE-wrap the session content key
 * for the human (docs/user-side-decryption.md §7.1/§8). Agents ETag-cache this and
 * revalidate; a 409 on user-wrap means rotation happened → refetch (B4).
 *
 * Returns { mirror_pub: null } when the user hasn't enrolled browser access — the
 * agent simply skips wrapping (I4), but should keep re-checking on later sends (S5).
 */
export async function GET(req: NextRequest) {
  const account = await getAccountFromAuth(req.headers.get("authorization"));
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const version = account.mirrorPubVersion ?? 0;
  const etag = `"mp-${account.id}-${version}"`;
  // Only honor a conditional request once a pub actually exists (so an agent that
  // cached "null" still re-checks after enrollment).
  if (account.mirrorPub && req.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag } });
  }
  return NextResponse.json(
    { mirror_pub: account.mirrorPub ?? null, version },
    { headers: { ETag: etag, "Cache-Control": "private, max-age=300" } },
  );
}
