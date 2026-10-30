import {withClient} from './db';
import {isUuid} from './repair-rules';
import type {Session} from './types';

const outcomes=['changed','no_change','cancelled','rejected_conflict','rejected_disabled','rejected_invalid','rejected_unavailable'] as const;
type Outcome=typeof outcomes[number];
export type RepairOverrideResult={status:'recorded';request_id:string;outcome:Outcome;recorded_at:string}|{status:'unknown'|'busy'|'unavailable'|'request_mismatch'|'invalid'};
export type RepairOverrideIntent={propertyId:string;requestId:string;expected:string;action:'set'|'clear';value:string};
type Mode='change'|'status'|'close';
function scopeValid(session:Session,propertyId:string,requestId?:string){return session.kind==='owner'&&!session.needsSandbox&&[session.orgId,session.liveOrgId,session.sessionId,session.userId,propertyId,...(requestId===undefined?[]:[requestId])].every(v=>typeof v==='string'&&isUuid(v))&&['live','sandbox'].includes(session.environment);}
function resultValid(result:unknown,request:string):result is RepairOverrideResult{
 if(!result||typeof result!=='object')return false;
 const r=result as Record<string,unknown>;
 return r.status==='unknown'||(r.status==='recorded'&&r.request_id===request.toLowerCase()&&outcomes.includes(r.outcome as Outcome)&&typeof r.recorded_at==='string'&&Number.isFinite(Date.parse(r.recorded_at)));
}

/** Exactly one fixed command; no caller SQL, callback, savepoint or provider I/O. */
async function run(session:Session,propertyId:string,requestId:string,mode:Mode,intent?:RepairOverrideIntent):Promise<RepairOverrideResult>{
 if(!scopeValid(session,propertyId,requestId))return{status:'unavailable'};
 if(mode==='change'&&(!intent||!['set','clear'].includes(intent.action)||typeof intent.expected!=='string'||!/^[a-f0-9]{64}$/.test(intent.expected)||typeof intent.value!=='string'||intent.value.length>64))return{status:'invalid'};
 try{return await withClient(async client=>{
  try{
   await client.query('BEGIN');await client.query(`SET LOCAL statement_timeout='5s'`);await client.query(`SET LOCAL lock_timeout='500ms'`);
   await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','service_role',true),set_config('app.active_org_id',$2,true),set_config('app.env',$3,true)`,[session.userId,session.orgId,session.environment]);await client.query('SET LOCAL ROLE service_role');
   const scope=[session.orgId,session.liveOrgId,session.environment,session.sessionId,propertyId,requestId];
   if(mode==='change')await client.query(`SELECT app.b013_change_override($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[...scope,intent!.expected,intent!.action,intent!.value]);
   else if(mode==='close')await client.query(`SELECT app.b013_close_override($1,$2,$3,$4,$5,$6)`,scope);
   else await client.query(`SELECT app.b013_override_status($1,$2,$3,$4,$5,$6)`,scope);
   await client.query('SET CONSTRAINTS ALL IMMEDIATE');
   const result=(await client.query<{result:unknown}>(`SELECT app.b013_finish_override($1,$2,$3,$4,$5,$6,$7) result`,[...scope,mode])).rows[0]?.result;
   // No further application work between final current authorization and COMMIT.
   await client.query('COMMIT');
   return resultValid(result,requestId)?result:{status:'unknown'};
  }catch(error){try{await client.query('ROLLBACK');}catch{return{status:'unknown'};}throw error;}
 });}catch(error){
  const e=error as {code?:string;constraint?:string};
  if(e.code==='42501')return{status:'unavailable'};
  if(e.code==='55P03'||e.code==='57014')return{status:'busy'};
  if(e.code==='22023')return{status:'invalid'};
  if(e.code==='23514'&&e.constraint==='b013_request_identity')return{status:'request_mismatch'};
  return{status:'unknown'};
 }
}
export function changeOwnerRepairOverride(session:Session,intent:RepairOverrideIntent){return run(session,intent.propertyId,intent.requestId,'change',intent);}
export function ownerRepairOverrideStatus(session:Session,propertyId:string,requestId:string){return run(session,propertyId,requestId,'status');}
export function closeOwnerRepairOverride(session:Session,propertyId:string,requestId:string){return run(session,propertyId,requestId,'close');}

