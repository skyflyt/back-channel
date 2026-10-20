import { NextRequest } from "next/server";
import { denyRoute } from "@/lib/secrets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/secret-broker/requests/:id/deny: one click, never gated (src/lib/secrets.ts). Approving is the passkey step-up itself.
export const POST = async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => denyRoute(req, (await params).id);
