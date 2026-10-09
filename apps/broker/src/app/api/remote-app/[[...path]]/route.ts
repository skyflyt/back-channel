import { NextRequest } from "next/server";
import { remoteAppRoute } from "@/lib/remote-app";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Every /api/remote-app/... endpoint, mapped onto one operation set in src/lib/remote-app.ts
// (the same operations the bc_remote_* MCP tools use). See remoteAppRoute for the map.
type Context = { params: Promise<{ path?: string[] }> };
const handle = async (req: NextRequest, context: Context) => remoteAppRoute(req, (await context.params).path ?? []);

export const GET = handle;
export const POST = handle;
