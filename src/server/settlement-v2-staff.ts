import { FlowError } from "./errors";
import { settlementRequestLock,settlementUuid } from "./settlement-access";
import { settlementV2HistoricalContext } from "./settlement-v2-context";
import { withSettlementFencePrototype } from "./settlement-fenced-transaction";
import { normalizeSettlementInput,type SettlementPreviewInput } from "./settlement-preview";
import { prepareV2Unknown,evaluateV2Unknown,v2FinalDeadline,V2SourceStale } from "./settlement-v2-preview";
import type { Session } from "./types";
import { requireOpenStatementRequest } from "./settlement-terminal";
import { validateV2UnknownSnapshot,assertV2Scope } from "./settlement-v2-schema";
import { SettlementSourceBusy,SettlementSourceIncomplete } from "./settlement-complete-source";

/** Staff-only v2 UNKNOWN draft; no publication or financial mutation. */
export async function saveV2Unknown(session:Session,raw:SettlementPreviewInput,expectedFingerprint:string,expectedVersion:string|null,requestId:string) {
 const input=normalizeSettlementInput(raw);settlementUuid(requestId);if(expectedVersion!==null)settlementUuid(expectedVersion);if(!/^[a-f0-9]{64}$/.test(expectedFingerprint))throw new FlowError("errors.required");
 let prepared:Awaited<ReturnType<typeof prepareV2Unknown>>,prior:string|null=null,previousItems:{id:string;item_key:string;original_minor:string}[]=[];
 return withSettlementFencePrototype(session.userId,async client=>{
  await settlementV2HistoricalContext(client,session,input.leaseId);await settlementRequestLock(client,session,input.leaseId,"statement",requestId);await requireOpenStatementRequest(client,session,input.leaseId,requestId);
  const existing=(await client.query<{id:string;published:boolean;source_fingerprint:string;snapshot:{schema?:string;input?:SettlementPreviewInput;requestExpectedVersion?:string|null;calculation?:{authoritative?:boolean}}}>(`SELECT id,published,source_fingerprint,snapshot FROM app.settlement_versions WHERE org_id=$1 AND lease_id=$2 AND created_by=$3 AND request_id=$4`,[session.orgId,input.leaseId,session.userId,requestId])).rows[0];
  if(existing){if(existing.published)throw new FlowError("errors.generic");const validated=validateV2UnknownSnapshot(existing.snapshot);assertV2Scope(validated.scope,session,input.leaseId,session.userId,requestId);if(validated.requestExpectedVersion!==expectedVersion||existing.source_fingerprint!==expectedFingerprint||JSON.stringify(validated.input)!==JSON.stringify(input))throw new FlowError("errors.generic");prior=existing.id;return;}
  prepared=await prepareV2Unknown(client,session,input,undefined,true);
  if(prepared.currentId!==expectedVersion)throw new FlowError("errors.generic");
  if(expectedVersion&&input.items.length){const keys=input.items.map(item=>item.key);previousItems=(await client.query<{id:string;item_key:string;original_minor:string}>(`SELECT id,item_key,original_minor::text FROM app.settlement_items WHERE org_id=$1 AND lease_id=$2 AND version_id=$3 AND item_key=ANY($4::uuid[]) ORDER BY id`,[session.orgId,input.leaseId,expectedVersion,keys])).rows;await client.query(`SELECT app.settlement_pin_prior_items($1,$2,$3,$4,$5,$6::uuid[])`,[session.orgId,session.liveOrgId,session.environment,input.leaseId,session.sessionId,previousItems.map(item=>item.id)]);}
 },async query=>{
  if(prior)return {id:prior,recovered:true as const,freshness:"unavailable" as const};
  const preview=await evaluateV2Unknown(query,session,prepared);if(preview.state!=="unknown"||preview.fingerprint!==expectedFingerprint||!prepared.recordId)throw new FlowError("errors.generic");
  const attrs=(await query(`SELECT a.id,a.amount_minor::text,a.revision,a.evidence_id,s.kind,s.currency::text AS currency FROM app.settlement_attributions a JOIN app.settlement_sources s ON s.id=a.source_id WHERE a.org_id=$1 AND a.lease_id=$2 AND a.id=ANY($3::uuid[]) ORDER BY a.id`,[session.orgId,input.leaseId,input.attributionIds])).rows;
  const snapshot={schema:"settlement-v2",commandScope:{actorId:session.userId.toLowerCase(),orgId:session.orgId.toLowerCase(),liveOrgId:session.liveOrgId.toLowerCase(),environment:session.environment,leaseId:input.leaseId.toLowerCase(),lane:"statement",requestId:requestId.toLowerCase(),expectedVersion},input,requestExpectedVersion:expectedVersion,calculation:preview.calculation,sourceEnvelope:preview.envelope,attrs,sourceProjection:preview.projection};
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
  const row=(await client.query<{snapshot:{schema?:string;input?:SettlementPreviewInput;calculation?:{authoritative?:boolean}};source_fingerprint:string;published:boolean;created_by:string;request_id:string}>(`SELECT snapshot,source_fingerprint,published,created_by,request_id FROM app.settlement_versions WHERE id=$1 AND org_id=$2 AND lease_id=$3`,[versionId,session.orgId,input.leaseId])).rows[0];
  if(!row||row.published)throw new FlowError("errors.notFound");const validated=validateV2UnknownSnapshot(row.snapshot);assertV2Scope(validated.scope,session,input.leaseId,row.created_by,row.request_id);if(JSON.stringify(validated.input)!==JSON.stringify(input))throw new FlowError("errors.notFound");snapshot={schema:"settlement-v2",input:validated.input,requestExpectedVersion:validated.requestExpectedVersion,calculation:validated.calculation,provenance:validated.provenance,sourceProjection:validated.projection};fingerprint=row.source_fingerprint;
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

/** Resolve the immutable v2 input server-side. Staff only; callers receive a
 * narrow stored projection, never the private source envelope or payment IDs. */
export async function loadV2Unknown(session:Session,leaseId:string,versionId:string) {
 settlementUuid(leaseId);settlementUuid(versionId);
 const { svc }=await import("./db");
 const stored=await svc(session.userId,async client=>{
  await settlementV2HistoricalContext(client,session,leaseId);
  const row=(await client.query<{snapshot:{schema?:string;input?:SettlementPreviewInput;calculation?:{authoritative?:boolean}};published:boolean;created_at:Date;created_by:string;request_id:string}>(`SELECT snapshot,published,created_at,created_by,request_id FROM app.settlement_versions WHERE org_id=$1 AND lease_id=$2 AND id=$3`,[session.orgId,leaseId,versionId])).rows[0];
  if(!row||row.published)throw new FlowError("errors.notFound");const validated=validateV2UnknownSnapshot(row.snapshot);assertV2Scope(validated.scope,session,leaseId,row.created_by,row.request_id);
  const items=(await client.query(`SELECT i.item_key,i.label,i.amount_minor::text,i.original_minor::text,prior.amount_minor::text AS prior_minor,i.reason,i.evidence_id,i.created_at,nullif(btrim(p.display_name),'') AS author_name FROM app.settlement_items i LEFT JOIN app.settlement_items prior ON prior.id=i.prior_item_id LEFT JOIN public.profiles p ON p.id=i.created_by WHERE i.org_id=$1 AND i.lease_id=$2 AND i.version_id=$3 ORDER BY i.item_key`,[session.orgId,leaseId,versionId])).rows;
  return {input:validated.input,createdAt:row.created_at,items};
 });
 const result=await readV2Unknown(session,stored.input,versionId),snapshot=result.snapshot as {calculation:{authoritative:false;netMinor:null;refundMinor:null;topUpMinor:null};provenance:{kind:string;amountMinor:string;revision:number;currency:string}[];sourceProjection:ReturnType<typeof validateV2UnknownSnapshot>["projection"]};
 if(!snapshot||!Array.isArray(snapshot.provenance)||!snapshot.sourceProjection)throw new FlowError("errors.generic");
 return {published:false as const,createdAt:stored.createdAt,freshness:result.freshness,calculation:snapshot.calculation,editorInput:stored.input,provenance:snapshot.provenance,sourceProjection:snapshot.sourceProjection,items:stored.items.map(i=>({...i,adjustment_minor:(BigInt(i.amount_minor)-BigInt(i.prior_minor??i.original_minor)).toString()}))};
}
