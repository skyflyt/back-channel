import { NextRequest, NextResponse } from "next/server";
import { NO_SUCH_PAGE } from "@/lib/no-such-page.mjs";

/**
 * Runs before every page (Next's `proxy` convention, Node.js runtime). Two jobs:
 * the owner gate for /admin, and the Content-Security-Policy header.
 *
 * ── The admin area does not exist for anyone but the owner ──
 * That is the /admin page and the admin APIs (GATED below). The gate is
 * decided here, before any page or route handler is chosen, and everyone who
 * is not the owner is rewritten to a path with no route. They get exactly what a
 * mistyped URL gets: the same status (404), the same body, the same headers,
 * produced by the same code path. Nothing about the response can say that an
 * admin area exists, which a 404 thrown from inside the page could not promise
 * (its body and caching headers differ from a real unknown path), and which a
 * sign-in prompt for signed-out visitors plainly gave away.
 *
 * One thing a rewrite does add: Next stamps the response with headers naming
 * where it was rewritten to. server.mjs removes them for this rewrite
 * (src/lib/no-such-page.mjs); without that they would be the tell.
 *
 * "Not the owner" is whatever checkOwnerAdmin (src/lib/admin.ts) refuses:
 * signed out, signed in as someone else, a bearer key, an unverified email, an
 * empty allowlist. If the check itself fails (database down), that is also a
 * 404: closed, and indistinguishable. The page and every admin route handler
 * keep their own check as well, so the matcher below is not the only thing
 * between a visitor and the dashboard. Seen from outside, though, the handlers'
 * own 401 and 403 never happen: this answers first.
 *
 * What is left, and accepted: a request carrying a session-shaped cookie costs
 * one indexed database read here that an unknown path does not, so the two
 * differ by that read's time.
 *
 * A signed-out owner therefore sees a 404 at /admin too. Sign in first; the
 * account page shows the Admin tab.
 *
 * ── CSP with Trusted Types (QA C1) ──
 * Moves CSP out of the static next.config headers so we can
 * enforce Trusted Types (`require-trusted-types-for 'script'`) so any raw-string DOM sink
 * throws — defense-in-depth for the Phase-2 decryption renderer.
 *
 * `script-src 'unsafe-inline'` (M5, security-pass-2026-07-03.md): investigated and NOT
 * dropped in this pass — documenting why rather than shipping a silent partial fix.
 *
 *   - A prior attempt to switch to `'nonce-<value>' 'strict-dynamic'` (this file's git
 *     history) hit Next 16's documented constraint: nonce-based CSP requires the nonce to be
 *     read from the request's CSP header and threaded through the root layout via
 *     next/headers, AND every page that needs it to render must opt into dynamic rendering
 *     (see https://nextjs.org/docs/app/guides/content-security-policy — "Dynamic Rendering
 *     Requirement": static optimization/ISR/PPR are incompatible with nonce-based CSP).
 *     root layout.tsx here reads no nonce today and no route is forced dynamic; wiring that
 *     up correctly across every route (and re-verifying each one still renders/hydrates) is
 *     an app-wide rendering-strategy change, not a hygiene-scope tweak — tracked as a
 *     follow-up, not done here.
 *   - What IS verified in this pass: there are zero handwritten inline `<script>` tags and
 *     zero `dangerouslySetInnerHTML`/`innerHTML` sinks anywhere under src/ (grepped clean),
 *     so `unsafe-inline` on script-src currently has no attacker-reachable injection point in
 *     this app's own code — it only widens what Next's own bootstrap scripts are allowed to
 *     do. That's real defense-in-depth debt (a future regression that adds a sink would be
 *     one CSP layer short of caught), not a live hole. Trusted Types above is the load-bearing
 *     control for that class of bug today.
 *   - Fast-follow options if/when this gets prioritized: (a) the nonce approach above, done
 *     properly with dynamic rendering audited per-route, or (b) Next's experimental
 *     Subresource-Integrity CSP mode (`experimental.sri`), which keeps static rendering and
 *     avoids the nonce/dynamic-rendering tradeoff entirely — worth evaluating first since it
 *     fits this app's mostly-static page shape better than nonces do.
 *
 * Dev (Turbopack/HMR/React-dev) needs unsafe-inline+eval and no TT enforcement, so the
 * strict policy applies in production only.
 */
/** Everything that is the owner's alone: the page, its APIs, and the Remote entitlement admin route. */
const GATED = ["/admin", "/api/admin", "/api/appbridge/v1/admin"];

/**
 * Is this path inside the admin area? Decoded first: Next matches a route
 * after decoding, so /%61dmin is /admin to the router and must be to the gate.
 */
export function isAdminPath(pathname: string): boolean {
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch { /* malformed escapes match no route; leave as written */ }
  return GATED.some((root) => path === root || path.startsWith(`${root}/`));
}

/**
 * True only for the owner. Any failure to find out is a no. The gate is loaded
 * here rather than at the top of the file so that if it (or the database
 * client behind it) cannot load, the admin area is a 404 and every other page
 * still works.
 */
async function ownerMayEnter(request: NextRequest): Promise<boolean> {
  try {
    const { checkOwnerAdmin, ownerGateInput } = await import("@/lib/admin");
    return (await checkOwnerAdmin(ownerGateInput(request), false)).ok;
  } catch {
    return false;
  }
}

export async function proxy(request: NextRequest) {
  const isProd = process.env.NODE_ENV === "production";

  const scriptSrc = isProd ? "script-src 'self' 'unsafe-inline'" : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";
  const tt = isProd ? "; require-trusted-types-for 'script'; trusted-types nextjs nextjs#bundler default dompurify 'allow-duplicates'" : "";

  const csp = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self' wss://back-channel.app wss://*.run.app",
    "font-src 'self' data:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ") + tt;

  const res = isAdminPath(request.nextUrl.pathname) && !(await ownerMayEnter(request))
    ? NextResponse.rewrite(new URL(NO_SUCH_PAGE, request.url))
    : NextResponse.next();
  res.headers.set("content-security-policy", csp);
  return res;
}

export const config = {
  // Everything except static assets, images and the favicon. That includes API routes:
  // they get the CSP header too, and the admin APIs are gated above.
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|txt)$).*)" }],
};
