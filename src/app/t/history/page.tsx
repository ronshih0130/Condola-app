import Link from 'next/link';
import { redirect } from 'next/navigation';
import { tenantLeaseHistoryCopy } from '@/i18n/tenant-lease-history';
import { requireCurrentConsent } from '@/server/consent-gate';
import { getSession } from '@/server/session';
import { tenantEndedLeaseList } from '@/server/tenant-lease-history';

export const dynamic = 'force-dynamic';
export default async function TenantHistoryPage({ searchParams }: { searchParams: Promise<{ after?: string | string[] }> }) {
  const session = await getSession();
  if (session.kind !== 'tenant') redirect('/m');
  await requireCurrentConsent(session, 'page', '/t/history');
  const t = tenantLeaseHistoryCopy(session.locale);
  const { after } = await searchParams;
  const result = Array.isArray(after) ? { state: 'unavailable' as const } : await tenantEndedLeaseList(session, after);
  return <main data-testid="tenant-history"><h1>{t.title}</h1>{result.state === 'unavailable' ? <p role="status">{t.unavailable}</p> : <>
    {result.items.length === 0 && (after === undefined ? <p>{t.empty}</p> : <><p>{t.emptyPage}</p><Link href="/t/history">{t.first}</Link></>)}
    <ul>{result.items.map(lease => <li key={lease.leaseId}><Link href={`/t/history/${lease.leaseId}`}>{lease.propertyLabel} / {lease.unitLabel}{lease.roomLabel ? ` / ${lease.roomLabel}` : ''}</Link> — {t.ended} ({lease.startsOn}–{lease.endsOn ?? t.noEnd}){(lease.archive.property || lease.archive.unit || lease.archive.room) && ` — ${t.archived}`}</li>)}</ul>
    {result.nextCursor && <Link href={{ pathname: '/t/history', query: { after: result.nextCursor } }}>{t.next}</Link>}
  </>}</main>;
}
