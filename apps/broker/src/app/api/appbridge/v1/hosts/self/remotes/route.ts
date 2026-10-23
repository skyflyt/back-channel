import { NextRequest } from "next/server";
import { listRemotesForHost } from "@/lib/appbridge";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (req: NextRequest) => listRemotesForHost(req);
