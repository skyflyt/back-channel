import { NextRequest } from "next/server";
import { setPushToken } from "@/lib/appbridge";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const PUT = (req: NextRequest) => setPushToken(req);
export const DELETE = (req: NextRequest) => setPushToken(req);
