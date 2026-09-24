import { NextRequest } from "next/server";
import { billingStatus } from "@/lib/billing";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (req: NextRequest) => billingStatus(req);
