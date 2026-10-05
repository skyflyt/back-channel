import { NextRequest } from "next/server";
import { authorizationServerMetadata } from "@/lib/oauth.mjs";
import { metadataJson, oauthPreflight, publicOrigin } from "@/lib/oauth-http";

export const runtime = "nodejs";

/** OAuth 2.0 Authorization Server Metadata (RFC 8414). See src/lib/oauth.mjs for the design. */
export function GET(req: NextRequest) {
  return metadataJson(authorizationServerMetadata(publicOrigin(req)));
}
export const OPTIONS = oauthPreflight;
