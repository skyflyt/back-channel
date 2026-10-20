import { NextRequest } from "next/server";
import { deviceAnswer } from "@/lib/secrets-device";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = async (req: NextRequest, { params }: { params: Promise<{ id: string; action: string }> }) => {
  const { id, action } = await params;
  return deviceAnswer(req, id, action);
};
