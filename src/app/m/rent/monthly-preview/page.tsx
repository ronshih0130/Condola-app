import { requireCurrentConsent } from '@/server/consent-gate';
import { getSession } from '@/server/session';
import { monthlyBillingAvailable, monthlyBillingPlan } from '@/server/monthly-billing-plan';
import { monthlyBillingCopy } from '@/i18n/monthly-billing-preview';
import { MonthlyBillingPreview } from '@/components/monthly-billing-preview';
import { PageHeader } from '@/components/ui';
import { monthlyBounds } from '@/server/monthly-billing-rules';
export const dynamic='force-dynamic';
export default async function Page({searchParams}:{searchParams:Promise<{month?:string}>}) {
 await requireCurrentConsent(undefined,'page');
 const session=await getSession(); const t=monthlyBillingCopy(session.locale); const params=await searchParams;
 const month=params.month??''; let valid=true; if(month) try {monthlyBounds(month);} catch {valid=false;}
 const available=month ? false : await monthlyBillingAvailable(session);
 const plan=month && valid ? await monthlyBillingPlan(session,month) : null;
 return <><PageHeader title={t.title}/><form method="get" className="card pad" style={{maxWidth:760}}><div className="fg"><label className="f" htmlFor="monthly-preview-month">{t.month}</label><input id="monthly-preview-month" className="inp" type="month" name="month" defaultValue={month}/></div><button className="btn pri" type="submit">{t.show}</button></form>{!month && available ? <p>{t.chooseMonth}</p> : <MonthlyBillingPreview plan={plan} locale={session.locale}/>}</>;
}
