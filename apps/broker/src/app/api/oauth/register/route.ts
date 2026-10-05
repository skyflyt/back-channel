import { NextRequest } from "next/server";
import { registerClient } from "@/lib/oauth.mjs";
import { oauthJson, oauthPreflight } from "@/lib/oauth-http";
import { rateLimit, clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * POST /api/oauth/register — OAuth 2.0 Dynamic Client Registration (RFC 7591).
 * Open and stateless: nothing is stored, the returned client_id IS the
 * registration (see src/lib/oauth.mjs for why that is safe). The rate limit is
 * only there so the endpoint cannot be used as free compute.
 */
export async function POST(req: NextRequest) {
  const rl = rateLimit("oauth:register", clientIp(req.headers.get("x-forwarded-for")), 60, 60 * 60 * 1000);
  if (!rl.ok) return oauthJson({ error: "rate_limited" }, 429, { "Retry-After": String(rl.retryAfterSec) });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return oauthJson({ error: "invalid_client_metadata", error_description: "body must be JSON" }, 400);
  }
  const result = registerClient(body);
  return "error" in result ? oauthJson(result, 400) : oauthJson(result, 201);
}
export const OPTIONS = oauthPreflight;
