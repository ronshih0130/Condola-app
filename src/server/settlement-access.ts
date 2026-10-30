import type { Client } from "pg";
import { FlowError } from "./errors";
import type { Session } from "./types";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function settlementUuid(id:string) { if (!UUID.test(id)) throw new FlowError("errors.notFound"); }
export async function settlementDeadline(client:Client,session:Session,leaseId:string) {
  const result=await client.query(`SELECT 1 FROM public.auth_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()`,[session.sessionId,session.userId]);
  if (!result.rowCount) throw new FlowError("errors.notFound");
  if (session.kind==="owner") {
    const current=await client.query(`SELECT 1 FROM public.leases l JOIN public.organizations o ON o.id=l.org_id JOIN public.property_owners po ON po.org_id=l.org_id AND po.property_id=l.property_id JOIN public.contacts c ON c.org_id=po.org_id AND c.id=po.owner_contact_id WHERE l.id=$1 AND l.org_id=$2 AND c.user_id=$3 AND c.is_owner AND c.archived_at IS NULL AND po.effective_from <= timezone(o.timezone,clock_timestamp())::date AND (po.effective_to IS NULL OR po.effective_to > timezone(o.timezone,clock_timestamp())::date)`,[leaseId,session.orgId,session.userId]);
    if (!current.rowCount) throw new FlowError("errors.notFound");
  }
}
/** Service gateway checks actual database relationships, never a submitted actor. */
export async function settlementAccess(client:Client,session:Session,leaseId:string, mode:"read"|"prepare"|"publish") {
  settlementUuid(leaseId);
  if (session.needsSandbox || !["staff","tenant","owner"].includes(session.kind)) throw new FlowError("errors.notFound");
  if (mode!=="read" && session.kind!=="staff") throw new FlowError("errors.notFound");
  if (session.kind==="tenant" && session.leaseId!==leaseId) throw new FlowError("errors.notFound");
  await client.query("LOCK TABLE public.platform_settings IN SHARE MODE");
  const org=await client.query(`SELECT o.id FROM public.organizations o WHERE o.id=$1 AND o.environment::text=$2 AND coalesce(o.live_org_id,o.id)=$3
    AND o.feature_flags->'deposit_settlements'='true'::jsonb AND EXISTS(SELECT 1 FROM public.platform_settings p WHERE p.key='deposit_settlements' AND p.value->'enabled'='true'::jsonb AND jsonb_typeof(p.value->'allowed_org_ids')='array' AND p.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) FOR SHARE`,[session.orgId,session.environment,session.liveOrgId]);
  if (!org.rowCount) throw new FlowError("errors.notFound");
  const auth=await client.query(`SELECT id FROM public.auth_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,[session.sessionId,session.userId]);
  if (!auth.rowCount) throw new FlowError("errors.notFound");
  let role:string|null=null; let ownerProperty:string|null=null;
  if (session.kind==="staff") {
    const member=await client.query<{role:string}>(`SELECT role::text FROM public.org_members WHERE org_id=$1 AND user_id=$2 AND status='active' AND role IN ('admin','accountant') FOR SHARE`,[session.liveOrgId,session.userId]);
    role=member.rows[0]?.role ?? null;
    if (!role || (mode==="publish" && role!=="admin")) throw new FlowError("errors.notFound");
  } else if (session.kind==="tenant") {
    const party=await client.query(`SELECT c.id FROM public.lease_parties lp JOIN public.contacts c ON c.org_id=lp.org_id AND c.id=lp.contact_id WHERE lp.org_id=$1 AND lp.lease_id=$2 AND lp.role IN ('primary','co_tenant') AND c.user_id=$3 AND c.is_tenant AND c.archived_at IS NULL FOR SHARE OF lp,c NOWAIT`,[session.orgId,leaseId,session.userId]);
    if (!party.rowCount) throw new FlowError("errors.notFound");
  } else {
    const owner=await client.query<{property_id:string}>(`SELECT po.property_id::text FROM public.leases l JOIN public.organizations o ON o.id=l.org_id JOIN public.property_owners po ON po.org_id=l.org_id AND po.property_id=l.property_id JOIN public.contacts c ON c.org_id=po.org_id AND c.id=po.owner_contact_id WHERE l.id=$1 AND l.org_id=$2 AND c.user_id=$3 AND c.is_owner AND c.archived_at IS NULL AND po.effective_from <= timezone(o.timezone,clock_timestamp())::date AND (po.effective_to IS NULL OR po.effective_to > timezone(o.timezone,clock_timestamp())::date) FOR SHARE OF po,c NOWAIT`,[leaseId,session.orgId,session.userId]);
    if (!owner.rowCount) throw new FlowError("errors.notFound");
    ownerProperty=owner.rows[0].property_id;
  }
  const lease=await client.query<{id:string;property_id:string;currency:string;start_date:string;end_date:string|null;moved_out_on:string|null;rent_amount_minor:string;rent_frequency:string;version:string}>(`SELECT id,property_id,currency::text,start_date::text,end_date::text,moved_out_on::text,rent_amount_minor::text,rent_frequency::text,xmin::text AS version FROM public.leases WHERE id=$1 AND org_id=$2 AND ($3::boolean OR status <> 'draft') FOR SHARE`,[leaseId,session.orgId,session.kind==="staff"]);
  if (!lease.rowCount || (session.kind==="owner" && ownerProperty!==lease.rows[0].property_id)) throw new FlowError("errors.notFound");
  await settlementDeadline(client,session,leaseId);
  return { lease:lease.rows[0], role };
}
/** Serialize retries for one verified actor/operation before financial locks. */
export async function settlementRequestLock(client:Client,session:Session,leaseId:string,lane:"statement"|"outcome"|"observation"|"reply"|"attribution"|"cycle"|"line_binding",requestId:string) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`b011:${lane}:${session.userId}:${requestId}`]);
  await settlementDeadline(client,session,leaseId);
}
