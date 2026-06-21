import { NextResponse } from "next/server";
import { SCOPE_CATALOG, BLOCKED_SCOPES } from "@/lib/scopes";

export const runtime = "nodejs";

/**
 * GET /api/scopes — the canonical, machine-readable scope catalog (M2). Public;
 * no auth. Lists exactly the scope strings an invite may request, what each
 * grants, and the hard-blocked set that's never allowed regardless of host
 * preference.
 */
export function GET() {
  return NextResponse.json(
    {
      scopes: SCOPE_CATALOG,
      hard_blocked: BLOCKED_SCOPES,
      note: "Request the least privilege that fits the task. *.apply (auto-apply) needs explicit user trust. Hard-blocked scopes (memory/email/messages/contacts/calendar/files .read) are refused for everyone.",
    },
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
}
