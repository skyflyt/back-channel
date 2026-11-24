import { NextRequest } from "next/server";
import { workerNext } from "@/lib/vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/vault/worker/next?wait=N: the vault worker's long-poll for the next read (src/lib/vault.ts, docs/vault-bridge.md).
export const GET = (req: NextRequest) => workerNext(req);
