/**
 * Verify a Google-signed ID token (RS256 JWT) — how the Back Channel Remote relay
 * (Cloud Run service `backchannel-relay`) proves its identity to the broker's
 * relay-facing AppBridge routes. The relay fetches the token from its instance
 * metadata server with audience = the broker origin; the broker checks the
 * signature against Google's published keys, the issuer, the audience, the
 * expiry and the service-account email. No dependency: node:crypto only.
 *
 * Claims are checked before any key fetch, and Google's key set is fetched at
 * most once a minute (cached for its Cache-Control max-age), so a flood of bad
 * tokens cannot turn into a flood of outbound requests. Never logs a token.
 */
import { createPublicKey, verify, type KeyObject } from "node:crypto";

const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const MAX_TOKEN = 4096;
const REFETCH_MS = 60_000;
const SKEW_SEC = 60;

type Keys = { keys: Map<string, KeyObject>; expiresAt: number };
let cache: Keys | null = null;
let lastFetch = 0;

/** Test hook: forget the cached key set. */
export function resetGoogleKeyCache(): void { cache = null; lastFetch = 0; }

function segment(value: string): Record<string, unknown> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

async function fetchKeys(now: number): Promise<Keys | null> {
  try {
    const res = await fetch(JWKS_URL, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const body = await res.json() as { keys?: unknown };
    if (!Array.isArray(body.keys)) return null;
    const keys = new Map<string, KeyObject>();
    for (const k of body.keys as Record<string, unknown>[]) {
      if (!k || k.kty !== "RSA" || (k.alg !== undefined && k.alg !== "RS256") || (k.use !== undefined && k.use !== "sig")) continue;
      if (typeof k.kid !== "string" || typeof k.n !== "string" || typeof k.e !== "string") continue;
      try { keys.set(k.kid, createPublicKey({ key: { kty: "RSA", n: k.n, e: k.e }, format: "jwk" })); } catch { /* skip a bad key */ }
    }
    if (!keys.size) return null;
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1] ?? 3600);
    return { keys, expiresAt: now + Math.min(Math.max(maxAge, 60), 86_400) * 1000 };
  } catch { return null; }
}

async function keyFor(kid: string, now: number): Promise<KeyObject | null> {
  if (cache && cache.expiresAt > now && cache.keys.has(kid)) return cache.keys.get(kid)!;
  // Unknown kid or stale cache: refetch, but at most once a minute.
  if (now - lastFetch < REFETCH_MS) return cache && cache.expiresAt > now ? cache.keys.get(kid) ?? null : null;
  lastFetch = now;
  const fresh = await fetchKeys(now);
  if (fresh) cache = fresh;
  return cache && cache.expiresAt > now ? cache.keys.get(kid) ?? null : null;
}

/** True only for a valid, unexpired Google ID token for exactly this audience and email. */
export async function verifyGoogleIdToken(token: string, expect: { audience: string; email: string }, now = Date.now()): Promise<boolean> {
  if (typeof token !== "string" || token.length > MAX_TOKEN) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const header = segment(parts[0]); const claims = segment(parts[1]);
  if (!header || !claims || header.alg !== "RS256" || typeof header.kid !== "string" || header.crit !== undefined) return false;
  const nowSec = Math.floor(now / 1000);
  if (typeof claims.iss !== "string" || !ISSUERS.has(claims.iss)) return false;
  if (claims.aud !== expect.audience) return false;
  if (typeof claims.email !== "string" || claims.email.toLowerCase() !== expect.email.toLowerCase() || claims.email_verified !== true) return false;
  if (typeof claims.exp !== "number" || typeof claims.iat !== "number") return false;
  if (claims.exp <= nowSec || claims.iat > nowSec + SKEW_SEC || claims.exp - claims.iat > 3600 + SKEW_SEC) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(parts[2])) return false;
  const key = await keyFor(header.kid, now);
  if (!key) return false;
  try { return verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url")); }
  catch { return false; }
}
