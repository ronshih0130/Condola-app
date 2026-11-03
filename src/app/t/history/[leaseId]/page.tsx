import Link from 'next/link';
import { redirect } from 'next/navigation';
import { tenantLeaseHistoryCopy } from '@/i18n/tenant-lease-history';
import { requireCurrentConsent } from '@/server/consent-gate';
import { getSession } from '@/server/session';
import { tenantEndedLeaseDetail } from '@/server/tenant-lease-history';

export const dynamic = 'force-dynamic';
export default async function TenantHistoryDetail({ params }: { params: Promise<{ leaseId: string }> }) {
  await requireCurrentConsent(undefined, 'page', '/t/history');
  const session = await getSession();
  if (session.kind !== 'tenant') redirect('/m');
  const { leaseId } = await params;
  const t = tenantLeaseHistoryCopy(session.locale);
  const result = await tenantEndedLeaseDetail(session, leaseId);
  return <main data-testid="tenant-history-detail"><Link href="/t/history">{t.back}</Link><h1>{t.title}</h1>{result.state === 'unavailable' ? <p role="status">{t.unavailable}</p> : <>
    <h2>{result.lease.propertyLabel} / {result.lease.unitLabel}{result.lease.roomLabel ? ` / ${result.lease.roomLabel}` : ''}</h2>
    <p>{t.dates}: {result.lease.startsOn}–{result.lease.endsOn ?? t.noEnd} ({t.ended})</p>
    {(result.lease.archive.property || result.lease.archive.unit || result.lease.archive.room) && <p>{t.archived}</p>}
    <h2>{t.papers}</h2>{result.pdfAvailability === 'unavailable' ? <p>{t.papersUnavailable}</p> : result.pdfs.length === 0 ? <p>{t.noPapers}</p> : <ul>{result.pdfs.map(pdf => <li key={pdf.id}>{pdf.current ? t.current : t.prior} — {t.uploaded}: <time dateTime={pdf.uploadedAt}>{pdf.uploadedAt}</time> — <Link href={`/t/history/${result.lease.leaseId}/signed/${pdf.id}`}>{t.download}</Link></li>)}</ul>}
  </>}</main>;
}
