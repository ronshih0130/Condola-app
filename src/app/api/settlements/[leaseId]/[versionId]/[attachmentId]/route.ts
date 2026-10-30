import { requireCurrentConsent } from "@/server/consent-gate";
import { readSettlementEvidence } from "@/server/settlement-evidence";
import { getSession } from "@/server/session";
export const dynamic="force-dynamic";
export async function GET(_request:Request,context:{params:Promise<{leaseId:string;versionId:string;attachmentId:string}>}) {
  const blocked=await requireCurrentConsent(undefined,"api"); if(blocked) return blocked;
  const session=await getSession(); const {leaseId,versionId,attachmentId}=await context.params;
  const headers={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"};
  try { const file=await readSettlementEvidence(session,leaseId,versionId,attachmentId); return new Response(Buffer.from(file.bytes),{headers:{...headers,"Content-Type":file.mime,"Content-Disposition":`${file.mime.startsWith("image/") ? "inline" : "attachment"}; filename="settlement-evidence"`}}); }
  catch { return new Response("Not found",{status:404,headers}); }
}
