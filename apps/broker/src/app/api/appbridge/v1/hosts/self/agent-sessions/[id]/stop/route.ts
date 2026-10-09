import { NextRequest } from "next/server";
import { hostStopAgentSession } from "@/lib/remote-app-host";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return hostStopAgentSession(req, (await context.params).id);
}
