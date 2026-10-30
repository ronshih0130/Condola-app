import type { Client } from "pg";
import { writeAudit } from "./audit";
import { svc } from "./db";
import { FlowError } from "./errors";
import { settlementAccess, settlementDeadline, settlementRequestLock, settlementUuid } from "./settlement-access";
import { settlementPreviewOn, type SettlementPreviewInput } from "./settlement-preview";
import type { Session } from "./types";
type Party = "staff"|"tenant"|"owner";
type Direction = "refund"|"top_up";
type Version={record_id:string;source_fingerprint:string;snapshot:{input:SettlementPreviewInput;calculation:{authoritative:boolean;refundMinor:number|null;topUpMinor:number|null}}};
function validDate(value:string) { const d=new Date(`${value}T00:00:00Z`);return /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith("0000-") && Number.isFinite(d.getTime()) && d.toISOString().slice(0,10)===value; }
async function party(client:Client,session:Session,leaseId:string,userId:string,kind:Party) {
  settlementUuid(userId);
  let row;
  if(kind==="staff") row=await client.query(`SELECT id FROM public.org_members WHERE org_id=$1 AND user_id=$2 AND status='active' AND role IN ('admin','accountant') FOR SHARE NOWAIT`,[session.liveOrgId,userId]);
  else if(kind==="tenant") row=await client.query(`SELECT c.id FROM public.lease_parties lp JOIN public.contacts c ON c.org_id=lp.org_id AND c.id=lp.contact_id WHERE lp.org_id=$1 AND lp.lease_id=$2 AND lp.role IN ('primary','co_tenant') AND c.user_id=$3 AND c.is_tenant AND c.archived_at IS NULL FOR SHARE OF lp,c NOWAIT`,[session.orgId,leaseId,userId]);
  else if(kind==="owner") row=await client.query(`SELECT po.id FROM public.leases l JOIN public.organizations o ON o.id=l.org_id JOIN public.property_owners po ON po.org_id=l.org_id AND po.property_id=l.property_id JOIN public.contacts c ON c.org_id=po.org_id AND c.id=po.owner_contact_id WHERE l.id=$1 AND l.org_id=$2 AND c.user_id=$3 AND c.is_owner AND c.archived_at IS NULL AND po.effective_from<=timezone(o.timezone,clock_timestamp())::date AND (po.effective_to IS NULL OR po.effective_to>timezone(o.timezone,clock_timestamp())::date) FOR SHARE OF po,c NOWAIT`,[leaseId,session.orgId,userId]);
  if(!row?.rowCount) throw new FlowError("errors.notFound");
}
async function versionOn(client:Client,session:Session,leaseId:string,versionId:string) {
  const row=(await client.query<Version>(`SELECT record_id,source_fingerprint,snapshot FROM app.settlement_versions WHERE id=$1 AND org_id=$2 AND lease_id=$3 AND published`,[versionId,session.orgId,leaseId])).rows[0];
  if(!row) throw new FlowError("errors.notFound"); return row;
}
type Reconciliation={kind:"outcome"|"observation";id:string;reason:string;evidenceId:string};
function reconciliations(input:Reconciliation[]|undefined) {
  if(input===undefined) return [];
  if(!Array.isArray(input) || input.length>100) throw new FlowError("errors.required");
  const result=input.map(row=>{
    if(!row || !["outcome","observation"].includes(row.kind)) throw new FlowError("errors.required");
    settlementUuid(row.id);settlementUuid(row.evidenceId); const reason=row.reason.trim(); if(!reason || reason.length>1000) throw new FlowError("errors.required");
    return {kind:row.kind,id:row.id,reason,evidenceId:row.evidenceId};
  }).sort((a,b)=>`${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  if(new Set(result.map(row=>`${row.kind}:${row.id}`)).size!==result.length) throw new FlowError("errors.required");
  return result;
}
export async function reportSettlementOutcome(session:Session,input:{leaseId:string;versionId:string;direction:Direction;amountMinor:number;occurredOn:string;payeeId:string;payeeKind:Party;evidenceId:string;requestId:string;reconciliations?:Reconciliation[]}) {
  for(const id of [input.leaseId,input.versionId,input.payeeId,input.evidenceId,input.requestId]) settlementUuid(id);
  if(!Number.isSafeInteger(input.amountMinor) || input.amountMinor<=0 || !validDate(input.occurredOn) || input.payeeId===session.userId || !["refund","top_up"].includes(input.direction)) throw new FlowError("errors.required");
  const reconciliation=reconciliations(input.reconciliations);
  const supported=input.direction==="refund" ? (session.kind==="staff" || session.kind==="owner") && input.payeeKind==="tenant" : session.kind==="tenant" && (input.payeeKind==="staff" || input.payeeKind==="owner");
  if(!supported) throw new FlowError("errors.notFound");
  return svc(session.userId,async client=>{
    const access=await settlementAccess(client,session,input.leaseId,"read");
    await settlementRequestLock(client,session,input.leaseId,"outcome",input.requestId);
    const prior=(await client.query<{id:string;version_id:string;direction:string;amount_minor:string;occurred_on:string;payee_id:string;payee_kind:string;payer_kind:string;evidence_id:string}>(`SELECT id,version_id,direction,amount_minor::text,occurred_on::text,payee_id,payee_kind,payer_kind,evidence_id FROM app.settlement_outcomes WHERE reporter_id=$1 AND request_id=$2 AND org_id=$3 AND lease_id=$4`,[session.userId,input.requestId,session.orgId,input.leaseId])).rows[0];
    if(prior) {
      if(prior.version_id!==input.versionId || prior.direction!==input.direction || Number(prior.amount_minor)!==input.amountMinor || prior.occurred_on!==input.occurredOn || prior.payee_id!==input.payeeId || prior.payee_kind!==input.payeeKind || prior.payer_kind!==session.kind || prior.evidence_id!==input.evidenceId) throw new FlowError("errors.generic");
      const savedReconciliation=(await client.query<{kind:"outcome"|"observation";id:string;reason:string;evidenceId:string}>(`SELECT CASE WHEN prior_outcome_id IS NOT NULL THEN 'outcome' ELSE 'observation' END AS kind,coalesce(prior_outcome_id,prior_observation_id)::text AS id,reason,evidence_id::text AS "evidenceId" FROM app.settlement_outcome_reconciliations WHERE report_id=$1 ORDER BY kind,id`,[prior.id])).rows;
      if(JSON.stringify(savedReconciliation)!==JSON.stringify(reconciliation)) throw new FlowError("errors.generic");
      const savedVersion=await versionOn(client,session,input.leaseId,input.versionId); let stale=false;
      await client.query("SAVEPOINT settlement_outcome_replay");
      try {const fresh=await settlementPreviewOn(client,session,savedVersion.snapshot.input,{partyRead:true,excludeOutcomeVersion:input.versionId});stale=fresh.fingerprint!==savedVersion.source_fingerprint;await client.query("RELEASE SAVEPOINT settlement_outcome_replay");}
      catch(error){if(!(error instanceof FlowError) && (error as {code?:string})?.code!=="55P03") throw error;await client.query("ROLLBACK TO SAVEPOINT settlement_outcome_replay");await client.query("RELEASE SAVEPOINT settlement_outcome_replay");stale=true;}
      const latest=(await client.query<{id:string}>(`SELECT id FROM app.settlement_versions WHERE record_id=$1 AND published ORDER BY revision DESC LIMIT 1`,[savedVersion.record_id])).rows[0];
      await settlementDeadline(client,session,input.leaseId);return {id:prior.id,recovered:true,stale,current:latest?.id===input.versionId,currentScope:"published" as const};
    }
    await party(client,session,input.leaseId,input.payeeId,input.payeeKind);
    const version=await versionOn(client,session,input.leaseId,input.versionId);
    const preview=await settlementPreviewOn(client,session,version.snapshot.input,{partyRead:true,lockParent:true,excludeOutcomeVersion:input.versionId});
    if(preview.fingerprint!==version.source_fingerprint || !preview.calculation.authoritative) throw new FlowError("errors.generic");
    const current=(await client.query<{id:string}>(`SELECT id FROM app.settlement_versions WHERE record_id=$1 AND published ORDER BY revision DESC LIMIT 1`,[version.record_id])).rows[0];
    if(current?.id!==input.versionId) throw new FlowError("errors.generic");
    const evidence=await client.query(`SELECT 1 FROM app.settlement_evidence_links WHERE evidence_id=$1 AND org_id=$2 AND lease_id=$3 AND version_id=$4`,[input.evidenceId,session.orgId,input.leaseId,input.versionId]); if(!evidence.rowCount) throw new FlowError("errors.notFound");
    const previous=(await client.query<{kind:"outcome"|"observation";id:string}>(`SELECT 'outcome'::text AS kind,id::text FROM app.settlement_outcomes WHERE org_id=$1 AND lease_id=$2 AND version_id<>$3 UNION ALL SELECT 'observation'::text,id::text FROM app.settlement_external_observations WHERE org_id=$1 AND lease_id=$2 AND direction=$4 ORDER BY kind,id`,[session.orgId,input.leaseId,input.versionId,input.direction])).rows;
    if(JSON.stringify(previous)!==JSON.stringify(reconciliation.map(({kind,id})=>({kind,id})))) throw new FlowError("errors.generic");
    for(const row of reconciliation) if(!(await client.query(`SELECT 1 FROM app.settlement_evidence_links WHERE org_id=$1 AND lease_id=$2 AND version_id=$3 AND evidence_id=$4`,[session.orgId,input.leaseId,input.versionId,row.evidenceId])).rowCount) throw new FlowError("errors.notFound");
    const used=(await client.query<{amount:string}>(`SELECT coalesce(sum(o.amount_minor),0)::text AS amount FROM app.settlement_outcomes o WHERE o.org_id=$1 AND o.lease_id=$2 AND o.direction=$3 AND coalesce((SELECT e.event FROM app.settlement_outcome_events e WHERE e.outcome_id=o.id AND e.event IN ('acknowledged','disputed','withdrawn') ORDER BY e.revision DESC LIMIT 1),'pending')<>'withdrawn'`,[session.orgId,input.leaseId,input.direction])).rows[0].amount;
    const max=input.direction==="refund" ? preview.calculation.refundMinor : preview.calculation.topUpMinor;
    if(max===null || BigInt(used)+BigInt(input.amountMinor)>BigInt(max)) throw new FlowError("errors.required");
    const today=(await client.query<{today:string}>(`SELECT timezone(timezone,clock_timestamp())::date::text AS today FROM public.organizations WHERE id=$1`,[session.orgId])).rows[0]?.today;
    if(!today || input.occurredOn>today) throw new FlowError("errors.required");
    await party(client,session,input.leaseId,input.payeeId,input.payeeKind);
    const out=(await client.query<{id:string}>(`INSERT INTO app.settlement_outcomes(org_id,lease_id,version_id,direction,amount_minor,currency,occurred_on,payer_id,payer_kind,payee_id,payee_kind,reporter_id,evidence_id,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$8,$12,$13) RETURNING id`,[session.orgId,input.leaseId,input.versionId,input.direction,input.amountMinor,access.lease.currency,input.occurredOn,session.userId,session.kind,input.payeeId,input.payeeKind,input.evidenceId,input.requestId])).rows[0];
    for(const row of reconciliation) await client.query(`INSERT INTO app.settlement_outcome_reconciliations(org_id,lease_id,version_id,report_id,prior_outcome_id,prior_observation_id,reason,evidence_id,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[session.orgId,input.leaseId,input.versionId,out.id,row.kind==="outcome"?row.id:null,row.kind==="observation"?row.id:null,row.reason,row.evidenceId,session.userId]);
    await writeAudit(session.orgId,session.userId,"settlement_outcome_reported",{lease_id:input.leaseId,version_id:input.versionId,outcome_id:out.id,direction:input.direction},client);
    await settlementDeadline(client,session,input.leaseId); await party(client,session,input.leaseId,input.payeeId,input.payeeKind); return {id:out.id,recovered:false,stale:false,current:true,currentScope:"published" as const};
  });
}

/** A factual reply survives financial source changes and stays on this outcome.
 * On stale sources, a NOWAIT parent lock avoids any late lock inversion. */
export async function replySettlementOutcome(session:Session,input:{leaseId:string;outcomeId:string;event:"acknowledged"|"disputed"|"withdrawn"|"external_reviewed";note:string;evidenceId:string|null;expectedLastEventId:string|null;requestId:string}) {
  for(const id of [input.leaseId,input.outcomeId,input.requestId]) settlementUuid(id);
  if(input.evidenceId) settlementUuid(input.evidenceId); if(input.expectedLastEventId) settlementUuid(input.expectedLastEventId);
  const note=input.note.trim();
  if(note.length>2000 || !["acknowledged","disputed","withdrawn","external_reviewed"].includes(input.event) || (input.event==="external_reviewed" && (!input.evidenceId || !note))) throw new FlowError("errors.required");
  return svc(session.userId,async client=>{
    await settlementAccess(client,session,input.leaseId,"read");
    const outcome=(await client.query<{id:string;version_id:string;payer_id:string;payer_kind:Party;payee_id:string;payee_kind:Party}>(`SELECT id,version_id,payer_id,payer_kind,payee_id,payee_kind FROM app.settlement_outcomes WHERE id=$1 AND org_id=$2 AND lease_id=$3`,[input.outcomeId,session.orgId,input.leaseId])).rows[0];
    if(!outcome) throw new FlowError("errors.notFound");
    if(input.event==="withdrawn") { if(session.userId!==outcome.payer_id || session.kind!==outcome.payer_kind) throw new FlowError("errors.notFound"); }
    else if(input.event==="external_reviewed") { if(session.kind!=="staff") throw new FlowError("errors.notFound"); }
    else if(session.userId!==outcome.payee_id || session.kind!==outcome.payee_kind || session.userId===outcome.payer_id) throw new FlowError("errors.notFound");
    const version=await versionOn(client,session,input.leaseId,outcome.version_id);
    let financialFresh=false;
    try {
      const preview=await settlementPreviewOn(client,session,version.snapshot.input,{partyRead:true,lockParent:true,excludeOutcomeVersion:outcome.version_id});
      financialFresh=preview.fingerprint===version.source_fingerprint && preview.calculation.authoritative;
    } catch(error) {
      if(!(error instanceof FlowError)) throw error;
      // Some sources are no longer valid; do not lose factual acknowledgments.
      // NOWAIT prevents waiting on a parent after a partially acquired source set.
      const record=await client.query(`SELECT id FROM app.settlement_records WHERE id=$1 AND org_id=$2 AND lease_id=$3 FOR UPDATE NOWAIT`,[version.record_id,session.orgId,input.leaseId]);
      if(!record.rowCount) throw new FlowError("errors.notFound");
    }
    await settlementDeadline(client,session,input.leaseId);
    const prior=(await client.query<{id:string;outcome_id:string;event:string;note:string;evidence_id:string|null;expected_last_event_id:string|null}>(`SELECT id,outcome_id,event,note,evidence_id,expected_last_event_id FROM app.settlement_outcome_events WHERE actor_id=$1 AND request_id=$2`,[session.userId,input.requestId])).rows[0];
    if(prior) {
      if(prior.outcome_id!==input.outcomeId || prior.event!==input.event || prior.note!==note || prior.evidence_id!==input.evidenceId || prior.expected_last_event_id!==input.expectedLastEventId) throw new FlowError("errors.generic");
      return {id:prior.id,financialFresh};
    }
    const latest=(await client.query<{id:string;revision:number}>(`SELECT id,revision FROM app.settlement_outcome_events WHERE outcome_id=$1 ORDER BY revision DESC LIMIT 1`,[input.outcomeId])).rows[0];
    if((latest?.id ?? null)!==input.expectedLastEventId) throw new FlowError("errors.generic");
    // An acknowledged receipt is an enduring fact: unilateral withdrawal
    // cannot release its cap. A withdrawn report cannot later be turned into
    // an ordinary acknowledgment after a replacement has consumed that cap.
    if(input.event==="withdrawn" || input.event==="acknowledged" || input.event==="disputed") {
      const conflicting=input.event==="withdrawn" ? "acknowledged" : "withdrawn";
      if((await client.query(`SELECT 1 FROM app.settlement_outcome_events WHERE outcome_id=$1 AND event=$2 LIMIT 1`,[input.outcomeId,conflicting])).rowCount) throw new FlowError("errors.generic");
    }
    if(input.evidenceId && !(await client.query(`SELECT 1 FROM app.settlement_evidence_links WHERE evidence_id=$1 AND org_id=$2 AND lease_id=$3 AND version_id=$4`,[input.evidenceId,session.orgId,input.leaseId,outcome.version_id])).rowCount) throw new FlowError("errors.notFound");
    const event=(await client.query<{id:string}>(`INSERT INTO app.settlement_outcome_events(org_id,lease_id,outcome_id,actor_id,revision,event,note,evidence_id,expected_last_event_id,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,[session.orgId,input.leaseId,input.outcomeId,session.userId,(latest?.revision ?? 0)+1,input.event,note,input.evidenceId,input.expectedLastEventId,input.requestId])).rows[0];
    await writeAudit(session.orgId,session.userId,"settlement_outcome_reply",{lease_id:input.leaseId,outcome_id:input.outcomeId,event_id:event.id,event:input.event,financial_fresh:financialFresh},client);
    await settlementDeadline(client,session,input.leaseId); return {id:event.id,financialFresh};
  });
}

/** A staff-recorded outside observation is explicitly unconfirmed. It is not a
 * payer report or counterpart acknowledgment, and has no financial posting. */
export async function observeExternalOutcome(session:Session,input:{leaseId:string;versionId:string;direction:Direction;amountMinor:number;occurredOn:string;payerId:string;payerKind:Party;payeeId:string;payeeKind:Party;evidenceId:string;reason:string;requestId:string}) {
  for(const id of [input.leaseId,input.versionId,input.payerId,input.payeeId,input.evidenceId,input.requestId]) settlementUuid(id);
  const reason=input.reason.trim();
  if(!reason || reason.length>1000 || !Number.isSafeInteger(input.amountMinor) || input.amountMinor<=0 || !validDate(input.occurredOn) || input.payerId===input.payeeId || !["refund","top_up"].includes(input.direction)) throw new FlowError("errors.required");
  const allowed=input.direction==="refund" ? ["staff","owner"].includes(input.payerKind) && input.payeeKind==="tenant" : input.payerKind==="tenant" && ["staff","owner"].includes(input.payeeKind);
  if(!allowed) throw new FlowError("errors.notFound");
  return svc(session.userId,async client=>{
    const access=await settlementAccess(client,session,input.leaseId,"prepare");
    await settlementRequestLock(client,session,input.leaseId,"observation",input.requestId);
    const prior=(await client.query<{id:string;version_id:string;direction:string;amount_minor:string;occurred_on:string;payer_id:string;payer_kind:string;payee_id:string;payee_kind:string;evidence_id:string;reason:string}>(`SELECT id,version_id,direction,amount_minor::text,occurred_on::text,payer_id,payer_kind,payee_id,payee_kind,evidence_id,reason FROM app.settlement_external_observations WHERE reporter_id=$1 AND request_id=$2 AND org_id=$3 AND lease_id=$4`,[session.userId,input.requestId,session.orgId,input.leaseId])).rows[0];
    if(prior) {
      if(prior.version_id!==input.versionId || prior.direction!==input.direction || Number(prior.amount_minor)!==input.amountMinor || prior.occurred_on!==input.occurredOn || prior.payer_id!==input.payerId || prior.payer_kind!==input.payerKind || prior.payee_id!==input.payeeId || prior.payee_kind!==input.payeeKind || prior.evidence_id!==input.evidenceId || prior.reason!==reason) throw new FlowError("errors.generic");
      await settlementDeadline(client,session,input.leaseId);return {id:prior.id,recovered:true};
    }
    await party(client,session,input.leaseId,input.payerId,input.payerKind);await party(client,session,input.leaseId,input.payeeId,input.payeeKind);
    const version=await versionOn(client,session,input.leaseId,input.versionId); let financialFresh=false;
    try {const preview=await settlementPreviewOn(client,session,version.snapshot.input,{partyRead:true,lockParent:true,excludeOutcomeVersion:input.versionId});financialFresh=preview.fingerprint===version.source_fingerprint && preview.calculation.authoritative;}
    catch(error) {if(!(error instanceof FlowError)) throw error; const lock=await client.query(`SELECT id FROM app.settlement_records WHERE id=$1 AND org_id=$2 AND lease_id=$3 FOR UPDATE NOWAIT`,[version.record_id,session.orgId,input.leaseId]);if(!lock.rowCount) throw new FlowError("errors.notFound");}
    await settlementDeadline(client,session,input.leaseId);await party(client,session,input.leaseId,input.payerId,input.payerKind);await party(client,session,input.leaseId,input.payeeId,input.payeeKind);
    if(!(await client.query(`SELECT 1 FROM app.settlement_evidence_links WHERE org_id=$1 AND lease_id=$2 AND version_id=$3 AND evidence_id=$4`,[session.orgId,input.leaseId,input.versionId,input.evidenceId])).rowCount) throw new FlowError("errors.notFound");
    const today=(await client.query<{today:string}>(`SELECT timezone(timezone,clock_timestamp())::date::text AS today FROM public.organizations WHERE id=$1`,[session.orgId])).rows[0]?.today;
    if(!today || input.occurredOn>today) throw new FlowError("errors.required");
    const row=(await client.query<{id:string}>(`INSERT INTO app.settlement_external_observations(org_id,lease_id,version_id,direction,amount_minor,currency,occurred_on,payer_id,payer_kind,payee_id,payee_kind,reporter_id,evidence_id,reason,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,[session.orgId,input.leaseId,input.versionId,input.direction,input.amountMinor,access.lease.currency,input.occurredOn,input.payerId,input.payerKind,input.payeeId,input.payeeKind,session.userId,input.evidenceId,reason,input.requestId])).rows[0];
    await writeAudit(session.orgId,session.userId,"settlement_external_observed",{lease_id:input.leaseId,version_id:input.versionId,observation_id:row.id,financial_fresh:financialFresh},client);
    await settlementDeadline(client,session,input.leaseId);await party(client,session,input.leaseId,input.payerId,input.payerKind);await party(client,session,input.leaseId,input.payeeId,input.payeeKind);
    return {id:row.id,recovered:false};
  });
}
