import { createHash } from "node:crypto";
import type { Client, QueryResult, QueryResultRow } from "pg";
import { FlowError } from "./errors";
import { settlementAccess,settlementDeadline,settlementUuid } from "./settlement-access";
import { calculateFinalRent } from "./settlement-calculation";
import { calculateReconciledRent } from "./settlement-rent-calculation";
import { withSettlementFencePrototype } from "./settlement-fenced-transaction";
import type { Session } from "./types";

export class SettlementSourceBusy extends FlowError { constructor(){super("errors.generic");} }
export class SettlementSourceIncomplete extends FlowError { constructor(){super("errors.generic");} }

/** Unwired diagnostic. Verified-candidate is not authorization to publish.
 * Complete source facts are server-derived under the local prototype fence. */
type BoundedQuery = <R extends QueryResultRow = QueryResultRow>(sql:string,params?:unknown[])=>Promise<QueryResult<R>>;
/** Acquire the source cohort before the global fence. Diagnostic only. */
export async function prepareCompleteSource(client:Client,session:Session,leaseId:string) {
  settlementUuid(leaseId);
    let country="",propertyVersion="",paymentIds:string[]=[],ledgerIds:string[]=[];
    const {lease}=await settlementAccess(client,session,leaseId,"prepare");
    const admission=(await client.query<{ok:boolean}>(`SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS ok`,[`b011:rent-cycle:${session.orgId}:${leaseId}`])).rows[0].ok;if(!admission)throw new SettlementSourceBusy();
    const property=(await client.query<{country:string;version:string}>(`SELECT country_code::text AS country,xmin::text AS version FROM public.properties WHERE org_id=$1 AND id=$2 FOR SHARE NOWAIT`,[session.orgId,lease.property_id])).rows[0];if(!property)throw new FlowError("errors.notFound");country=property.country;propertyVersion=property.version;
    const payments=(await client.query<{id:string}>(`SELECT id FROM public.payments WHERE org_id=$1 AND lease_id=$2 ORDER BY id LIMIT 1001`,[session.orgId,leaseId])).rows;
    const ledgers=(await client.query<{id:string}>(`SELECT id FROM public.ledger_transactions WHERE org_id=$1 AND lease_id=$2 ORDER BY id LIMIT 1001`,[session.orgId,leaseId])).rows;
    if(payments.length>1000||ledgers.length>1000)throw new SettlementSourceIncomplete();paymentIds=payments.map(x=>x.id);ledgerIds=ledgers.map(x=>x.id);
    if((await client.query(`SELECT id FROM public.payments WHERE org_id=$1 AND lease_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE`,[session.orgId,leaseId,paymentIds])).rowCount!==paymentIds.length)throw new FlowError("errors.generic");
    if((await client.query(`SELECT id FROM public.ledger_transactions WHERE org_id=$1 AND lease_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR UPDATE NOWAIT`,[session.orgId,leaseId,ledgerIds])).rowCount!==ledgerIds.length)throw new FlowError("errors.generic");
    await settlementDeadline(client,session,leaseId);
    const txid=(await client.query<{txid:string}>(`SELECT txid_current()::text AS txid`)).rows[0].txid;
    return {lease,country,propertyVersion,paymentIds,ledgerIds,txid,actorId:session.userId,sessionId:session.sessionId,orgId:session.orgId,liveOrgId:session.liveOrgId,environment:session.environment,leaseId};
}
type SourceCohort = Awaited<ReturnType<typeof prepareCompleteSource>>;
/** Classify a previously locked cohort inside the caller's bounded transaction. */
export async function inspectCompleteSourceOn(query:BoundedQuery,session:Session,leaseId:string,cohort:SourceCohort) {
  const {lease,country,propertyVersion,paymentIds,ledgerIds}=cohort;
  const txid=(await query<{txid:string}>(`SELECT txid_current()::text AS txid`)).rows[0].txid;
  if(txid!==cohort.txid || session.userId!==cohort.actorId || session.sessionId!==cohort.sessionId || session.orgId!==cohort.orgId || session.liveOrgId!==cohort.liveOrgId || session.environment!==cohort.environment || leaseId!==cohort.leaseId) throw new FlowError("errors.notFound");
    await query("LOCK TABLE public.invoices,public.invoice_lines IN SHARE MODE NOWAIT");
    const params=[session.orgId,leaseId];
    const payments=(await query(`SELECT id,property_id,payer_contact_id,currency::text,amount_minor::text,status::text,ledger_transaction_id,xmin::text AS version FROM public.payments WHERE org_id=$1 AND lease_id=$2 ORDER BY id LIMIT 1001`,params)).rows;
    const ledgers=(await query(`SELECT id,org_id,lease_id,property_id,currency::text,kind::text,source_table,source_id,reverses_transaction_id,xmin::text AS version FROM public.ledger_transactions WHERE org_id=$1 AND lease_id=$2 ORDER BY id LIMIT 1001`,params)).rows;
    async function finish<T>(value:T):Promise<T> {const current=await query(`SELECT 1 FROM public.auth_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()`,[session.sessionId,session.userId]);if(!current.rowCount)throw new FlowError("errors.notFound");return value;}
    const equalIds=(rows:Record<string,unknown>[],ids:string[])=>rows.length===ids.length&&rows.every((row,i)=>row.id===ids[i]);
    if(!equalIds(payments,paymentIds)||!equalIds(ledgers,ledgerIds))return finish({verifiedCandidate:false as const,reason:"source_changed" as const});
    const invoices=(await query(`SELECT id,property_id,bill_to_contact_id,invoice_number,currency::text,status::text,total_minor::text,paid_minor::text,balance_minor::text,voided_at,ledger_transaction_id,xmin::text AS version FROM public.invoices WHERE org_id=$1 AND lease_id=$2 ORDER BY id LIMIT 1001 FOR SHARE NOWAIT`,params)).rows;
    const lines=(await query(`SELECT l.id,l.invoice_id,l.description,l.charge_type::text,l.amount_minor::text,l.service_period::text,lower(l.service_period)::text AS period_start,upper(l.service_period)::text AS period_end,coalesce(isempty(l.service_period),false) AS empty,coalesce(lower_inf(l.service_period),true) AS lower_infinite,coalesce(upper_inf(l.service_period),true) AS upper_infinite,l.xmin::text AS version FROM public.invoice_lines l JOIN public.invoices i ON i.org_id=l.org_id AND i.id=l.invoice_id WHERE i.org_id=$1 AND i.lease_id=$2 ORDER BY l.id LIMIT 1001 FOR SHARE OF l NOWAIT`,params)).rows;
    const allocations=(await query(`SELECT a.id,a.invoice_id,a.payment_id,a.amount_minor::text,a.xmin::text AS version FROM public.payment_allocations a JOIN public.invoices i ON i.org_id=a.org_id AND i.id=a.invoice_id WHERE i.org_id=$1 AND i.lease_id=$2 ORDER BY a.id LIMIT 1001`,params)).rows;
    // A valid same-org reversal need not itself carry the original lease ID.
    // Original headers are locked before this query, fencing new FK-backed reversals.
    const reversals=(await query(`SELECT id,org_id,lease_id,reverses_transaction_id,xmin::text AS version FROM public.ledger_transactions WHERE org_id=$1 AND reverses_transaction_id=ANY($2::uuid[]) ORDER BY id LIMIT 1001`,[session.orgId,ledgerIds])).rows;
    const entries=(await query(`SELECT e.id::text,e.transaction_id,e.org_id,e.lease_id,e.property_id,e.contact_id,e.invoice_id,e.account::text,e.amount_minor::text,e.currency::text,e.xmin::text AS version FROM public.ledger_entries e JOIN public.ledger_transactions t ON t.id=e.transaction_id AND t.org_id=e.org_id WHERE t.org_id=$1 AND t.lease_id=$2 ORDER BY e.id LIMIT 2001`,params)).rows;
    const cycles=(await query(`SELECT id,currency::text,period_start::text,period_end::text,agreed_monthly_minor::text,source_lease_start::text,source_move_out::text,source_country,evidence_id FROM app.settlement_rent_cycles WHERE org_id=$1 AND lease_id=$2 ORDER BY id LIMIT 1001`,params)).rows;
    const roots=(await query(`SELECT r.id,r.category,r.cycle_id,s.id AS source_id,s.kind,s.payment_id,s.currency::text AS source_currency,a.id AS attribution_id,a.revision,a.amount_minor::text,a.evidence_id FROM app.settlement_allocation_roots r JOIN app.settlement_sources s ON s.id=r.source_id LEFT JOIN LATERAL(SELECT * FROM app.settlement_attributions WHERE root_id=r.id ORDER BY revision DESC LIMIT 1) a ON true WHERE r.org_id=$1 AND r.lease_id=$2 ORDER BY r.id LIMIT 1001`,params)).rows;
    const bindings=(await query(`SELECT r.invoice_line_id,b.id,b.classification,b.cycle_id,b.evidence_id,b.source_invoice_version,b.source_line_version FROM app.settlement_line_roots r JOIN LATERAL(SELECT * FROM app.settlement_line_bindings WHERE root_id=r.id ORDER BY revision DESC LIMIT 1) b ON true WHERE r.org_id=$1 AND r.lease_id=$2 ORDER BY r.invoice_line_id LIMIT 1001`,params)).rows;
    if([invoices,lines,allocations,cycles,roots,bindings,reversals].some(rows=>rows.length>1000)||entries.length>2000)return finish({verifiedCandidate:false as const,reason:"capacity" as const});
    if(roots.some(r=>!r.attribution_id))return finish({verifiedCandidate:false as const,reason:"attribution_unknown" as const});
    const evidenceIds=[...new Set([...cycles.map(c=>String(c.evidence_id)),...roots.map(r=>String(r.evidence_id)),...bindings.map(b=>String(b.evidence_id))])].sort();
    const evidence=(await query(`SELECT e.id,e.sha256,e.mime,e.size_bytes,e.uploaded_by,e.uploaded_at,e.xmin::text AS version FROM app.settlement_evidence e WHERE e.org_id=$1 AND e.lease_id=$2 AND e.id=ANY($3::uuid[]) AND EXISTS(SELECT 1 FROM app.settlement_evidence_links l WHERE l.org_id=e.org_id AND l.lease_id=e.lease_id AND l.evidence_id=e.id) ORDER BY e.id`,[session.orgId,leaseId,evidenceIds])).rows;
    const facts={lease,country,propertyVersion,payments,ledgers,reversals,invoices,lines,allocations,entries,cycles,roots,bindings,evidence};
    const fingerprint=createHash("sha256").update(JSON.stringify(facts)).digest("hex");
    // Staff-only immutable observation, derived from precisely the hashed rows.
    // No account details, private paths or contact identities are projected.
    const projection={coverage:"unverified" as const,amountBasis:"raw_minor_units" as const,statementCurrency:lease.currency,cycles:cycles.map(c=>({currency:c.currency,periodStart:c.period_start,periodEnd:c.period_end,monthlyMinor:c.agreed_monthly_minor})),cash:roots.filter(r=>r.category==="rent").map(r=>({kind:r.kind,currency:r.source_currency,amountMinor:r.amount_minor,revision:r.revision,validity:"unknown" as const})),lines:lines.map(line=>{const invoice=invoices.find(i=>i.id===line.invoice_id),binding=bindings.find(b=>b.invoice_line_id===line.id);return {description:line.description,chargeType:line.charge_type,amountMinor:line.amount_minor,period:line.service_period,invoiceNumber:invoice?.invoice_number??null,currency:invoice?.currency??null,status:invoice?.status??null,balanceMinor:invoice?.balance_minor??null,classification:binding?.classification??null};})};
    const unknown=(reason:string)=>finish({verifiedCandidate:false as const,reason,fingerprint,projection});
    if(evidence.length!==evidenceIds.length)return unknown("evidence_unknown");
    if(country!=="TW"||lease.currency!=="TWD"||lease.rent_frequency!=="monthly"||!lease.moved_out_on||cycles.length!==1)return unknown("cycle_unknown");
    const cycle=cycles[0];if(cycle.currency!==lease.currency||cycle.source_country!==country||cycle.source_lease_start!==lease.start_date||cycle.source_move_out!==lease.moved_out_on||cycle.agreed_monthly_minor!==lease.rent_amount_minor)return unknown("cycle_changed");
    let finalRent:ReturnType<typeof calculateFinalRent>;try{finalRent=calculateFinalRent({country,currency:lease.currency,frequency:lease.rent_frequency,monthlyMinor:Number(lease.rent_amount_minor),periodStart:cycle.period_start,periodEnd:cycle.period_end,leaseStart:lease.start_date,moveOut:lease.moved_out_on});}catch{return unknown("cycle_unsupported");}
    if(!invoices.length||invoices.some(i=>i.property_id!==lease.property_id||i.currency!==lease.currency||i.status!=="paid"||i.voided_at!==null||BigInt(i.total_minor)<=BigInt(0)||BigInt(i.balance_minor)!==BigInt(0)||i.paid_minor!==i.total_minor))return unknown("invoice_unresolved");
    const ledgerById=new Map(ledgers.map(l=>[l.id,l]));
    const validLedger=(id:string|null,kind:string,sourceTable:string,sourceId:string)=>{const l=id?ledgerById.get(id):undefined;if(!l||l.org_id!==session.orgId||l.lease_id!==leaseId||l.property_id!==lease.property_id||l.currency!==lease.currency||l.kind!==kind||l.source_table!==sourceTable||l.source_id!==sourceId||l.reverses_transaction_id||reversals.some(r=>r.reverses_transaction_id===id))return false;const own=entries.filter(e=>e.transaction_id===id);return own.length>=2&&own.every(e=>e.currency===lease.currency&&e.org_id===session.orgId&&e.lease_id===leaseId&&e.property_id===lease.property_id)&&own.reduce((n,e)=>n+BigInt(e.amount_minor),BigInt(0))===BigInt(0);};
    if(invoices.some(i=>{
      const own=entries.filter(e=>e.transaction_id===i.ledger_transaction_id),ownLines=lines.filter(l=>l.invoice_id===i.id);
      const sum=(account:string)=>own.filter(e=>e.account===account).reduce((n,e)=>n+BigInt(e.amount_minor),BigInt(0));
      const charges=(kind:string)=>ownLines.filter(l=>l.charge_type===kind).reduce((n,l)=>n+BigInt(l.amount_minor),BigInt(0));
      return !i.bill_to_contact_id||!validLedger(i.ledger_transaction_id,"invoice","invoices",i.id)||own.some(e=>e.contact_id!==i.bill_to_contact_id||e.invoice_id!==i.id||!["tenant_receivable","rental_income","deposits_held"].includes(e.account))||sum("tenant_receivable")!==BigInt(i.total_minor)||sum("rental_income")!== -charges("rent")||sum("deposits_held")!== -charges("deposit");
    }))return unknown("invoice_lineage_unknown");
    if(invoices.some(i=>lines.filter(l=>l.invoice_id===i.id).reduce((n,l)=>n+BigInt(l.amount_minor),BigInt(0))!==BigInt(i.total_minor)))return unknown("invoice_total_inconsistent");
    const currentBindings=new Map(bindings.map(b=>[b.invoice_line_id,b]));
    if(!lines.length||lines.some(l=>!invoices.some(i=>i.id===l.invoice_id)||!currentBindings.has(l.id)))return unknown("line_unbound");
    for(const line of lines){const binding=currentBindings.get(line.id),invoice=invoices.find(i=>i.id===line.invoice_id);if(!binding||!invoice||binding.source_invoice_version!==invoice.version||binding.source_line_version!==line.version)return unknown("binding_stale");if(line.charge_type==="rent"){if(binding.classification!=="rent"||binding.cycle_id!==cycle.id||line.service_period===null||line.empty||line.lower_infinite||line.upper_infinite||!line.period_start||!line.period_end)return unknown("rent_period_unknown");}else if(line.charge_type==="deposit"){if(binding.classification!=="unrelated")return unknown("deposit_scope_unknown");}else return unknown("unsupported_charge");}
    const rent=lines.filter(l=>l.charge_type==="rent").sort((a,b)=>String(a.period_start).localeCompare(String(b.period_start)));if(!rent.length)return unknown("rent_missing");
    const agreedStart=new Date(`${cycle.period_start}T00:00:00Z`);const monthEnd=new Date(Date.UTC(agreedStart.getUTCFullYear(),agreedStart.getUTCMonth()+2,0)).getUTCDate();
    const nextMonth=new Date(Date.UTC(agreedStart.getUTCFullYear(),agreedStart.getUTCMonth()+1,Math.min(agreedStart.getUTCDate(),monthEnd)));nextMonth.setUTCDate(nextMonth.getUTCDate()-1);
    if(nextMonth.toISOString().slice(0,10)!==cycle.period_end)return unknown("monthly_cycle_shape_unknown");
    let next=cycle.period_start;for(const line of rent){if(line.period_start!==next)return unknown("rent_coverage_unknown");next=line.period_end;}
    const end=new Date(`${cycle.period_end}T00:00:00Z`);end.setUTCDate(end.getUTCDate()+1);if(next!==end.toISOString().slice(0,10))return unknown("rent_coverage_unknown");
    const liveRoots=roots.filter(r=>BigInt(r.amount_minor)>BigInt(0));if(liveRoots.some(r=>r.kind!=="payment"||r.source_currency!==lease.currency||(r.category==="rent"&&r.cycle_id!==cycle.id)))return unknown("attribution_unknown");
    const paymentById=new Map(payments.map(p=>[p.id,p]));
    for(const invoice of invoices){const allocated=allocations.filter(a=>a.invoice_id===invoice.id);if(allocated.reduce((n,a)=>n+BigInt(a.amount_minor),BigInt(0))!==BigInt(invoice.paid_minor))return unknown("allocation_unknown");}
    for(const payment of payments){const own=entries.filter(e=>e.transaction_id===payment.ledger_transaction_id);const cash=own.filter(e=>e.account==="cash_clearing").reduce((n,e)=>n+BigInt(e.amount_minor),BigInt(0));const allocated=allocations.filter(a=>a.payment_id===payment.id).reduce((n,a)=>n+BigInt(a.amount_minor),BigInt(0));const assigned=liveRoots.filter(r=>r.payment_id===payment.id).reduce((n,r)=>n+BigInt(r.amount_minor),BigInt(0));if(payment.property_id!==lease.property_id||payment.currency!==lease.currency||payment.status!=="confirmed"||!payment.payer_contact_id||own.some(e=>e.contact_id!==payment.payer_contact_id||e.invoice_id!==null||!["cash_clearing","tenant_receivable"].includes(e.account))||cash!==BigInt(payment.amount_minor)||!validLedger(payment.ledger_transaction_id,"payment","payments",payment.id)||entries.filter(e=>e.transaction_id===payment.ledger_transaction_id&&e.account==="tenant_receivable").reduce((n,e)=>n+BigInt(e.amount_minor),BigInt(0))!== -BigInt(payment.amount_minor)||allocated!==BigInt(payment.amount_minor)||assigned!==BigInt(payment.amount_minor))return unknown("payment_unknown");}
    if(allocations.some(a=>!paymentById.has(a.payment_id))||liveRoots.some(r=>!paymentById.has(r.payment_id)))return unknown("payment_unknown");
    const D=liveRoots.filter(r=>r.category==="deposit").reduce((n,r)=>n+BigInt(r.amount_minor),BigInt(0)),R=liveRoots.filter(r=>r.category==="rent").reduce((n,r)=>n+BigInt(r.amount_minor),BigInt(0)),C=rent.reduce((n,l)=>n+BigInt(l.amount_minor),BigInt(0));
    if(D<=BigInt(0)||R<=BigInt(0)||[D,R,C].some(x=>x>BigInt(Number.MAX_SAFE_INTEGER)))return unknown("attribution_unknown");
    const candidate=calculateReconciledRent({depositMinor:Number(D),unrelatedDeductions:[],finalRentMinor:finalRent.amountMinor,rentCashMinor:Number(R),chargedRentMinor:Number(C),sourceCoverage:"verified",outstanding:"resolved",priorOutcomes:"unresolved"});
    // Prior-outcome reconciliation is deliberately not yet implemented here.
    // Thus even a fully supported source candidate has no authoritative net.
    return finish({verifiedCandidate:true as const,fingerprint,projection,verifiedAttributions:liveRoots.map(r=>({id:String(r.attribution_id),evidenceId:String(r.evidence_id)})),sourceAmounts:{depositMinor:Number(D),rentCashMinor:Number(R),chargedRentMinor:Number(C),finalRentMinor:finalRent.amountMinor},calculation:candidate});
}
export async function inspectSettlementCompleteSource(session:Session,leaseId:string) {
  let cohort:SourceCohort;
  return withSettlementFencePrototype(session.userId,async client=>{cohort=await prepareCompleteSource(client,session,leaseId);},query=>inspectCompleteSourceOn(query,session,leaseId,cohort));
}
