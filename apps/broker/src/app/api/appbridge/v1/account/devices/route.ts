import { NextRequest } from "next/server";
import { listDevices } from "@/lib/appbridge";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (req: NextRequest) => listDevices(req);
