import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateApiKey, generateHandle } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: { email?: string; display_name?: string; agent_endpoint?: string; agent_pubkey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.email || !body.email.includes("@")) {
    return NextResponse.json({ error: "email_required" }, { status: 400 });
  }

  // Phase 3 MVP: skip email verification, just create the account
  // (magic-link flow lands in v0.4)
  const handle = generateHandle(body.email);
  const apiKey = generateApiKey();

  try {
    const account = await prisma.account.create({
      data: {
        email: body.email,
        handle,
        displayName: body.display_name,
        agentEndpoint: body.agent_endpoint,
        agentPubkey: body.agent_pubkey,
        apiKey,
      },
    });
    return NextResponse.json({
      handle: account.handle,
      api_key: apiKey,  // shown ONCE — store on agent side
      account_id: account.id,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("Unique constraint")) {
      return NextResponse.json({ error: "email_or_handle_taken" }, { status: 409 });
    }
    return NextResponse.json({ error: "server_error", detail: msg }, { status: 500 });
  }
}

