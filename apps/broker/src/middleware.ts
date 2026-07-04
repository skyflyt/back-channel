import { NextRequest, NextResponse } from "next/server";

/**
 * CSP with Trusted Types (QA C1). Moves CSP out of the static next.config headers so we can
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
export function middleware(request: NextRequest) {
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

  const res = NextResponse.next();
  res.headers.set("content-security-policy", csp);
  return res;
}

export const config = {
  // Run on pages (not static assets / images / favicon). API routes set their own
  // headers; excluding them avoids per-API overhead.
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|txt)$).*)" }],
};
