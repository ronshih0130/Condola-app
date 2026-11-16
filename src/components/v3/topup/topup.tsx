import React from "react";
import Link from "next/link";
import { makeT, type Locale } from "../../../i18n";
import { brandV3TopupCopy } from "../../../i18n/lanes/brand-v3-topup";
import { topupDay, topupMoney } from "../../../lib/deposit-topup";
import type { TopupView } from "../../../server/mf3-deposit-topup";
import { displaySampleName } from "../../../server/sandbox-data";
import { TopupSheet } from "./topup-sheet";

/**
 * MO-TOPUP (MGT-151-AC1/AC2; frames 「第七輪・第二批」). Staff get the crumb, the lead, the card titled
 * 結算（三方同一版） and 「記錄已收」; the tenant and the owner get the same figures and entries with no button.
 */
export type TopupKind = "staff" | "tenant" | "owner";
const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");

function Figures({ view, locale }: { view: TopupView; locale: Locale }) {
  const c = brandV3TopupCopy(locale), money = (minor: string) => topupMoney(minor, view.currency, view.minorUnit);
  return <>
    <p className="v3-topup-kv"><span>{c.deposit}</span><b className="num">{money(view.depositMinor)}</b></p>
    <p className="v3-topup-kv"><span>{c.deductions}</span><b className="num">{money(view.deductionMinor)}</b></p>
    <p className="v3-topup-sum" data-testid="topup-line"><b>{fill(c.line, { owed: money(view.owedMinor), paid: money(view.paidMinor) })}</b></p>
  </>;
}
function Entries({ view }: { view: TopupView }) {
  return <ul className="v3-topup-entries" data-testid="topup-entries">{view.entries.map(entry => <li key={entry.id} data-testid="topup-entry">
    <time className="num" dateTime={entry.receivedOn}>{topupDay(entry.receivedOn)}</time>
    <span className="num">{topupMoney(entry.amountMinor, view.currency, view.minorUnit)}</span>
  </li>)}</ul>;
}

export function TopupStaffView({ view, locale }: { view: TopupView; locale: Locale }) {
  const c = brandV3TopupCopy(locale), t = makeT(locale);
  const tenant = view.tenant ? displaySampleName(view.tenant) : "";
  const owed = topupMoney(view.owedMinor, view.currency, view.minorUnit);
  return <section className="v3-topup" data-testid="topup-staff">
    <nav className="v3-topup-crumb" aria-label={c.title}>
      <Link href="/m/leases">{t("i_nav_leases")}</Link><span aria-hidden="true">›</span>
      {tenant ? <><Link href={`/m/leases/${encodeURIComponent(view.leaseId)}`}>{tenant}</Link><span aria-hidden="true">›</span></> : null}
      <span aria-current="page">{c.title}</span>
    </nav>
    <div className="v3-topup-head">
      <h1>{tenant ? fill(c.titleWith, { tenant }) : c.title}</h1>
      <p data-testid="topup-lead"><b>{fill(c.lead, { amount: owed })}</b></p>
    </div>
    <div className="v3-topup-card">
      <h2>{c.card}</h2>
      <Figures view={view} locale={locale} />
      {view.entries.length ? <><h3>{c.entries}</h3><Entries view={view} /></> : null}
      {view.canRecord ? <TopupSheet locale={locale} leaseId={view.leaseId} settlementId={view.settlementId}
        currency={view.currency} minorUnit={view.minorUnit} owedMinor={view.owedMinor} paidMinor={view.paidMinor} /> : null}
    </div>
  </section>;
}

/** Tenant and owner: the same version, read only (no button: the money is paid outside the app). */
export function TopupReadView({ view, locale, kind }: { view: TopupView; locale: Locale; kind: "tenant" | "owner" }) {
  const c = brandV3TopupCopy(locale);
  return <section className="v3-topup" data-testid={`topup-${kind}`}>
    <div className="v3-topup-head"><h1>{c.title}</h1></div>
    <div className="v3-topup-card">
      <Figures view={view} locale={locale} />
      {view.entries.length ? <Entries view={view} /> : null}
    </div>
  </section>;
}

/** GS-02 read error in place, with 「再試一次」 as the page's one action. */
export function TopupError({ locale, retryHref }: { locale: Locale; retryHref: string }) {
  const c = brandV3TopupCopy(locale);
  return <section className="v3-topup" data-testid="topup-error">
    <div className="v3-topup-head"><h1>{c.title}</h1></div>
    <div className="v3-topup-card" role="alert"><p>{c.readFailed}</p><a className="btn pri" href={retryHref}>{c.retry}</a></div>
  </section>;
}
