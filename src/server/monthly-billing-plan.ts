import { createHash } from 'node:crypto';
import { tx } from './db';
import { billingPreviewAuthorityOn } from './billing-preview-authority';
import { monthlyBounds, planMonthlyRow, utilityReadiness, type LeaseSource, type RentSource, type ComponentSource } from './monthly-billing-rules';
import type { Session } from './types';

const CAP=2000;
/** Uses the same authority in its own read-only snapshot without scanning billing data. */
export async function monthlyBillingAvailable(session:Session):Promise<boolean> {
  return tx(session.userId, client=>billingPreviewAuthorityOn(client,session), {orgId:session.orgId,environment:session.environment},{isolation:'repeatable read',readOnly:true});
}

/** Snapshot is a read-only preview, not posting authority or a complete bill. */
export async function monthlyBillingPlan(session:Session, month:string) {
  const period=monthlyBounds(month);
  return tx(session.userId,async client=>{
    if (!(await billingPreviewAuthorityOn(client,session))) return null;
    const controls=(await client.query(`SELECT (SELECT value FROM platform_settings WHERE key='billing_previews') AS global_value,feature_flags FROM organizations WHERE id=$1`,[session.orgId])).rows;
    const asOf=(await client.query<{value:string}>(`SELECT clock_timestamp()::text AS value`)).rows[0].value;
    const leases=(await client.query<LeaseSource>(`SELECT x.id::text,x.property_id::text,p.name AS property_name,u.label AS unit_label,x.start_date::text,x.end_date::text,x.terminated_on::text,x.moved_out_on::text,x.currency::text,x.rent_amount_minor::text AS rent,x.rent_frequency::text AS frequency,x.due_day FROM leases x JOIN properties p ON p.id=x.property_id AND p.org_id=x.org_id JOIN units u ON u.id=x.unit_id AND u.org_id=x.org_id WHERE x.org_id=$1 AND x.status='active' ORDER BY x.id LIMIT $2`,[session.orgId,CAP+1])).rows;
    const rent=(await client.query<RentSource>(`SELECT i.lease_id::text,i.id::text AS invoice_id,i.invoice_number,l.id::text AS line_id,i.status::text,i.source,l.service_period::text AS period,l.amount_minor::text AS amount,i.currency::text AS currency,coalesce(l.service_period && daterange($2::date,($3::date+1),'[)'),false) AS overlaps,coalesce(l.service_period=daterange($2::date,($3::date+1),'[)'),false) AS exact FROM invoices i JOIN invoice_lines l ON l.org_id=i.org_id AND l.invoice_id=i.id JOIN leases x ON x.org_id=i.org_id AND x.id=i.lease_id WHERE i.org_id=$1 AND x.status='active' AND l.charge_type='rent' ORDER BY i.lease_id,i.id,l.id LIMIT $4`,[session.orgId,period.start,period.end,CAP+1])).rows;
    const charges=(await client.query<ComponentSource>(`SELECT c.lease_id::text,c.id::text,'charge' AS kind,'unresolved' AS readiness,'charge_schedule_unverified' AS reason,jsonb_build_array(c.charge_type,c.label_key,c.description,c.frequency,c.start_date,c.end_date,c.fee_rule_id,c.meter_id,f.kind,f.hybrid_mode,f.basis,f.currency,f.fixed_amount_minor,f.percent_bp,f.rate_minor_per_unit,f.usage_unit,f.minimum_minor,f.maximum_minor,f.rounding,f.archived_at)::text AS state FROM lease_charges c JOIN leases x ON x.id=c.lease_id AND x.org_id=c.org_id LEFT JOIN fee_rules f ON f.org_id=c.org_id AND f.id=c.fee_rule_id WHERE c.org_id=$1 AND x.status='active' AND c.start_date<=$3::date AND (c.end_date IS NULL OR c.end_date>=$2::date) ORDER BY c.lease_id,c.id LIMIT $4`,[session.orgId,period.start,period.end,CAP+1])).rows;
    const utilityRows=(await client.query<{lease_id:string;id:string;kind:'utility';state:string;posted_valid:boolean;linked_valid:boolean;link_present:boolean;pointers_present:boolean;run_status:string}>(`SELECT l.lease_id::text,l.id::text,'utility' AS kind,r.status::text AS run_status,
      (il.id IS NOT NULL) AS link_present,
      (l.posted_invoice_id IS NOT NULL OR l.posted_invoice_line_id IS NOT NULL OR l.posted_ledger_transaction_id IS NOT NULL OR l.posted_amount_minor IS NOT NULL) AS pointers_present,
      coalesce(l.bearer='tenant' AND l.posted_invoice_id=pi.id AND l.posted_invoice_line_id=pl.id AND pl.invoice_id=pi.id AND pl.charge_type='utility' AND pi.lease_id=l.lease_id AND pi.currency=r.currency AND pi.status IN ('open','partially_paid','paid') AND pl.amount_minor=l.posted_amount_minor AND l.posted_amount_minor=l.amount_minor AND lt.id=l.posted_ledger_transaction_id AND lt.kind='invoice' AND lt.lease_id=l.lease_id AND lt.currency=r.currency AND lt.source_table='utility_allocation_lines' AND lt.source_id=l.id AND NOT EXISTS (SELECT 1 FROM ledger_transactions rev WHERE rev.org_id=l.org_id AND rev.reverses_transaction_id=lt.id),false) AS posted_valid,
      coalesce(l.bearer='tenant' AND il.charge_type='utility' AND i.lease_id=l.lease_id AND i.currency=r.currency AND i.status IN ('open','partially_paid','paid') AND il.amount_minor=l.amount_minor,false) AS linked_valid,
      jsonb_build_array(r.id,r.status,r.period_start,r.period_end,r.currency,l.bearer,l.amount_minor,l.posted_invoice_id,l.posted_invoice_line_id,l.posted_ledger_transaction_id,l.posted_amount_minor,pl.id,pl.invoice_id,pl.charge_type,pl.amount_minor,pi.id,pi.lease_id,pi.currency,pi.status,lt.id,lt.kind,lt.lease_id,lt.currency,lt.source_table,lt.source_id,il.id,il.invoice_id,il.charge_type,il.amount_minor,i.id,i.lease_id,i.currency,i.status,EXISTS(SELECT 1 FROM ledger_transactions rev WHERE rev.org_id=l.org_id AND rev.reverses_transaction_id=lt.id))::text AS state
      FROM utility_allocation_lines l JOIN utility_allocation_runs r ON r.org_id=l.org_id AND r.id=l.run_id JOIN leases x ON x.org_id=l.org_id AND x.id=l.lease_id
      LEFT JOIN invoice_lines il ON il.org_id=l.org_id AND il.allocation_line_id=l.id LEFT JOIN invoices i ON i.org_id=il.org_id AND i.id=il.invoice_id
      LEFT JOIN invoice_lines pl ON pl.org_id=l.org_id AND pl.id=l.posted_invoice_line_id LEFT JOIN invoices pi ON pi.org_id=l.org_id AND pi.id=l.posted_invoice_id LEFT JOIN ledger_transactions lt ON lt.org_id=l.org_id AND lt.id=l.posted_ledger_transaction_id
      WHERE l.org_id=$1 AND x.status='active' AND r.period_start<=$3::date AND r.period_end>=$2::date ORDER BY l.lease_id,l.id,il.id LIMIT $4`,[session.orgId,period.start,period.end,CAP+1])).rows;
    const utilities:ComponentSource[]=utilityRows.map(u=>({...u,...utilityReadiness({postedValid:u.posted_valid,linkedValid:u.linked_valid,linkPresent:u.link_present,pointersPresent:u.pointers_present,runStatus:u.run_status})}));
    if (!(await billingPreviewAuthorityOn(client,session))) return null;
    if ([leases,rent,charges,utilities].some(rows=>rows.length>CAP)) return {kind:'incomplete' as const,month};
    const rows=leases.map(l=>planMonthlyRow(l,rent.filter(r=>r.lease_id===l.id),[...charges,...utilities].filter(c=>c.lease_id===l.id),month));
    const sums=new Map<string,{amount:bigint;count:number}>();
    for(const row of rows) if(row.state==='supported' && row.rentMinor!==null) {const x=sums.get(row.currency)??{amount:BigInt(0),count:0};x.amount+=BigInt(row.rentMinor);x.count++;sums.set(row.currency,x);}
    const unresolvedCount=rows.filter(r=>r.state==='unresolved' || r.dueReason!==null || r.components.some(c=>c.readiness==='unresolved' || c.readiness==='unposted')).length;
    const digest=createHash('sha256').update(JSON.stringify({version:1,org:session.orgId,environment:session.environment,month,controls,leases,rent,charges,utilities})).digest('hex');
    if (!(await billingPreviewAuthorityOn(client,session))) return null;
    return {kind:'complete' as const,month,period,asOf,rows,digest,unresolvedCount,subtotals:[...sums].sort(([a],[b])=>a.localeCompare(b)).map(([currency,x])=>({currency,amountMinor:x.amount.toString(),count:x.count}))};
  },{orgId:session.orgId,environment:session.environment},{isolation:'repeatable read',readOnly:true});
}
export type MonthlyBillingPlan=NonNullable<Awaited<ReturnType<typeof monthlyBillingPlan>>>;
