import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { makeT } from "@/i18n";
import { AuthHashForward } from "@/components/auth-hash";
import { ChunkReloadListener } from "@/components/chunk-reload";
import { BrandLink, LocaleLinks, ResetButton, SignOutButton } from "@/components/chrome";
import { RequiredValidity } from "@/components/required-validity";
import { EnvBanner } from "@/components/env-mode";
import { LocaleProvider } from "@/components/locale";
import { demoModeEnabled } from "@/server/demo";
import { BRAND_V2_PAGE_STYLES, brandV2Enabled, brandMetadata, BRAND_V2_THEME_COLOR, LEGACY_THEME_COLOR } from "@/server/brand-v2";
import { sandboxChrome } from "@/server/sandbox";
import { readSession, requestPrefs } from "@/server/session";
import "./globals.css";

export const dynamic = "force-dynamic";

export async function generateViewport(): Promise<Viewport> {
  return { themeColor: brandV2Enabled() ? BRAND_V2_THEME_COLOR : LEGACY_THEME_COLOR };
}

export async function generateMetadata(): Promise<Metadata> {
  const prefs = await requestPrefs();
  return { title: makeT(prefs.locale)("i_brand"), ...brandMetadata(prefs.locale) };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const prefs = await requestPrefs();
  const session = await readSession();
  const chrome = await sandboxChrome(session);
  const t = makeT(prefs.locale);
  const showReset = demoModeEnabled() && session?.kind === "staff" && session.role === "admin";
  const v2 = brandV2Enabled();
  const body = (
    <body>
      <LocaleProvider locale={prefs.locale}>
        <RequiredValidity message={t("i_field_required")} />
        <AuthHashForward />
        <ChunkReloadListener />
        <header className="top">
          <label htmlFor="nav-open" className="nav-toggle" data-testid="nav-toggle" aria-label={t("i_menu")}>
            <span aria-hidden="true">☰</span>
          </label>
          {v2 ? <BrandLink v2 /> : <BrandLink />}
          <span className="top-extra">
            {session ? <span className="small">{session.name}</span> : <a href="/login">{t("i_sign_in")}</a>}
          </span>
          <span className="locale-slot">
            <LocaleLinks />
          </span>
          <span className="top-extra-end">
            {session?.portals?.owner && session.portals.tenant && session.kind !== "staff" ? (
              <a
                className="small"
                data-testid="switch-role"
                href={session.kind === "owner" ? "/t" : "/o/statements"}
                style={{ marginRight: 10 }}
              >
                {session.kind === "owner" ? t("i_switch_role_tenant") : t("i_switch_role_owner")}
              </a>
            ) : null}
            {session ? <SignOutButton /> : null}
            {showReset ? <ResetButton /> : null}
          </span>
        </header>
        {chrome.environment === "sandbox" ? <EnvBanner showBack={session?.kind === "staff" && Boolean(session.liveOrgId)} /> : null}
        {children}
        <footer className="foot site-foot" data-testid="site-footer" style={{ margin: "16px" }}>
          <nav className="site-legal" aria-label={t("i_legal_nav")}>
            <Link href="/terms">{t("i_legal_terms")}</Link>
            <Link href="/privacy">{t("i_legal_privacy")}</Link>
            <Link href="/licenses">{t("i_legal_licenses")}</Link>
            <Link href="/refund">{t("i_legal_refund")}</Link>
          </nav>
          <p data-testid="app-version">{process.env.NEXT_PUBLIC_COMMIT || "unknown"}</p>
        </footer>
      </LocaleProvider>
    </body>
  );

  if (!v2) {
    return <html lang={prefs.locale === "zh-TW" ? "zh-Hant-TW" : "en"}>{body}</html>;
  }

  return (
    <html lang={prefs.locale === "zh-TW" ? "zh-Hant-TW" : "en"} data-brand="v2">
      <head>
        <link
          rel="preload"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
          href="/brand/v2/fonts/Inter-latin-wght.woff2"
        />
        {
          // Load the external theme only for v2 to preserve OFF behavior without changing globals.css.
          // eslint-disable-next-line @next/next/no-css-tags
          <link rel="stylesheet" href="/brand/v2/theme.css" />
        }
        {BRAND_V2_PAGE_STYLES.map((href) => (
          // eslint-disable-next-line @next/next/no-css-tags
          <link key={href} rel="stylesheet" href={href} />
        ))}
      </head>
      {body}
    </html>
  );
}
