import { NextRequest } from "next/server";
import { dispatch } from "@/lib/dispatch";
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return dispatch(req, "cancel", (await context.params).id);
}
