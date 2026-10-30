import {isUuid} from './repair-rules';
import type {RepairDefaultIntent} from './repair-owner-policy';
type Input=({mode:'change'}&RepairDefaultIntent)|{mode:'status'|'close';propertyId:string;requestId:string}|{mode:'view';propertyId:string};
type Parsed={ok:true;input:Input}|{ok:false;status:400|403|413};
const max=4096;
export async function readOwnerRepairRequest(request:Request):Promise<Parsed>{
 const origin=request.headers.get('origin'),site=request.headers.get('sec-fetch-site');
 try{if(!origin||(site!==null&&site!=='same-origin'))return{ok:false,status:403};const supplied=new URL(origin),target=new URL(request.url);if(!['http:','https:'].includes(supplied.protocol)||supplied.origin!==origin||supplied.username||supplied.password||supplied.origin!==target.origin)return{ok:false,status:403};}catch{return{ok:false,status:403};}
 if((request.headers.get('content-type')??'').split(';')[0].trim().toLowerCase()!=='application/json')return{ok:false,status:400};
 const length=request.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>max))return{ok:false,status:413};
 if(!request.body)return{ok:false,status:400};const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>max){void reader.cancel().catch(()=>{});return{ok:false,status:413};}chunks.push(item.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  const data:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!data||typeof data!=='object'||Array.isArray(data))return{ok:false,status:400};const row=data as Record<string,unknown>;
  if(!['view','change','status','close'].includes(row.mode as string)||typeof row.propertyId!=='string'||!isUuid(row.propertyId))return{ok:false,status:400};
  const expected=row.mode==='view'?'mode,propertyId':row.mode==='change'?'action,expected,mode,propertyId,requestId,value':'mode,propertyId,requestId';if(Object.keys(row).sort().join(',')!==expected)return{ok:false,status:400};
  if(row.mode!=='view'&&(typeof row.requestId!=='string'||!isUuid(row.requestId)))return{ok:false,status:400};
  if(row.mode==='change'&&(typeof row.expected!=='string'||!/^[a-f0-9]{64}$/.test(row.expected)||!['set','clear'].includes(row.action as string)||typeof row.value!=='string'||row.value.length>64))return{ok:false,status:400};
  return{ok:true,input:row as Input};
 }catch{return{ok:false,status:400};}
}
