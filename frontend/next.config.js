/**
 * Vibe Coding/blockwage/frontend/next.config.js
 *
 * Next.js configuration for the BlockWage frontend.
 *
 * - Uses `NEXT_PUBLIC_BACKEND_URL` (or `BACKEND_URL`) env var to proxy API calls in production/dev builds.
 * - Adds helpful security headers for basic hardening.
 * - Exposes a few build-time flags and enables SWC minifier.
 *
 * Usage:
 *  - Set NEXT_PUBLIC_BACKEND_URL (or BACKEND_URL) in your .env.local or Vercel env vars, e.g.:
 *      NEXT_PUBLIC_BACKEND_URL=https://your-backend.example.com
 *
 *  - The rewrites below will proxy client-side requests to:
 *      /api/* -> ${NEXT_PUBLIC_BACKEND_URL}/api/*
 *    This is convenient during deployments where the backend is hosted separately and you want
 *    to avoid CORS or have relative API paths in the client.
 *
 * Note: For strict production setups you may prefer to configure rewrites at the hosting layer (Vercel rewrites),
 * or remove the proxy and call the absolute backend URL from the frontend code. Keep secrets and private keys
 * on the backend only — never expose them to client-side env variables.
 */

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || process.env.BACKEND_URL || "";

module.exports = {
  reactStrictMode: true,
  swcMinify: true,

  // Note: If you rely on next/image, add allowed domains here.
  images: {
    domains: [], // add external image domains if needed
  },

  // Public runtime configuration (available client-side via process.env / NEXT_PUBLIC_*)
  publicRuntimeConfig: {
    backendUrl: BACKEND_URL,
  },

  // Security headers applied to all routes (basic set)
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-XSS-Protection", value: "0" }, // modern browsers prefer Content-Security-Policy
        ],
      },
    ];
  },

  // Rewrites: proxy /api/* requests to the backend service when BACKEND_URL is configured.
  // This allows client code to call relative paths like /api/simulate-facilitator and have Next.js proxy to the backend.
  async rewrites() {
    if (!BACKEND_URL) {
      // No backend configured — no rewrites
      return [];
    }

    // Ensure BACKEND_URL contains no trailing slash for consistent rewriting
    const backend = BACKEND_URL.replace(/\/$/, "");

    return [
      {
        source: "/api/:path*",
        destination: `${backend}/api/:path*`,
      },
      // Optional convenience endpoints that mirror backend root endpoints
      {
        source: "/simulate-facilitator",
        destination: `${backend}/simulate-facilitator`,
      },
      {
        source: "/salary/verify",
        destination: `${backend}/salary/verify`,
      },
      {
        source: "/health",
        destination: `${backend}/health`,
      },
    ];
  },

  eslint: {
    // Allow production builds even if ESLint errors are present (change to false to fail on lint errors)
    ignoreDuringBuilds: true,
  },

  // Customize webpack if you need to add aliases or fallbacks
  webpack: (config, { isServer }) => {
    // Example: add alias for common lib path (frontend/lib)
    config.resolve = config.resolve || {};
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      "@lib": require("path").resolve(__dirname, "lib"),
      "@components": require("path").resolve(__dirname, "components"),
    };

    // If you need to polyfill Node built-ins in the browser, configure here.
    // We intentionally avoid polyfills to keep client bundle small.

    return config;
  },
};
