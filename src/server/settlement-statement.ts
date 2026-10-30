import { writeAudit } from "./audit";
import { svc } from "./db";
import { FlowError } from "./errors";
import { settlementAccess, settlementDeadline, settlementRequestLock, settlementUuid } from "./settlement-access";
import { normalizeSettlementInput, settlementPreviewOn, SettlementFreshnessBusy, type SettlementPreviewInput } from "./settlement-preview";
import type { Session } from "./types";

/** A version is immutable; source changes or a concurrent edit require refresh. */
export async function saveSettlement(session:Session, input:SettlementPreviewInput, expectedFingerprint:string, expectedVersion:string|null, requestId:string, publish:boolean) {
  settlementUuid(requestId); if(expectedVersion!==null) settlementUuid(expectedVersion);
  if(!/^[0-9a-f]{64}$/.test(expectedFingerprint) || typeof publish!=="boolean") throw new FlowError("errors.required");
  return svc(session.userId,async client=>{
    await settlementAccess(client,session,input.leaseId,"read");
    await settlementRequestLock(client,session,input.leaseId,"statement",requestId);
    const prior=(await client.query<{id:string;record_id:string;source_fingerprint:string;published:boolean;snapshot:{schema?:unknown;input:SettlementPreviewInput;requestExpectedVersion:string|null}}>(`SELECT id,record_id,source_fingerprint,published,snapshot FROM app.settlement_versions WHERE created_by=$1 AND request_id=$2 AND org_id=$3 AND lease_id=$4`,[session.userId,requestId,session.orgId,input.leaseId])).rows[0];
    if(prior) {
      if(prior.snapshot.schema!==undefined || prior.source_fingerprint!==expectedFingerprint || prior.published!==publish || prior.snapshot.requestExpectedVersion!==expectedVersion || JSON.stringify(normalizeSettlementInput(prior.snapshot.input))!==JSON.stringify(normalizeSettlementInput(input))) throw new FlowError("errors.generic");
      let stale=false,freshnessUnavailable=false; await client.query("SAVEPOINT settlement_replay");
      try { const fresh=await settlementPreviewOn(client,session,prior.snapshot.input,{partyRead:true,excludeOutcomeVersion:prior.id}); stale=fresh.fingerprint!==prior.source_fingerprint; await client.query("RELEASE SAVEPOINT settlement_replay"); }
      catch(error) { if(!(error instanceof FlowError) && (error as {code?:string})?.code!=="55P03") throw error; await client.query("ROLLBACK TO SAVEPOINT settlement_replay"); await client.query("RELEASE SAVEPOINT settlement_replay"); if(error instanceof SettlementFreshnessBusy||(error as {code?:string})?.code==="55P03")freshnessUnavailable=true;else stale=true; }
      const latest=(await client.query<{id:string}>(`SELECT id FROM app.settlement_versions WHERE record_id=$1 AND (NOT $2::boolean OR published) ORDER BY revision DESC LIMIT 1`,[prior.record_id,prior.published])).rows[0];
      await settlementDeadline(client,session,input.leaseId); return {id:prior.id,recovered:true,stale,...(freshnessUnavailable?{freshnessUnavailable:true as const}:{}),current:latest?.id===prior.id,currentScope:prior.published ? "published" as const : "editor" as const};
    }
    const preview=await settlementPreviewOn(client,session,input,{lockParent:true,publish});
    if(!preview.recordId || preview.fingerprint!==expectedFingerprint) throw new FlowError("errors.generic");
    const current=(await client.query<{id:string;revision:number}>(`SELECT id,revision FROM app.settlement_versions WHERE record_id=$1 ORDER BY revision DESC LIMIT 1`,[preview.recordId])).rows[0];
    if((current?.id ?? null)!==expectedVersion) throw new FlowError("errors.generic");
    if(publish && !preview.calculation.authoritative) throw new FlowError("errors.required");
    const {recordId,...facts}=preview;
    const snapshot={...facts,requestExpectedVersion:expectedVersion};
    const version=(await client.query<{id:string}>(`INSERT INTO app.settlement_versions(org_id,lease_id,record_id,revision,published,snapshot,source_fingerprint,created_by,request_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) RETURNING id`,[session.orgId,input.leaseId,recordId,(current?.revision ?? 0)+1,publish,JSON.stringify(snapshot),expectedFingerprint,session.userId,requestId])).rows[0];
    const evidenceIds=[...new Set([...preview.input.items.map(i=>i.evidenceId),...(preview.input.sourceReview?[preview.input.sourceReview.evidenceId]:[]),...preview.attrs.map(a=>String(a.evidence_id))])];
    for(const evidenceId of evidenceIds) await client.query(`INSERT INTO app.settlement_evidence_links(org_id,lease_id,version_id,evidence_id,linked_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[session.orgId,input.leaseId,version.id,evidenceId,session.userId]);
    for(const attribution of preview.input.attributionIds) await client.query(`INSERT INTO app.settlement_version_attributions(org_id,lease_id,version_id,attribution_id) VALUES($1,$2,$3,$4)`,[session.orgId,input.leaseId,version.id,attribution]);
    for(const item of preview.input.items) {
      const previous=current ? (await client.query<{id:string;original_minor:string}>(`SELECT id,original_minor::text FROM app.settlement_items WHERE version_id=$1 AND item_key=$2`,[current.id,item.key])).rows[0] : undefined;
      await client.query(`INSERT INTO app.settlement_items(org_id,lease_id,version_id,item_key,label,original_minor,amount_minor,reason,evidence_id,prior_item_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[session.orgId,input.leaseId,version.id,item.key,item.label,previous?.original_minor ?? item.amountMinor,item.amountMinor,item.reason,item.evidenceId,previous?.id ?? null,session.userId]);
    }
    await writeAudit(session.orgId,session.userId,"settlement_version_saved",{lease_id:input.leaseId,version_id:version.id,published:publish},client);
    await settlementDeadline(client,session,input.leaseId); return {id:version.id,recovered:false,stale:false,current:true,currentScope:publish ? "published" as const : "editor" as const};
  });
}

/** Immutable content is shown with a fresh-source indication, never a claim
 * that the source will remain fresh after this transaction releases locks. */
export async function readSettlement(session:Session,leaseId:string,versionId:string) {
  settlementUuid(leaseId); settlementUuid(versionId);
  return svc(session.userId,async client=>{
    await settlementAccess(client,session,leaseId,"read");
    const version=(await client.query<{snapshot:{input:SettlementPreviewInput;calculation:unknown;attrs:{kind:string;amount_minor:string;revision:number}[];cycles?:{period_start:string;period_end:string;agreed_monthly_minor:string}[];rentAttrs?:{id:string;kind:string;amount_minor:string;revision:number}[];candidateLines?:{id:string;description:string;invoice_number:string;charge_type:string;amount_minor:string;service_period:string|null;status:string;balance_minor:string}[];bindings?:{invoice_line_id:string;classification:string}[];rentSourceCoverage?:string;rentSourceIssues?:{id:string;invalid:boolean}[]};source_fingerprint:string;published:boolean;created_at:Date;author_name:string|null}>(`SELECT v.snapshot,v.source_fingerprint,v.published,v.created_at,nullif(btrim(p.display_name),'') AS author_name FROM app.settlement_versions v LEFT JOIN public.profiles p ON p.id=v.created_by WHERE v.id=$1 AND v.org_id=$2 AND v.lease_id=$3`,[versionId,session.orgId,leaseId])).rows[0];
    if(!version || (!version.published && session.kind!=="staff")) throw new FlowError("errors.notFound");
    let stale=false,freshnessUnavailable=false;
    await client.query("SAVEPOINT settlement_read_freshness");
    try {
      const fresh=await settlementPreviewOn(client,session,version.snapshot.input,{partyRead:true,excludeOutcomeVersion:versionId});
      stale=fresh.fingerprint!==version.source_fingerprint;
      await client.query("RELEASE SAVEPOINT settlement_read_freshness");
    } catch(error) {
      if(!(error instanceof FlowError) && (error as {code?:string})?.code!=="55P03") throw error;
      await client.query("ROLLBACK TO SAVEPOINT settlement_read_freshness");await client.query("RELEASE SAVEPOINT settlement_read_freshness");
      if(error instanceof SettlementFreshnessBusy||(error as {code?:string})?.code==="55P03")freshnessUnavailable=true;else stale=true;
    }
    const items=(await client.query(`SELECT i.item_key,i.label,i.amount_minor::text,i.original_minor::text,prior.amount_minor::text AS prior_minor,i.reason,i.evidence_id,i.created_at,nullif(btrim(p.display_name),'') AS author_name FROM app.settlement_items i LEFT JOIN app.settlement_items prior ON prior.id=i.prior_item_id LEFT JOIN public.profiles p ON p.id=i.created_by WHERE i.org_id=$1 AND i.lease_id=$2 AND i.version_id=$3 ORDER BY i.item_key`,[session.orgId,leaseId,versionId])).rows;
    const outcomes=(await client.query(`SELECT o.id,o.version_id,o.evidence_id,o.direction,o.amount_minor::text,o.currency::text,o.occurred_on::text,v.revision AS statement_revision,nullif(btrim(payer.display_name),'') AS payer_name,nullif(btrim(payee.display_name),'') AS payee_name,(o.payer_id=$3 AND o.payer_kind=$4) AS can_withdraw,(o.payee_id=$3 AND o.payee_kind=$4) AS can_ack,coalesce((SELECT jsonb_agg(jsonb_build_object('event',e.event,'revision',e.revision,'created_at',e.created_at) ORDER BY e.revision) FROM app.settlement_outcome_events e WHERE e.outcome_id=o.id),'[]'::jsonb) AS events,(SELECT e.id FROM app.settlement_outcome_events e WHERE e.outcome_id=o.id ORDER BY e.revision DESC LIMIT 1) AS last_event_id FROM app.settlement_outcomes o JOIN app.settlement_versions v ON v.id=o.version_id LEFT JOIN public.profiles payer ON payer.id=o.payer_id LEFT JOIN public.profiles payee ON payee.id=o.payee_id WHERE o.org_id=$1 AND o.lease_id=$2 AND v.published ORDER BY o.created_at,o.id`,[session.orgId,leaseId,session.userId,session.kind])).rows;
    const replies=(await client.query(`SELECT r.actor_kind,r.response,r.note,r.created_at,nullif(btrim(p.display_name),'') AS actor_name FROM app.settlement_replies r LEFT JOIN public.profiles p ON p.id=r.actor_id WHERE r.org_id=$1 AND r.lease_id=$2 AND r.version_id=$3 ORDER BY r.created_at,r.id`,[session.orgId,leaseId,versionId])).rows;
    const observations=(await client.query(`SELECT o.id,o.version_id,o.direction,o.amount_minor::text,o.currency::text,o.occurred_on::text,o.reason,o.created_at,o.evidence_id,v.revision AS statement_revision,nullif(btrim(p.display_name),'') AS reporter_name,nullif(btrim(payer.display_name),'') AS payer_name,nullif(btrim(payee.display_name),'') AS payee_name FROM app.settlement_external_observations o JOIN app.settlement_versions v ON v.id=o.version_id LEFT JOIN public.profiles p ON p.id=o.reporter_id LEFT JOIN public.profiles payer ON payer.id=o.payer_id LEFT JOIN public.profiles payee ON payee.id=o.payee_id WHERE o.org_id=$1 AND o.lease_id=$2 AND v.published ORDER BY o.created_at,o.id`,[session.orgId,leaseId])).rows;
    await settlementDeadline(client,session,leaseId);
    // Do not expose stored payment IDs, external source identities or database
    // fingerprints to the portal; those remain within the private snapshot.
    return { published:version.published,createdAt:version.created_at,stale,freshnessUnavailable,calculation:version.snapshot.calculation,sourceReview:version.snapshot.input.sourceReview ? {...version.snapshot.input.sourceReview,actorName:version.author_name,createdAt:version.created_at} : null,provenance:version.snapshot.attrs.map(a=>({kind:a.kind,amountMinor:a.amount_minor,revision:a.revision})),rentSources:version.snapshot.rentSourceCoverage ? {coverage:version.snapshot.rentSourceCoverage,cycles:version.snapshot.cycles??[],cash:(version.snapshot.rentAttrs??[]).map(a=>({kind:a.kind,amountMinor:a.amount_minor,revision:a.revision,invalid:version.snapshot.rentSourceIssues?.find(issue=>issue.id===a.id)?.invalid??true})),lines:(version.snapshot.candidateLines??[]).map(line=>({description:line.description,invoiceNumber:line.invoice_number,chargeType:line.charge_type,amountMinor:line.amount_minor,period:line.service_period,status:line.status,balanceMinor:line.balance_minor,classification:version.snapshot.bindings?.find(b=>b.invoice_line_id===line.id)?.classification??null}))} : null,editorInput:session.kind==="staff" ? version.snapshot.input : null,items:items.map(i=>({...i,adjustment_minor:(BigInt(i.amount_minor)-BigInt(i.prior_minor ?? i.original_minor)).toString()})),outcomes,observations,replies };
  });
}
