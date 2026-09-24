import { NextRequest } from "next/server";
import { adminJson, requireOwnerAdmin } from "@/lib/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/grant — RETIRED. Admin is no longer a grantable role: it is
 * the ADMIN_EMAILS allowlist, checked on every request by src/lib/admin.ts.
 * Account.admin is kept for schema compatibility and grants nothing.
 *
 * The route stays so old clients get a clear answer, behind the same owner gate
 * as every admin route (401 signed out, 403 anyone else), and then answers
 * 410 without reading the body or writing anything. It cannot widen access.
 */
export async function POST(req: NextRequest) {
  const gate = await requireOwnerAdmin(req, { mutate: true });
  if (!gate.ok) return gate.response;
  return adminJson({ error: "gone" }, 410);
}
