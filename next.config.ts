import type { NextConfig } from "next";
import { PRODUCTION_HOSTS } from "./src/server/public-origin";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "8mb",
      allowedOrigins: [...PRODUCTION_HOSTS],
    },
  },
};

export default nextConfig;
