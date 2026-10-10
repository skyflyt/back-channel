import { NextRequest } from "next/server";
import { hostAgentSessions } from "@/lib/remote-app-host";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (req: NextRequest) => hostAgentSessions(req);
