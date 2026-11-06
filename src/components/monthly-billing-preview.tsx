import { monthlyBillingCopy } from '@/i18n/monthly-billing-preview';
import { Cell, RfTable } from '@/components/rf';
import Link from 'next/link';
import { formatConfiguredMinor } from '@/server/monthly-rent-operation-plan';
import type { MonthlyBillingPlan } from '@/server/monthly-billing-plan';
import type { MonthlyBillPreviewDTO } from '@/server/monthly-bill-types';

export function MonthlyBillingPreview({plan,locale,fullBill}:{plan:MonthlyBillingPlan|null;locale:string;fullBill?:MonthlyBillPreviewDTO|null}) {
 return <>
  <RentBillingPreview plan={plan} locale={locale} />
  {fullBill != null ? (
   <section data-testid="monthly-full-bill">
    <p>components: {fullBill.components.length}</p>
    <p>netMinor: {fullBill.netMinor}</p>
    <p>carryMinor: {fullBill.carryMinor}</p>
   </section>
  ) : null}
 </>;
}

function RentBillingPreview({plan,locale}:{plan:MonthlyBillingPlan|null;locale:string}) {
 const t=monthlyBillingCopy(locale);
 if (!plan) return <p>{t.unavailable}</p>;
 if (plan.kind==='incomplete') return <p role="status" data-testid="monthly-incomplete">{t.incomplete}</p>;
 return <section data-testid="monthly-preview"><p>{t.period}: {plan.period.start} – {plan.period.end}</p><p>{t.asOf}: {plan.asOf}</p><p>{t.rentOnly}</p><p>{t.unknown}</p><p>{t.unresolvedCount}: {plan.unresolvedCount}</p>{plan.rows.length===0?<p>{t.empty}</p>:<RfTable testId="monthly-rows"><thead><tr><th>{t.property}</th><th>{t.currency}</th><th>{t.amount}</th><th>{t.due}</th><th>{t.state}</th><th>{t.detail}</th></tr></thead><tbody>{plan.rows.map(row=><tr key={row.leaseId}><Cell label={t.property}>{row.propertyName} · {row.unitLabel}</Cell><Cell label={t.currency}>{row.currency}</Cell><Cell label={t.amount}>{row.rentMinor===null||row.currencyConfig===null?t.moneyUnavailable:formatConfiguredMinor(row.rentMinor,row.currencyConfig)}</Cell><Cell label={t.due}>{row.dueDate??t.reason.due_day_unavailable}</Cell><Cell label={t.state}>{t[row.state]}{row.reason ? ` · ${t.reason[row.reason as keyof typeof t.reason] ?? t.unresolved}`:''}{row.evidenceRefs.map(ref=><small key={ref.lineId}> {t.invoice}: {ref.invoiceNumber}</small>)}{row.components.length ? <ul aria-label={t.components}>{row.components.map(c=><li key={`${c.kind}-${c.id}`}>{c.kind==='utility'?t.utility:t.charge}: {t.reason[c.reason as keyof typeof t.reason]??t.unresolved}</li>)}</ul>:null}</Cell><Cell label={t.detail}><Link className="btn" data-testid="monthly-rent-detail-link" href={`/m/rent/monthly-preview/${row.leaseId}?month=${encodeURIComponent(plan.month)}`} aria-label={`${t.detailFor} ${row.propertyName} ${row.unitLabel}`}>{t.openDetail}</Link></Cell></tr>)}</tbody></RfTable>}<ul data-testid="monthly-subtotals">{plan.subtotals.map(s=><li key={s.currency}>{s.currency}: {s.currencyConfig===null?t.moneyUnavailable:formatConfiguredMinor(s.amountMinor,s.currencyConfig)} ({s.count})</li>)}</ul></section>;
}
