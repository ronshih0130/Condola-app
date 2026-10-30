import { svc } from "./db";
import { FlowError } from "./errors";
import { settlementAccess, settlementDeadline, settlementUuid } from "./settlement-access";
import { calculateFinalRent } from "./settlement-calculation";
import type { Session } from "./types";

type Input={leaseId:string; agreedPeriodStart:string; agreedPeriodEnd:string; evidenceId:string; fullPeriodAsserted:boolean};
/** The supplied dates are an administrator's evidenced assertion of the full
 * agreed cycle, not an inference from a potentially partial invoice line.
 * This is an advisory quote, not a payment or settlement posting. */
export async function previewFinalRent(session:Session,input:Input) {
  settlementUuid(input.leaseId); settlementUuid(input.evidenceId);
  if(input.fullPeriodAsserted!==true) throw new FlowError("errors.required");
  return svc(session.userId,async client=>{
    const {lease}=await settlementAccess(client,session,input.leaseId,"publish");
    const property=(await client.query<{country_code:string}>(`SELECT country_code::text FROM public.properties WHERE id=$1 AND org_id=$2 FOR SHARE NOWAIT`,[lease.property_id,session.orgId])).rows[0];
    const evidence=(await client.query<{sha256:string}>(`SELECT e.sha256 FROM app.settlement_evidence e WHERE e.id=$1 AND e.org_id=$2 AND e.lease_id=$3 AND EXISTS(SELECT 1 FROM app.settlement_evidence_links l WHERE l.org_id=e.org_id AND l.lease_id=e.lease_id AND l.evidence_id=e.id)`,[input.evidenceId,session.orgId,input.leaseId])).rows[0];
    if(!property || !evidence || !lease.moved_out_on) throw new FlowError("errors.required");
    let quote:ReturnType<typeof calculateFinalRent>;
    try { quote=calculateFinalRent({country:property.country_code,currency:lease.currency,frequency:lease.rent_frequency,monthlyMinor:Number(lease.rent_amount_minor),periodStart:input.agreedPeriodStart,periodEnd:input.agreedPeriodEnd,leaseStart:lease.start_date,moveOut:lease.moved_out_on}); }
    catch { throw new FlowError("errors.required"); }
    const charges=(await client.query(`SELECT il.id,il.invoice_id,il.amount_minor::text,il.service_period::text,i.status::text,i.voided_at,i.paid_minor::text,i.total_minor::text FROM public.invoice_lines il JOIN public.invoices i ON i.id=il.invoice_id AND i.org_id=il.org_id WHERE i.org_id=$1 AND i.lease_id=$2 AND il.charge_type='rent' AND (il.service_period IS NULL OR il.service_period && daterange($3::date,$4::date,'[]')) ORDER BY il.id`,[session.orgId,input.leaseId,input.agreedPeriodStart,input.agreedPeriodEnd])).rows;
    await settlementDeadline(client,session,input.leaseId);
    // Even a visible prior invoice charge is not proof of line-level payment.
    return { quote, assertedPeriod:{start:input.agreedPeriodStart,end:input.agreedPeriodEnd,evidenceId:input.evidenceId,evidenceSha256:evidence.sha256}, priorCharges:charges, reconciliationRequired:charges.length>0, asOf:"transaction" as const };
  });
}
