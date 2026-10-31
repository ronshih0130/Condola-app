import Link from 'next/link';
import { monthlyRentCopy } from '@/i18n/monthly-rent-preview';
import type { MonthlyRentPreview as MonthlyRentPreviewResult } from '@/server/monthly-rent-preview';
import { formatConfiguredMinor } from '@/server/monthly-rent-operation-plan';

export function MonthlyRentPreview({ preview, locale }: { preview: MonthlyRentPreviewResult | null; locale: string }) {
  const t = monthlyRentCopy(locale);
  const backHref = preview ? `/m/rent/monthly-preview?month=${encodeURIComponent(preview.month)}` : '/m/rent';
  if (!preview) {
    return <section className="card pad" data-testid="monthly-rent-unavailable"><p role="status">{t.unavailable}</p><Link className="btn" href="/m/rent">{t.back}</Link></section>;
  }
  if (preview.kind === 'unsupported') {
    return <section className="card pad" data-testid="monthly-rent-unsupported"><p>{t.unsupported}</p><p role="status">{t.reasons[preview.reason]}</p><p>{t.asOf}: {preview.asOf}</p><Link className="btn" href={backHref}>{t.back}</Link></section>;
  }
  const operation = preview.operation;
  return <section className="card pad" data-testid="monthly-rent-detail">
    <dl>
      <div className="fg"><dt className="small" style={{ display: 'block', margin: '0 0 4px', color: 'var(--ink2)', fontWeight: 600 }}>{t.property}</dt><dd style={{ margin: 0, fontWeight: 600, overflowWrap: 'anywhere' }}>{operation.propertyName}</dd></div>
      <div className="fg"><dt className="small" style={{ display: 'block', margin: '0 0 4px', color: 'var(--ink2)', fontWeight: 600 }}>{t.billTo}</dt><dd style={{ margin: 0, fontWeight: 600, overflowWrap: 'anywhere' }}>{operation.payerName}</dd></div>
      <div className="fg"><dt className="small" style={{ display: 'block', margin: '0 0 4px', color: 'var(--ink2)', fontWeight: 600 }}>{t.currency}</dt><dd style={{ margin: 0, fontWeight: 600, overflowWrap: 'anywhere' }}>{operation.currency}</dd></div>
      <div className="fg"><dt className="small" style={{ display: 'block', margin: '0 0 4px', color: 'var(--ink2)', fontWeight: 600 }}>{t.rent}</dt><dd style={{ margin: 0, fontWeight: 600, overflowWrap: 'anywhere' }}>{operation.currency} {formatConfiguredMinor(operation.amountMinor, operation.currencyConfig)}</dd></div>
      <div className="fg"><dt className="small" style={{ display: 'block', margin: '0 0 4px', color: 'var(--ink2)', fontWeight: 600 }}>{t.period}</dt><dd style={{ margin: 0, fontWeight: 600, overflowWrap: 'anywhere' }}>{operation.periodStart} – {operation.periodEnd}</dd></div>
      <div className="fg"><dt className="small" style={{ display: 'block', margin: '0 0 4px', color: 'var(--ink2)', fontWeight: 600 }}>{t.due}</dt><dd style={{ margin: 0, fontWeight: 600, overflowWrap: 'anywhere' }}>{operation.dueDate}</dd></div>
    </dl>
    <p>{t.rentOnly}: {t.exclusions}</p>
    <p>{t.snapshot}</p>
    <p>{t.asOf}: {preview.asOf}</p>
    <Link className="btn" href={backHref}>{t.back}</Link>
  </section>;
}
