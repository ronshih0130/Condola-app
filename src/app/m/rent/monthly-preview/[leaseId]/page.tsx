import { requireCurrentConsent } from '@/server/consent-gate';
import { getSession } from '@/server/session';
import { monthlyRentPreview } from '@/server/monthly-rent-preview';
import { monthlyRentCopy } from '@/i18n/monthly-rent-preview';
import { MonthlyRentPreview } from '@/components/monthly-rent-preview';
import { PageHeader } from '@/components/ui';
import type { MonthlyRentPreview as PreviewType } from '@/server/monthly-rent-preview';

export const dynamic = 'force-dynamic';

export default async function Page({ params, searchParams }: { params: Promise<{ leaseId: string }>; searchParams: Promise<{ month?: string }> }) {
  await requireCurrentConsent(undefined, 'page');
  const session = await getSession();
  const t = monthlyRentCopy(session.locale);
  const [{ leaseId }, query] = await Promise.all([params, searchParams]);
  const month = query.month ?? '';
  let preview: PreviewType | null = null;
  if (month) preview = await monthlyRentPreview(session, leaseId, month);
  return <><PageHeader title={t.title} crumb={t.back} /><MonthlyRentPreview preview={preview} locale={session.locale} /></>;
}
