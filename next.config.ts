import type { NextConfig } from "next";
import { PRODUCTION_HOSTS } from "./src/server/public-origin";

const NO_STORE = [{ key: "Cache-Control", value: "private, no-store" }];

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "8mb",
      allowedOrigins: [...PRODUCTION_HOSTS],
    },
  },
  async headers() {
    return [
      { source: "/login", headers: NO_STORE },
      { source: "/signup/:path*", headers: NO_STORE },
      { source: "/forgot", headers: NO_STORE },
      { source: "/reset", headers: NO_STORE },
      { source: "/reset/:path*", headers: NO_STORE },
      { source: "/auth/:path*", headers: NO_STORE },
      { source: "/accept/:path*", headers: NO_STORE },
    ];
  },
};

export default nextConfig;
