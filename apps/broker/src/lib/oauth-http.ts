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

/** Largest body any OAuth endpoint has a reason to read. Bigger is refused before parsing. */
export const MAX_OAUTH_BODY_BYTES = 16 * 1024;

/** Read a request body as text, or null if it is larger than MAX_OAUTH_BODY_BYTES. */
export async function readBoundedBody(req: NextRequest): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_OAUTH_BODY_BYTES) return null;
  const text = await req.text();
  return Buffer.byteLength(text, "utf8") > MAX_OAUTH_BODY_BYTES ? null : text;
}

/** Metadata documents are public and stable: cacheable, unlike everything else here. */
export function metadataJson(body: unknown): NextResponse {
  return NextResponse.json(body, { headers: { ...CORS, "Cache-Control": "public, max-age=3600" } });
}
