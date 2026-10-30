import { requireCurrentConsent } from "@/server/consent-gate";
import { readHandoverJson } from "@/server/handover-input";
import { HANDOVER_MAX_BYTES } from "@/server/handover-storage";
import { prepareSettlementUpload, uploadSettlementBytes, finalizeSettlementUpload, discardSettlementUpload } from "@/server/settlement-attachments";
import { getSession } from "@/server/session";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"};
const denied=()=>Response.json({ok:false},{status:404,headers});
export async function POST(request:Request,context:{params:Promise<{leaseId:string;versionId:string}>}) {
  const blocked=await requireCurrentConsent(undefined,"api"); if(blocked)return blocked;
  const session=await getSession(), {leaseId,versionId}=await context.params;
  try {
    const body=await readHandoverJson(request);
    if(body.operation==="prepare" && typeof body.requestId==="string" && typeof body.fileName==="string" && typeof body.mime==="string" && typeof body.size==="number" && typeof body.sha256==="string") return Response.json({ok:true,intentId:await prepareSettlementUpload(session,leaseId,versionId,{requestId:body.requestId,fileName:body.fileName,mime:body.mime,size:body.size,sha256:body.sha256})},{headers});
    if(typeof body.intentId!=="string") return denied();
    if(body.operation==="finalize") return Response.json({ok:true,evidenceId:await finalizeSettlementUpload(session,leaseId,versionId,body.intentId)},{headers});
    if(body.operation==="discard") {await discardSettlementUpload(session,leaseId,versionId,body.intentId);return Response.json({ok:true},{headers});}
    return denied();
  } catch {return denied();}
}
export async function PUT(request:Request,context:{params:Promise<{leaseId:string;versionId:string}>}) {
  const blocked=await requireCurrentConsent(undefined,"api"); if(blocked)return blocked;
  const session=await getSession(), {leaseId,versionId}=await context.params;
  try {
    const id=new URL(request.url).searchParams.get("intent")??"", declared=Number(request.headers.get("content-length"));
    if(!Number.isInteger(declared)||declared<1||declared>HANDOVER_MAX_BYTES||!request.body)return denied();
    const reader=request.body.getReader(), chunks:Uint8Array[]=[];let size=0;
    try {while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>declared||size>HANDOVER_MAX_BYTES)return denied();chunks.push(part.value);}} finally {await reader.cancel().catch(()=>undefined);}
    if(size!==declared)return denied();
    await uploadSettlementBytes(session,leaseId,versionId,id,new Uint8Array(Buffer.concat(chunks,size)));
    return Response.json({ok:true},{headers});
  } catch {return denied();}
}
