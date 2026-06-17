/** @type {import('next').NextConfig} */
const nextConfig = {
  // No `output: "standalone"` — we ship the whole app dir + node_modules.
  // Cloud Run image is bigger but the path layout stays predictable for
  // our custom server.mjs.
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
};
export default nextConfig;
