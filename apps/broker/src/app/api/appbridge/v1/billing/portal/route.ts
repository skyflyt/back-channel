import { NextRequest } from "next/server";
import { createPortal } from "@/lib/billing";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = (req: NextRequest) => createPortal(req);
