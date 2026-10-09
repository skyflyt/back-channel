import { NextRequest } from "next/server";
import { supportRoute } from "@/lib/remote-support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Every /api/support/... endpoint (docs/remote-support.md), mapped onto one operation set in
// src/lib/remote-support.ts (the same operations the bc_support_* MCP tools use). See supportRoute for the map.
type Context = { params: Promise<{ path?: string[] }> };
const handle = async (req: NextRequest, context: Context) => supportRoute(req, (await context.params).path ?? []);

export const GET = handle;
export const POST = handle;
