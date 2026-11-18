import React, { type ReactNode } from "react";
import Link from "next/link";
import type { Locale } from "../../../i18n";
import { brandV3TenantHomeCopy } from "../../../i18n/lanes/brand-v3-tenant-home";
import { tenantPaymentHistoryCopy } from "../../../i18n/tenant-payment-history";
import { moneyLabel } from "../../../server/format";
import type { TenantHomeView } from "../../../server/b090-tenant-home";
import type { TenantHomeHeadline } from "../../../server/b090-tenant-home-rules";
import { CompletionCheck } from "../completion-check";
import { Illustration } from "../illustrations";
import { WaitMark } from "../wait-mark";

type Ready = Extract<TenantHomeView, { state: "ready" }>;

/** TEN-54-AC1: the one sentence for the tenant's current month. */
export function tenantHomeSentence(headline: TenantHomeHeadline, currency: string, locale: Locale, name: string, company: string): string {
  const copy = brandV3TenantHomeCopy(locale), money = (minor: number) => moneyLabel(minor, currency, locale);
  switch (headline.kind) {
    case "due": return (name.trim() ? copy.due : copy.dueNoName).replace("{name}", name.trim()).replace("{month}", copy.month(headline.month))
      .replace("{amount}", money(headline.amountMinor)).replace("{date}", copy.date(headline.dueOn));
    case "reported": return copy.reported.replace("{amount}", money(headline.amountMinor)).replace("{company}", company);
    case "paid": return copy.paid.replace("{month}", copy.month(headline.month));
    case "overdue": return copy.overdue.replace("{month}", copy.month(headline.month)).replace("{days}", copy.days(headline.days));
    case "partial": return copy.partial.replace("{month}", copy.month(headline.month)).replace("{amount}", money(headline.restMinor));
    case "none": {
      const bill = tenantPaymentHistoryCopy(locale);
      return ({ unsigned: bill.unsigned, no_invoice: bill.noInvoice, nonpayable: bill.nonpayable, zero_charge: bill.zeroCharge, credit: bill.credit,
        offset: bill.offset, due: bill.due, partial: bill.partial, paid: bill.paid })[headline.state];
    }
  }
}

/**
 * RT-HOME. No solid button on this page: cards carry text links only. The tick shows only for 已繳清, which the
 * bill reaches only through staff-confirmed payments (PLT-51); the clock shows beside the waiting line.
 */
export function TenantHomeV3({ view, locale, name, company }: { view: Ready; locale: Locale; name: string; company: string }) {
  const copy = brandV3TenantHomeCopy(locale);
  const { headline } = view;
  // TEN-54-AC3: drawing 07 follows the payment state only ("nothing to pay"); open-repair cards show alongside it.
  const nothingToPay = headline.kind === "paid" || headline.kind === "none";
  return <section className="v3-tenant-home" data-testid="tenant-home-v3" data-headline={headline.kind}>
    <h1 className="t-home-lead">{tenantHomeSentence(headline, view.currency, locale, name, company)}
      {headline.kind === "paid" ? <> <span className="t-home-ok" data-testid="tenant-home-tick"><CompletionCheck />{tenantPaymentHistoryCopy(locale).confirmed}</span></> : null}
    </h1>
    {view.waiting ? <p className="t-home-wait" data-testid="tenant-home-wait"><WaitMark />{copy.waiting.replace("{company}", company)}</p> : null}
    {view.repairs.map(repair => <div key={repair.id} className="t-home-card" data-testid="tenant-home-repair">
      <div className="t-home-row"><h2>{copy.repairTitle.replace("{title}", repair.title)}</h2><span className="t-home-badge">{copy.steps[repair.step]}</span></div>
      <Link className="t-home-text" href={`/t/repair?id=${encodeURIComponent(repair.id)}`}>{copy.viewProgress}</Link>
    </div>)}
    {nothingToPay ? <div className="t-home-card t-home-empty" data-testid="tenant-home-empty"><Illustration name="07" /></div> : null}
  </section>;
}

/** TEN-54-AC4: the headline area is a skeleton; nothing (no amount, no NT$0) is shown while loading. */
export function TenantHomeLoading() {
  return <section className="v3-tenant-home" data-testid="tenant-home-loading" aria-busy="true">
    <div className="t-home-skel t-home-skel-lead" aria-hidden="true" />
    <div className="t-home-skel t-home-skel-card" aria-hidden="true" />
  </section>;
}

/** TEN-54-AC4: a failed read shows the approved line and 「再試一次」 (an outline link back to 首頁). */
export function TenantHomeError({ locale }: { locale: Locale }) {
  const copy = brandV3TenantHomeCopy(locale);
  return <section className="v3-tenant-home" data-testid="tenant-home-error">
    <h1 className="t-home-lead">{copy.tabs.home}</h1>
    <div className="t-home-card" role="alert"><p>{copy.readFailed}</p><Link className="t-home-outline" href="/t">{copy.retry}</Link></div>
  </section>;
}

export function TenantHomeState({ view, locale, name, company, legacy }: {
  view: TenantHomeView; locale: Locale; name: string; company: string; legacy: ReactNode;
}) {
  if (view.state === "off") return <>{legacy}</>;
  if (view.state === "error") return <TenantHomeError locale={locale} />;
  return <TenantHomeV3 view={view} locale={locale} name={name} company={company} />;
}
