import React from "react";
import Link from "next/link";
import { dictionary, makeT, type Locale } from "../../../i18n";
import { brandV3OwnerStateCopy } from "../../../i18n/lanes/brand-v3";
import { brandV3OwnerDecidedCopy } from "../../../i18n/lanes/brand-v3-owner-decided";
import { brandV3OwnerUnitsCopy } from "../../../i18n/lanes/brand-v3-owner-units";
import { ticketRelayCopy } from "../../../i18n/lanes/brand-v3-ticket-relay";
import { MAINTENANCE_STATUS_WORD } from "../../../lib/b3-ticket-relay";
import type { OwnerUnitDetail, OwnerUnitMonth } from "../../../server/b092-owner-unit";
import { formatDate, moneyLabel } from "../../../server/format";
import { displaySampleName } from "../../../server/sandbox-data";
import type { CalendarMode } from "../../../server/types";
import { Illustration } from "../illustrations";

/**
 * RO-UNIT (OWN-33-AC2/AC4), frame 「總覽・我的物件・信義路 2 樓」: one authorised space, read-only. Tenant (or 「租客」
 * when the company hides names), phone only when the gateway returns one, term, rent; 「最近的繳款」 per month with the
 * RO-UNITS status words; 「進行中的報修」 with the approved maintenance status words. No buttons, no forms.
 */
const Crumb = ({ locale }: { locale: Locale }) =>
  <nav className="owner-unit-crumb"><Link href="/o" data-testid="owner-unit-crumb">{brandV3OwnerUnitsCopy(locale).title}</Link></nav>;

/** The RO-UNITS wording per month; 'none' shows nothing. */
export function monthStatusText(month: OwnerUnitMonth, currency: string | null, locale: Locale): string | null {
  const c = brandV3OwnerUnitsCopy(locale);
  if (month.status === "paid") return c.paid;
  if (month.status === "overdue") return c.overdue;
  if (month.status === "partial" && month.remainingMinor && currency) return c.partial(moneyLabel(month.remainingMinor, currency, locale));
  return null;
}

/** 租期 in the app's own date format (OQ-079; the org's ROC-calendar setting, as RO-DECIDED), joined by the frame's 「～」. */
export function termText(unit: Pick<OwnerUnitDetail, "startDate" | "endDate">, locale: Locale, calendar: CalendarMode): string | null {
  if (!unit.startDate) return null;
  const day = (value: string | null) => value ? formatDate(value, locale, calendar, dictionary(locale)) : "";
  return `${day(unit.startDate)}～${day(unit.endDate)}`;
}

export function OwnerUnitView({ unit, locale, calendar }: { unit: OwnerUnitDetail; locale: Locale; calendar: CalendarMode }) {
  const c = brandV3OwnerUnitsCopy(locale), t = makeT(locale), mnt = ticketRelayCopy(locale).mntStatus;
  const term = termText(unit, locale, calendar);
  return <section className="v3-owner-unit owner-unit" data-testid="owner-unit">
    <Crumb locale={locale} />
    <h2>{displaySampleName(`${unit.property} ${unit.space}`)}</h2>
    <div className="owner-unit-card card">
      <dl className="owner-unit-facts">
        <div><dt>{c.tenant}</dt><dd data-testid="owner-unit-tenant">{unit.tenant === null ? c.tenantHidden : displaySampleName(unit.tenant)}</dd></div>
        {unit.phone !== null && <div><dt>{t("i_phone_label")}</dt><dd className="num" data-testid="owner-unit-phone">{unit.phone}</dd></div>}
        {term && <div><dt>{t("i_term")}</dt><dd className="num">{term}</dd></div>}
        {unit.rentMinor && unit.currency && <div><dt>{t("i_rent_label")}</dt><dd className="num">{moneyLabel(unit.rentMinor, unit.currency, locale)}</dd></div>}
      </dl>
    </div>
    {unit.months.length > 0 && <section className="owner-unit-card card" data-testid="owner-unit-payments">
      <h3>{c.recentPayments}</h3>
      <ul className="owner-unit-lines">{unit.months.map(m => {
        const status = monthStatusText(m, unit.currency, locale);
        return <li key={m.month} className={`owner-unit-${m.status}`}>
          <span>{c.month(Number(m.month.slice(5)))}</span>
          {status && <span className="owner-unit-status">{status}</span>}
        </li>;
      })}</ul>
    </section>}
    {unit.repairs.length > 0 && <section className="owner-unit-card card" data-testid="owner-unit-repairs">
      <h3>{c.openRepairs}</h3>
      <ul className="owner-unit-lines">{unit.repairs.map(r => <li key={r.id}>
        <span>{r.title}</span><span className="owner-unit-status">{mnt[MAINTENANCE_STATUS_WORD[r.status]]}</span>
      </li>)}</ul>
    </section>}
  </section>;
}

/** O-STATES read error in place, with an outline retry back to the same panel. */
export function OwnerUnitError({ locale, retryHref }: { locale: Locale; retryHref: string }) {
  const state = brandV3OwnerStateCopy(locale);
  return <section className="v3-owner-unit owner-unit" data-testid="owner-unit-error">
    <Crumb locale={locale} />
    <div className="owner-unit-card card" role="alert"><p>{state.error}</p><a className="owner-action" href={retryHref}>{state.retry}</a></div>
  </section>;
}

/** GS-03 / B1-NOPERM (as RO-DECIDED and RO-RULES): drawing 26, one sentence, one primary back home. No space is named. */
export function OwnerUnitNoPerm({ locale }: { locale: Locale }) {
  const copy = brandV3OwnerDecidedCopy(locale);
  return <section className="v3-owner-unit owner-unit owner-unit-noperm" data-testid="owner-unit-noperm">
    <Illustration name="26" /><p>{copy.noPerm}</p>
    <Link className="owner-action owner-primary" href="/o">{copy.home}</Link>
  </section>;
}
