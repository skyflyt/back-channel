import { NextRequest } from "next/server";
import { passkeysRoute } from "@/lib/passkeys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Every /api/account/passkeys/... endpoint (the passkeys behind the approval step-up). See passkeysRoute for the map.
type Context = { params: Promise<{ path?: string[] }> };
const handle = async (req: NextRequest, context: Context) => passkeysRoute(req, (await context.params).path ?? []);

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
