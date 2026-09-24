import { NextRequest } from "next/server";
import { adminJson, requireOwnerAdmin } from "@/lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/revoke — RETIRED, like /api/admin/grant. Admin is the
 * ADMIN_EMAILS allowlist (src/lib/admin.ts); to remove the owner, change that
 * env var. Owner-gated, then 410 with no reads or writes.
 */
export async function POST(req: NextRequest) {
  const gate = await requireOwnerAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  return adminJson({ error: "gone" }, 410);
}
