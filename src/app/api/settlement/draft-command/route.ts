import { requireCurrentConsent } from "@/server/consent-gate";
import { getSession } from "@/server/session";
import { readSettlementTerminalInput } from "@/server/settlement-terminal-input";
import { resolveStatementTerminal } from "@/server/settlement-terminal";

export const dynamic="force-dynamic";
const privateHeaders={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"};
export async function POST(request:Request) {
 const blocked=await requireCurrentConsent(undefined,"api");if(blocked)return blocked;
 const session=await getSession();let input:Awaited<ReturnType<typeof readSettlementTerminalInput>>;
 try{input=await readSettlementTerminalInput(request);}catch{return Response.json({ok:false},{status:400,headers:privateHeaders});}
 try{const result=await resolveStatementTerminal(session,input.leaseId,input.requestId,input.mode==="close");return Response.json({ok:true,...result},{headers:privateHeaders});}
 catch{return Response.json({ok:false},{status:503,headers:privateHeaders});}
}
