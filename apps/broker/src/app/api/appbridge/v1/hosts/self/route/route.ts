import { NextRequest } from "next/server";
import { publishRoute } from "@/lib/appbridge";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const PUT = (req: NextRequest) => publishRoute(req);
