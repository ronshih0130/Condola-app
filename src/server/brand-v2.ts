import type { Metadata } from "next";

export function brandV2Enabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.BRAND_V2 === "true";
}

export const BRAND_V2_THEME_COLOR = "#14325C";
export const LEGACY_THEME_COLOR = "#2E2622";

export function brandMetadata(
  locale: "zh-TW" | "en",
  env: Record<string, string | undefined> = process.env,
): Partial<Metadata> {
  if (brandV2Enabled(env)) return brandV2Metadata(locale, env);
  return {
    manifest: "/manifest.webmanifest",
    icons: {
      icon: [
        { url: "/favicon.ico", type: "image/x-icon", sizes: "16x16" },
        { url: "/icon.svg?e3e157dd9f40b850", type: "image/svg+xml", sizes: "any" },
      ],
      apple: [
        { url: "/apple-icon.png?9721f2c0ec0085a3", type: "image/png", sizes: "180x180" },
      ],
    },
  };
}

export function brandV2Metadata(
  locale: "zh-TW" | "en",
  env: Record<string, string | undefined> = process.env,
): Partial<Metadata> {
  let metadataBase = new URL("https://app.condola.app");
  try {
    const candidate = new URL(env.CONDOLA_SITE_URL ?? "");
    const allowedProtocol = candidate.protocol === "https:"
      || (candidate.protocol === "http:"
        && ["127.0.0.1", "localhost"].includes(candidate.hostname));
    if (
      allowedProtocol
      && !candidate.username
      && !candidate.password
      && candidate.pathname === "/"
      && !candidate.search
      && !candidate.hash
    ) {
      metadataBase = new URL(candidate.origin);
    }
  } catch {
    // Missing or malformed configuration uses the production origin.
  }

  return {
    metadataBase,
    manifest: "/brand/v2/favicon/site.webmanifest",
    icons: {
      icon: [
        { url: "/brand/v2/favicon/favicon.svg", type: "image/svg+xml" },
        { url: "/brand/v2/favicon/favicon.ico?v=20261027", sizes: "16x16 32x32 48x48" },
      ],
      apple: [{ url: "/brand/v2/favicon/apple-touch-icon.png", sizes: "180x180" }],
    },
    openGraph: {
      images: [
        {
          url: `/brand/v2/og/og-${locale === "zh-TW" ? "zh" : "en"}-1200x630.png`,
          width: 1200,
          height: 630,
        },
      ],
    },
  };
}

export const BRAND_V2_ASSETS = [
  "/brand/v2/theme.css",
  "/brand/v2/logo/lockup_en_color.svg",
  "/brand/v2/logo/lockup_stacked_color.svg",
  "/brand/v2/logo/symbol_color.svg",
  "/brand/v2/fonts/Inter-latin-wght.woff2",
  "/brand/v2/fonts/PlusJakartaSans-latin-wght.woff2",
  "/brand/v2/fonts/LICENSE-Inter.txt",
  "/brand/v2/fonts/LICENSE-PlusJakartaSans.txt",
  "/brand/v2/og/og-zh-1200x630.png",
  "/brand/v2/og/og-en-1200x630.png",
  "/brand/v2/favicon/favicon.svg",
  "/brand/v2/favicon/favicon.ico",
  "/brand/v2/favicon/favicon-16.png",
  "/brand/v2/favicon/favicon-32.png",
  "/brand/v2/favicon/favicon-48.png",
  "/brand/v2/favicon/apple-touch-icon.png",
  "/brand/v2/favicon/android-chrome-192.png",
  "/brand/v2/favicon/android-chrome-512.png",
  "/brand/v2/favicon/maskable-512.png",
  "/brand/v2/favicon/site.webmanifest",
] as const;
