import { NextRequest } from "next/server";
import { issueAgentPass } from "@/lib/appbridge";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = (req: NextRequest) => issueAgentPass(req);
