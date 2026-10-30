import { settlementUuid } from "./settlement-access";
import { sameOriginMutation } from "./request-origin";

/** Parse only the public terminal command, bounded by actual streamed bytes. */
export async function readSettlementTerminalInput(request:Request) {
 if(!sameOriginMutation(request))throw new Error("Invalid request");
 if(!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(request.headers.get("content-type")??""))throw new Error("Invalid request");
 const length=request.headers.get("content-length");if(length!==null&&(!/^\d+$/.test(length)||Number(length)>4096))throw new Error("Invalid request");
 if(!request.body)throw new Error("Invalid request");const reader=request.body.getReader(),parts:Uint8Array[]=[];let size=0;
 try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>4096)throw new Error("Invalid request");parts.push(part.value);}}finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
 const value:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(parts,size)));
 if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Invalid request");const body=value as Record<string,unknown>;
 if(Object.keys(body).sort().join(",")!=="leaseId,mode,requestId"||!(body.mode==="status"||body.mode==="close")||typeof body.leaseId!=="string"||typeof body.requestId!=="string")throw new Error("Invalid request");
 settlementUuid(body.leaseId);settlementUuid(body.requestId);return {mode:body.mode,leaseId:body.leaseId,requestId:body.requestId};
}
