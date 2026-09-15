import { NextRequest } from "next/server";
import { dispatch } from "@/lib/dispatch";
export const dynamic = "force-dynamic";
export const GET = (req: NextRequest) => dispatch(req, "agents");
export const POST = (req: NextRequest) => dispatch(req, "enroll");
