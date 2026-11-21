import React from "react";
import Link from "next/link";
import type { Locale } from "../../../i18n";
import { brandV3OwnerStateCopy } from "../../../i18n/lanes/brand-v3";
import { brandV3OwnerDecidedCopy } from "../../../i18n/lanes/brand-v3-owner-decided";
import { ownStatusCopy } from "../../../i18n/lanes/brand-v3-own-status";
import { vendorWorkbenchCopy } from "../../../i18n/lanes/brand-v3-vendor-workbench";
import type { VendorJobRow, VendorPaymentRow } from "../../../server/vendor-workbench";
import { Illustration } from "../illustrations";
import baseTokens from "../../../brand/v2/tokens.json";
import brandTokens from "../../../brand/v3/tokens.json";

/**
 * B-063 screens inside the vendor shell. No solid primary on V-HOME, V-JOBS or V-RECV (rows use outline 查看);
 * the only solid button is 「再試一次」 when a read fails (GS-02, as O-STATES) and 回到首頁 on B1-NOPERM (GS-03).
 */
export type VendorWorkbenchScreenId = "home" | "jobs" | "payments";

function name(row: { property: string; item: string }) {
  return [row.property.trim(), row.item].filter(Boolean).join("・");
}
function View({ href, locale }: { href: string | null; locale: Locale }) {
  return href ? <a className="vendor-action" href={href} data-testid="vendor-row-view">{vendorWorkbenchCopy(locale).view}</a> : null;
}

function JobRows({ rows, locale }: { rows: VendorJobRow[]; locale: Locale }) {
  const copy = vendorWorkbenchCopy(locale);
  return <ul className="vendor-rows">{rows.map(row => <li className="vendor-row" key={row.jobId} data-testid="vendor-job-row">
    <div className="vendor-row-main"><b>{name(row)}</b>
      <span className="vendor-badges"><span className="vendor-badge vendor-badge-info">{row.status === "working" ? copy.working : copy.visit}</span></span></div>
    <View href={row.href} locale={locale} />
  </li>)}</ul>;
}
function PaymentRows({ rows, locale }: { rows: VendorPaymentRow[]; locale: Locale }) {
  const own = ownStatusCopy(locale);
  return <>
    <ul className="vendor-rows">{rows.map(row => <li className="vendor-row" key={row.jobId} data-testid="vendor-payment-row">
      <div className="vendor-row-main"><b>{name(row)}</b>
        <span className="vendor-badges"><span className="vendor-badge vendor-badge-warn">{own.vendorStatus}</span><span className="num" data-testid="vendor-payment-amount">{row.amount}</span></span></div>
      <View href={row.href} locale={locale} />
    </li>)}</ul>
    <p className="vendor-note">{vendorWorkbenchCopy(locale).note}</p>
  </>;
}

/** V-EMPTY (VEN-14-AC4): drawing 21, the approved heading and reason, no button. */
export function VendorEmpty({ locale }: { locale: Locale }) {
  return <section className="vendor-card vendor-empty" data-testid="vendor-empty">
    <Illustration name="21" /><h2>{vendorWorkbenchCopy(locale).emptyTitle}</h2><p>{ownStatusCopy(locale).vendorEmpty}</p>
  </section>;
}

/**
 * V-HOME (VEN-14-AC1…AC3): the open-jobs card and the own-status list card; both empty is V-EMPTY. V-HOME-ONE
 * (round 7 batch 4): one empty card keeps its title and one line (目前沒有未結案件, or the V-RECV empty heading), no
 * illustration, and the note only with rows.
 */
export function VendorHome({ jobs, payments, locale }: { jobs: VendorJobRow[]; payments: VendorPaymentRow[]; locale: Locale }) {
  const copy = vendorWorkbenchCopy(locale), own = ownStatusCopy(locale);
  if (!jobs.length && !payments.length) return <div className="v3-vendor-workbench" data-testid="vendor-home"><VendorEmpty locale={locale} /></div>;
  return <div className="v3-vendor-workbench" data-testid="vendor-home">
    <section className="vendor-card" aria-labelledby="vendor-home-jobs" data-testid="vendor-home-jobs">
      <h2 id="vendor-home-jobs">{copy.openJobs}</h2>
      {jobs.length ? <JobRows rows={jobs} locale={locale} /> : <p className="vendor-card-empty">{copy.emptyTitle}</p>}
    </section>
    <section className="vendor-card" aria-labelledby="vendor-home-payments" data-testid="vendor-home-payments">
      <h2 id="vendor-home-payments">{own.vendorListTitle}</h2>
      {payments.length ? <PaymentRows rows={payments} locale={locale} /> : <p className="vendor-card-empty">{own.vendorListEmpty}</p>}
    </section>
  </div>;
}

/** V-JOBS: the 未結案件 list as on V-HOME. Empty (round 7 batch 1): drawing 21, heading, one sentence, no button. */
export function VendorJobs({ jobs, locale }: { jobs: VendorJobRow[]; locale: Locale }) {
  const copy = vendorWorkbenchCopy(locale);
  return <div className="v3-vendor-workbench" data-testid="vendor-jobs">
    {jobs.length ? <section className="vendor-card" aria-labelledby="vendor-jobs-title">
      <h2 id="vendor-jobs-title">{copy.openJobs}</h2><JobRows rows={jobs} locale={locale} />
    </section> : <section className="vendor-card vendor-empty" data-testid="vendor-jobs-empty">
      <Illustration name="21" /><h2>{copy.emptyTitle}</h2><p>{copy.jobsEmpty}</p>
    </section>}
  </div>;
}

/** V-RECV: the title is the page lead (shown once); rows and the note as on V-HOME. Empty: drawing 22 + heading. */
export function VendorPayments({ payments, locale }: { payments: VendorPaymentRow[]; locale: Locale }) {
  return <div className="v3-vendor-workbench" data-testid="vendor-payments">
    {payments.length ? <section className="vendor-card" aria-label={ownStatusCopy(locale).vendorListTitle}>
      <PaymentRows rows={payments} locale={locale} />
    </section> : <section className="vendor-card vendor-empty" data-testid="vendor-payments-empty">
      <Illustration name="22" /><h2>{ownStatusCopy(locale).vendorListEmpty}</h2>
    </section>}
  </div>;
}

/** GS-02 / VEN-14-AC5: skeletons only, never a number, count or NT$0. */
export function VendorWorkbenchLoading({ screen, locale }: { screen: VendorWorkbenchScreenId; locale: Locale }) {
  const copy = vendorWorkbenchCopy(locale), own = ownStatusCopy(locale);
  const card = (title: string | null, key: string) => <section className="vendor-card" key={key}>
    {title ? <h2>{title}</h2> : null}
    <div aria-hidden="true">{[0, 1].map(i => <div className="vendor-skeleton" key={i}><span /><span /></div>)}</div>
  </section>;
  return <div className="v3-vendor-workbench" aria-busy="true" data-testid="vendor-loading">
    {screen === "payments" ? card(null, "payments") : card(copy.openJobs, "jobs")}
    {screen === "home" ? card(own.vendorListTitle, "payments") : null}
  </div>;
}

/** GS-02 / VEN-14-AC6: read error in place; 「再試一次」 reloads the same page (the only action, so solid). */
export function VendorWorkbenchError({ locale, retryHref }: { locale: Locale; retryHref: string }) {
  const state = brandV3OwnerStateCopy(locale);
  return <div className="v3-vendor-workbench" data-testid="vendor-error">
    <section className="vendor-card" role="alert"><p>{state.error}</p>
      <a className="vendor-action vendor-primary" href={retryHref}>{state.retry}</a></section>
  </div>;
}

/** GS-03 / B1-NOPERM for a signed-in person who is not a vendor account: drawing 26, one sentence, back home. */
// That person's own organization brand is not this page's, so (like V-TOKEN) the canonical tokens are scoped here.
const scopedTokens = Object.fromEntries(
  [baseTokens.color, baseTokens.font, baseTokens.size, baseTokens.space, baseTokens.radius,
    baseTokens.shadow, baseTokens.layout, brandTokens.color, brandTokens.radius]
    .flatMap(group => Object.entries(group).map(([key, entry]) => [`--${key}`, entry.value])),
) as React.CSSProperties;
export function VendorNoPerm({ locale }: { locale: Locale }) {
  const copy = brandV3OwnerDecidedCopy(locale);
  return <main className="vendor-noperm" data-testid="vendor-noperm" style={scopedTokens}>
    {/* eslint-disable-next-line @next/next/no-css-tags -- B1-NOPERM outside any v3 shell, like the bearer token page */}
    <link rel="stylesheet" href="/brand/v3/vendor.css" />
    <Illustration name="26" /><p>{copy.noPerm}</p>
    <Link className="vendor-noperm-home" href="/">{copy.home}</Link>
  </main>;
}
