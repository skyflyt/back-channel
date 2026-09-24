import { NextRequest } from "next/server";
import { attestPairing, withdrawPairing } from "@/lib/appbridge";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function PUT(req: NextRequest, context: { params: Promise<{ enrollmentId: string }> }) {
  return attestPairing(req, (await context.params).enrollmentId);
}
export async function DELETE(req: NextRequest, context: { params: Promise<{ enrollmentId: string }> }) {
  return withdrawPairing(req, (await context.params).enrollmentId);
}
