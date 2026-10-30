import {requireCurrentConsent} from '@/server/consent-gate';
import {getSession} from '@/server/session';
import {ownerRepairPolicyView} from '@/server/repair-owner-policy';
import {changeOwnerRepairOverride,closeOwnerRepairOverride,ownerRepairOverrideStatus} from '@/server/repair-owner-override';
import {readOwnerRepairRequest} from '@/server/repair-owner-policy-request';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie','X-Content-Type-Options':'nosniff'};
export async function POST(request:Request){
 const denied=await requireCurrentConsent(undefined,'api');if(denied)return denied;
 const session=await getSession();if(session.kind!=='owner')return new Response(null,{status:403,headers});
 const parsed=await readOwnerRepairRequest(request);if(!parsed.ok)return new Response(null,{status:parsed.status,headers});const input=parsed.input;
 const result=input.mode==='view'?await ownerRepairPolicyView(session,input.propertyId):input.mode==='change'?await changeOwnerRepairOverride(session,input):input.mode==='close'?await closeOwnerRepairOverride(session,input.propertyId,input.requestId):await ownerRepairOverrideStatus(session,input.propertyId,input.requestId);
 return Response.json(result,{headers});
}
