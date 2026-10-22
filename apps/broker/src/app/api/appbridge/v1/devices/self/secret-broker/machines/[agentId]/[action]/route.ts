import { NextRequest } from "next/server";
import { deviceMachine } from "@/lib/secrets-device";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = async (req: NextRequest, { params }: { params: Promise<{ agentId: string; action: string }> }) => {
  const { agentId, action } = await params;
  return deviceMachine(req, agentId, action);
};
