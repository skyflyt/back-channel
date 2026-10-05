import { NextRequest, NextResponse } from "next/server";

/**
 * Shared HTTP plumbing for the OAuth routes.
 *
 * CORS is open (`*`) on the metadata, registration and token endpoints on
 * purpose: browser-based MCP clients call them cross-origin, none of them reads
 * a cookie, and the token endpoint's only secrets are in the request body. The
 * consent endpoint (/api/oauth/consent) is cookie-authed and gets NO CORS
 * headers — do not reuse these helpers there.
 */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, mcp-protocol-version",
  "Access-Control-Max-Age": "86400",
};

/** The public origin every OAuth URL is built from. Never the Host header in production. */
export function publicOrigin(req: NextRequest): string {
  return (process.env.PUBLIC_APP_URL ?? req.nextUrl.origin).replace(/\/$/, "");
}

export function oauthJson(body: unknown, status = 200, extra: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...CORS, "Cache-Control": "no-store", Pragma: "no-cache", ...extra } });
}

export function oauthPreflight(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/** Metadata documents are public and stable: cacheable, unlike everything else here. */
export function metadataJson(body: unknown): NextResponse {
  return NextResponse.json(body, { headers: { ...CORS, "Cache-Control": "public, max-age=3600" } });
}
