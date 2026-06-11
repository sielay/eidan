import type { NextConfig } from "next";

// The same-origin front door: NEXT_PUBLIC_EIDAN_BACKEND_URL comes from the environment (empty =
// same-origin, the default). `output: standalone` produces a minimal self-contained server for the
// Docker image (Dockerfile copies .next/standalone).
const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
};

export default nextConfig;
