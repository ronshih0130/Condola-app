import React from "react";
import Link from "next/link";
import { dictionary, makeT, translate, type Locale } from "../../../../i18n";
import { centerCopy } from "../../../../i18n/lanes/notification-center";
import { moneyPageCopy } from "../../../../i18n/lanes/brand-v3-money";
import { brandV3NavigationCopy, brandV3TodayCopy } from "../../../../i18n/lanes/brand-v3";
import { actionConfirmPayment } from "../../../../server/actions";
import type { MoneyMonthBill, MoneyMonthReport } from "../../../../server/b3-money-month";
import { adjacentMoneyMonth, moneyBillMatchesTab, moneyHref, type MoneyBills, type MoneyReports, type MoneyTab } from "../../../../server/money-page";
import { formatDate, moneyLabel } from "../../../../server/format";
import { displaySampleName } from "../../../../server/sandbox-data";
import { can } from "../../../../server/perms";
import type { Session } from "../../../../server/types";
import { ErrorBanner } from "../../../ui";
import { RoleAvatar } from "../../role-avatar";
import { CompletionCheck } from "../../completion-check";
import { ProxyConfirmation } from "./proxy-confirmation";

const tabs = ["all", "yours", "overdue", "future", "paid"] as const;
export function MoneyPage({ session, month, tab, bills, reports, error, cursor }: {
  session: Session; month: string; tab: MoneyTab; bills: MoneyBills; reports: MoneyReports; error?: string; cursor?: string;
}) {
  const locale: Locale = session.locale, copy = moneyPageCopy(locale), t = makeT(locale);
  const text = (key: keyof typeof copy, vars: Record<string, string | number>) => translate(copy, key, vars);
  const date = (value: string) => formatDate(value, locale, session.calendar, dictionary(locale));
  const returnTo = moneyHref(month, tab);
  const primary = tab === "yours" ? reports : bills;
  const nextCursor = primary.state === "ready" ? primary.nextCursor : null;
  const reportReady = reports.state === "ready";
  const attached = reportReady ? [...reports.attached].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.id.localeCompare(b.id)) : [];
  const forBill = (bill: MoneyMonthBill) => attached.filter(report => report.billRows.some(target => target.leaseId === bill.leaseId && target.month === month));
  const count = (key: MoneyTab) => key === "yours" ? reportReady ? reports.yourTurn : undefined
    : bills.state === "ready" ? bills.counts[key] : undefined;
  const visible = bills.state === "ready" ? bills.rows.filter(row => moneyBillMatchesTab(row, bills.today, tab)) : [];
  const supporting = [reportReady && reports.yourTurn > 0 ? text("pending", { count: reports.yourTurn }) : "",
    ...(bills.state === "ready" ? bills.outstanding.currencies.filter(value => BigInt(value.amountMinor) > BigInt(0)).map(value =>
      `${t("i_open_balance")} ${moneyLabel(value.amountMinor, value.currency, locale)}・${t("i_tenant_count", { count: value.leaseCount })}`) : []),
  ].filter(Boolean).join("・");
  const notice = (kind: "bills" | "reports", state: MoneyBills["state"]) => state === "ready" ? null :
    <p className="v3-money-notice" role="status" data-testid={`money-${kind}-${state}`}>
      {kind === "bills" ? copy.due : copy.turn}・{state === "forbidden" ? t("i_forbidden") : centerCopy(locale).unknown}
      {state !== "forbidden" && <>・<Link href={returnTo}>{brandV3TodayCopy(locale).retry}</Link></>}
    </p>;
  const reportDetails = (report: MoneyMonthReport) => <div className="v3-money-report" key={report.id} data-report-id={report.id}>
    <span>{moneyLabel(report.amountMinor, report.currency, locale)}・{copy.tenantReport} {bills.state === "ready" ? date(new Intl.DateTimeFormat("en-CA", { timeZone: bills.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(report.submittedAt))) : ""}</span>
    <span className="v3-money-turn"><RoleAvatar role="m" locale={locale} decorative /><span>{copy.yours}</span>
      {session.kind === "staff" && can(session, "pay.record") && (report.ownerPayee
        ? <ProxyConfirmation paymentId={report.id} ownerName={displaySampleName(report.ownerPayee.displayName ?? "") || copy.proxyOwner}
          target={[displaySampleName(report.place), displaySampleName(report.tenantName ?? "")].filter(Boolean).join("・")}
          amount={moneyLabel(report.amountMinor, report.currency, locale)} date={date(report.paidOn)} locale={locale} returnTo={returnTo} />
        : <form action={actionConfirmPayment}>
        <input type="hidden" name="paymentId" value={report.id} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <button type="submit" className="btn o" data-testid="confirm-payment">{copy.confirm}</button>
      </form>)}
    </span>
  </div>;
  const reportRow = (report: MoneyMonthReport, other: boolean) => <tr key={report.id} data-testid={other ? "money-other" : "money-report-only"}>
    <td><strong>{other ? copy.other : displaySampleName(report.place)}</strong><span className="v3-money-sub">{other && `${displaySampleName(report.place)}・`}{displaySampleName(report.tenantName ?? "")}</span></td>
    <td data-label={copy.due}>—</td><td data-label={copy.status}>{copy.reported}</td>
    <td data-label={copy.source}>{copy.tenantReport}{report.bankTransactionId ? `・${copy.bank}` : ""}</td>
    <td data-label={copy.turn}>{reportDetails(report)}</td>
  </tr>;
  return <div className="v3-money" data-testid="money-v3" data-month={month}>
    <div className="v3-money-title"><span>{brandV3NavigationCopy(locale).money}</span>
      <nav className="v3-money-month" aria-label={month}>
        {month !== "0001-01" && <Link href={moneyHref(adjacentMoneyMonth(month, -1), tab)} aria-label={adjacentMoneyMonth(month, -1)}>‹</Link>}
        <span>{text("month", { month: Number(month.slice(5)) })}</span>
        {month !== "9999-12" && <Link href={moneyHref(adjacentMoneyMonth(month, 1), tab)} aria-label={adjacentMoneyMonth(month, 1)}>›</Link>}
      </nav>
    </div>
    <ErrorBanner t={t} error={error} />
    {error && <Link href={returnTo}>{brandV3TodayCopy(locale).retry}</Link>}
    {can(session, "pay.record") && <Link href="/m/payments/list">{t("i_nav_inbox")}</Link>}
    <header className="v3-money-lead"><h1>{bills.state === "ready"
      ? text("headline", { month: Number(month.slice(5)), total: bills.counts.all, paid: bills.counts.paid })
      : brandV3NavigationCopy(locale).money}</h1>{supporting && <p data-testid="money-supporting">{supporting}</p>}</header>
    {notice("bills", bills.state)}{reports.state !== "forbidden" && notice("reports", reports.state)}
    <section className="card v3-money-card">
      <nav className="v3-money-tabs" aria-label={copy.status}>{tabs.filter(key => key !== "yours" || reports.state !== "forbidden").map(key =>
        <Link key={key} href={moneyHref(month, key)} aria-current={key === tab ? "page" : undefined} data-testid={`money-tab-${key}`}>
          {copy[key]} <span>{count(key) ?? "—"}</span>
        </Link>)}</nav>
      <table className="v3-money-table"><thead><tr>{[copy.property, copy.due, copy.status, copy.source, copy.turn].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
        <tbody>
          {tab === "yours" && reportReady && reports.other.map(report => reportRow(report, true))}
          {visible.map(bill => {
            const items = forBill(bill);
            return <tr key={bill.leaseId} id={`bill-${bill.leaseId}`} data-testid="money-bill" data-status={bill.status === "reported" && !reportReady ? undefined : bill.status}>
              <td><strong>{displaySampleName(bill.place)}</strong><span className="v3-money-sub">{[displaySampleName(bill.tenantName ?? ""), text("dueDate", { date: date(bill.dueDate) })].filter(Boolean).join("・")}</span></td>
              <td data-label={copy.due} className="v3-money-amount">{moneyLabel(bill.status === "paid" ? bill.totalMinor : bill.remainingMinor, bill.currency, locale)}</td>
              <td data-label={copy.status}><span className={`v3-money-status${bill.status === "reported" && !reportReady ? "" : ` v3-money-${bill.status}`}`}>
                {bill.status === "paid" && <CompletionCheck />}{bill.status === "reported" && !reportReady ? "—" : copy[bill.status]}
              </span>{BigInt(bill.confirmedMinor) > BigInt(0) && BigInt(bill.confirmedMinor) < BigInt(bill.totalMinor) &&
                <span className="v3-money-sub" data-testid="money-partial-amounts">{text("partialAmounts", {
                  paid: moneyLabel(bill.confirmedMinor, bill.currency, locale), balance: moneyLabel(bill.remainingMinor, bill.currency, locale),
                })}</span>}</td>
              <td data-label={copy.source}>{items.length ? copy.tenantReport : "—"}{items.some(item => item.bankTransactionId) ? `・${copy.bank}` : ""}</td>
              <td data-label={copy.turn}>{items.map(reportDetails)}{reportReady && !items.length && (bill.status === "overdue" || bill.status === "due_today" || bill.status === "partial") &&
                <span className="v3-money-turn"><RoleAvatar role="t" locale={locale} decorative /><span>{copy.waiting}</span></span>}</td>
            </tr>;
          })}
          {/* A visible report remains accessible when its bill is on another page or cannot be read. */}
          {tab === "yours" && attached.filter(report => !visible.some(bill => report.billRows.some(target => target.month === month && target.leaseId === bill.leaseId))).map(report => reportRow(report, false))}
        </tbody>
      </table>
      {(cursor !== undefined || nextCursor) && <nav className="v3-money-paging">
        {cursor !== undefined && <Link href={returnTo}>{copy.first}</Link>}
        {nextCursor && <Link href={moneyHref(month, tab, nextCursor)}>{copy.next}</Link>}
      </nav>}
      {count(tab) === 0 && <p className="v3-money-notice" data-testid="money-empty">{t("i_empty")}</p>}
    </section>
  </div>;
}
