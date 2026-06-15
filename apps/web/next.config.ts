import type { NextConfig } from "next";
import withSerwistInit from "@serwist/next";

// The same-origin front door: NEXT_PUBLIC_EIDAN_BACKEND_URL comes from the environment (empty =
// same-origin, the default). `output: standalone` produces a minimal self-contained server for the
// Docker image (Dockerfile copies .next/standalone).
const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
};

// PWA service worker (Serwist). Compiles src/app/sw.ts → public/sw.js with the
// build-time precache manifest injected. Disabled in dev so HMR isn't shadowed
// by a stale cached shell; the SW only registers on production builds.
const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV === "development",
  // Reload open clients once a new SW takes control so a deploy is picked up
  // without a manual hard refresh.
  reloadOnOnline: true,
});

export default withSerwist(nextConfig);
