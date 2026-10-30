import { withClient } from './db';
import { isUuid } from './repair-rules';
import type { Session } from './types';

const OUTCOMES = ['changed','no_change','cancelled','rejected_conflict','rejected_invalid','rejected_disabled','rejected_unavailable','rejected_email_exists'] as const;
type Outcome = typeof OUTCOMES[number];
export type DirectoryEditResult = {status:'recorded';request_id:string;outcome:Outcome;recorded_at:string} | {status:'unknown'|'busy'|'unavailable'|'request_mismatch'};
export type DirectoryEditIntent = {requestId:string;contactId:string;expected:string;name:string;email:string;phone:string};
type Mode = 'edit'|'close'|'status';

function validResult(value:unknown,requestId:string):value is DirectoryEditResult {
 if(!value || typeof value!=='object')return false;
 const row=value as Record<string,unknown>;
 return row.status==='unknown' || (row.status==='recorded' && row.request_id===requestId && typeof row.recorded_at==='string' && OUTCOMES.includes(row.outcome as Outcome));
}

/** One fixed operation; no caller callback/SQL or external work inside its locks. */
async function run(session:Session,contactId:string,requestId:string,mode:Mode,intent?:DirectoryEditIntent):Promise<DirectoryEditResult> {
 if(session.kind!=='staff' || session.needsSandbox || ![session.userId,session.orgId,session.liveOrgId,session.sessionId,contactId,requestId].every(isUuid) || !['live','sandbox'].includes(session.environment))return {status:'unavailable'};
 if(mode==='edit' && (!intent || [intent.expected,intent.name,intent.email,intent.phone].some(v=>typeof v!=='string' || v.length>1024)))return {status:'unavailable'};
 try {
  return await withClient(async client=>{
   try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout='5s'`);
    await client.query(`SET LOCAL lock_timeout='500ms'`);
    await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','service_role',true),set_config('app.active_org_id',$2,true),set_config('app.env',$3,true)`,[session.userId,session.orgId,session.environment]);
    await client.query('SET LOCAL ROLE service_role');
    const scope=[session.orgId,session.liveOrgId,session.environment,session.sessionId,contactId,requestId];
    if(mode==='edit') {
     await client.query(`SELECT app.b015_edit_contact($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[...scope,intent!.expected,intent!.name,intent!.email,intent!.phone]);
    } else if(mode==='close') {
     await client.query(`SELECT app.b015_close_edit_request($1,$2,$3,$4,$5,$6)`,scope);
    } else {
     await client.query(`SELECT app.b015_edit_status($1,$2,$3,$4,$5,$6)`,scope);
    }
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    const result=(await client.query<{result:unknown}>(`SELECT app.b015_finish_edit_request($1,$2,$3,$4,$5,$6,$7) result`,[...scope,mode])).rows[0]?.result;
    // The immediately following awaited COMMIT is the operation's decision.
    await client.query('COMMIT');
    return validResult(result,requestId)?result:{status:'unknown'};
   } catch(error) {
    try {await client.query('ROLLBACK');} catch {return {status:'unknown'};}
    throw error;
   }
  });
 } catch(error) {
  const code=(error as {code?:string})?.code;
  if(code==='42501')return {status:'unavailable'};
  if(code==='55P03' || code==='57014')return {status:'busy'};
  if(code==='23514' && (error as {constraint?:string})?.constraint==='b015_request_identity')return {status:'request_mismatch'};
  // A transport failure cannot establish whether COMMIT reached PostgreSQL.
  return {status:'unknown'};
 }
}

export function editDirectoryContact(session:Session,intent:DirectoryEditIntent){return run(session,intent.contactId,intent.requestId,'edit',intent);}
export function directoryEditStatus(session:Session,contactId:string,requestId:string){return run(session,contactId,requestId,'status');}
export function closeDirectoryEdit(session:Session,contactId:string,requestId:string){return run(session,contactId,requestId,'close');}

export type DirectoryEditView = {state:'disabled'|'unavailable'|'busy'|'recovery_only'} | {state:'enabled';contactId:string;name:string;email:string|null;phone:string|null;expected:string;isOwner:boolean;isVendor:boolean};
export async function directoryContactEditView(session:Session,contactId:string):Promise<DirectoryEditView>{
 if(session.kind!=='staff' || session.needsSandbox || ![session.userId,session.orgId,session.liveOrgId,session.sessionId,contactId].every(isUuid) || !['live','sandbox'].includes(session.environment))return {state:'unavailable'};
 try{return await withClient(async client=>{
  try{
   await client.query('BEGIN');await client.query(`SET LOCAL statement_timeout='5s'`);await client.query(`SET LOCAL lock_timeout='500ms'`);
   await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','service_role',true),set_config('app.active_org_id',$2,true),set_config('app.env',$3,true)`,[session.userId,session.orgId,session.environment]);await client.query('SET LOCAL ROLE service_role');
   const view=(await client.query<{view:DirectoryEditView}>(`SELECT app.b015_edit_view($1,$2,$3,$4,$5) view`,[session.orgId,session.liveOrgId,session.environment,session.sessionId,contactId])).rows[0]?.view;
   await client.query('COMMIT');
   if(view?.state==='disabled' || view?.state==='unavailable' || view?.state==='recovery_only')return view;
   if(view?.state==='enabled' && view.contactId===contactId && typeof view.name==='string' && (view.email===null||typeof view.email==='string') && (view.phone===null||typeof view.phone==='string') && /^[a-f0-9]{64}$/.test(view.expected) && typeof view.isOwner==='boolean' && typeof view.isVendor==='boolean')return view;
   return {state:'unavailable'};
  }catch(error){try{await client.query('ROLLBACK');}catch{return {state:'unavailable'};}throw error;}
 });}catch(error){return {state:['55P03','57014'].includes((error as {code?:string})?.code??'')?'busy':'unavailable'};}
}
