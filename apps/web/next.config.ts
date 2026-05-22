/** @type {import('next').NextConfig} */
const backendBase =
  process.env.NEXT_PUBLIC_EIDAN_BACKEND_URL ??
  process.env.EIDAN_BACKEND_URL ??
  (process.env.NODE_ENV === "development" ? "http://localhost:8000" : "");

const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_EIDAN_BACKEND_URL: backendBase,
  },
};

export default nextConfig;
