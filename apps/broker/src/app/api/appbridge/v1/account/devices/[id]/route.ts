import { NextRequest } from "next/server";
import { revokeDevice } from "@/lib/appbridge";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return revokeDevice(req, (await context.params).id);
}
