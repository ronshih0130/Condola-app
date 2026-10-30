import type { Client } from "pg";
import { writeAudit } from "./audit";
import { svc } from "./db";
import { FlowError } from "./errors";
import { settlementAccess, settlementDeadline, settlementRequestLock, settlementUuid } from "./settlement-access";
import type { Session } from "./types";

type Input = { leaseId:string; evidenceId:string; requestId:string; expectedAttributionId:string|null; amountMinor:number; reason:string; source: { kind:"payment";paymentId:string } | { kind:"external";identity:string;declaredMinor:number } };
function validAmount(amount:number) { return Number.isSafeInteger(amount) && amount>=0; }
function validate(input:Input) {
  settlementUuid(input.leaseId); settlementUuid(input.evidenceId); settlementUuid(input.requestId); if (input.expectedAttributionId !== null) settlementUuid(input.expectedAttributionId);
  if (!validAmount(input.amountMinor) || !input.reason.trim() || input.reason.trim().length>1000) throw new FlowError("errors.required");
  if (input.source.kind==="payment") settlementUuid(input.source.paymentId);
  else if (input.source.kind!=="external" || !input.source.identity.trim() || input.source.identity.trim().length>200 || !validAmount(input.source.declaredMinor) || input.source.declaredMinor===0) throw new FlowError("errors.required");
}
async function paymentSource(client:Client,session:Session,leaseId:string,paymentId:string,currency:string,propertyId:string) {
  const row=(await client.query<{id:string;amount_minor:string;status:string;ledger_transaction_id:string;property_id:string}>(`SELECT id,amount_minor::text,status::text,ledger_transaction_id,property_id FROM public.payments WHERE id=$1 AND org_id=$2 AND lease_id=$3 AND currency=$4 AND property_id=$5 AND ledger_transaction_id IS NOT NULL FOR UPDATE`,[paymentId,session.orgId,leaseId,currency,propertyId])).rows[0];
  if (!row || row.status!=="confirmed") throw new FlowError("errors.notFound");
  // Old reversal writers acquire KEY SHARE on the original ledger header
  // before possibly updating payment. NOWAIT avoids an inverted lock wait.
  const ledger=await client.query(`SELECT id FROM public.ledger_transactions WHERE id=$1 AND org_id=$2 AND lease_id=$3 AND property_id=$4 AND currency=$5 AND kind='payment' AND source_table='payments' AND source_id=$6 AND reverses_transaction_id IS NULL FOR UPDATE NOWAIT`,[row.ledger_transaction_id,session.orgId,leaseId,row.property_id,currency,paymentId]);
  if (!ledger.rowCount) throw new FlowError("errors.notFound");
  const reversed=await client.query(`SELECT 1 FROM public.payments p JOIN public.ledger_transactions t ON t.reverses_transaction_id=p.ledger_transaction_id WHERE p.id=$1 AND p.org_id=$2 LIMIT 1`,[paymentId,session.orgId]);
  if (reversed.rowCount) throw new FlowError("errors.notFound");
  return row;
}
/** A new revision reserves only its difference; payment lock precedes source lock. */
export async function setDepositAttribution(session:Session,input:Input) {
  validate(input);
  return svc(session.userId,async client=>{
    const {lease}=await settlementAccess(client,session,input.leaseId,"prepare");
    await settlementRequestLock(client,session,input.leaseId,"attribution",input.requestId);
    const existing=(await client.query<{id:string;source_id:string;root_id:string;amount_minor:string;reason:string;evidence_id:string;expected_prior_id:string|null;kind:string;payment_id:string|null;external_identity:string|null;request_external_identity:string|null;declared_minor:string|null}>(`SELECT a.id,a.source_id,a.root_id,a.amount_minor::text,a.reason,a.evidence_id,a.expected_prior_id,a.request_external_identity,s.kind,s.payment_id,s.external_identity,s.declared_minor::text FROM app.settlement_attributions a JOIN app.settlement_sources s ON s.id=a.source_id WHERE a.created_by=$1 AND a.request_id=$2 AND a.org_id=$3 AND a.lease_id=$4`,[session.userId,input.requestId,session.orgId,input.leaseId])).rows[0];
    if(existing) {
      const matchingSource=input.source.kind==="payment" ? existing.kind==="payment" && existing.payment_id===input.source.paymentId : existing.kind==="external" && existing.request_external_identity===input.source.identity.trim() && Number(existing.declared_minor)===input.source.declaredMinor;
      if(!matchingSource || Number(existing.amount_minor)!==input.amountMinor || existing.reason!==input.reason.trim() || existing.evidence_id!==input.evidenceId || existing.expected_prior_id!==input.expectedAttributionId) throw new FlowError("errors.generic");
      let stale=false; await client.query("SAVEPOINT attribution_replay");
      try {if(existing.payment_id) await paymentSource(client,session,input.leaseId,existing.payment_id,lease.currency,lease.property_id);await client.query("RELEASE SAVEPOINT attribution_replay");}
      catch(error){if(!(error instanceof FlowError) && (error as {code?:string})?.code!=="55P03")throw error;await client.query("ROLLBACK TO SAVEPOINT attribution_replay");await client.query("RELEASE SAVEPOINT attribution_replay");stale=true;}
      const current=(await client.query<{id:string}>(`SELECT id FROM app.settlement_attributions WHERE root_id=$1 ORDER BY revision DESC LIMIT 1`,[existing.root_id])).rows[0];
      await settlementDeadline(client,session,input.leaseId);return {id:existing.id,recovered:true,stale,current:current?.id===existing.id};
    }
    const payment=input.source.kind==="payment" ? await paymentSource(client,session,input.leaseId,input.source.paymentId,lease.currency,lease.property_id) : null;
    await settlementDeadline(client,session,input.leaseId);
    const evidence=(await client.query(`SELECT 1 FROM app.settlement_evidence e JOIN app.settlement_evidence_links l ON l.org_id=e.org_id AND l.lease_id=e.lease_id AND l.evidence_id=e.id WHERE e.id=$1 AND e.org_id=$2 AND e.lease_id=$3`,[input.evidenceId,session.orgId,input.leaseId])).rowCount;
    if (!evidence) throw new FlowError("errors.notFound");
    const ext=input.source.kind==="external" ? input.source.identity.trim() : null;
    const declared=input.source.kind==="external" ? input.source.declaredMinor : null;
    await client.query(`INSERT INTO app.settlement_sources(org_id,lease_id,currency,kind,payment_id,external_identity,declared_minor,evidence_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,[session.orgId,input.leaseId,lease.currency,input.source.kind,payment?.id ?? null,ext,declared,input.evidenceId,session.userId]);
    const source=(await client.query<{id:string;declared_minor:string|null;currency:string;payment_id:string|null}>(`SELECT id,declared_minor::text,currency::text,payment_id FROM app.settlement_sources WHERE org_id=$1 AND lease_id=$2 AND (($3::uuid IS NOT NULL AND payment_id=$3) OR ($4::text IS NOT NULL AND lower(btrim(external_identity))=lower(btrim($4)))) FOR UPDATE`,[session.orgId,input.leaseId,payment?.id ?? null,ext])).rows[0];
    if (!source || source.currency!==lease.currency || (ext!==null && Number(source.declared_minor)!==declared)) throw new FlowError("errors.generic");
    await settlementDeadline(client,session,input.leaseId);
    await client.query(`INSERT INTO app.settlement_allocation_roots(org_id,lease_id,source_id,category,created_by) VALUES($1,$2,$3,'deposit',$4) ON CONFLICT DO NOTHING`,[session.orgId,input.leaseId,source.id,session.userId]);
    const root=(await client.query<{id:string}>(`SELECT id FROM app.settlement_allocation_roots WHERE org_id=$1 AND lease_id=$2 AND source_id=$3 AND category='deposit'`,[session.orgId,input.leaseId,source.id])).rows[0];
    if(!root) throw new FlowError("errors.generic");
    const current=(await client.query<{id:string;revision:number}>(`SELECT id,revision FROM app.settlement_attributions WHERE root_id=$1 ORDER BY revision DESC LIMIT 1`,[root.id])).rows[0];
    if ((current?.id ?? null)!==input.expectedAttributionId) throw new FlowError("errors.generic");
    const used=(await client.query<{amount:string}>(`SELECT coalesce(sum(a.amount_minor),0)::text AS amount FROM app.settlement_allocation_roots r JOIN LATERAL (SELECT amount_minor FROM app.settlement_attributions WHERE root_id=r.id ORDER BY revision DESC LIMIT 1) a ON true WHERE r.source_id=$1 AND r.id<>$2`,[source.id,root.id])).rows[0].amount;
    const cap=BigInt(payment?.amount_minor ?? source.declared_minor ?? "0");
    if (BigInt(used)+BigInt(input.amountMinor)>cap) throw new FlowError("errors.required");
    const result=(await client.query<{id:string}>(`INSERT INTO app.settlement_attributions(org_id,lease_id,source_id,root_id,revision,amount_minor,reason,evidence_id,expected_prior_id,request_external_identity,request_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,[session.orgId,input.leaseId,source.id,root.id,(current?.revision ?? 0)+1,input.amountMinor,input.reason.trim(),input.evidenceId,input.expectedAttributionId,ext,input.requestId,session.userId])).rows[0];
    await writeAudit(session.orgId,session.userId,"settlement_deposit_attributed",{lease_id:input.leaseId,source_id:source.id,attribution_id:result.id},client);
    await settlementDeadline(client,session,input.leaseId);
    return {id:result.id,recovered:false,stale:false,current:true};
  });
}
