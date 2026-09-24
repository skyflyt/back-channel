import { NextRequest } from "next/server";
import { redeemPass } from "@/lib/appbridge";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = (req: NextRequest) => redeemPass(req);
