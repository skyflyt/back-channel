import { NextRequest } from "next/server";
import { mintDeviceCode } from "@/lib/appbridge";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = (req: NextRequest) => mintDeviceCode(req);
