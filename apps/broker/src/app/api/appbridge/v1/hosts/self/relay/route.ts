import { NextRequest } from "next/server";
import { setRelay } from "@/lib/appbridge";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const PUT = (req: NextRequest) => setRelay(req);
