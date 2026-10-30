import {notFound,redirect} from 'next/navigation';
import {OwnerRepairOverrideEditor} from '@/components/owner-repair-override';
import {ownerRepairOverrideCopy} from '@/i18n/lanes/repair-owner-override';
import {requireCurrentConsent} from '@/server/consent-gate';
import {getSession} from '@/server/session';
import {isUuid} from '@/server/repair-rules';
import {ownerRepairPolicyView} from '@/server/repair-owner-policy';
export const dynamic='force-dynamic';
export default async function OwnerRepairOverridePage({params}:{params:Promise<{id:string}>}){
 await requireCurrentConsent(undefined,'page');const session=await getSession();if(session.kind!=='owner')redirect('/m');const {id}=await params;if(!isUuid(id))notFound();const propertyId=id.toLowerCase(),view=await ownerRepairPolicyView(session,propertyId),scope=`${session.orgId}:${session.liveOrgId}:${session.environment}:${session.userId}`;
 return <><a className="btn" style={{minHeight:44}} href={`/o/repair-policy/${propertyId}`} data-testid="repair-default-back">{ownerRepairOverrideCopy(session.locale).back}</a><OwnerRepairOverrideEditor key={`${scope}:${propertyId}`} locale={session.locale} scope={scope} propertyId={propertyId} view={view}/></>;
}
