import { NextRequest } from "next/server";
import { deleteSelf, getSelf } from "@/lib/appbridge";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (req: NextRequest) => getSelf(req);
export const DELETE = (req: NextRequest) => deleteSelf(req);
