import type { Metadata } from "next";
import { makeT } from "@/i18n";
import { BrandLink, LocaleLinks, ModeLinks, PersonaSelect, ResetButton } from "@/components/chrome";
import { LocaleProvider } from "@/components/locale";
import { getSession, listPersonas } from "@/server/session";
import "./globals.css";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const session = await getSession();
  return { title: makeT(session.locale)("i_brand") };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  const personas = await listPersonas();
  const t = makeT(session.locale);
  return (
    <html lang={session.locale === "zh-TW" ? "zh-Hant-TW" : "en"}>
      <body>
        <LocaleProvider locale={session.locale}>
          <header className="top">
            <label htmlFor="nav-open" className="nav-toggle" data-testid="nav-toggle" aria-label={t("i_menu")}>
              <span aria-hidden="true">☰</span>
            </label>
            <BrandLink />
            <span className="top-extra">
              <span className="demo-pill">{t("s_f269874")}</span>
              <ModeLinks />
              <span className="sp" />
              <PersonaSelect personas={personas.map((persona) => ({ id: persona.id, name: persona.name }))} current={session.userId} />
            </span>
            <span className="locale-slot">
              <LocaleLinks />
            </span>
            <span className="top-extra-end">
              <ResetButton />
            </span>
          </header>
          {children}
        </LocaleProvider>
      </body>
    </html>
  );
}
