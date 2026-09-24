import { NextRequest } from "next/server";
import { releaseLease } from "@/lib/appbridge";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = (req: NextRequest) => releaseLease(req);
