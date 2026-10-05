import { NextRequest } from "next/server";
import { protectedResourceMetadata } from "@/lib/oauth.mjs";
import { metadataJson, oauthPreflight, publicOrigin } from "@/lib/oauth-http";

export const runtime = "nodejs";

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728) for /api/mcp — where an MCP
 * client that just got a 401 learns which authorization server to use. Served
 * at the bare well-known path and at the path-suffixed form
 * (/.well-known/oauth-protected-resource/api/mcp); clients probe both.
 */
export function GET(req: NextRequest) {
  return metadataJson(protectedResourceMetadata(publicOrigin(req)));
}
export const OPTIONS = oauthPreflight;
