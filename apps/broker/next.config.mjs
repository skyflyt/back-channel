import path from "node:path";
import { fileURLToPath } from "node:url";

// PROTOTYPE branch note (proto/logged-in-redesign): pin the Turbopack workspace root.
// Without this, a stray package-lock.json in the user's HOME dir makes Turbopack infer
// C:\Users\<user> as the root, splitting the client module graph across two path-root
// encodings — client hydration silently never completes in local dev (skeleton forever).
const appDir = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: { root: appDir },
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "X-Content-Type-Options",    value: "nosniff" },
          { key: "X-Frame-Options",           value: "DENY" },
          { key: "Referrer-Policy",           value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy",        value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
          // Content-Security-Policy is set per-request in middleware.ts (nonce + Trusted Types).
        ],
      },
    ];
  },
};
export default nextConfig;
