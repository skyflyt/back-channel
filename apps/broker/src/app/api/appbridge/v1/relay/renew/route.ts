import { NextRequest } from "next/server";
import { renewLease } from "@/lib/appbridge";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = (req: NextRequest) => renewLease(req);
