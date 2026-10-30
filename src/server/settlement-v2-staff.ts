import { FlowError } from "./errors";
import { settlementRequestLock,settlementUuid } from "./settlement-access";
import { settlementV2HistoricalContext } from "./settlement-v2-context";
import { withSettlementFencePrototype } from "./settlement-fenced-transaction";
import { normalizeSettlementInput,type SettlementPreviewInput } from "./settlement-preview";
import { prepareV2Unknown,evaluateV2Unknown,v2FinalDeadline,V2SourceStale } from "./settlement-v2-preview";
import type { Session } from "./types";
import { SettlementSourceBusy,SettlementSourceIncomplete } from "./settlement-complete-source";

/** Staff-only v2 UNKNOWN draft; no publication or financial mutation. */
export async function saveV2Unknown(session:Session,raw:SettlementPreviewInput,expectedFingerprint:string,expectedVersion:string|null,requestId:string) {
 const input=normalizeSettlementInput(raw);settlementUuid(requestId);if(expectedVersion!==null)settlementUuid(expectedVersion);if(!/^[a-f0-9]{64}$/.test(expectedFingerprint))throw new FlowError("errors.required");
 let prepared:Awaited<ReturnType<typeof prepareV2Unknown>>,prior:string|null=null,previousItems:{id:string;item_key:string;original_minor:string}[]=[];
 return withSettlementFencePrototype(session.userId,async client=>{
  await settlementV2HistoricalContext(client,session,input.leaseId);await settlementRequestLock(client,session,input.leaseId,"statement",requestId);
  const existing=(await client.query<{id:string;published:boolean;source_fingerprint:string;snapshot:{schema?:string;input?:SettlementPreviewInput;requestExpectedVersion?:string|null;calculation?:{authoritative?:boolean}}}>(`SELECT id,published,source_fingerprint,snapshot FROM app.settlement_versions WHERE org_id=$1 AND lease_id=$2 AND created_by=$3 AND request_id=$4`,[session.orgId,input.leaseId,session.userId,requestId])).rows[0];
  if(existing){if(existing.published||existing.snapshot.schema!=="settlement-v2"||existing.snapshot.calculation?.authoritative!==false||!existing.snapshot.input||existing.snapshot.requestExpectedVersion!==expectedVersion||existing.source_fingerprint!==expectedFingerprint||JSON.stringify(normalizeSettlementInput(existing.snapshot.input))!==JSON.stringify(input))throw new FlowError("errors.generic");prior=existing.id;return;}
  prepared=await prepareV2Unknown(client,session,input,undefined,true);
  if(prepared.currentId!==expectedVersion)throw new FlowError("errors.generic");
  if(expectedVersion&&input.items.length){const keys=input.items.map(item=>item.key);previousItems=(await client.query<{id:string;item_key:string;original_minor:string}>(`SELECT id,item_key,original_minor::text FROM app.settlement_items WHERE org_id=$1 AND lease_id=$2 AND version_id=$3 AND item_key=ANY($4::uuid[]) ORDER BY id`,[session.orgId,input.leaseId,expectedVersion,keys])).rows;await client.query(`SELECT app.settlement_pin_prior_items($1,$2,$3,$4,$5,$6::uuid[])`,[session.orgId,session.liveOrgId,session.environment,input.leaseId,session.sessionId,previousItems.map(item=>item.id)]);}
 },async query=>{
  if(prior)return {id:prior,recovered:true as const,freshness:"unavailable" as const};
  const preview=await evaluateV2Unknown(query,session,prepared);if(preview.state!=="unknown"||preview.fingerprint!==expectedFingerprint||!prepared.recordId)throw new FlowError("errors.generic");
  const attrs=(await query(`SELECT a.id,a.amount_minor::text,a.revision,a.evidence_id,s.kind FROM app.settlement_attributions a JOIN app.settlement_sources s ON s.id=a.source_id WHERE a.org_id=$1 AND a.lease_id=$2 AND a.id=ANY($3::uuid[]) ORDER BY a.id`,[session.orgId,input.leaseId,input.attributionIds])).rows;
  const snapshot={schema:"settlement-v2",input,requestExpectedVersion:expectedVersion,calculation:preview.calculation,sourceEnvelope:preview.envelope,attrs,sourceProjection:"not_included"};
  const version=(await query<{id:string}>(`INSERT INTO app.settlement_versions(org_id,lease_id,record_id,revision,published,snapshot,source_fingerprint,created_by,request_id) VALUES($1,$2,$3,$4,false,$5::jsonb,$6,$7,$8) RETURNING id`,[session.orgId,input.leaseId,prepared.recordId,prepared.anchor,JSON.stringify(snapshot),preview.fingerprint,session.userId,requestId])).rows[0].id;
  for(const evidenceId of prepared.evidence)await query(`INSERT INTO app.settlement_evidence_links(org_id,lease_id,version_id,evidence_id,linked_by) VALUES($1,$2,$3,$4,$5)`,[session.orgId,input.leaseId,version,evidenceId,session.userId]);
  for(const attribution of input.attributionIds)await query(`INSERT INTO app.settlement_version_attributions(org_id,lease_id,version_id,attribution_id) VALUES($1,$2,$3,$4)`,[session.orgId,input.leaseId,version,attribution]);
  for(const item of input.items){const previous=previousItems.find(row=>row.item_key===item.key);await query(`INSERT INTO app.settlement_items(org_id,lease_id,version_id,item_key,label,original_minor,amount_minor,reason,evidence_id,prior_item_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[session.orgId,input.leaseId,version,item.key,item.label,previous?.original_minor??item.amountMinor,item.amountMinor,item.reason,item.evidenceId,previous?.id??null,session.userId]);}
  await query(`INSERT INTO public.audit_log(org_id,actor_user_id,actor_role,table_name,row_id,action,event_type,new_row,reason) VALUES($1,$2,'app','auth_events','settlement_version_saved','insert','settlement_version_saved',$3::jsonb,'settlement_version_saved')`,[session.orgId,session.userId,JSON.stringify({event:"settlement_version_saved",lease_id:input.leaseId,version_id:version,published:false})]);
  return {id:version,recovered:false as const,freshness:"current" as const};
 },query=>v2FinalDeadline(query,session));
}

/** Exact saved v2 draft with bounded source freshness; staff only. */
export async function readV2Unknown(session:Session,raw:SettlementPreviewInput,versionId:string) {
 const input=normalizeSettlementInput(raw);settlementUuid(versionId);let prepared:Awaited<ReturnType<typeof prepareV2Unknown>>,snapshot:unknown,fingerprint="",unavailable=false,sourceStale=false;
 return withSettlementFencePrototype(session.userId,async client=>{
  await settlementV2HistoricalContext(client,session,input.leaseId);
  const row=(await client.query<{snapshot:{schema?:string;input?:SettlementPreviewInput;calculation?:{authoritative?:boolean}};source_fingerprint:string;published:boolean}>(`SELECT snapshot,source_fingerprint,published FROM app.settlement_versions WHERE id=$1 AND org_id=$2 AND lease_id=$3`,[versionId,session.orgId,input.leaseId])).rows[0];
  if(!row||row.published||row.snapshot.schema!=="settlement-v2"||row.snapshot.calculation?.authoritative!==false||!row.snapshot.input||JSON.stringify(normalizeSettlementInput(row.snapshot.input))!==JSON.stringify(input))throw new FlowError("errors.notFound");snapshot=row.snapshot;fingerprint=row.source_fingerprint;
  await client.query("SAVEPOINT v2_read_freshness");
  try {prepared=await prepareV2Unknown(client,session,input,versionId);await client.query("RELEASE SAVEPOINT v2_read_freshness");}
  catch(error){const code=(error as {code?:string})?.code;if(!(error instanceof V2SourceStale)&&!(error instanceof SettlementSourceBusy)&&!(error instanceof SettlementSourceIncomplete)&&code!=="55P03"&&code!=="42501"&&code!=="57014")throw error;await client.query("ROLLBACK TO SAVEPOINT v2_read_freshness");await client.query("RELEASE SAVEPOINT v2_read_freshness");sourceStale=error instanceof V2SourceStale;unavailable=!sourceStale;}
 },async query=>{
  if(sourceStale)return {snapshot,freshness:"stale" as const};
  if(unavailable)return {snapshot,freshness:"unavailable" as const};
  await query("SAVEPOINT v2_fenced_freshness");
  try {const result=await evaluateV2Unknown(query,session,prepared);await query("RELEASE SAVEPOINT v2_fenced_freshness");return {snapshot,freshness:result.state==="unavailable"?"unavailable" as const:result.fingerprint===fingerprint?"current" as const:"stale" as const};}
  catch(error){const code=(error as {code?:string})?.code;if(!(error instanceof V2SourceStale)&&code!=="55P03"&&code!=="57014")throw error;await query("ROLLBACK TO SAVEPOINT v2_fenced_freshness");await query("RELEASE SAVEPOINT v2_fenced_freshness");return {snapshot,freshness:error instanceof V2SourceStale?"stale" as const:"unavailable" as const};}
 },query=>v2FinalDeadline(query,session));
}
