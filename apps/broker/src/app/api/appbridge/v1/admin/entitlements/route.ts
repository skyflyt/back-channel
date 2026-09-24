import { NextRequest } from "next/server";
import { setEntitlement } from "@/lib/appbridge";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const PUT = (req: NextRequest) => setEntitlement(req);
