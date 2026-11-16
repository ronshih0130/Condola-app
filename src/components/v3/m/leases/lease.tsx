import React from "react";
import Link from "next/link";
import { makeT, type Locale } from "../../../../i18n";
import { leasesCopy } from "../../../../i18n/lanes/brand-v3-leases";
import { tenantOneCopy } from "../../../../i18n/lanes/brand-v3-tenant-one";
import { tenantsCopy } from "../../../../i18n/lanes/brand-v3-tenants";
import type { LeaseReady, LeaseResult } from "../../../../server/b3-leases";
import { moneyLabel } from "../../../../server/format";
import { displaySampleName } from "../../../../server/sandbox-data";
import { statusKey } from "../../../ui";
import { Illustration } from "../../illustrations";

/** Lease page tabs built here. 點交 is the existing /m/handover/[leaseId] page. */
export const LEASE_V3_TABS = ["fees", "deposit", "moveout"] as const;
export type LeaseV3Tab = "overview" | (typeof LEASE_V3_TABS)[number];
type LegacyTab = "summary" | "ledger" | "sign" | "msg";

/** Under brand_v3, /m/leases/[id] shows this page only for its own tab URLs. Every other query
 * (the legacy ?tab=summary|ledger|sign|msg, ?error=, ?created=, ?saved=, ?audit=, …) keeps the
 * existing page, so its write controls and redirects stay reachable unchanged. */
export function leaseV3View(query: Record<string, string | undefined>) {
  const keys = Object.keys(query);
  if (keys.some(key => key !== "tab")) return false;
  return query.tab === undefined || (LEASE_V3_TABS as readonly string[]).includes(query.tab);
}
export function leaseV3Tab(tab: string | undefined): LeaseV3Tab {
  return (LEASE_V3_TABS as readonly string[]).includes(tab ?? "") ? tab as LeaseV3Tab : "overview";
}
export function leaseHref(id: string, tab: LeaseV3Tab = "overview") {
  return `/m/leases/${encodeURIComponent(id)}${tab === "overview" ? "" : `?tab=${tab}`}`;
}
const LEGACY_LABEL: Record<LegacyTab, string> = { summary: "s_6b6fe14", ledger: "s_6ef99a0", sign: "s_8ecfcf9", msg: "s_b95abdb" };
/** Existing pages keep their own controls and permission checks; links only. */
function LegacyLinks({ id, tabs, locale }: { id: string; tabs: LegacyTab[]; locale: Locale }) {
  const t = makeT(locale);
  return <nav className="v3-lease-legacy" aria-label={t("i_nav_leases")}>
    {tabs.map(tab => <Link key={tab} className="btn" data-testid={`lease-legacy-${tab}`}
      href={`/m/leases/${encodeURIComponent(id)}?tab=${tab}`}>{t(LEGACY_LABEL[tab])}</Link>)}
  </nav>;
}
/** R2-TEN-ONE sentence; without an end date keep the tenant name only (the approved R2 fallback). */
export function leaseLead(data: Pick<LeaseReady, "tenant" | "place" | "endDate">, locale: Locale) {
  if (!data.endDate) return displaySampleName(data.tenant);
  const values = { name: displaySampleName(data.tenant), unit: displaySampleName(data.place), date: data.endDate };
  return tenantOneCopy(locale).lead.replace(/\{(name|unit|date)\}/g, (_, key: keyof typeof values) => values[key]);
}
/** GS-02: skeletons only; no amount, count or date. */
export function LeaseLoading({ locale }: { locale: Locale }) {
  return <section className="v3-leases v3-lease" aria-busy="true" aria-label={tenantsCopy(locale).loading}>
    {["lead", "tabs", "card"].map(part => <div className={`v3-leases-skeleton v3-lease-skeleton-${part}`} key={part} aria-hidden="true" />)}
  </section>;
}
/** B1-NOPERM (GS-03): drawing 26, one sentence, one primary back home. */
export function NoPermission({ locale, home }: { locale: Locale; home: string }) {
  const c = leasesCopy(locale);
  return <section className="v3-leases v3-lease-noperm" data-testid="b1-noperm" role="status">
    <Illustration name="26" /><p>{c.noPerm}</p><Link className="btn pri" href={home}>{c.home}</Link>
  </section>;
}
export function LeaseView({ data, locale, id, tab = "overview", handover = false, home = "/m" }: {
  data: LeaseResult | { state: "forbidden" }; locale: Locale; id: string; tab?: LeaseV3Tab;
  /** The existing handover reader admits this session for this lease. */
  handover?: boolean; home?: string;
}) {
  const c = leasesCopy(locale), t = makeT(locale);
  if (data.state === "forbidden") return <NoPermission locale={locale} home={home} />;
  if (data.state !== "ready") return <section className="v3-leases v3-lease" data-testid="v3-lease">
    <div className="v3-leases-card v3-leases-empty" role="alert"><p>{c.readError}</p>
      <Link className="btn" href={leaseHref(id, tab)}>{c.retry}</Link></div></section>;
  const money = (minor: string) => moneyLabel(minor, data.currency, locale);
  const tabs: { key: LeaseV3Tab | "handover"; label: string; href: string }[] = [
    { key: "overview", label: c.overview, href: leaseHref(data.id) },
    { key: "fees", label: c.fees, href: leaseHref(data.id, "fees") },
    { key: "deposit", label: c.deposit, href: leaseHref(data.id, "deposit") },
    ...(handover ? [{ key: "handover" as const, label: c.handover, href: `/m/handover/${encodeURIComponent(data.id)}` }] : []),
    { key: "moveout", label: c.moveOut, href: leaseHref(data.id, "moveout") },
  ];
  return <section className="v3-leases v3-lease" data-testid="v3-lease">
    <header className="v3-leases-lead"><h1>{leaseLead(data, locale)}</h1></header>
    <nav className="v3-lease-tabs" aria-label={t("i_nav_leases")}>
      {tabs.map(item => <Link key={item.key} href={item.href} data-testid={`lease-tab-${item.key}`}
        aria-current={item.key === tab ? "page" : undefined}>{item.label}</Link>)}
    </nav>
    {tab === "overview" && <>
      <section className="v3-leases-card v3-lease-card" aria-label={c.overview}>
        <dl>
          <div><dt>{t("i_period")}</dt><dd><span className="num">{data.startDate}</span>
            {data.endDate && <> – <span className="num">{data.endDate}</span></>}</dd></div>
          <div><dt>{t("i_rent_label")}</dt><dd className="num" data-testid="lease-rent">{money(data.rentMinor)}</dd></div>
          <div><dt>{t("i_deposit_label")}</dt><dd className="num">{money(data.depositMinor)}</dd></div>
          <div><dt>{t("i_due_day_label")}</dt><dd className="num">{data.dueDay}</dd></div>
          <div><dt>{t("i_status")}</dt><dd>{data.status === "active" ? c.active : t(statusKey(data.status))}</dd></div>
        </dl>
      </section>
      <LegacyLinks id={data.id} tabs={["summary", "ledger", "sign", "msg"]} locale={locale} />
    </>}
    {/* R3-FEES cards need B-049 fixed monthly fees and MF-1 one-off fees; neither exists yet. */}
    {tab === "fees" && <LegacyLinks id={data.id} tabs={["ledger"]} locale={locale} />}
    {tab === "deposit" && <>
      <section className="v3-leases-card v3-lease-card" aria-labelledby="lease-deposit-title">
        <h2 id="lease-deposit-title">{c.deposit}</h2>
        <dl><div><dt>{c.agreedDeposit}</dt><dd className="num" data-testid="lease-agreed-deposit">{money(data.depositMinor)}</dd></div></dl>
      </section>
      <LegacyLinks id={data.id} tabs={["ledger"]} locale={locale} />
    </>}
    {tab === "moveout" && <LegacyLinks id={data.id} tabs={["summary"]} locale={locale} />}
  </section>;
}
