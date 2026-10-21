import { NextRequest } from "next/server";
import { deviceView } from "@/lib/secrets-device";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (req: NextRequest) => deviceView(req);
