import type { Metadata, Viewport } from "next";
import { makeT } from "@/i18n";
import { BrandLink, LocaleLinks, ResetButton, SignOutButton } from "@/components/chrome";
import { LocaleProvider } from "@/components/locale";
import { demoModeEnabled } from "@/server/demo";
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
  const t = makeT(prefs.locale);
  const showReset = demoModeEnabled() && session?.kind === "staff" && session.role === "admin";
  return (
    <html lang={prefs.locale === "zh-TW" ? "zh-Hant-TW" : "en"}>
      <body>
        <LocaleProvider locale={prefs.locale}>
          <header className="top">
            <label htmlFor="nav-open" className="nav-toggle" data-testid="nav-toggle" aria-label={t("i_menu")}>
              <span aria-hidden="true">☰</span>
            </label>
            <BrandLink />
            <span className="top-extra">
              <span className="demo-pill">{t("s_f269874")}</span>
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
          {children}
        </LocaleProvider>
      </body>
    </html>
  );
}
