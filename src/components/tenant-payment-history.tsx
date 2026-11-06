import Link from 'next/link';
import { tenantPaymentHistoryCopy } from '@/i18n/tenant-payment-history';
import { makeT, type Locale } from '@/i18n';
import { chargeKey } from '@/components/ui';
import { electricityMonthLabel } from '@/server/format';
import type { tenantPaymentHistory } from '@/server/tenant-payment-history';

type Ready = Extract<Awaited<ReturnType<typeof tenantPaymentHistory>>, { state: 'ready' }>;

function amount(value: number | string, currency: string, locale: Locale) {
  // Format integer minor units directly, avoiding floating-point rounding for large values.
  const raw = BigInt(value), absolute = raw < BigInt(0) ? -raw : raw;
  const major = absolute / BigInt(100), minor = absolute % BigInt(100);
  const grouped = new Intl.NumberFormat(locale === 'zh-TW' ? 'zh-Hant-TW' : 'en-US', { maximumFractionDigits: 0 }).format(major);
  const code = currency.trim().toUpperCase();
  const fraction = code === 'TWD' && minor === BigInt(0) ? '' : `.${minor.toString().padStart(2, '0')}`;
  return `${raw < BigInt(0) ? '-' : ''}${code === 'TWD' ? 'NT$' : `${code} `}${grouped}${fraction}`;
}

export function TenantBillSummary({ data, locale, showLines = false }: { data: Ready; locale: Locale; showLines?: boolean }) {
  const t = tenantPaymentHistoryCopy(locale), bill = data.bill;
  const label = { unsigned: t.unsigned, no_invoice: t.noInvoice, nonpayable: t.nonpayable, zero_charge: t.zeroCharge, credit: t.credit, offset: t.offset, due: t.due, partial: t.partial, paid: t.paid }[bill.state];
  return <section aria-label={t.currentBill} data-testid="tenant-payment-summary">
    <p><strong>{label}</strong>{bill.overdue && <> · {t.overdue}</>}{bill.pending && <> · {t.pending}</>}</p>
    {(bill.state === 'due' || bill.state === 'partial' || bill.state === 'paid' || bill.state === 'zero_charge') && <p data-testid="tenant-payment-balance">{t.currentBill}: {amount(bill.balanceMinor, bill.currency, locale)}</p>}
    {bill.state === 'credit' && <p data-testid="tenant-payment-credit">{t.creditBalance}: {amount(Math.abs(bill.balanceMinor), bill.currency, locale)}</p>}
    {showLines && bill.lines.length > 0 && <><h3>{t.billLines}</h3><ul>{bill.lines.map((line, index) => <li key={`${line.chargeType}-${index}`}>{line.chargeType === 'utility' ? electricityMonthLabel(line.periodStart, line.description && line.description !== 'utility' ? line.description : makeT(locale)('i_charge_utility')) : line.description || makeT(locale)(chargeKey(line.chargeType))}: {amount(line.amountMinor, bill.currency, locale)}</li>)}</ul></>}
    {bill.state === 'partial' && <p>{t.paidAmount}: {amount(bill.paidMinor, bill.currency, locale)}</p>}
    {data.monthlyDue.length > 0 && <div data-testid="tenant-monthly-due"><h3>{t.monthlyDue}</h3>{data.monthlyDue.map((p) => <div key={p.periodYm}>
      <p><strong>{p.periodYm} {t.dueTotal}: {amount(p.dueMinor, p.currency, locale)}</strong></p>
      {showLines && <ul>{p.components.map((c) => <li key={`${c.source.invoiceNumber}-${c.source.lineNo}`}>{c.description || t.dueKeys[c.key]}: {amount(c.amountMinor, p.currency, locale)} <span className="small muted">({t.dueSource(c.source.invoiceNumber, c.source.lineNo)})</span></li>)}
        <li>{t.dueGross}: {amount(p.grossMinor, p.currency, locale)}</li>{p.offsetMinor !== '0' && <li>{t.dueOffset}: {amount(`-${p.offsetMinor}`, p.currency, locale)}</li>}{p.payments.map((x) => <li key={`paid-${x.invoiceNumber}`}>{t.duePaidSource(x.invoiceNumber)}: {amount(`-${x.paidMinor}`, p.currency, locale)}</li>)}{p.payments.length > 1 && <li>{t.duePaid}: {amount(`-${p.paidMinor}`, p.currency, locale)}</li>}</ul>}
      {p.carryMinor !== '0' && <p className="small">{t.dueCarry}: {amount(p.carryMinor, p.currency, locale)}</p>}
    </div>)}<p className="small muted">{t.dueNetNote}</p><p className="small muted">{t.monthlyDueNote}</p></div>}
    {bill.pending && <p className="small">{t.pendingNote}</p>}
  </section>;
}

export function TenantPaymentHistory({ data, locale, pathname, cursor, selectedReport, allowReport = true }: { data: Ready; locale: Locale; pathname: string; cursor?: string; selectedReport?: string; allowReport?: boolean }) {
  const t = tenantPaymentHistoryCopy(locale);
  return <section aria-labelledby="tenant-payment-history-title" data-testid="tenant-payment-history">
    <h2 id="tenant-payment-history-title">{t.title}</h2>
    <p className="small">{t.currentBillNote}</p>
    {data.reports.length === 0 ? <p>{t.empty}</p> : <ol>{data.reports.map(report => <li key={report.id} id={`report-${report.id}`} style={{ overflowWrap: 'anywhere' }}>
      <p><strong>{({ submitted: t.submitted, confirmed: t.confirmed, rejected: t.rejected, reversed: t.reversed })[report.status]}</strong></p>
      <p>{t.recordedAmount}: {amount(report.current.amountMinor, report.current.currency, locale)}</p>
      <p>{t.recordedPaidOn}: <time dateTime={report.current.paidOn}>{report.current.paidOn}</time></p>
      <p>{t.submittedAt}: <time dateTime={report.submittedAt}>{report.submittedAt}</time></p>
      {report.confirmedAt && <p>{t.confirmedAt}: <time dateTime={report.confirmedAt}>{report.confirmedAt}</time></p>}
      {report.original.state === 'unavailable' ? <p className="small">{t.originalUnavailable}</p> : <p>{t.original}: {amount(report.original.amountMinor, report.original.currency, locale)} · {t.paidOn}: <time dateTime={report.original.paidOn}>{report.original.paidOn}</time></p>}
      {report.status === 'rejected' && <p>{report.rejectionReason ? `${t.rejectionReason}: ${report.rejectionReason}` : t.rejectionReasonUnavailable}</p>}
      {report.status === 'reversed' && <p>{t.reversalReasonUnavailable}</p>}
      <p><Link href={{ pathname, query: { reportId: report.id }, hash: `report-${report.id}` }}>{t.reportDetails}</Link></p>
      {report.status === 'rejected' && allowReport && data.lease.canReport && <p><a href="/t/pay#report-payment">{t.reportAgain}</a> <span className="small">{t.reportAgainNote}</span></p>}
    </li>)}</ol>}
    {data.nextCursor && <Link href={{ pathname, query: { cursor: data.nextCursor } }}>{t.next}</Link>}
    {(cursor || selectedReport) && <p><Link href={pathname}>{t.first}</Link></p>}
  </section>;
}
