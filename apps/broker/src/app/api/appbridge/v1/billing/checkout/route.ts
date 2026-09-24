import { NextRequest } from "next/server";
import { createCheckout } from "@/lib/billing";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = (req: NextRequest) => createCheckout(req);
