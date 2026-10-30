import { CenterBusyError, CenterDeniedError, centerVendorItems } from "@/server/notification-center";
import { readMarkRequest } from "@/server/notification-center-request";

export const dynamic="force-dynamic";
const headers={"Cache-Control":"private, no-store"};
export async function POST(request:Request) {
  const parsed=await readMarkRequest(request,true);
  if(!parsed.ok || !parsed.input.token) return new Response(null,{status:parsed.ok?400:parsed.status,headers});
  try {
    const result=await centerVendorItems(parsed.input.token,parsed.input.recipientId);
    if(result.items.length!==1) return new Response(null,{status:404,headers});
    return Response.json({status:"marked"},{headers});
  } catch(error) {
    if(error instanceof CenterBusyError) return Response.json({status:"busy"},{headers});
    if(error instanceof CenterDeniedError) return new Response(null,{status:404,headers});
    return new Response(null,{status:500,headers});
  }
}
