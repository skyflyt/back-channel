import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromCookie, SESSION_COOKIE_NAME } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * PATCH /api/account/settings — dashboard settings writes (cookie auth).
 * Currently: notify_idle_frames (the idle-recipient email toggle). Returns the
 * updated values.
 */
export async function PATCH(req: NextRequest) {
  const account = await getAccountFromCookie(req.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!account) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { notify_idle_frames?: boolean };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }

  const data: { notifyIdleFrames?: boolean } = {};
  if (typeof body.notify_idle_frames === "boolean") data.notifyIdleFrames = body.notify_idle_frames;
  if (Object.keys(data).length === 0) return NextResponse.json({ error: "no_valid_fields" }, { status: 400 });

  const updated = await prisma.account.update({ where: { id: account.id }, data });
  return NextResponse.json({ notify_idle_frames: updated.notifyIdleFrames });
}
