import React from "react";
import Link from "next/link";
import { makeT, type Locale } from "@/i18n";
import type { EmptyAction, EmptyCta } from "@/lib/empty-cta";
import { EmptyIllustration, type EmptyIllustrationName } from "./empty-illustration";

const illustrations = { DASH: "home", MSG: "chat", PROP: "home", UNIT: "home", TEN: "people", TENID: "doc", LEASE: "doc", PAY: "coin", BANK: "coin", UTIL: "coin", EXP: "doc", STMT: "doc", RPT: "doc", TIX: "wrench", OWN: "people", NOTI: "bell", SRCH: "search", DASH_pay: "coin", DASH_lease: "doc", DASH_C_pay: "check", DASH_C_lease: "check", MSG_joined: "chat" } satisfies Record<string, EmptyIllustrationName>;
export type EmptyStateId = keyof typeof illustrations;
export function EmptyPrimary({ action, locale }: { action: EmptyAction; locale: Locale }) {
  return <div className="es-primary"><Link className="btn pri" href={action.href}>{makeT(locale)(action.key)}</Link></div>;
}
export function EmptyState({ id, locale, cta = { primary: null, links: [], showAdminHint: false }, compact = false }: {
  id: EmptyStateId; locale: Locale; cta?: EmptyCta; compact?: boolean;
}) {
  const t = makeT(locale);
  return <section className={`empty-state${compact ? " es-compact" : ""}`} data-testid={`empty-${id}`}>
    <EmptyIllustration name={illustrations[id]} compact={compact} />
    <h2>{t(`es_${id}_title`)}</h2><p>{t(`es_${id}_reason`)}</p>
    {cta.showAdminHint ? <p><strong>{t("es_common_admin_hint")}</strong></p> : null}
    {cta.primary ? <EmptyPrimary action={cta.primary} locale={locale} /> : null}
    {cta.links.length ? <div className="es-links">{cta.links.slice(0, 2).map(link =>
      <Link key={link.key} href={link.href}>{t(link.key)}</Link>)}</div> : null}
  </section>;
}
