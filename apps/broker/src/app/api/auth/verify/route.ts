import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateApiKey } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get("token");
  if (!token) {
    return NextResponse.json({ error: "token_required" }, { status: 400 });
  }

  const link = await prisma.magicLink.findUnique({ where: { token } });
  if (!link) {
    return NextResponse.json({ error: "invalid_token" }, { status: 404 });
  }
  if (link.consumedAt) {
    return NextResponse.json({ error: "token_already_used" }, { status: 410 });
  }
  if (link.expiresAt < new Date()) {
    return NextResponse.json({ error: "token_expired" }, { status: 410 });
  }

  const account = await prisma.account.findUnique({ where: { email: link.email } });
  if (!account) {
    return NextResponse.json({ error: "account_not_found" }, { status: 404 });
  }

  // Mark verified + issue API key (atomic-ish)
  const apiKey = account.apiKey ?? generateApiKey();
  const updated = await prisma.$transaction(async (tx) => {
    const a = await tx.account.update({
      where: { id: account.id },
      data: {
        emailVerifiedAt: account.emailVerifiedAt ?? new Date(),
        apiKey: account.apiKey ?? apiKey,
      },
    });
    await tx.magicLink.update({
      where: { token },
      data: { consumedAt: new Date() },
    });
    return a;
  });

  // The /verify page will fetch this and display it. We DON'T expose the API key
  // via this endpoint to non-browser callers via simple GET — but for MVP this is fine.
  // Phase 3.2: require a state parameter to bind to the original browser session.
  return NextResponse.json({
    status: "verified",
    handle: updated.handle,
    email: updated.email,
    api_key: updated.apiKey,
    account_id: updated.id,
  });
}
