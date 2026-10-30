import {sameOriginMutation} from './request-origin';
import { isUuid } from './repair-rules';
import type { DirectoryEditIntent } from './tenant-directory-edit';
type Input = ({mode:'edit'} & DirectoryEditIntent) | {mode:'status'|'close';contactId:string;requestId:string};
type Parsed = {ok:true;input:Input} | {ok:false;status:400|403|413};
const MAX_BODY=4096;

/** Exact same-origin, bounded JSON. Actor, company and role are never input. */
export async function readDirectoryEditRequest(request:Request):Promise<Parsed>{
 if(!sameOriginMutation(request))return {ok:false,status:403};
 if((request.headers.get('content-type')??'').split(';')[0].trim().toLowerCase()!=='application/json')return {ok:false,status:400};
 const length=request.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>MAX_BODY))return {ok:false,status:413};
 if(!request.body)return {ok:false,status:400};const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{
  for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>MAX_BODY){void reader.cancel().catch(()=>{});return {ok:false,status:413};}chunks.push(next.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!value||typeof value!=='object'||Array.isArray(value))return {ok:false,status:400};const row=value as Record<string,unknown>;
  if(!['edit','status','close'].includes(row.mode as string)||typeof row.contactId!=='string'||!isUuid(row.contactId)||typeof row.requestId!=='string'||!isUuid(row.requestId))return {ok:false,status:400};
  const keys=Object.keys(row).sort().join(',');if(keys!==(row.mode==='edit'?'contactId,email,expected,mode,name,phone,requestId':'contactId,mode,requestId'))return {ok:false,status:400};
  if(row.mode==='edit'&&[row.expected,row.name,row.email,row.phone].some(v=>typeof v!=='string'||v.length>1024))return {ok:false,status:400};
  return {ok:true,input:row as Input};
 }catch{return {ok:false,status:400};}
}
