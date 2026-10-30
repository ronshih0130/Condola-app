import { createHash } from "node:crypto";
import type { Client } from "pg";
import { svc } from "./db";
import { FlowError } from "./errors";
import { settlementAccess, settlementDeadline, settlementUuid } from "./settlement-access";
import { calculateSettlement } from "./settlement-calculation";
import type { Session } from "./types";

export type SettlementItemInput = { key:string; label:string; amountMinor:number; reason:string; evidenceId:string; invoiceLineId:string|null };
export type SettlementPreviewInput = { leaseId:string; attributionIds:string[]; items:SettlementItemInput[]; sourceReview?:{attested:true;evidenceId:string}|null };
export function normalizeSettlementInput(input:SettlementPreviewInput) {
  settlementUuid(input.leaseId);
  if (!Array.isArray(input.attributionIds) || !Array.isArray(input.items) || input.attributionIds.length>50 || input.items.length>50) throw new FlowError("errors.required");
  const attrs=[...input.attributionIds].sort(); attrs.forEach(settlementUuid);
  if (new Set(attrs).size!==attrs.length) throw new FlowError("errors.required");
  const items=input.items.map(item=>{
    settlementUuid(item.key); settlementUuid(item.evidenceId); if(item.invoiceLineId) settlementUuid(item.invoiceLineId);
    const label=item.label.trim(),reason=item.reason.trim();
    if (!label || label.length>200 || !reason || reason.length>1000 || !Number.isSafeInteger(item.amountMinor) || item.amountMinor<0) throw new FlowError("errors.required");
    return {key:item.key,label,amountMinor:item.amountMinor,reason,evidenceId:item.evidenceId,invoiceLineId:item.invoiceLineId};
  }).sort((a,b)=>a.key.localeCompare(b.key));
  if (new Set(items.map(i=>i.key)).size!==items.length || new Set(items.filter(i=>i.invoiceLineId).map(i=>i.invoiceLineId)).size!==items.filter(i=>i.invoiceLineId).length) throw new FlowError("errors.required");
  let sourceReview:{attested:true;evidenceId:string}|null=null;
  if(input.sourceReview) {if(input.sourceReview.attested!==true) throw new FlowError("errors.required");settlementUuid(input.sourceReview.evidenceId);sourceReview={attested:true,evidenceId:input.sourceReview.evidenceId};}
  return {leaseId:input.leaseId,attributionIds:attrs,items,sourceReview};
}
/** Called inside the gateway transaction. Locks source rows in the approved
 * payment → ledger → invoice → attribution order before producing a snapshot. */
export async function settlementPreviewOn(client:Client,session:Session,raw:SettlementPreviewInput, options?:{lockParent?:boolean;publish?:boolean;partyRead?:boolean;excludeOutcomeVersion?:string}) {
  const input=normalizeSettlementInput(raw); const {lease}=await settlementAccess(client,session,input.leaseId,options?.partyRead ? "read" : options?.publish ? "publish" : "prepare");
  const initial=(await client.query<{id:string;source_id:string;payment_id:string|null}>(`SELECT a.id,a.source_id,s.payment_id FROM app.settlement_attributions a JOIN app.settlement_sources s ON s.id=a.source_id WHERE a.org_id=$1 AND a.lease_id=$2 AND a.id=ANY($3::uuid[]) ORDER BY a.id`,[session.orgId,input.leaseId,input.attributionIds])).rows;
  if(initial.length!==input.attributionIds.length) throw new FlowError("errors.notFound");
  const payments=[...new Set(initial.flatMap(a=>a.payment_id?[a.payment_id]:[]))].sort();
  const lockedPayments=(await client.query<{id:string;ledger_transaction_id:string|null}>(`SELECT id,ledger_transaction_id FROM public.payments WHERE org_id=$1 AND lease_id=$2 AND id=ANY($3::uuid[]) AND property_id=$4 AND currency=$5 ORDER BY id FOR UPDATE`,[session.orgId,input.leaseId,payments,lease.property_id,lease.currency])).rows;
  if(lockedPayments.length!==payments.length || lockedPayments.some(p=>!p.ledger_transaction_id)) throw new FlowError("errors.generic");
  const ledgerIds=[...new Set(lockedPayments.map(p=>p.ledger_transaction_id!))].sort();
  const ledger=(await client.query(`SELECT id FROM public.ledger_transactions WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT`,[ledgerIds])).rowCount;
  if(ledger!==ledgerIds.length) throw new FlowError("errors.generic");
  const lineIds=input.items.flatMap(i=>i.invoiceLineId?[i.invoiceLineId]:[]).sort();
  const initialLines=(await client.query<{id:string;invoice_id:string}>(`SELECT il.id,il.invoice_id FROM public.invoice_lines il JOIN public.invoices i ON i.id=il.invoice_id AND i.org_id=il.org_id WHERE il.org_id=$1 AND i.lease_id=$2 AND il.id=ANY($3::uuid[]) ORDER BY il.id`,[session.orgId,input.leaseId,lineIds])).rows;
  if(initialLines.length!==lineIds.length) throw new FlowError("errors.notFound");
  const invoiceIds=[...new Set(initialLines.map(l=>l.invoice_id))].sort();
  if ((await client.query(`SELECT id FROM public.invoices WHERE org_id=$1 AND lease_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR SHARE`,[session.orgId,input.leaseId,invoiceIds])).rowCount!==invoiceIds.length) throw new FlowError("errors.generic");
  const sourceIds=[...new Set(initial.map(a=>a.source_id))].sort();
  if ((await client.query(`SELECT id FROM app.settlement_sources WHERE org_id=$1 AND lease_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE`,[session.orgId,input.leaseId,sourceIds])).rowCount!==sourceIds.length) throw new FlowError("errors.generic");
  await settlementDeadline(client,session,input.leaseId);
  const attrs=(await client.query(`SELECT a.id,a.source_id AS attribution_source_id,a.revision,a.amount_minor::text,a.evidence_id,s.currency::text AS source_currency,s.kind,s.external_identity,s.declared_minor::text,s.payment_id,p.status::text AS payment_status,p.amount_minor::text AS payment_amount,p.currency::text AS payment_currency,p.ledger_transaction_id,t.org_id AS ledger_org,t.lease_id AS ledger_lease,t.property_id AS ledger_property,t.currency::text AS ledger_currency,t.kind::text AS ledger_kind,t.source_table,t.source_id AS ledger_source_id,EXISTS(SELECT 1 FROM public.ledger_transactions rev WHERE rev.reverses_transaction_id=t.id) AS reversed
    FROM app.settlement_attributions a JOIN app.settlement_allocation_roots r ON r.id=a.root_id AND r.category='deposit' JOIN app.settlement_sources s ON s.id=a.source_id LEFT JOIN public.payments p ON p.id=s.payment_id LEFT JOIN public.ledger_transactions t ON t.id=p.ledger_transaction_id
    WHERE a.org_id=$1 AND a.lease_id=$2 AND a.id=ANY($3::uuid[]) AND a.id=(SELECT id FROM app.settlement_attributions WHERE root_id=a.root_id ORDER BY revision DESC LIMIT 1) ORDER BY a.id`,[session.orgId,input.leaseId,input.attributionIds])).rows;
  if(attrs.length!==input.attributionIds.length) throw new FlowError("errors.generic");
  if (attrs.some(a=>a.source_currency!==lease.currency)) throw new FlowError("errors.generic");
  for(const a of attrs) if(a.kind==="payment" && (a.payment_status!=="confirmed" || a.reversed || a.payment_currency!==lease.currency || a.ledger_org!==session.orgId || a.ledger_lease!==input.leaseId || a.ledger_property!==lease.property_id || a.ledger_currency!==lease.currency || a.ledger_kind!=="payment" || a.source_table!=="payments" || a.ledger_source_id!==a.payment_id)) throw new FlowError("errors.generic");
  for (const a of attrs) {
    const amount=BigInt(a.amount_minor);
    if (amount<0 || amount>BigInt(a.kind === "payment" ? a.payment_amount : a.declared_minor)) throw new FlowError("errors.generic");
  }
  const evidenceIds=[...new Set([...input.items.map(i=>i.evidenceId),...(input.sourceReview?[input.sourceReview.evidenceId]:[])])].sort();
  const evidence=(await client.query(`SELECT e.id,e.sha256 FROM app.settlement_evidence e WHERE e.org_id=$1 AND e.lease_id=$2 AND e.id=ANY($3::uuid[]) AND EXISTS(SELECT 1 FROM app.settlement_evidence_links l WHERE l.org_id=e.org_id AND l.lease_id=e.lease_id AND l.evidence_id=e.id) ORDER BY e.id`,[session.orgId,input.leaseId,evidenceIds])).rows;
  if(evidence.length!==evidenceIds.length) throw new FlowError("errors.notFound");
  const lines=(await client.query(`SELECT il.id,il.invoice_id,il.charge_type::text,il.amount_minor::text,il.service_period::text,il.xmin::text AS line_version,i.status::text,i.voided_at,i.paid_minor::text,i.total_minor::text,i.xmin::text AS invoice_version FROM public.invoice_lines il JOIN public.invoices i ON i.id=il.invoice_id AND i.org_id=il.org_id WHERE il.org_id=$1 AND i.lease_id=$2 AND il.id=ANY($3::uuid[]) ORDER BY il.id`,[session.orgId,input.leaseId,lineIds])).rows;
  if(lines.length!==lineIds.length) throw new FlowError("errors.generic");
  const totals=attrs.map(a=>Number(a.amount_minor));
  if(totals.some(n=>!Number.isSafeInteger(n) || n<0)) throw new FlowError("errors.generic");
  const deposit=totals.reduce((sum,n)=>sum+n,0);
  if(!Number.isSafeInteger(deposit)) throw new FlowError("errors.generic");
  // Invoice-linked items need separate evidence of partial-payment reconciliation.
  const reconciliationRequired=lines.length>0 || (input.items.some(i=>!i.invoiceLineId) && !input.sourceReview);
  const calculation=calculateSettlement(attrs.length && !reconciliationRequired ? deposit : null,input.items.map(i=>i.amountMinor));
  let recordId:string|null=null;
  if (options?.lockParent) {
    await client.query(`INSERT INTO app.settlement_records(org_id,lease_id,currency) VALUES($1,$2,$3) ON CONFLICT(org_id,lease_id,currency) DO NOTHING`,[session.orgId,input.leaseId,lease.currency]);
    const record=(await client.query<{id:string}>(`SELECT id FROM app.settlement_records WHERE org_id=$1 AND lease_id=$2 AND currency=$3 FOR UPDATE`,[session.orgId,input.leaseId,lease.currency])).rows[0];
    if(!record) throw new FlowError("errors.generic"); recordId=record.id;
    await settlementDeadline(client,session,input.leaseId);
  }
  const outcomes=(await client.query(`SELECT o.id,o.version_id,o.direction,o.amount_minor::text,o.currency::text,o.occurred_on::text,o.payer_id,o.payee_id,o.created_at,coalesce((SELECT jsonb_agg(jsonb_build_object('id',e.id,'event',e.event,'actor_id',e.actor_id,'revision',e.revision,'created_at',e.created_at) ORDER BY e.revision) FROM app.settlement_outcome_events e WHERE e.outcome_id=o.id),'[]'::jsonb) AS events FROM app.settlement_outcomes o WHERE o.org_id=$1 AND o.lease_id=$2 AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM app.settlement_versions prior JOIN app.settlement_versions anchor ON anchor.id=$3 WHERE prior.id=o.version_id AND prior.record_id=anchor.record_id AND prior.revision<anchor.revision)) ORDER BY o.id`,[session.orgId,input.leaseId,options?.excludeOutcomeVersion ?? null])).rows;
  const observations=(await client.query(`SELECT id,version_id,direction,amount_minor::text,currency::text,occurred_on::text,payer_id,payer_kind,payee_id,payee_kind,reporter_id,evidence_id,reason,created_at FROM app.settlement_external_observations WHERE org_id=$1 AND lease_id=$2 AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM app.settlement_versions prior JOIN app.settlement_versions anchor ON anchor.id=$3 WHERE prior.id=settlement_external_observations.version_id AND prior.record_id=anchor.record_id AND prior.revision<anchor.revision)) ORDER BY id`,[session.orgId,input.leaseId,options?.excludeOutcomeVersion ?? null])).rows;
  const facts={lease,attrs,evidence,lines,outcomes,observations,input,calculation,reconciliationRequired};
  const fingerprint=createHash("sha256").update(JSON.stringify(facts)).digest("hex");
  await settlementDeadline(client,session,input.leaseId);
  return { ...facts,fingerprint,recordId };
}
export async function previewSettlement(session:Session,input:SettlementPreviewInput) { return svc(session.userId,client=>settlementPreviewOn(client,session,input)); }
