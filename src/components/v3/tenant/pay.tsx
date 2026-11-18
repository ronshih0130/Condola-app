import React, { type ReactNode } from "react";
import Link from "next/link";
import { makeT, type Locale } from "../../../i18n";
import { errorText } from "../../../i18n/errors";
import { brandV3TenantHomeCopy } from "../../../i18n/lanes/brand-v3-tenant-home";
import { brandV3TenantPayCopy } from "../../../i18n/lanes/brand-v3-tenant-pay";
import { payeeStrings } from "../../../i18n/payee";
import { tenantPaymentHistoryCopy } from "../../../i18n/tenant-payment-history";
import { moneyLabel } from "../../../server/format";
import type { TenantPayAccount, TenantPayView } from "../../../server/b090-tenant-pay";
import type { PayBadge, PayHistoryLine } from "../../../server/b090-tenant-pay-rules";
import { groupedMajor, serverErrorField, type ReportField, type ReportProblem } from "../../../server/b090-tenant-pay-form";
import { CompletionCheck } from "../completion-check";
import { WaitMark } from "../wait-mark";
import { tenantHomeSentence } from "./home";
import { PayCopyButton, ReportDraftSweep, TenantReportForm, type DraftOwner, type ReportAction } from "./pay-client";

type Ready = Extract<TenantPayView, { state: "ready" }>;
const money = (minor: number, currency: string, locale: Locale) => moneyLabel(minor, currency, locale);

/** 「10 月」, or 「2025 年 12 月」 outside the property's current year. */
export function payMonthLabel(ym: string, today: string, locale: Locale): string {
  const home = brandV3TenantHomeCopy(locale), copy = brandV3TenantPayCopy(locale);
  const month = home.month(ym);
  if (locale === "zh-TW" && ym.slice(0, 4) === today.slice(0, 4)) return `${month} 月`;
  return copy.monthWithYear.replace("{year}", String(Number(ym.slice(0, 4)))).replace("{month}", month);
}

function badgeOf(badge: PayBadge, currency: string, locale: Locale): { tone: "warn" | "danger" | "ok" | "mute"; text: string } {
  const copy = brandV3TenantPayCopy(locale).badge;
  switch (badge.kind) {
    case "due": return { tone: "warn", text: copy.due };
    case "overdue": return { tone: "danger", text: copy.overdue };
    case "sent": return { tone: "warn", text: copy.sent };
    case "partial": return { tone: "warn", text: copy.partial.replace("{amount}", money(badge.restMinor, currency, locale)) };
    case "paid": return { tone: "ok", text: copy.paid };
    case "none": {
      const bill = tenantPaymentHistoryCopy(locale);
      return { tone: "mute", text: ({ unsigned: bill.unsigned, no_invoice: bill.noInvoice, nonpayable: bill.nonpayable, zero_charge: bill.zeroCharge, credit: bill.credit,
        offset: bill.offset, due: bill.due, partial: bill.partial, paid: bill.paid })[badge.state] };
    }
  }
}

/** TEN-53-AC3 / AC4: the clock line while reports wait for the company. */
export function TenantPayWaiting({ view, locale, company }: { view: Ready; locale: Locale; company: string }) {
  const w = view.pay.waiting;
  if (!w) return null;
  const copy = brandV3TenantPayCopy(locale);
  const text = (w.restMinor > 0 ? copy.waitingRest : copy.waiting).replace("{pending}", money(w.pendingMinor, view.currency, locale))
    .replace("{company}", company).replace("{rest}", money(w.restMinor, view.currency, locale));
  return <p className="t-pay-wait" data-testid="tenant-pay-wait"><WaitMark /><span>{text}</span></p>;
}

/** TEN-53-AC5 (TEN-51): the latest report was not accepted, so it is the tenant's turn again, with the reason. */
function TenantPayRedo({ view, locale }: { view: Ready; locale: Locale }) {
  if (!view.redo) return null;
  const bill = tenantPaymentHistoryCopy(locale);
  return <p className="t-pay-redo" data-testid="tenant-pay-redo"><b>{brandV3TenantPayCopy(locale).redo}</b>
    <span>{view.redo.reason ? `${bill.rejectionReason}: ${view.redo.reason}` : bill.rejectionReasonUnavailable}</span></p>;
}

/** TEN-52-AC2: where to pay. The account belongs to the owner (屋主) or the company (管理方). */
export function TenantPayAccountCard({ account, locale, brand }: { account: TenantPayAccount; locale: Locale; brand: string }) {
  const copy = brandV3TenantPayCopy(locale), home = brandV3TenantHomeCopy(locale), t = makeT(locale);
  let body: ReactNode;
  if (account.kind === "account") {
    const bank = account.bank && account.bankCode ? copy.bankWithCode.replace("{bank}", account.bank).replace("{code}", account.bankCode) : account.bank ?? account.bankCode;
    const labels = payeeStrings(locale);
    body = <>
      {account.holder ? <p className="t-pay-kv"><span>{copy.holder}</span><b>{account.holder}</b></p> : null}
      {bank ? <p className="t-pay-kv"><span>{copy.bank}</span><b>{bank}</b></p> : null}
      <div className="t-pay-kv"><span>{copy.number}</span><span className="t-pay-number"><b className="num" data-testid="tenant-pay-number">{account.number}</b><PayCopyButton value={account.number} label={copy.copy} /></span></div>
      {account.swift ? <p className="t-pay-kv"><span>{labels.swift}</span><b>{account.swift}</b></p> : null}
      {account.routing ? <p className="t-pay-kv"><span>{labels.routing}</span><b>{account.routing}</b></p> : null}
      <p className="t-pay-note">{copy.direct.replace("{payee}", account.payee === "owner" ? copy.payeeOwner : copy.payeeCompany).replace("{brand}", brand)}</p>
    </>;
  } else if (account.kind === "legacy") {
    // payee_details OFF: the existing tenant line (the last five digits only) and the existing direct-payment line.
    body = <><p>{t("i_account_last5", { last5: account.last5 })}</p><p className="t-pay-note">{t("i_pay_direct", { brand })}</p></>;
  } else if (account.kind === "none") {
    body = <><p>{copy.noAccount}</p><Link className="t-pay-text" href="/t/messages" data-testid="tenant-pay-message">{copy.message}</Link></>;
  } else {
    body = <div role="alert" className="t-pay-alert"><p>{home.readFailed}</p><Link className="t-pay-outline" href="/t/pay">{home.retry}</Link></div>;
  }
  return <div className="t-pay-card" data-testid="tenant-pay-account" data-kind={account.kind}><h2>{copy.accountTitle}</h2>{body}</div>;
}

const historyTone = { confirmed: "ok", submitted: "warn", rejected: "warn", reversed: "mute" } as const;

/** TEN-52-AC3: one line per month, newest first; the line opens that month's reports. */
export function TenantPayHistory({ lines, today, locale, older = false }: { lines: PayHistoryLine[]; today: string; locale: Locale; older?: boolean }) {
  if (!lines.length) return null;
  const copy = brandV3TenantPayCopy(locale), bill = tenantPaymentHistoryCopy(locale);
  // Only the most recent months are listed (complete totals each). Older months exist when `older`; there is no approved
  // wording or tenant page for them yet, so no link is shown (reported for Ron).
  return <div className="t-pay-card" data-testid="tenant-pay-history" data-older={older ? "true" : undefined}><h2>{copy.historyTitle}</h2>
    {lines.map(line => {
      const month = payMonthLabel(line.month, today, locale);
      return <details key={line.month} className="t-pay-hrow" data-month={line.month} data-status={line.status} data-count={line.count}>
        <summary><span>{month}　<span className="num">{money(line.amountMinor, line.currency, locale)}</span></span>
          <span className={`t-pay-badge t-pay-${historyTone[line.status]}`}>{line.status === "confirmed" ? <CompletionCheck /> : line.status === "submitted" ? <WaitMark /> : null}{copy.history[line.status]}</span></summary>
        {line.status === "rejected" ? <p className="t-pay-reason">{line.reason ? `${bill.rejectionReason}: ${line.reason}` : bill.rejectionReasonUnavailable}</p> : null}
        <ul aria-label={copy.reportsIn.replace("{month}", month)}>{line.reports.map(r => <li key={r.id}>
          <span><time dateTime={r.paidOn}>{r.paidOn}</time>　<span className="num">{money(r.amountMinor, r.currency, locale)}</span></span><span>{copy.history[r.status]}</span>
        </li>)}</ul>
      </details>;
    })}
  </div>;
}

/**
 * RT-PAY 「繳款・這個月要繳」. The lead is RT-HOME's sentence without the greeting (待繳: 「{月} 月租金 NT${amount}，{date} 前繳。」).
 * 「回報已繳」 is the page's only solid button, hidden when nothing is owed or everything is already reported.
 */
export function TenantPayV3({ view, locale, place, company, brand }: { view: Ready; locale: Locale; place: string; company: string; brand: string }) {
  const copy = brandV3TenantPayCopy(locale);
  const { pay } = view;
  const badge = badgeOf(pay.badge, view.currency, locale);
  return <section className="v3-tenant-pay" data-testid="tenant-pay-v3" data-headline={pay.headline.kind}>
    <h1 className="t-pay-lead">{tenantHomeSentence(pay.headline, view.currency, locale, "", company)}</h1>
    <TenantPayRedo view={view} locale={locale} />
    <TenantPayWaiting view={view} locale={locale} company={company} />
    <div className="t-pay-card" data-testid="tenant-pay-bill">
      <p className="t-pay-kv"><span>{copy.place}</span><b>{place}</b></p>
      {pay.owedMinor !== null ? <p className="t-pay-kv"><span>{copy.amount}</span><b className="num" data-testid="tenant-pay-amount">{money(pay.owedMinor, view.currency, locale)}</b></p> : null}
      <div className="t-pay-kv"><span>{copy.status}</span><span className={`t-pay-badge t-pay-${badge.tone}`} data-testid="tenant-pay-status">{pay.badge.kind === "paid" ? <CompletionCheck /> : null}{badge.text}</span></div>
      {pay.canReport ? <Link className="t-pay-solid" href="/t/pay?report=1" data-testid="tenant-pay-report">{copy.report}</Link> : null}
    </div>
    {view.account ? <TenantPayAccountCard account={view.account} locale={locale} brand={brand} /> : null}
    <TenantPayHistory lines={view.history} today={view.today} locale={locale} older={view.olderMonths} />
    <ReportDraftSweep />
  </section>;
}

/**
 * RT-REPORT 「回報已繳・只報還差的」. Only the not-yet-reported rest can be sent (prefilled and the maximum). When
 * everything is reported there is no form, only the waiting line. 轉帳截圖 is hidden until attachments ship (B-086).
 */
export function TenantReportV3({ view, locale, company, owner, errorKey, renderId, action }: {
  view: Ready; locale: Locale; company: string; owner: DraftOwner; errorKey: string | undefined; renderId: string; action: ReportAction;
}) {
  const copy = brandV3TenantPayCopy(locale), t = makeT(locale);
  const { pay } = view;
  const field = serverErrorField(errorKey);
  const message = errorKey ? errorText(t, errorKey) : "";
  const messages: Record<ReportProblem, string> = {
    amountPositive: copy.amountPositive, overLimit: errorText(t, "errors.amountOverUnreported"), required: errorText(t, "errors.required"), last5: errorText(t, "errors.last5"),
  };
  return <section className="v3-tenant-pay" data-testid="tenant-report-v3">
    <h1 className="t-pay-lead">{copy.formTitle}</h1>
    <TenantPayRedo view={view} locale={locale} />
    <TenantPayWaiting view={view} locale={locale} company={company} />
    {pay.canReport ? <TenantReportForm key={renderId} action={action} owner={owner} currency={view.currency} restMinor={pay.restMinor}
      defaults={{ amount: groupedMajor(pay.restMinor, view.currency), paidOn: view.today, last5: view.lastLast5 ?? "", note: "" }}
      lastUsed={view.lastLast5 !== null} needsLast5={view.currency.trim().toUpperCase() === "TWD"}
      serverError={errorKey ? { field: field as ReportField | null, message } : null} messages={messages}
      labels={{ amount: copy.amount, max: copy.max.replace("{amount}", money(pay.restMinor, view.currency, locale)), paidOn: copy.paidOn, last5: copy.last5,
        required: copy.required, lastUsed: copy.lastUsed, note: copy.note, notePlaceholder: copy.notePlaceholder, submit: copy.submit, saving: copy.saving,
        cancel: copy.cancel, retry: brandV3TenantHomeCopy(locale).retry, errorItem: copy.errorItem }} />
      : <>{errorKey ? <p className="t-pay-alert" role="alert">{message}</p> : null}<Link className="t-pay-text" href="/t/pay">{copy.cancel}</Link></>}
  </section>;
}

/** TEN-52-AC5: skeletons hold the cards; no amount (no NT$0) while loading. */
export function TenantPayLoading() {
  return <section className="v3-tenant-pay" data-testid="tenant-pay-loading" aria-busy="true">
    <div className="t-pay-skel t-pay-skel-lead" aria-hidden="true" />
    <div className="t-pay-skel t-pay-skel-card" aria-hidden="true" />
    <div className="t-pay-skel t-pay-skel-card" aria-hidden="true" />
  </section>;
}

/** TEN-52-AC5: a failed read shows the approved line and 「再試一次」 in place. */
export function TenantPayError({ locale }: { locale: Locale }) {
  const home = brandV3TenantHomeCopy(locale);
  return <section className="v3-tenant-pay" data-testid="tenant-pay-error">
    <h1 className="t-pay-lead">{home.tabs.pay}</h1>
    <div className="t-pay-card t-pay-alert" role="alert"><p>{home.readFailed}</p><Link className="t-pay-outline" href="/t/pay">{home.retry}</Link></div>
  </section>;
}

export type TenantPayMode = { report: boolean; errorKey: string | undefined; renderId: string };

/** RT-REPORT opens on 「回報已繳」 (?report=1) or after a failed send (the action bounces back with ?error). */
export function TenantPayState({ view, locale, place, company, brand, owner, mode, action, legacy }: {
  view: TenantPayView; locale: Locale; place: string; company: string; brand: string; owner: DraftOwner; mode: TenantPayMode; action: ReportAction; legacy: ReactNode;
}) {
  if (view.state === "off") return <>{legacy}</>;
  if (view.state === "error") return <TenantPayError locale={locale} />;
  if ((mode.report || mode.errorKey) && (view.pay.canReport || mode.errorKey)) {
    return <TenantReportV3 view={view} locale={locale} company={company} owner={owner} errorKey={mode.errorKey} renderId={mode.renderId} action={action} />;
  }
  return <TenantPayV3 view={view} locale={locale} place={place} company={company} brand={brand} />;
}
