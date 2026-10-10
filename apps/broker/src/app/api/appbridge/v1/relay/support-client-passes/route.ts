import { NextRequest } from "next/server";
import { issueSupportClientPass } from "@/lib/appbridge";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The issuer connector's relay pass to the helper of one support session (docs/remote-support.md): its own ab_ device
// credential only (scope appbridge.relay.pass), pinned on the session at first use.
export const POST = (req: NextRequest) => issueSupportClientPass(req);
