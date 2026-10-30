import { requireCurrentConsent } from '@/server/consent-gate';
import { getSession } from '@/server/session';
import { closeDirectoryEdit,directoryEditStatus,editDirectoryContact } from '@/server/tenant-directory-edit';
import { readDirectoryEditRequest } from '@/server/tenant-directory-edit-request';

export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie'};
export async function POST(request:Request){
 const denied=await requireCurrentConsent(undefined,'api');if(denied)return denied;
 const session=await getSession();if(session.kind!=='staff')return new Response(null,{status:403,headers});
 const parsed=await readDirectoryEditRequest(request);if(!parsed.ok)return new Response(null,{status:parsed.status,headers});
 const input=parsed.input;
 const result=input.mode==='edit'?await editDirectoryContact(session,input):input.mode==='close'?await closeDirectoryEdit(session,input.contactId,input.requestId):await directoryEditStatus(session,input.contactId,input.requestId);
 return Response.json(result,{headers});
}
