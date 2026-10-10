import { NextRequest } from "next/server";
import { putReadiness } from "@/lib/agent-readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PUT /api/agents/self/readiness: the Back Channel worker's readiness report (src/lib/agent-readiness.ts).
export const PUT = (req: NextRequest) => putReadiness(req);
