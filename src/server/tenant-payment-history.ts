import { tx } from './db';
import { consentCoversCurrent, type StoredConsent } from './consent';
import { logServerError } from './errors';
import { tenantBillLines, type TenantBillLine } from './money';
import { tenantPayeeVisible } from './pay-note';
import { isUuid } from './repair-rules';
import { historyFlagEnabled, safeMinor, summarizeBill, sumMinor, type BillState } from './tenant-payment-history-rules';
import type { Session } from './types';

export type TenantPaymentReport = { id:string; status:'submitted'|'confirmed'|'rejected'|'reversed'; current:{amountMinor:number;currency:string;paidOn:string}; submittedAt:string; confirmedAt:string|null; rejectionReason:string|null; reversalReason:'unavailable'; original:{state:'unavailable'}|{state:'available';amountMinor:number;currency:string;paidOn:string} };
export type TenantPaymentHistory = {state:'off'}|{state:'unavailable'}|{state:'ready';lease:{id:string;status:string;currency:string;canReport:boolean;legacyPayeeVisible:boolean};bill:{state:BillState;overdue:boolean;pending:boolean;balanceMinor:number;paidMinor:number;currency:string;lines:TenantBillLine[]};reports:TenantPaymentReport[];nextCursor:string|null};
type ReportRow={id:string;status:TenantPaymentReport['status'];amount:string;currency:string;paid_on:string;submitted_at:string;confirmed_at:string|null;rejected_reason:string|null;payer_contact_id:string|null};
type InvoiceRow={id:string;status:string;total:string;paid:string;balance:string;due_on:string;currency:string};
type LineRow={invoice_id:string;charge_type:string;amount:string;description:string;period_start:string|null};
const unavailable={state:'unavailable' as const},off={state:'off' as const};
const valid=(s:Session)=>s.kind==='tenant'&&s.role===null&&!s.needsSandbox&&consentCoversCurrent(s.consent??null)&&[s.userId,s.sessionId,s.orgId,s.liveOrgId].every(isUuid)&&(s.environment==='live'||s.environment==='sandbox');
const ctx=`o.id=$1::uuid AND o.environment::text=$5 AND ((o.environment='live' AND o.id=$4::uuid AND o.live_org_id IS NULL) OR (o.environment='sandbox' AND o.live_org_id=$4::uuid))
 AND EXISTS (SELECT 1 FROM public.auth_sessions a WHERE a.id=$3::uuid AND a.user_id=$2::uuid AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp())
 AND NOT EXISTS (SELECT 1 FROM public.org_members sm LEFT JOIN public.organizations so ON so.id=sm.org_id WHERE sm.user_id=$2::uuid AND sm.status='active' AND (so.id IS NULL OR so.environment='live'))`;
const party=`app.is_lease_tenant(l.id) AND EXISTS (SELECT 1 FROM public.lease_parties lp JOIN public.contacts c ON c.org_id=lp.org_id AND c.id=lp.contact_id WHERE lp.org_id=l.org_id AND lp.lease_id=l.id AND lp.role IN ('primary','co_tenant','occupant') AND c.user_id=$2::uuid AND c.is_tenant AND c.archived_at IS NULL)`;
const personal=`p.org_id=$1::uuid AND p.lease_id=$3::uuid AND p.source='tenant_portal' AND p.submitted_by=$2::uuid AND (p.payer_contact_id IS NULL OR EXISTS (SELECT 1 FROM public.contacts pc JOIN public.lease_parties pp ON pp.org_id=pc.org_id AND pp.contact_id=pc.id AND pp.lease_id=p.lease_id WHERE pc.org_id=p.org_id AND pc.id=p.payer_contact_id AND pc.user_id=$2::uuid AND pc.is_tenant AND pc.archived_at IS NULL AND pp.role IN ('primary','co_tenant','occupant')))`;
function encodeCursor(id:string):string { return id; }
/** Only selected-lease UUIDs and an own-report cursor or exact own report are accepted. */
export async function tenantPaymentHistory(s:Session,leaseId:string,options:{view:'current'|'ended';cursor?:string;reportId?:string}):Promise<TenantPaymentHistory> {
 if(!valid(s)||!options||!['current','ended'].includes(options.view)||!isUuid(leaseId)||(options?.cursor!==undefined&&!isUuid(options.cursor))||(options?.reportId!==undefined&&!isUuid(options.reportId))||(options?.cursor&&options?.reportId))return unavailable;
 try{return await tx(s.userId,async c=>{
  const args=[s.orgId,s.userId,s.sessionId,s.liveOrgId,s.environment,leaseId];
  // OFF is decided before lease/report lookup so the existing page remains authoritative.
  const controls=await c.query<{flags:unknown;global:unknown}>(`SELECT o.feature_flags flags,(SELECT value FROM public.platform_settings WHERE key='tenant_payment_history') AS global FROM public.organizations o WHERE ${ctx}`,[s.orgId,s.userId,s.sessionId,s.liveOrgId,s.environment]);
  if(!controls.rows[0])return unavailable;
  if(!historyFlagEnabled(controls.rows[0].global,controls.rows[0].flags,s.orgId))return off;
  const context=await c.query<{status:string;currency:string;timezone:string;flags:unknown;global:unknown;consent:StoredConsent|null}>(`SELECT l.status::text,l.currency::text,pr.timezone,o.feature_flags flags,(SELECT value FROM public.platform_settings WHERE key='tenant_payment_history') AS global,
   (SELECT jsonb_build_object('accepted_at',z.accepted_at,'terms_version',z.terms_version,'privacy_version',z.privacy_version,'source',z.source) FROM public.consents z WHERE z.user_id=$2::uuid ORDER BY z.recorded_at DESC,z.id DESC LIMIT 1) consent
   FROM public.leases l JOIN public.organizations o ON o.id=l.org_id JOIN public.properties pr ON pr.org_id=l.org_id AND pr.id=l.property_id WHERE ${ctx} AND l.org_id=$1::uuid AND l.id=$6::uuid AND ${party}`,args);
  const lease=context.rows[0];if(!lease||!consentCoversCurrent(lease.consent))return unavailable;
  if(options.view==='ended' ? lease.status!=='ended' : !['active','pending_signature'].includes(lease.status))return unavailable;
  const invoices=await c.query<InvoiceRow>(`SELECT id::text,status::text,total_minor::text total,paid_minor::text paid,balance_minor::text balance,due_date::text due_on,currency::text FROM public.invoices WHERE org_id=$1::uuid AND lease_id=$2::uuid ORDER BY due_date,id`,[s.orgId,leaseId]);
  if(invoices.rows.some(i=>i.currency!==lease.currency))return unavailable;
  const parsed=invoices.rows.map(i=>({status:i.status,total:safeMinor(i.total),paid:safeMinor(i.paid),balance:safeMinor(i.balance),dueOn:i.due_on}));
  const bill=summarizeBill(lease.status,parsed,lease.timezone,new Date());
  const open=invoices.rows.filter(i=>i.status==='open'||i.status==='partially_paid');
  let lines:TenantBillLine[]=[];
  if(open.length) {
   const rows=await c.query<LineRow>(`SELECT il.invoice_id::text,il.charge_type::text,il.amount_minor::text amount,il.description,i.period_start::text FROM public.invoice_lines il JOIN public.invoices i ON i.org_id=il.org_id AND i.id=il.invoice_id WHERE il.org_id=$1::uuid AND il.invoice_id=ANY($2::uuid[]) ORDER BY il.invoice_id,il.line_no`,[s.orgId,open.map(i=>i.id)]);
   // Bound every intermediate accumulation in the reused bill allocator.
   sumMinor(rows.rows.map(x=>Math.abs(safeMinor(x.amount))));
   lines=open.flatMap(i=>tenantBillLines(rows.rows.filter(x=>x.invoice_id===i.id).map(x=>({charge_type:x.charge_type,amount_minor:safeMinor(x.amount),description:x.description,period_start:x.period_start})),safeMinor(i.paid)));
   for (const invoice of open) { const own=tenantBillLines(rows.rows.filter(x=>x.invoice_id===invoice.id).map(x=>({charge_type:x.charge_type,amount_minor:safeMinor(x.amount),description:x.description,period_start:x.period_start})),safeMinor(invoice.paid)); if(sumMinor(own.map(x=>x.amountMinor))!==safeMinor(invoice.balance))return unavailable; }
  }
  const select=`p.id::text,p.status::text,p.amount_minor::text amount,p.currency::text,p.paid_on::text,to_char(p.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') submitted_at,CASE WHEN p.confirmed_at IS NULL THEN NULL ELSE to_char(p.confirmed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END confirmed_at,p.rejected_reason,p.payer_contact_id::text`;
  let cursorDate:string|null=null;
  if(options?.cursor){const anchor=await c.query<{submitted_at:string}>(`SELECT to_char(p.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') submitted_at FROM public.payments p WHERE ${personal} AND p.id=$4::uuid`,[s.orgId,s.userId,leaseId,options.cursor]);if(anchor.rowCount!==1)return unavailable;cursorDate=anchor.rows[0].submitted_at;}
  const reports=await c.query<ReportRow>(`SELECT ${select} FROM public.payments p WHERE ${personal} AND ($4::uuid IS NULL OR p.id=$4::uuid) AND ($5::timestamptz IS NULL OR (p.submitted_at,p.id)<($5::timestamptz,$6::uuid)) ORDER BY p.submitted_at DESC,p.id DESC LIMIT 51`,[s.orgId,s.userId,leaseId,options?.reportId??null,cursorDate,options?.cursor??null]);
  if(options?.reportId&&reports.rowCount!==1)return unavailable;
  const pendingResult=await c.query<{pending:boolean}>(`SELECT EXISTS(SELECT 1 FROM public.payments p WHERE ${personal} AND p.status='submitted') pending`,[s.orgId,s.userId,leaseId]);
  const selected=reports.rows.slice(0,50);
  // Existing service role has SELECT on audit_log. This fixed projection runs only after
  // tenant/session/lease admission and returns no raw audit row or extra tenant data.
  await c.query('SET LOCAL ROLE service_role');
  const original=await c.query<{row_id:string;actor:string|null;source:string|null;lease_id:string|null;embedded_id:string|null;embedded_org:string|null;submitted_by:string|null;payer:string|null;amount:string|null;currency:string|null;paid_on:string|null}>(`SELECT row_id,actor_user_id::text actor,new_row->>'source' source,new_row->>'lease_id' lease_id,new_row->>'id' embedded_id,new_row->>'org_id' embedded_org,new_row->>'submitted_by' submitted_by,new_row->>'payer_contact_id' payer,new_row->>'amount_minor' amount,new_row->>'currency' currency,new_row->>'paid_on' paid_on FROM public.audit_log WHERE org_id=$1::uuid AND table_name='payments' AND action='insert' AND row_id=ANY($2::text[])`,[s.orgId,selected.map(x=>x.id)]);
  await c.query('SET LOCAL ROLE authenticated');
  const finalContext=await c.query(`SELECT 1 FROM public.leases l JOIN public.organizations o ON o.id=l.org_id WHERE ${ctx} AND l.org_id=$1::uuid AND l.id=$6::uuid AND ${party}`,args);
  if(finalContext.rowCount!==1)return unavailable;
  const result:TenantPaymentReport[]=selected.map(p=>{
   const snapshots=original.rows.filter(x=>x.row_id===p.id);const a=snapshots[0];let evidence:TenantPaymentReport['original']={state:'unavailable'};
   if(snapshots.length===1&&a.actor===s.userId&&a.embedded_id===p.id&&a.embedded_org===s.orgId&&a.source==='tenant_portal'&&a.lease_id===leaseId&&a.submitted_by===s.userId&&a.payer===p.payer_contact_id&&a.amount&&a.currency===p.currency&&a.paid_on&&/^\d{4}-\d{2}-\d{2}$/.test(a.paid_on)) {try{const amountMinor=safeMinor(a.amount);if(amountMinor>0)evidence={state:'available',amountMinor,currency:a.currency,paidOn:a.paid_on};}catch{/* legacy evidence unavailable */}}
   return {id:p.id,status:p.status,current:{amountMinor:safeMinor(p.amount),currency:p.currency,paidOn:p.paid_on},submittedAt:p.submitted_at,confirmedAt:p.confirmed_at,rejectionReason:p.status==='rejected'?p.rejected_reason:null,reversalReason:'unavailable',original:evidence};
  });
  return {state:'ready',lease:{id:leaseId,status:lease.status,currency:lease.currency,canReport:options.view==='current'&&['active','pending_signature'].includes(lease.status)&&bill.balanceMinor>0,legacyPayeeVisible:options.view==='current'&&tenantPayeeVisible(lease.status,lines.length===0,lines)},bill:{...bill,pending:pendingResult.rows[0]?.pending===true,currency:lease.currency,lines},reports:result,nextCursor:reports.rows.length>50?encodeCursor(selected[selected.length-1].id):null};
 },{orgId:s.orgId,environment:s.environment},{isolation:'repeatable read',readOnly:true});}catch(error){logServerError('tenant_payment_history',error);return unavailable;}
}
