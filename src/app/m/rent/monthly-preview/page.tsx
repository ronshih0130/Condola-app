import { requireCurrentConsent } from '@/server/consent-gate';
import { getSession } from '@/server/session';
import { monthlyBillingPlan } from '@/server/monthly-billing-plan';
import { monthlyBillingCopy } from '@/i18n/monthly-billing-preview';
import { MonthlyBillingPreview } from '@/components/monthly-billing-preview';
import { taipeiToday } from '@/server/money';
import { monthlyBounds } from '@/server/monthly-billing-rules';
export const dynamic='force-dynamic';
export default async function Page({searchParams}:{searchParams:Promise<{month?:string}>}) {
 await requireCurrentConsent(undefined,'page');
 const session=await getSession(); const t=monthlyBillingCopy(session.locale); const params=await searchParams;
 const month=params.month??taipeiToday().slice(0,7); let valid=true; try {monthlyBounds(month);} catch {valid=false;}
 const plan=valid?await monthlyBillingPlan(session,month):null;
 return <main><h1>{t.title}</h1><form method="get"><label>{t.month}<input type="month" name="month" defaultValue={month}/></label><button type="submit">{t.show}</button></form><MonthlyBillingPreview plan={plan} locale={session.locale}/></main>;
}
