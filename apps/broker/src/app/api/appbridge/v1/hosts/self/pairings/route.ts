import { NextRequest } from "next/server";
import { listPairingsForHost } from "@/lib/appbridge";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (req: NextRequest) => listPairingsForHost(req);
