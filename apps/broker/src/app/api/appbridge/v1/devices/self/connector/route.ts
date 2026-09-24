import { NextRequest } from "next/server";
import { rotateConnector } from "@/lib/appbridge";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const PUT = (req: NextRequest) => rotateConnector(req);
