import { NextRequest } from "next/server";
import { machineRoute } from "@/lib/secrets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/secret-broker/machines/:agentId/{install,update,enrol,lockdown}: ask that PC's worker (src/lib/secrets.ts).
export const POST = async (req: NextRequest, { params }: { params: Promise<{ agentId: string; action: string }> }) => {
  const p = await params;
  return machineRoute(req, p.agentId, p.action);
};
