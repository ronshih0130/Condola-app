import { isUuid } from "./repair-rules";
import { vendorTokenAcceptable } from "./vendor-repair-rules";

const MAX_BODY=2048;
export type MarkInput={recipientId:string;token?:string};
export type MarkRequestResult={ok:true;input:MarkInput}|{ok:false;status:400|403|413};

/** Fixed same-origin JSON contract; never logs or returns input on failure. */
export async function readMarkRequest(request:Request,vendor:boolean):Promise<MarkRequestResult> {
  const origin=request.headers.get("origin"),site=request.headers.get("sec-fetch-site");
  try {
    if(!origin || (site!==null && site!=="same-origin")) return {ok:false,status:403};
    const supplied=new URL(origin),target=new URL(request.url);
    if(!["http:","https:"].includes(supplied.protocol) || supplied.origin!==origin || supplied.username || supplied.password || supplied.origin!==target.origin) return {ok:false,status:403};
  } catch {return {ok:false,status:403};}
  const type=(request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if(type!=="application/json") return {ok:false,status:400};
  const length=request.headers.get("content-length");
  if(length!==null && (!/^\d+$/.test(length) || Number(length)>MAX_BODY)) return {ok:false,status:413};
  if(!request.body) return {ok:false,status:400};
  const reader=request.body.getReader();const chunks:Uint8Array[]=[];let size=0;
  try {
    for(;;) {const next=await reader.read();if(next.done) break;size+=next.value.byteLength;if(size>MAX_BODY){void reader.cancel().catch(()=>{});return {ok:false,status:413};}chunks.push(next.value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    const value:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
    if(!value || typeof value!=="object" || Array.isArray(value)) return {ok:false,status:400};
    const obj=value as Record<string,unknown>,keys=Object.keys(obj).sort();
    if(keys.join(",")!==(vendor?"recipientId,token":"recipientId") || typeof obj.recipientId!=="string" || !isUuid(obj.recipientId)) return {ok:false,status:400};
    if(vendor && (typeof obj.token!=="string" || obj.token.length>256 || obj.token!==obj.token.trim() || !vendorTokenAcceptable(obj.token))) return {ok:false,status:400};
    return {ok:true,input:vendor?{recipientId:obj.recipientId,token:obj.token as string}:{recipientId:obj.recipientId}};
  } catch {return {ok:false,status:400};}
}
