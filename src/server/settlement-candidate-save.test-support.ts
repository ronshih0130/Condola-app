import { createHash } from "node:crypto";
import { FlowError } from "./errors";
import { settlementAccess, settlementRequestLock, settlementUuid } from "./settlement-access";
import { prepareCompleteSource, inspectCompleteSourceOn } from "./settlement-complete-source";
import { withSettlementFencePrototype } from "./settlement-fenced-transaction";
import type { Session } from "./types";
import { disposableDbUrl } from "./test-disposable-db";

/** Isolated local diagnostic; never call from an action or publish path. */
export async function saveCandidateDiagnostic(session:Session,ownedDatabase:string,input:{leaseId:string;requestId:string;expectedSource:string;evidenceId:string;attributionId:string;label:string}) {
  const db=disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
  if(!/^condola_b011_[a-f0-9]{32}$/.test(ownedDatabase)||decodeURIComponent(db.pathname.slice(1))!==ownedDatabase||process.env.DEMO_MODE!=="true")throw new FlowError("errors.notFound");
  for(const id of [input.leaseId,input.requestId,input.evidenceId,input.attributionId])settlementUuid(id);
  const label=input.label.trim();if(!label||label.length>200||!/^[a-f0-9]{64}$/.test(input.expectedSource))throw new FlowError("errors.required");
  const payload={leaseId:input.leaseId,requestId:input.requestId,expectedSource:input.expectedSource,evidenceId:input.evidenceId,attributionId:input.attributionId,label},payloadHash=createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  let prior:string|null=null,cohort:Awaited<ReturnType<typeof prepareCompleteSource>>,recordId="",revision=0;
  return withSettlementFencePrototype(session.userId,async client=>{
    await settlementAccess(client,session,input.leaseId,"prepare");await settlementRequestLock(client,session,input.leaseId,"statement",input.requestId);
    const existing=(await client.query<{id:string;snapshot:{diagnostic?:{payloadHash:string}}}>(`SELECT id,snapshot FROM app.settlement_versions WHERE org_id=$1 AND lease_id=$2 AND created_by=$3 AND request_id=$4`,[session.orgId,input.leaseId,session.userId,input.requestId])).rows[0];
    if(existing){if(existing.snapshot.diagnostic?.payloadHash!==payloadHash)throw new FlowError("errors.generic");prior=existing.id;return;}
    cohort=await prepareCompleteSource(client,session,input.leaseId);
    const record=(await client.query<{id:string}>(`SELECT id FROM app.settlement_records WHERE org_id=$1 AND lease_id=$2 AND currency=$3 FOR UPDATE NOWAIT`,[session.orgId,input.leaseId,cohort.lease.currency])).rows[0];if(!record)throw new FlowError("errors.notFound");recordId=record.id;
    revision=((await client.query<{revision:number}>(`SELECT revision FROM app.settlement_versions WHERE record_id=$1 ORDER BY revision DESC LIMIT 1`,[recordId])).rows[0]?.revision??0)+1;
    await client.query(`SELECT app.b011_test_pin_candidate($1,$2,$3,$4,$5,$6,$7,$8)`,[session.userId,session.sessionId,session.orgId,input.leaseId,input.evidenceId,input.attributionId,session.liveOrgId,session.environment]);
    await client.query("LOCK TABLE app.settlement_versions,app.settlement_evidence_links,app.settlement_version_attributions,app.settlement_items,public.audit_log IN ROW EXCLUSIVE MODE NOWAIT");
  },async query=>{
    if(prior)return {id:prior,recovered:true as const};
    const candidate=await inspectCompleteSourceOn(query,session,input.leaseId,cohort);
    if(!candidate.verifiedCandidate||candidate.fingerprint!==input.expectedSource||!candidate.verifiedAttributions.some(a=>a.id===input.attributionId&&a.evidenceId===input.evidenceId))throw new FlowError("errors.generic");
    const snapshot={diagnostic:{schema:"b011-candidate-v1",payloadHash,sourceFingerprint:candidate.fingerprint,sourceAmounts:candidate.sourceAmounts},calculation:{authoritative:false,netMinor:null}};
    const version=(await query<{id:string}>(`INSERT INTO app.settlement_versions(org_id,lease_id,record_id,revision,published,snapshot,source_fingerprint,created_by,request_id) VALUES($1,$2,$3,$4,false,$5::jsonb,$6,$7,$8) RETURNING id`,[session.orgId,input.leaseId,recordId,revision,JSON.stringify(snapshot),candidate.fingerprint,session.userId,input.requestId])).rows[0].id;
    await query(`INSERT INTO app.settlement_evidence_links(org_id,lease_id,version_id,evidence_id,linked_by) VALUES($1,$2,$3,$4,$5)`,[session.orgId,input.leaseId,version,input.evidenceId,session.userId]);
    await query(`INSERT INTO app.settlement_version_attributions(org_id,lease_id,version_id,attribution_id) VALUES($1,$2,$3,$4)`,[session.orgId,input.leaseId,version,input.attributionId]);
    await query(`INSERT INTO app.settlement_items(org_id,lease_id,version_id,item_key,label,original_minor,amount_minor,reason,evidence_id,created_by) VALUES($1,$2,$3,$4,$5,0,0,'Diagnostic only',$6,$7)`,[session.orgId,input.leaseId,version,input.requestId,label,input.evidenceId,session.userId]);
    await query(`INSERT INTO public.audit_log(org_id,actor_user_id,actor_role,table_name,row_id,action,event_type,new_row,reason) VALUES($1,$2,'app','auth_events','settlement_candidate_diagnostic','insert','settlement_candidate_diagnostic',$3::jsonb,'settlement_candidate_diagnostic')`,[session.orgId,session.userId,JSON.stringify({lease_id:input.leaseId,version_id:version})]);
    return {id:version,recovered:false as const};
  },async query=>{const live=await query(`SELECT 1 FROM public.auth_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()`,[session.sessionId,session.userId]);if(!live.rowCount)throw new FlowError("errors.notFound");});
}

/** Isolated diagnostic read; not a production settlement reader. */
export async function readCandidateDiagnostic(session:Session,ownedDatabase:string,leaseId:string,versionId:string) {
  const db=disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
  if(!/^condola_b011_[a-f0-9]{32}$/.test(ownedDatabase)||decodeURIComponent(db.pathname.slice(1))!==ownedDatabase||process.env.DEMO_MODE!=="true")throw new FlowError("errors.notFound");
  settlementUuid(leaseId);settlementUuid(versionId);let cohort:Awaited<ReturnType<typeof prepareCompleteSource>>,stored="";
  try {return await withSettlementFencePrototype(session.userId,async client=>{
    await settlementAccess(client,session,leaseId,"prepare");
    const version=(await client.query<{source_fingerprint:string;snapshot:{diagnostic?:{schema:string}};published:boolean}>(`SELECT source_fingerprint,snapshot,published FROM app.settlement_versions WHERE org_id=$1 AND lease_id=$2 AND id=$3`,[session.orgId,leaseId,versionId])).rows[0];
    if(!version||version.published||version.snapshot.diagnostic?.schema!=="b011-candidate-v1")throw new FlowError("errors.notFound");stored=version.source_fingerprint;cohort=await prepareCompleteSource(client,session,leaseId);
  },async query=>{
    const candidate=await inspectCompleteSourceOn(query,session,leaseId,cohort);
    if(!("fingerprint" in candidate))return {status:"unavailable" as const};
    if(candidate.fingerprint!==stored)return {status:"stale" as const};
    return {status:candidate.verifiedCandidate?"current" as const:"unavailable" as const};
  },async query=>{const live=await query(`SELECT 1 FROM public.auth_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()`,[session.sessionId,session.userId]);if(!live.rowCount)throw new FlowError("errors.notFound");});}
  catch(error){if(error instanceof FlowError&&(error.cause as {code?:string})?.code==="55P03")return {status:"unavailable" as const};throw error;}
}
