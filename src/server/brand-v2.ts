import type { Metadata } from "next";
import { cache } from "react";
import tokens from "../brand/v2/tokens.json";

export const brandV2Tokens: typeof tokens = tokens;

export function brandV2CssVars(): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const group of [
    brandV2Tokens.color,
    brandV2Tokens.font,
    brandV2Tokens.size,
    brandV2Tokens.space,
    brandV2Tokens.radius,
    brandV2Tokens.shadow,
    brandV2Tokens.layout,
  ]) {
    for (const [name, token] of Object.entries(group)) {
      variables[`--${name}`] = token.value;
    }
  }
  return variables;
}

export function brandV2Enabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.BRAND_V2 === "true";
}

const readOrgBrandV2Flag = cache(async (orgId: string): Promise<unknown> => {
  const { query } = await import("./db");
  const { rows } = await query<{ flag: unknown }>(
    "SELECT feature_flags -> 'brand_v2' AS flag FROM public.organizations WHERE id = $1",
    [orgId],
  );
  return rows[0]?.flag;
});

export async function brandV2EnabledForOrg(
  orgId: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
  lookup: (orgId: string) => Promise<unknown> = readOrgBrandV2Flag,
): Promise<boolean> {
  if (brandV2Enabled(env)) return true;
  if (!orgId) return false;

  try {
    return (await lookup(orgId)) === true;
  } catch {
    return false;
  }
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
  "/brand/v2/logo/lockup_zh_color.svg",
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

/** Per-page v2 stylesheets (R&D mockups 10/28); loaded only when BRAND_V2 is ON. */
export const BRAND_V2_PAGE_STYLES = [
  "/brand/v2/pages/t-home.css",
  "/brand/v2/pages/o-home.css",
  "/brand/v2/pages/o-approvals.css",
  "/brand/v2/pages/v-job.css",
  "/brand/v2/pages/m-home.css",
] as const;
