import { guardEffectiveSession } from "@/server/b017-custom-role-governance";
import {withClient} from './db';
import {isUuid} from './repair-rules';
import type {Session} from './types';

const outcomes=['changed','no_change','cancelled','rejected_conflict','rejected_disabled','rejected_invalid','rejected_unavailable'] as const;
type Outcome=typeof outcomes[number];
export type RepairDefaultResult={status:'recorded';request_id:string;outcome:Outcome;recorded_at:string}|{status:'unknown'|'busy'|'unavailable'|'request_mismatch'|'invalid'};
export type RepairDefaultIntent={propertyId:string;requestId:string;expected:string;action:'set'|'clear';value:string};
type Mode='change'|'status'|'close';
function scopeValid(session:Session,propertyId:string,requestId?:string){return session.kind==='owner'&&!session.needsSandbox&&[session.orgId,session.liveOrgId,session.sessionId,session.userId,propertyId,...(requestId===undefined?[]:[requestId])].every(v=>typeof v==='string'&&isUuid(v))&&['live','sandbox'].includes(session.environment);}
function resultValid(result:unknown,request:string):result is RepairDefaultResult{
 if(!result||typeof result!=='object')return false;
 const r=result as Record<string,unknown>;
 return r.status==='unknown'||(r.status==='recorded'&&r.request_id===request.toLowerCase()&&outcomes.includes(r.outcome as Outcome)&&typeof r.recorded_at==='string'&&Number.isFinite(Date.parse(r.recorded_at)));
}

/** Exactly one fixed command; no caller SQL, callback, savepoint or provider I/O. */
async function run(session:Session,propertyId:string,requestId:string,mode:Mode,intent?:RepairDefaultIntent):Promise<RepairDefaultResult>{
 if(!scopeValid(session,propertyId,requestId))return{status:'unavailable'};
 if(mode==='change'&&(!intent||!['set','clear'].includes(intent.action)||typeof intent.expected!=='string'||!/^[a-f0-9]{64}$/.test(intent.expected)||typeof intent.value!=='string'||intent.value.length>64))return{status:'invalid'};
 try{return await withClient(async client=>{
  try{
   await client.query('BEGIN');await client.query(`SET LOCAL statement_timeout='5s'`);await client.query(`SET LOCAL lock_timeout='500ms'`);
   await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','service_role',true),set_config('app.active_org_id',$2,true),set_config('app.env',$3,true)`,[session.userId,session.orgId,session.environment]);await client.query('SET LOCAL ROLE service_role');
   const scope=[session.orgId,session.liveOrgId,session.environment,session.sessionId,propertyId,requestId];
   if(mode==='change')await client.query(`SELECT app.b013_change_default($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[...scope,intent!.expected,intent!.action,intent!.value]);
   else if(mode==='close')await client.query(`SELECT app.b013_close_default($1,$2,$3,$4,$5,$6)`,scope);
   else await client.query(`SELECT app.b013_default_status($1,$2,$3,$4,$5,$6)`,scope);
   await client.query('SET CONSTRAINTS ALL IMMEDIATE');
   const result=(await client.query<{result:unknown}>(`SELECT app.b013_finish_default($1,$2,$3,$4,$5,$6,$7) result`,[...scope,mode])).rows[0]?.result;
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
export function changeOwnerRepairDefault(session:Session,intent:RepairDefaultIntent){return run(session,intent.propertyId,intent.requestId,'change',intent);}
export function ownerRepairDefaultStatus(session:Session,propertyId:string,requestId:string){return run(session,propertyId,requestId,'status');}
export function closeOwnerRepairDefault(session:Session,propertyId:string,requestId:string){return run(session,propertyId,requestId,'close');}

export type OwnerRepairPolicyView={state:'disabled'|'unavailable'|'busy'|'recovery_only'}|{state:'enabled';propertyId:string;ownershipId:string;currency:string;minorUnit:number;defaultMinor:string|null;defaultSource:string;overrideMinor:string|null;effectiveMinor:string|null;effectiveSource:string;verified:boolean;snapshot:string};
export async function ownerRepairPolicyView(session:Session,propertyId:string):Promise<OwnerRepairPolicyView>{
  session = await guardEffectiveSession(session, "tickets.update");
 if(!scopeValid(session,propertyId))return{state:'unavailable'};
 try{return await withClient(async client=>{
  try{
   await client.query('BEGIN');await client.query(`SET LOCAL statement_timeout='5s'`);await client.query(`SET LOCAL lock_timeout='500ms'`);
   await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','service_role',true),set_config('app.active_org_id',$2,true),set_config('app.env',$3,true)`,[session.userId,session.orgId,session.environment]);await client.query('SET LOCAL ROLE service_role');
   const v=(await client.query<{view:OwnerRepairPolicyView}>(`SELECT app.b013_owner_view($1,$2,$3,$4,$5) view`,[session.orgId,session.liveOrgId,session.environment,session.sessionId,propertyId])).rows[0]?.view;
   await client.query('COMMIT');
   if(v?.state==='disabled'||v?.state==='recovery_only')return v;
   if(v?.state==='enabled'&&v.propertyId===propertyId.toLowerCase()&&isUuid(v.ownershipId)&&/^[A-Z]{3}$/.test(v.currency)&&Number.isInteger(v.minorUnit)&&v.minorUnit>=0&&v.minorUnit<=4&&[v.defaultMinor,v.overrideMinor,v.effectiveMinor].every(x=>x===null||(typeof x==='string'&&/^(0|[1-9][0-9]*)$/.test(x)&&x.length<=19&&BigInt(x)<=BigInt('9223372036854775807')))&&typeof v.defaultSource==='string'&&typeof v.effectiveSource==='string'&&typeof v.verified==='boolean'&&/^[a-f0-9]{64}$/.test(v.snapshot))return v;
   return{state:'unavailable'};
  }catch(error){try{await client.query('ROLLBACK');}catch{return{state:'unavailable'};}throw error;}
 });}catch(error){return{state:['55P03','57014'].includes((error as {code?:string}).code??'')?'busy':'unavailable'};}
}

/** Informational link hint only; every destination/command reauthorizes under pins. */
export async function ownerRepairPolicyEntryIds(session:Session,properties:string[]):Promise<string[]>{
  session = await guardEffectiveSession(session, "tickets.update");
 if(session.kind!=='owner'||session.needsSandbox||![session.orgId,session.liveOrgId,session.sessionId,session.userId,...properties].every(isUuid)||!['live','sandbox'].includes(session.environment))return[];
 if(!properties.length)return[];
 return await withClient(async client=>{
  try{await client.query('BEGIN');await client.query(`SET LOCAL statement_timeout='5s'`);await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true),set_config('app.active_org_id',$2,true),set_config('app.env',$3,true)`,[session.userId,session.orgId,session.environment]);await client.query('SET LOCAL ROLE authenticated');
   const result=await client.query<{id:string}>(`SELECT DISTINCT p.id::text id FROM public.properties p
    JOIN public.organizations o ON o.id=p.org_id JOIN public.organizations live ON live.id=$2 AND live.environment='live' AND live.live_org_id IS NULL
    JOIN public.contacts c ON c.org_id=p.org_id AND c.user_id=auth.uid() AND c.is_owner AND c.archived_at IS NULL
    JOIN public.property_owners po ON po.org_id=p.org_id AND po.property_id=p.id AND po.owner_contact_id=c.id
    JOIN public.auth_sessions s ON s.id=$3 AND s.user_id=auth.uid() AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
    JOIN public.platform_settings f ON f.key='repair_approvals'
    WHERE p.org_id=$1 AND p.id=ANY($4::uuid[]) AND p.archived_at IS NULL AND o.environment::text=$5 AND
     (($5='live' AND o.id=$2 AND o.live_org_id IS NULL) OR($5='sandbox' AND o.live_org_id=$2))
     AND(CASE WHEN EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=o.timezone) THEN
      po.effective_from<=(clock_timestamp() AT TIME ZONE o.timezone)::date
      AND(po.effective_to IS NULL OR po.effective_to>(clock_timestamp() AT TIME ZONE o.timezone)::date) ELSE false END)
     AND o.feature_flags->'repair_approvals'='true'::jsonb AND f.value->'enabled'='true'::jsonb AND jsonb_typeof(f.value->'allowed_org_ids')='array' AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)
    ORDER BY id`,[session.orgId,session.liveOrgId,session.sessionId,properties,session.environment]);await client.query('COMMIT');return result.rows.map(row=>row.id);
  }catch(error){await client.query('ROLLBACK');throw error;}
 });
}
