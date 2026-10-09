import { NextRequest } from "next/server";
import { issueSupportPass } from "@/lib/appbridge";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The temporary support client's relay pass (docs/remote-support.md): its own abs_ credential only.
export const POST = (req: NextRequest) => issueSupportPass(req);
