import type { Client } from "pg";
import { FlowError } from "./errors";
import { settlementAccess,settlementDeadline,settlementUuid } from "./settlement-access";
import type { Session } from "./types";

/** Staff-only historical recovery context. This is not a rollout permission
 * and must never be used to create a version or disclose a party draft. */
export async function settlementV2HistoricalContext(client:Client,session:Session,leaseId:string) {
  settlementUuid(leaseId);settlementUuid(session.sessionId);settlementUuid(session.userId);settlementUuid(session.orgId);settlementUuid(session.liveOrgId);
  if(session.kind!=="staff"||session.needsSandbox||!["live","sandbox"].includes(session.environment))throw new FlowError("errors.notFound");
  await client.query(`SELECT set_config('statement_timeout','1500ms',true),set_config('lock_timeout','100ms',true)`);
  const params=[session.orgId,session.liveOrgId,session.environment,session.sessionId,session.userId,leaseId];
  const predicate=`SELECT 1 FROM public.organizations o JOIN public.organizations live ON live.id=$2 AND live.environment='live' AND live.live_org_id IS NULL JOIN public.auth_sessions a ON a.id=$4 AND a.user_id=$5 AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp() JOIN public.org_members m ON m.org_id=live.id AND m.user_id=$5 AND m.status='active' AND m.role IN ('admin','accountant') JOIN public.leases l ON l.org_id=o.id AND l.id=$6 WHERE auth.uid()=$5 AND o.id=$1 AND o.environment::text=$3 AND (($3='live' AND o.id=live.id AND o.live_org_id IS NULL) OR ($3='sandbox' AND o.live_org_id=live.id))`;
  if(!(await client.query(predicate,params)).rowCount)throw new FlowError("errors.notFound");
  // Serialize with demo reset, even when the rollout is disabled.
  await client.query("LOCK TABLE public.platform_settings IN SHARE MODE NOWAIT");
  const orgs=[...new Set([session.orgId,session.liveOrgId])].sort();
  if((await client.query(`SELECT id FROM public.organizations WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE NOWAIT`,[orgs])).rowCount!==orgs.length)throw new FlowError("errors.notFound");
  if(!(await client.query(`SELECT id FROM public.auth_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE NOWAIT`,[session.sessionId,session.userId])).rowCount)throw new FlowError("errors.notFound");
  if(!(await client.query(`SELECT id FROM public.org_members WHERE org_id=$1 AND user_id=$2 AND status='active' AND role IN ('admin','accountant') FOR SHARE NOWAIT`,[session.liveOrgId,session.userId])).rowCount)throw new FlowError("errors.notFound");
  if(!(await client.query(`SELECT id FROM public.leases WHERE org_id=$1 AND id=$2 FOR SHARE NOWAIT`,[session.orgId,leaseId])).rowCount)throw new FlowError("errors.notFound");
  if(!(await client.query(predicate,params)).rowCount)throw new FlowError("errors.notFound");await settlementDeadline(client,session,leaseId);
}
/** ON-only context: call before any selected-only context or financial locks. */
export async function settlementV2EnabledContext(client:Client,session:Session,leaseId:string) {
  if(session.kind!=="staff"||session.needsSandbox)throw new FlowError("errors.notFound");
  await client.query(`SELECT set_config('statement_timeout','1500ms',true),set_config('lock_timeout','100ms',true)`);
  await client.query(`SELECT app.settlement_pin_source_parents($1,$2,$3,$4,$5,'{}'::uuid[],'{}'::uuid[])`,[session.orgId,session.liveOrgId,session.environment,leaseId,session.sessionId]);
  return settlementAccess(client,session,leaseId,"prepare");
}
