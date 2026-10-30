import type { Client,QueryResult,QueryResultRow } from "pg";
import { FlowError } from "./errors";
import { settlementUuid } from "./settlement-access";
import { settlementV2EnabledContext } from "./settlement-v2-context";
import { prepareCompleteSource,inspectCompleteSourceOn } from "./settlement-complete-source";
import { withSettlementFencePrototype } from "./settlement-fenced-transaction";
import { normalizeSettlementInput,type SettlementPreviewInput } from "./settlement-preview";
import { encodeUnknownV2 } from "./settlement-v2-unknown";
import type { Session } from "./types";

export class V2SourceStale extends FlowError { constructor(){super("errors.generic");} }
type BoundedQuery=<R extends QueryResultRow = QueryResultRow>(sql:string,params?:unknown[])=>Promise<QueryResult<R>>;
export async function prepareV2Unknown(client:Client,session:Session,raw:SettlementPreviewInput,anchorVersionId?:string,createRecord=false) {
 if(anchorVersionId)settlementUuid(anchorVersionId);
 const input=normalizeSettlementInput(raw);let anchor=1,prior:unknown[]=[{outcomes:[],events:[],observations:[],reconciliations:[]}];let capacity=false;
  await settlementV2EnabledContext(client,session,input.leaseId);const cohort=await prepareCompleteSource(client,session,input.leaseId);
  let record=(await client.query<{id:string}>(`SELECT id FROM app.settlement_records WHERE org_id=$1 AND lease_id=$2 AND currency=$3 FOR UPDATE NOWAIT`,[session.orgId,input.leaseId,cohort.lease.currency])).rows[0];
  if(!record && createRecord){await client.query(`INSERT INTO app.settlement_records(org_id,lease_id,currency) VALUES($1,$2,$3) ON CONFLICT(org_id,lease_id,currency) DO NOTHING`,[session.orgId,input.leaseId,cohort.lease.currency]);record=(await client.query<{id:string}>(`SELECT id FROM app.settlement_records WHERE org_id=$1 AND lease_id=$2 AND currency=$3 FOR UPDATE NOWAIT`,[session.orgId,input.leaseId,cohort.lease.currency])).rows[0];if(!record)throw new FlowError("errors.generic");}
  let currentId:string|null=null;
  if(record){if(anchorVersionId){const saved=(await client.query<{revision:number}>(`SELECT revision FROM app.settlement_versions WHERE id=$1 AND record_id=$2 AND org_id=$3 AND lease_id=$4 AND NOT published AND snapshot->>'schema'='settlement-v2'`,[anchorVersionId,record.id,session.orgId,input.leaseId])).rows[0];if(!saved)throw new V2SourceStale();anchor=saved.revision;}else{const current=(await client.query<{id:string;revision:number}>(`SELECT id,revision FROM app.settlement_versions WHERE record_id=$1 ORDER BY revision DESC LIMIT 1`,[record.id])).rows[0];currentId=current?.id??null;anchor=(current?.revision??0)+1;}
   const outcomes=(await client.query(`SELECT o.id::text,o.version_id::text,o.direction,o.amount_minor::text,o.currency::text,o.occurred_on::text,o.payer_id::text,o.payer_kind,o.payee_id::text,o.payee_kind,o.evidence_id::text,extract(epoch from o.created_at)::text AS created_at FROM app.settlement_outcomes o JOIN app.settlement_versions v ON v.id=o.version_id WHERE o.org_id=$1 AND o.lease_id=$2 AND v.record_id=$3 AND v.revision<$4 ORDER BY o.id LIMIT 1001`,[session.orgId,input.leaseId,record.id,anchor])).rows;
   const events=(await client.query(`SELECT e.id::text,e.outcome_id::text,e.event,e.revision,e.actor_id::text,e.note,e.evidence_id::text,extract(epoch from e.created_at)::text AS created_at FROM app.settlement_outcome_events e JOIN app.settlement_outcomes o ON o.id=e.outcome_id JOIN app.settlement_versions v ON v.id=o.version_id WHERE o.org_id=$1 AND o.lease_id=$2 AND v.record_id=$3 AND v.revision<$4 ORDER BY e.outcome_id,e.revision,e.id LIMIT 1001`,[session.orgId,input.leaseId,record.id,anchor])).rows;
   const observations=(await client.query(`SELECT o.id::text,o.version_id::text,o.direction,o.amount_minor::text,o.currency::text,o.occurred_on::text,o.payer_id::text,o.payee_id::text,o.payer_kind,o.payee_kind,o.reporter_id::text,o.evidence_id::text,o.reason,extract(epoch from o.created_at)::text AS created_at FROM app.settlement_external_observations o JOIN app.settlement_versions v ON v.id=o.version_id WHERE o.org_id=$1 AND o.lease_id=$2 AND v.record_id=$3 AND v.revision<$4 ORDER BY o.id LIMIT 1001`,[session.orgId,input.leaseId,record.id,anchor])).rows;
   const reconciliations=(await client.query(`SELECT r.id::text,r.version_id::text,r.report_id::text,r.prior_outcome_id::text,r.prior_observation_id::text,r.reason,r.evidence_id::text,r.actor_id::text,extract(epoch from r.created_at)::text AS created_at FROM app.settlement_outcome_reconciliations r JOIN app.settlement_versions v ON v.id=r.version_id WHERE r.org_id=$1 AND r.lease_id=$2 AND v.record_id=$3 AND v.revision<$4 ORDER BY r.id LIMIT 1001`,[session.orgId,input.leaseId,record.id,anchor])).rows;
   capacity=[outcomes,events,observations,reconciliations].some(rows=>rows.length>1000);prior=[{outcomes,events,observations,reconciliations}];
  }
  if(anchorVersionId&&!record)throw new V2SourceStale();
  const attrs=(await client.query<{id:string;evidence_id:string}>(`SELECT a.id,a.evidence_id FROM app.settlement_attributions a JOIN app.settlement_allocation_roots r ON r.id=a.root_id AND r.org_id=a.org_id AND r.lease_id=a.lease_id AND r.category='deposit' WHERE a.org_id=$1 AND a.lease_id=$2 AND a.id=ANY($3::uuid[]) AND a.id=(SELECT id FROM app.settlement_attributions WHERE root_id=a.root_id ORDER BY revision DESC LIMIT 1) ORDER BY a.id`,[session.orgId,input.leaseId,input.attributionIds])).rows;
  if(attrs.length!==input.attributionIds.length){if(anchorVersionId)throw new V2SourceStale();throw new FlowError("errors.notFound");}
  const evidence=[...new Set([...attrs.map(a=>a.evidence_id),...input.items.map(i=>i.evidenceId),...(input.sourceReview?[input.sourceReview.evidenceId]:[])])].sort();
  const linked=await client.query(`SELECT e.id FROM app.settlement_evidence e WHERE e.org_id=$1 AND e.lease_id=$2 AND e.id=ANY($3::uuid[]) AND EXISTS(SELECT 1 FROM app.settlement_evidence_links l WHERE l.org_id=e.org_id AND l.lease_id=e.lease_id AND l.evidence_id=e.id)`,[session.orgId,input.leaseId,evidence]);if(linked.rowCount!==evidence.length)throw new FlowError("errors.notFound");
  await client.query(`SELECT app.settlement_pin_source_parents($1,$2,$3,$4,$5,$6::uuid[],$7::uuid[])`,[session.orgId,session.liveOrgId,session.environment,input.leaseId,session.sessionId,evidence,input.attributionIds]);

  if(createRecord)await client.query("LOCK TABLE app.settlement_versions,app.settlement_evidence_links,app.settlement_version_attributions,app.settlement_items,public.audit_log IN ROW EXCLUSIVE MODE NOWAIT");
  return {input,cohort,anchor,prior,capacity,recordId:record?.id??null,currentId,evidence,anchorVersionId};
}
type V2Prepared=Awaited<ReturnType<typeof prepareV2Unknown>>;
export async function evaluateV2Unknown(query:BoundedQuery,session:Session,prepared:V2Prepared) {
 const {input,cohort,anchor,prior,capacity,anchorVersionId}=prepared;

  if(capacity)return {state:"unavailable" as const};
  const source=await inspectCompleteSourceOn(query,session,input.leaseId,cohort);
  if(!("fingerprint" in source))return {state:"unavailable" as const};
  const lineIds=input.items.flatMap(item=>item.invoiceLineId?[item.invoiceLineId]:[]).sort();
  const scoped=await query(`SELECT l.id FROM public.invoice_lines l JOIN public.invoices i ON i.id=l.invoice_id AND i.org_id=l.org_id WHERE l.org_id=$1 AND i.lease_id=$2 AND l.id=ANY($3::uuid[]) ORDER BY l.id`,[session.orgId,input.leaseId,lineIds]);
  if(scoped.rowCount!==lineIds.length){if(anchorVersionId)throw new V2SourceStale();throw new FlowError("errors.notFound");}
  return encodeUnknownV2(input,source,{anchor,prior:prior as never});
}
export async function v2FinalDeadline(query:BoundedQuery,session:Session) {if(!(await query(`SELECT 1 FROM public.auth_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()`,[session.sessionId,session.userId])).rowCount)throw new FlowError("errors.notFound");}
/** Staff-only UNKNOWN preview; no write, publication or financial mutation. */
export async function previewV2Unknown(session:Session,raw:SettlementPreviewInput,anchorVersionId?:string) {
 let prepared:V2Prepared;
 return withSettlementFencePrototype(session.userId,async client=>{prepared=await prepareV2Unknown(client,session,raw,anchorVersionId);},query=>evaluateV2Unknown(query,session,prepared),query=>v2FinalDeadline(query,session));
}
