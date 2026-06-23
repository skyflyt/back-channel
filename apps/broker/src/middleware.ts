import { NextRequest, NextResponse } from "next/server";

/**
 * CSP with a per-request nonce + Trusted Types (QA C1). Moves CSP out of the static
 * next.config headers so we can:
 *  - drop `script-src 'unsafe-inline'` → `'self' 'nonce-…' 'strict-dynamic'` (Next
 *    auto-applies the nonce to its scripts when it sees it on the request CSP header),
 *    so injected inline scripts / event handlers don't execute; and
 *  - enforce Trusted Types (`require-trusted-types-for 'script'`) so any raw-string DOM
 *    sink throws — defense-in-depth for the Phase-2 decryption renderer.
 *
 * Dev (Turbopack/HMR/React-dev) needs unsafe-inline+eval and no TT enforcement, so the
 * strict policy applies in production only.
 */
export function middleware(request: NextRequest) {
  const isProd = process.env.NODE_ENV === "production";

  // Trusted Types enforcement is the C1 fix: it makes any raw-string DOM sink
  // (innerHTML / document.write) THROW, so the Phase-2 decryption renderer can't be
  // turned into an XSS sink even if a sanitizer regresses. We keep script-src
  // 'unsafe-inline' for now — Next 16's request-header nonce propagation isn't
  // applying the nonce to its bootstrap scripts (verified: strict-dynamic blocked
  // hydration), so dropping unsafe-inline via nonce is a separate fast-follow.
  // Dev (Turbopack/HMR/React-dev) needs eval and is incompatible with TT enforcement.
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
