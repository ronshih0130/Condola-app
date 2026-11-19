import React, { type ReactNode } from "react";
import Link from "next/link";
import { dictionary, type Locale } from "../../../i18n";
import { brandV3TenantLeaseRepairCopy } from "../../../i18n/lanes/brand-v3-tenant-lease-repair";
import { formatDate, moneyLabel } from "../../../server/format";
import type { TenantLeaseTerms } from "../../../server/b090-tenant-lease-repair";
import type { CalendarMode } from "../../../server/types";

/**
 * RT-LEASE (更多 › 我的租約), read part (TEN-57-AC1): the terms card 物件／租期／租金／繳租日／押金, read-only.
 * The renewal question needs B-089 and is not shown, so the heading is the frames' page title 「我的租約」. The deposit
 * card (TEN-49) stays legal-blocked. Today's ID check, lease PDF, signed copies, first-period summary and firm line are
 * rendered by the route and passed in (`before` / `after`).
 */
export function TenantLeaseV3({ terms, locale, calendar, place, before, after }: {
  terms: TenantLeaseTerms; locale: Locale; calendar: CalendarMode; place: string; before: ReactNode; after: ReactNode;
}) {
  const copy = brandV3TenantLeaseRepairCopy(locale).lease;
  const dict = dictionary(locale);
  const date = (d: string) => formatDate(d, locale, calendar, dict);
  return <section className="v3-tenant-lease" data-testid="tenant-lease-v3">
    <h1 className="t-ls-lead">{copy.title}</h1>
    {before}
    <div className="t-ls-card" data-testid="tenant-lease-terms">
      <p className="t-ls-kv"><span>{copy.place}</span><b>{place}</b></p>
      <p className="t-ls-kv"><span>{copy.period}</span><b>{copy.periodValue.replace("{start}", date(terms.start)).replace("{end}", date(terms.end))}</b></p>
      <p className="t-ls-kv" data-testid="tenant-lease-rent" data-minor={terms.rentMinor}><span>{copy.rent}</span><b className="t-ls-num">{copy.rentValue.replace("{amount}", moneyLabel(terms.rentMinor, terms.currency, locale))}</b></p>
      {terms.dueDay !== null ? <p className="t-ls-kv" data-testid="tenant-lease-due-day"><span>{copy.dueDay}</span><b>{copy.dueDayValue.replace("{day}", String(terms.dueDay))}</b></p> : null}
      <p className="t-ls-kv" data-testid="tenant-lease-deposit" data-minor={terms.depositMinor}><span>{copy.deposit}</span><b className="t-ls-num">{moneyLabel(terms.depositMinor, terms.currency, locale)}</b></p>
    </div>
    {after}
  </section>;
}

/** G-LOAD (GS-02 = A): skeleton only, no amount. */
export function TenantLeaseLoading() {
  return <section className="v3-tenant-lease" data-testid="tenant-lease-loading" aria-busy="true">
    <div className="t-ls-skel t-ls-skel-lead" aria-hidden="true" />
    <div className="t-ls-skel t-ls-skel-card" aria-hidden="true" />
  </section>;
}

/** G-ERR (GS-02 = A): the approved read-error line with 「再試一次」. */
export function TenantLeaseError({ locale }: { locale: Locale }) {
  const copy = brandV3TenantLeaseRepairCopy(locale);
  return <section className="v3-tenant-lease" data-testid="tenant-lease-error">
    <h1 className="t-ls-lead">{copy.lease.title}</h1>
    <div className="t-ls-card" role="alert"><p>{copy.readFailed}</p><Link className="t-ls-outline" href="/t/lease">{copy.retry}</Link></div>
  </section>;
}
