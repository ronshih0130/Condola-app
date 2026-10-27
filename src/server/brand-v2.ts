import type { Metadata } from "next";

export function brandV2Enabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.BRAND_V2 === "true";
}

export const BRAND_V2_THEME_COLOR = "#14325C";
export const LEGACY_THEME_COLOR = "#2E2622";

export function brandV2Metadata(locale: "zh-TW" | "en"): Partial<Metadata> {
  return {
    icons: {
      icon: [
        { url: "/brand/v2/favicon/favicon.svg", type: "image/svg+xml" },
        { url: "/brand/v2/favicon/favicon.ico" },
      ],
      apple: [{ url: "/brand/v2/favicon/apple-touch-icon.png" }],
    },
    manifest: "/brand/v2/favicon/site.webmanifest",
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
  "/brand/v2/logo/lockup_en_dark.svg",
  "/brand/v2/logo/symbol_dark.svg",
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
