import { execSync } from "node:child_process";
import type { NextConfig } from "next";
import { PRODUCTION_HOSTS } from "./src/server/public-origin";

function buildSha() {
  const fromEnv = (process.env.CONDOLA_BUILD_SHA || process.env.CONDOLA_COMMIT || process.env.CF_PAGES_COMMIT_SHA || "").trim();
  if (fromEnv) return fromEnv.slice(0, 7);
  try {
    return execSync("git rev-parse --short=7 HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const NO_STORE = [{ key: "Cache-Control", value: "private, no-store" }];
const sha = buildSha();

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_BUILD_SHA: sha,
    NEXT_PUBLIC_COMMIT: sha,
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "8mb",
      allowedOrigins: [...PRODUCTION_HOSTS],
    },
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.resolve.alias = {
        ...config.resolve.alias,
        "heic-convert": false,
        "heic-convert/browser": false,
        "heic-decode": false,
        "libheif-js": false,
      };
    }
    config.module.rules.push({
      test: /\.md$/,
      type: "asset/source",
    });
    return config;
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
