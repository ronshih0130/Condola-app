import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import { requireCurrentConsent } from "@/server/consent-gate";
import { getSession } from "@/server/session";
import { CenterBusyError, CenterDeniedError, centerSessionItems } from "@/server/notification-center";
import { readMarkRequest } from "@/server/notification-center-request";

export const dynamic="force-dynamic";
const headers={"Cache-Control":"private, no-store"};
export async function POST(request:Request) {
  const denial=await requireCurrentConsent(undefined,"api");
  if(denial) return denial;
  const session=await guardEffectiveSession(await getSession(), null);
  if(!["staff","tenant","owner"].includes(session.kind)) return new Response(null,{status:404,headers});
  const parsed=await readMarkRequest(request,false);
  if(!parsed.ok) return new Response(null,{status:parsed.status,headers});
  try {
    const result=await centerSessionItems(session,parsed.input.recipientId);
    if(result.items.length!==1) return new Response(null,{status:404,headers});
    return Response.json({status:"marked"},{headers});
  } catch(error) {
    if(error instanceof CenterBusyError) return Response.json({status:"busy"},{headers});
    if(error instanceof CenterDeniedError) return new Response(null,{status:404,headers});
    return new Response(null,{status:500,headers});
  }
}
