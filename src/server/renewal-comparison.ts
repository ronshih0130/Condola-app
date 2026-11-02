import { createHash } from "node:crypto";
import { tx } from "./db";
import { can } from "./perms";
import { isUuid } from "./repair-rules";
import type { Session } from "./types";
import { parseRenewalInput,renewalDiff,type RenewalInput,type RenewalTerms } from "@/lib/renewal-comparison";

type Row={id:string;start_date:string;end_date:string|null;rent_amount_minor:string;rent_frequency:string;due_day:number;deposit_amount_minor:string;currency:string;minor_unit:number;unit_id:string;target_unit_id:string|null;target_room_id:string|null;updated_at:string};
export type RenewalView={terms:RenewalTerms;fingerprint:string};
function permitted(s:Session,id:string) {return s.kind==="staff" && !s.needsSandbox && can(s.role,"leases.edit") && [s.userId,s.orgId,s.liveOrgId,s.sessionId,id].every(isUuid) && ["live","sandbox"].includes(s.environment);}
async function authorized(client:import("pg").Client,s:Session) {
  const result=await client.query(`SELECT 1 FROM public.organizations o JOIN public.org_members m ON m.org_id=$2 AND m.user_id=$3 AND m.status='active' AND m.role::text=$4 JOIN public.auth_sessions a ON a.id=$5 AND a.user_id=$3 JOIN public.platform_settings f ON f.key='lease_renewal'
    WHERE o.id=$1 AND o.environment::text=$6 AND ((o.environment='live' AND o.id=$2 AND o.live_org_id IS NULL) OR (o.environment='sandbox' AND o.live_org_id=$2)) AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp()
    AND o.feature_flags->'lease_renewal'='true'::jsonb AND f.value->'enabled'='true'::jsonb
    AND CASE WHEN jsonb_typeof(f.value->'allowed_org_ids')='array' THEN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(f.value->'allowed_org_ids') AS item(value) WHERE jsonb_typeof(item.value)<>'string' OR (item.value #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') ELSE false END
    AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)`,[s.orgId,s.liveOrgId,s.userId,s.role,s.sessionId,s.environment]);
  return result.rowCount===1;
}
async function source(client:import("pg").Client,s:Session,id:string) {
  if(!await authorized(client,s))return null;
  const row=(await client.query<Row>(`SELECT l.id::text,l.start_date::text,l.end_date::text,l.rent_amount_minor::text,l.rent_frequency::text,l.due_day,l.deposit_amount_minor::text,l.currency::text,c.minor_unit,l.unit_id::text,l.target_unit_id::text,l.target_room_id::text,l.updated_at::text FROM public.leases l JOIN public.currencies c ON c.code=l.currency WHERE l.id=$1 AND l.org_id=$2`,[id,s.orgId])).rows[0];
  if(!row || !Number.isInteger(row.minor_unit) || row.minor_unit<0 || row.minor_unit>4)return null;
  const terms:RenewalTerms={startDate:row.start_date,endDate:row.end_date,rentMinor:row.rent_amount_minor,frequency:row.rent_frequency,dueDay:row.due_day,depositMinor:row.deposit_amount_minor,currency:row.currency.trim(),minorUnit:row.minor_unit};
  return {row,terms,fingerprint:createHash("sha256").update(JSON.stringify(row)).digest("hex")};
}
export async function renewalComparisonView(s:Session,id:string):Promise<RenewalView|null> {
 if(!permitted(s,id))return null;
 try{return await tx(s.userId,async c=>{const src=await source(c,s,id);if(!src||!await authorized(c,s))return null;return {terms:src.terms,fingerprint:src.fingerprint};},{orgId:s.orgId,environment:s.environment},{readOnly:true});}catch{return null;}
}
export async function compareRenewal(s:Session,id:string,expected:string,input:RenewalInput) {
 if(!permitted(s,id)||typeof expected!=="string"||!/^[a-f0-9]{64}$/.test(expected))return {state:"unavailable" as const};
 try{return await tx(s.userId,async c=>{
   const src=await source(c,s,id);if(!src)return {state:"unavailable" as const};if(src.fingerprint!==expected)return {state:"stale" as const};
   const proposed=parseRenewalInput(input,src.terms);if(!proposed)return {state:"invalid" as const};
   const conflict=await c.query(`SELECT EXISTS(SELECT 1 FROM public.leases l WHERE l.org_id=$1 AND l.unit_id=$2 AND l.status IN ('pending_signature','active') AND l.term && daterange($3::date,$4::date,'[]') AND (l.target_unit_id IS NOT NULL OR $5::uuid IS NOT NULL OR l.target_room_id=$6::uuid)) AS present`,[s.orgId,src.row.unit_id,proposed.startDate,proposed.endDate,src.row.target_unit_id,src.row.target_room_id]);
   if(!await authorized(c,s))return {state:"unavailable" as const};
   const fresh=await source(c,s,id);if(!fresh || fresh.fingerprint!==expected)return {state:"stale" as const};
   return {state:"ready" as const,current:src.terms,proposed,diff:renewalDiff(src.terms,proposed),overlap:conflict.rows[0].present as boolean};
 },{orgId:s.orgId,environment:s.environment},{readOnly:true});}catch{return {state:"unavailable" as const};}
}
