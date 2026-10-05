import { NextRequest } from "next/server";
import { registerClient } from "@/lib/oauth.mjs";
import { oauthJson, oauthPreflight, readBoundedBody } from "@/lib/oauth-http";
import { rateLimit, clientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * POST /api/oauth/register — OAuth 2.0 Dynamic Client Registration (RFC 7591).
 * Open and stateless: nothing is stored, the returned client_id IS the
 * registration (see src/lib/oauth.mjs for why that is safe). The rate limit is
 * only there so the endpoint cannot be used as free compute — and it is per IP,
 * so it has to be generous: every user of a hosted client (claude.ai, ChatGPT)
 * registers from that client's handful of egress addresses.
 */
export async function POST(req: NextRequest) {
  const rl = rateLimit("oauth:register", clientIp(req.headers.get("x-forwarded-for")), 1200, 60 * 60 * 1000);
  if (!rl.ok) return oauthJson({ error: "rate_limited" }, 429, { "Retry-After": String(rl.retryAfterSec) });

  let body: unknown;
  try {
    const text = await readBoundedBody(req);
    if (text === null) return oauthJson({ error: "invalid_client_metadata", error_description: "registration is too large" }, 413);
    body = JSON.parse(text);
  } catch {
    return oauthJson({ error: "invalid_client_metadata", error_description: "body must be JSON" }, 400);
  }
  const result = registerClient(body);
  return "error" in result ? oauthJson(result, 400) : oauthJson(result, 201);
}
export const OPTIONS = oauthPreflight;
