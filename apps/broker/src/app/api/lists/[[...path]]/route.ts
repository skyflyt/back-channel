import { NextRequest } from "next/server";
import { listsRoute } from "@/lib/lists";

export const runtime = "nodejs";

// Every /api/lists/... endpoint, mapped onto one operation set in src/lib/lists.ts
// (the same operations the bc_task* MCP tools use). See listsRoute for the map.
type Context = { params: Promise<{ path?: string[] }> };
const handle = async (req: NextRequest, context: Context) => listsRoute(req, (await context.params).path ?? []);

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
