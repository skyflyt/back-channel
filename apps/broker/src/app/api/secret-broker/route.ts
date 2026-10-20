import { NextRequest } from "next/server";
import { viewRoute } from "@/lib/secrets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/secret-broker: the person's PCs' secret brokers and the requests waiting on them (src/lib/secrets.ts).
export const GET = (req: NextRequest) => viewRoute(req);
