import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getAccountFromAuth, generateInviteCode } from "@/lib/auth";
import { validateScopes } from "@/lib/scopes";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const visitor = await getAccountFromAuth(req.headers.get("authorization"));
  if (!visitor) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { host_handle?: string; scopes?: string[]; ttl_minutes?: number; message?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.host_handle) return NextResponse.json({ error: "host_handle_required" }, { status: 400 });
  if (!body.scopes || !Array.isArray(body.scopes) || body.scopes.length === 0) {
    return NextResponse.json({ error: "scopes_required" }, { status: 400 });
  }

  const scopeCheck = validateScopes(body.scopes);
  if (!scopeCheck.ok) return NextResponse.json({ error: "invalid_scope", detail: scopeCheck.error }, { status: 400 });

  const host = await prisma.account.findUnique({ where: { handle: body.host_handle } });
  if (!host) return NextResponse.json({ error: "host_not_found" }, { status: 404 });

  const ttl = Math.min(Math.max(body.ttl_minutes ?? 30, 5), 60);
  const code = generateInviteCode();
  const expiresAt = new Date(Date.now() + ttl * 60 * 1000);

  const invite = await prisma.invite.create({
    data: {
      code,
      hostAccountId: host.id,
      visitorAccountId: visitor.id,
      scopes: body.scopes,
      ttlMinutes: ttl,
      message: body.message,
      expiresAt,
    },
  });

  // TODO Phase 3.1: push notification to host's registered channel

  return NextResponse.json({
    code: invite.code,
    invite_id: invite.id,
    expires_at: invite.expiresAt.toISOString(),
    relay_url: `${process.env.PUBLIC_APP_URL ?? "wss://backchannel.app"}/relay/<session_id_after_claim>`,
  });
}

