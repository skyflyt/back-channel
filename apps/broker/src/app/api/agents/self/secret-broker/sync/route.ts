import { NextRequest } from "next/server";
import { workerSyncRoute } from "@/lib/secrets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/agents/self/secret-broker/sync: the worker's secret broker status, requests out, decisions and jobs back (src/lib/secrets.ts).
export const POST = (req: NextRequest) => workerSyncRoute(req);
