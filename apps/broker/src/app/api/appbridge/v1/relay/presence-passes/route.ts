import { NextRequest } from "next/server";
import { issuePresencePass } from "@/lib/appbridge";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = (req: NextRequest) => issuePresencePass(req);
