/** @type {import('next').NextConfig} */
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(self)" },
];

const nextConfig = {
  poweredByHeader: false,
  // `pnpm dev` inside a GitHub Codespace is reached through *.app.github.dev (development only).
  allowedDevOrigins: ["*.app.github.dev"],
  reactStrictMode: true,
  // Standalone server bundle only for the Docker image (infra/docker/web.Dockerfile sets this).
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  // Linting runs once for the whole monorepo (root eslint.config.mjs) in CI.
  eslint: { ignoreDuringBuilds: true },
  // @openline/shared is a workspace package (compiled CommonJS in dist/).
  transpilePackages: ["@openline/shared"],
  // /api/* is proxied to the API at RUNTIME by src/app/api/[...path]/route.ts (not a rewrite:
  // rewrites are fixed at build time, and one image is promoted from staging to production).
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // Browsers and crawlers ask for /favicon.ico even when the page names src/app/icon.svg.
  async rewrites() {
    return [{ source: "/favicon.ico", destination: "/icon.svg" }];
  },
};

export default nextConfig;
