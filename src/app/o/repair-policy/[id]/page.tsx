import {notFound,redirect} from 'next/navigation';
import {ownerRepairOverrideCopy} from '@/i18n/lanes/repair-owner-override';
import {OwnerRepairPolicyEditor} from '@/components/owner-repair-policy';
import {requireCurrentConsent} from '@/server/consent-gate';
import {getSession} from '@/server/session';
import {isUuid} from '@/server/repair-rules';
import {ownerRepairPolicyView} from '@/server/repair-owner-policy';
export const dynamic='force-dynamic';
export default async function OwnerRepairPolicyPage({params}:{params:Promise<{id:string}>}){
 await requireCurrentConsent(undefined,'page');const session=await getSession();if(session.kind!=='owner')redirect('/m');const {id}=await params;if(!isUuid(id))notFound();const propertyId=id.toLowerCase(),view=await ownerRepairPolicyView(session,propertyId),scope=`${session.orgId}:${session.liveOrgId}:${session.environment}:${session.userId}`;
 return <>{view.state==='enabled'?<a className="btn" style={{minHeight:44}} href={`/o/repair-policy/${propertyId}/override`} data-testid="repair-override-entry">{ownerRepairOverrideCopy(session.locale).entry}</a>:null}<OwnerRepairPolicyEditor key={`${scope}:${propertyId}`} locale={session.locale} scope={scope} propertyId={propertyId} view={view}/></>;
}
