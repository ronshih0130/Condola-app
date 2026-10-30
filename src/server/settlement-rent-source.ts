import type { Client } from "pg";
import { FlowError } from "./errors";

/** Local prototype only. Caller must already have authorized context, lease,
 * cycle admission, all source payment locks, and verified ledger header locks.
 * No new blocking dependencies or I/O may follow the returned fence. The table
 * locks persist to transaction end; this does not itself authorize a net. */
export async function scanRentSourcesUnderFence(client:Client,orgId:string,leaseId:string,periodStart:string,periodEnd:string) {
  const valid=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
  if(!valid(periodStart)||!valid(periodEnd)||periodEnd<periodStart)throw new FlowError("errors.required");
  await client.query("LOCK TABLE public.invoices, public.invoice_lines IN SHARE MODE NOWAIT");
  const invoices=await client.query(`SELECT i.id,i.status::text,i.voided_at,i.currency::text,i.total_minor::text,i.paid_minor::text,i.balance_minor::text,i.period_start::text,i.period_end::text,i.xmin::text AS version FROM public.invoices i WHERE i.org_id=$1 AND i.lease_id=$2 ORDER BY i.id LIMIT 1001 FOR SHARE NOWAIT`,[orgId,leaseId]);
  if(invoices.rows.length>1000)throw new FlowError("errors.generic");
  const lines=await client.query(`SELECT il.id,il.invoice_id,il.charge_type::text,il.amount_minor::text,il.service_period::text,il.xmin::text AS version,CASE WHEN il.service_period IS NULL OR isempty(il.service_period) OR lower_inf(il.service_period) OR upper_inf(il.service_period) THEN true ELSE false END AS ambiguous_period,coalesce(il.service_period && daterange($3::date,$4::date,'[]'),false) AS overlaps FROM public.invoice_lines il JOIN public.invoices i ON i.org_id=il.org_id AND i.id=il.invoice_id WHERE i.org_id=$1 AND i.lease_id=$2 AND il.charge_type IN ('rent','credit','adjustment','deposit_refund') ORDER BY il.id LIMIT 1001`,[orgId,leaseId,periodStart,periodEnd]);
  if(lines.rows.length>1000)throw new FlowError("errors.generic");
  // A source binding and complete accounting reconciliation are still required.
  // This scanner deliberately never asserts a final or authoritative net.
  return {invoices:invoices.rows,lines:lines.rows,authoritative:false as const};
}
