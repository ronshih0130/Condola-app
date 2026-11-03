import type { Client } from 'pg';
import { consentCoversCurrent, type StoredConsent } from './consent';
import { svc, withClient } from './db';
import { logServerError } from './errors';
import { isUuid } from './repair-rules';
import { readPartnerStateOn } from './partner-consent';
import { partnerFlag, partnerGateEnabled } from './partner-consent-rules';
import { parseStaffDisplayName, staffProfileVersion, validStaffProfileVersion } from './staff-profile-rules';
import { writeAudit } from './audit';
import type { Session } from './types';

type Row={name:string|null;updated_at_utc:string};
export type StaffProfileView={state:'ready';name:string;version:string}|{state:'unavailable'};
export type StaffProfileResult='updated'|'unchanged'|'stale'|'invalid'|'unavailable';
const unavailable={state:'unavailable' as const};
function eligible(s:Session){return s.kind==='staff'&&!s.needsSandbox&&s.environment==='live'&&s.orgId===s.liveOrgId&&!!s.role&&['admin','manager','accountant','maintenance'].includes(s.role)&&[s.userId,s.orgId,s.liveOrgId,s.sessionId].every(isUuid);}
type PartnerProof={value:unknown;override:unknown};
async function core(c:Client,s:Session){
 if(!eligible(s))return false;
 const q=await c.query<StoredConsent>(`SELECT cs.accepted_at::text,cs.terms_version,cs.privacy_version,cs.source FROM public.organizations o JOIN public.org_members m ON m.org_id=o.id AND m.user_id=$2 AND m.status='active' AND m.role::text=$3 JOIN public.auth_sessions a ON a.id=$4 AND a.user_id=$2 JOIN public.platform_settings f ON f.key='company_profile_edit' JOIN LATERAL (SELECT accepted_at,terms_version,privacy_version,source FROM public.consents WHERE user_id=$2 ORDER BY recorded_at DESC,id DESC LIMIT 1) cs ON true WHERE o.id=$1 AND o.environment='live' AND o.live_org_id IS NULL AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp() AND o.feature_flags->'company_profile_edit'='true'::jsonb AND jsonb_typeof(f.value)='object' AND f.value->'enabled'='true'::jsonb AND CASE WHEN jsonb_typeof(f.value->'allowed_org_ids')='array' THEN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(f.value->'allowed_org_ids') x(value) WHERE jsonb_typeof(x.value)<>'string' OR (x.value #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') ELSE false END AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)`,[s.orgId,s.userId,s.role,s.sessionId]);return q.rowCount===1&&consentCoversCurrent(q.rows[0]??null);
}
async function authorized(c:Client,s:Session):Promise<PartnerProof|null>{
 if(!await core(c,s))return null;
 const value=(await c.query<{value:unknown}>(`SELECT value FROM public.platform_settings WHERE key='design_partner_consent_gate'`)).rows[0]?.value??null;
 const override=(await c.query<{value:unknown}>(`SELECT feature_flags->'design_partner_consent_gate' AS value FROM public.organizations WHERE id=$1`,[s.orgId])).rows[0]?.value??null;
 const expected=partnerGateEnabled(value,override),state=await readPartnerStateOn(c,s,undefined,partnerFlag(value));
 // Partner reader preserves legacy fallback; an aborted SQL transaction must not become success.
 await c.query('SELECT 1');
 if(expected ? !state.active||state.required : state.active)return null;
 return {value,override};
}
async function finalProof(c:Client,s:Session,proof:PartnerProof){
 // NOWAIT avoids a profile/authority lock inversion with unrelated existing writers.
 const rows=await c.query(`SELECT o.id FROM public.organizations o JOIN public.org_members m ON m.org_id=o.id AND m.user_id=$2 JOIN public.auth_sessions a ON a.id=$3 AND a.user_id=$2 WHERE o.id=$1 FOR SHARE OF o,m,a NOWAIT`,[s.orgId,s.userId,s.sessionId]);
 if(rows.rowCount!==1)return false;
 const flags=await c.query<{key:string;value:unknown}>(`SELECT key,value FROM public.platform_settings WHERE key IN ('company_profile_edit','design_partner_consent_gate') ORDER BY key FOR SHARE NOWAIT`);
 const value=flags.rows.find(r=>r.key==='design_partner_consent_gate')?.value??null;
 const override=(await c.query<{value:unknown}>(`SELECT feature_flags->'design_partner_consent_gate' AS value FROM public.organizations WHERE id=$1`,[s.orgId])).rows[0]?.value??null;
 return JSON.stringify(value)===JSON.stringify(proof.value)&&JSON.stringify(override)===JSON.stringify(proof.override)&&await core(c,s);
}
const select=`SELECT display_name AS name,to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_utc FROM public.profiles WHERE id=$1`;
/** The caller supplies only the current server session; no target identity is accepted. */
export async function staffProfileView(s:Session):Promise<StaffProfileView>{
 if(!eligible(s))return unavailable;
 try{return await svc(s.userId,async c=>{if(!await authorized(c,s))return unavailable;const row=(await c.query<Row>(select,[s.userId])).rows[0];if(!row||!await authorized(c,s))return unavailable;return {state:'ready',name:row.name??'',version:staffProfileVersion(s,row.updated_at_utc,row.name)};});}catch(error){logServerError('staff_profile_view',error);return unavailable;}
}
export async function saveStaffProfile(s:Session,nameInput:unknown,versionInput:unknown):Promise<StaffProfileResult>{
 const name=parseStaffDisplayName(nameInput);if(!name||!validStaffProfileVersion(versionInput))return 'invalid';if(!eligible(s))return 'unavailable';
 try{return await withClient(async c=>{
  try{
   await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
   await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','service_role',true)`,[s.userId]);
   await c.query('SET LOCAL ROLE service_role');await c.query(`SET LOCAL lock_timeout='5s'`);
   if(!await authorized(c,s)){await c.query('ROLLBACK');return 'unavailable';}
   const row=(await c.query<Row>(`${select} FOR UPDATE`,[s.userId])).rows[0];
   if(!row){await c.query('ROLLBACK');return 'unavailable';}
   // Fence absent settings only after the profile wait; do not wait on this fence.
   await c.query('LOCK TABLE public.platform_settings IN SHARE MODE NOWAIT');
   const proof=await authorized(c,s);
   if(!proof||!await finalProof(c,s,proof)){await c.query('ROLLBACK');return 'unavailable';}
   if(row.name!==name&&staffProfileVersion(s,row.updated_at_utc,row.name)!==versionInput){await c.query('ROLLBACK');return 'stale';}
   if(row.name===name){await c.query('ROLLBACK');return 'unchanged';}
   const result=await c.query('UPDATE public.profiles SET display_name=$2 WHERE id=$1',[s.userId,name]);
   if(result.rowCount!==1)throw new Error('Profile update unavailable');
   await writeAudit(s.orgId,s.userId,'staff_display_name_changed',{scope:'account',field:'display_name',outcome:'updated',source:'account_settings',environment:'live'},c);
   await c.query('SET CONSTRAINTS ALL IMMEDIATE');
   if(!await core(c,s))throw new Error('Profile authorization changed');
   const committed=await c.query('COMMIT');if(committed.command!=='COMMIT')throw new Error('Profile commit not confirmed');
   return 'updated';
  }catch(error){try{await c.query('ROLLBACK');}catch(rollbackError){logServerError('staff_profile_rollback',rollbackError);}throw error;}
 });}catch(error){logServerError('staff_profile_save',error);return 'unavailable';}
}
