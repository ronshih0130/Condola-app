import type { Metadata, Viewport } from "next";
import { makeT } from "@/i18n";
import { AuthHashForward } from "@/components/auth-hash";
import { ChunkReloadListener } from "@/components/chunk-reload";
import { BrandLink, LocaleLinks, ResetButton, SignOutButton } from "@/components/chrome";
import { RequiredValidity } from "@/components/required-validity";
import { EnvBanner } from "@/components/env-mode";
import { LocaleProvider } from "@/components/locale";
import { demoModeEnabled } from "@/server/demo";
import { sandboxChrome } from "@/server/sandbox";
import { readSession, requestPrefs } from "@/server/session";
import "./globals.css";

export const dynamic = "force-dynamic";

export const viewport: Viewport = { themeColor: "#2E2622" };

export async function generateMetadata(): Promise<Metadata> {
  const prefs = await requestPrefs();
  return { title: makeT(prefs.locale)("i_brand") };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const prefs = await requestPrefs();
  const session = await readSession();
  const chrome = await sandboxChrome(session);
  const t = makeT(prefs.locale);
  const showReset = demoModeEnabled() && session?.kind === "staff" && session.role === "admin";
  return (
    <html lang={prefs.locale === "zh-TW" ? "zh-Hant-TW" : "en"}>
      <body>
        <LocaleProvider locale={prefs.locale}>
          <RequiredValidity message={t("i_field_required")} />
          <AuthHashForward />
          <ChunkReloadListener />
          <header className="top">
            <label htmlFor="nav-open" className="nav-toggle" data-testid="nav-toggle" aria-label={t("i_menu")}>
              <span aria-hidden="true">☰</span>
            </label>
            <BrandLink />
            <span className="top-extra">
              {session ? <span className="small">{session.name}</span> : <a href="/login">{t("i_sign_in")}</a>}
            </span>
            <span className="locale-slot">
              <LocaleLinks />
            </span>
            <span className="top-extra-end">
              {session ? <SignOutButton /> : null}
              {showReset ? <ResetButton /> : null}
            </span>
          </header>
          {chrome.environment === "sandbox" ? <EnvBanner showBack={session?.kind === "staff" && Boolean(session.liveOrgId)} /> : null}
          {children}
        </LocaleProvider>
      </body>
    </html>
  );
}
