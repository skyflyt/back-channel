import { NextRequest } from "next/server";
import { workerResult } from "@/lib/vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/vault/worker/result: the vault worker's answer to one read (src/lib/vault.ts, docs/vault-bridge.md).
export const POST = (req: NextRequest) => workerResult(req);
