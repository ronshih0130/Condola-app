import Link from 'next/link';
import { redirect } from 'next/navigation';
import { tenantLeaseHistoryCopy } from '@/i18n/tenant-lease-history';
import { requireCurrentConsent } from '@/server/consent-gate';
import { getSession } from '@/server/session';
import { tenantEndedLeaseDetail } from '@/server/tenant-lease-history';
import { tenantPaymentHistory } from '@/server/tenant-payment-history';
import { TenantBillSummary, TenantPaymentHistory } from '@/components/tenant-payment-history';
import { tenantPaymentHistoryCopy } from '@/i18n/tenant-payment-history';
import { signedPdfUploadedAt } from '@/server/paper-lease-history-time';

export const dynamic = 'force-dynamic';
export default async function TenantHistoryDetail({ params, searchParams }: { params: Promise<{ leaseId: string }>; searchParams: Promise<{ cursor?: string | string[]; reportId?: string | string[] }> }) {
  await requireCurrentConsent(undefined, 'page', '/t/history');
  const session = await getSession();
  if (session.kind !== 'tenant') redirect('/m');
  const { leaseId } = await params;
  const t = tenantLeaseHistoryCopy(session.locale);
  const result = await tenantEndedLeaseDetail(session, leaseId);
  const query = await searchParams;
  const cursor = Array.isArray(query.cursor) ? '!' : query.cursor;
  const reportId = Array.isArray(query.reportId) ? '!' : query.reportId;
  const initialPayments = result.state === 'unavailable' ? null : await tenantPaymentHistory(session, leaseId, { view: 'ended' });
  const payments = initialPayments?.state === 'ready' && (cursor !== undefined || reportId !== undefined)
    ? await tenantPaymentHistory(session, leaseId, { view: 'ended', cursor, reportId }) : initialPayments;
  return <main data-testid="tenant-history-detail"><Link href="/t/history">{t.back}</Link><h1>{t.title}</h1>{result.state === 'unavailable' ? <p role="status">{t.unavailable}</p> : <>
    <h2>{result.lease.propertyLabel} / {result.lease.unitLabel}{result.lease.roomLabel ? ` / ${result.lease.roomLabel}` : ''}</h2>
    <p>{t.dates}: {result.lease.startsOn}–{result.lease.endsOn ?? t.noEnd} ({t.ended})</p>
    {(result.lease.archive.property || result.lease.archive.unit || result.lease.archive.room) && <p>{t.archived}</p>}
    {payments?.state === 'unavailable' ? <p role="status">{tenantPaymentHistoryCopy(session.locale).unavailable}</p> : payments?.state === 'ready' ? <><TenantBillSummary data={payments} locale={session.locale} /><TenantPaymentHistory data={payments} locale={session.locale} pathname={`/t/history/${leaseId}`} cursor={cursor} selectedReport={reportId} allowReport={false} /></> : null}
    <h2>{t.papers}</h2>{result.pdfAvailability === 'unavailable' ? <p>{t.papersUnavailable}</p> : result.pdfs.length === 0 ? <p>{t.noPapers}</p> : <ul>{result.pdfs.map(pdf => { const uploaded = signedPdfUploadedAt(pdf.uploadedAt, session.locale, session.calendar); return <li key={pdf.id}>{pdf.current ? t.current : t.prior} — {t.uploaded}: <time dateTime={pdf.uploadedAt}>{uploaded?.label ?? t.papersUnavailable}</time> — <Link href={`/t/history/${result.lease.leaseId}/signed/${pdf.id}`}>{t.download}</Link></li>; })}</ul>}
  </>}</main>;
}
