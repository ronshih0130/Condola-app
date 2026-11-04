import type { Client } from 'pg';
import { consentCoversCurrent } from './consent';
import { tx } from './db';
import { logServerError } from './errors';
import { isUuid } from './repair-rules';
import { tenantSignedPdfGloballyEnabled } from './tenant-signed-pdf-rules';
import type { Session } from './types';

export type TenantEndedLeaseSummary = {
  leaseId:string; status:'ended'; startsOn:string; endsOn:string|null;
  propertyLabel:string; unitLabel:string; roomLabel:string|null;
  archive:{property:boolean;unit:boolean;room:boolean};
};
export type TenantEndedLeaseList = {state:'ready';items:TenantEndedLeaseSummary[];nextCursor:string|null}|{state:'unavailable'};
export type TenantEndedLeaseDetail = {state:'ready';lease:TenantEndedLeaseSummary;pdfAvailability:'available'|'unavailable';pdfs:Array<{id:string;current:boolean;uploadedAt:string;sizeBytes:number}>}|{state:'unavailable'};
export type TenantEndedSignedPdf = {id:string;content:Uint8Array;size_bytes:number;file_name:string};

type SummaryRow = {lease_id:string;starts_on:string;ends_on:string|null;property_label:string;unit_label:string;room_label:string|null;property_archived:boolean;unit_archived:boolean;room_archived:boolean};
const unavailable={state:'unavailable' as const};
const valid=(s:Session)=>s.kind==='tenant'&&s.role===null&&!s.needsSandbox&&consentCoversCurrent(s.consent??null)&&[s.userId,s.sessionId,s.orgId,s.liveOrgId].every(isUuid)&&(s.environment==='live'||s.environment==='sandbox');
const args=(s:Session)=>[s.orgId,s.userId,s.sessionId,s.liveOrgId,s.environment];
/** Parameters $1..$5 always come from the fresh server Session, never a URL. */
const context=`o.id=$1::uuid AND o.environment::text=$5 AND ((o.environment='live' AND o.id=$4::uuid AND o.live_org_id IS NULL) OR (o.environment='sandbox' AND o.live_org_id=$4::uuid))
 AND EXISTS (SELECT 1 FROM public.auth_sessions a WHERE a.id=$3::uuid AND a.user_id=$2::uuid AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp())
 AND EXISTS (SELECT 1 FROM public.contacts c WHERE c.org_id=o.id AND c.user_id=$2::uuid AND c.is_tenant AND c.archived_at IS NULL)
 AND NOT EXISTS (SELECT 1 FROM public.org_members sm LEFT JOIN public.organizations so ON so.id=sm.org_id WHERE sm.user_id=$2::uuid AND sm.status='active' AND (so.id IS NULL OR so.environment='live'))`;
const eligibleLease=`l.org_id=o.id AND l.status='ended' AND app.is_lease_tenant(l.id)
 AND EXISTS (SELECT 1 FROM public.lease_parties lp JOIN public.contacts c ON c.org_id=lp.org_id AND c.id=lp.contact_id WHERE lp.org_id=l.org_id AND lp.lease_id=l.id AND c.user_id=$2::uuid AND c.is_tenant AND c.archived_at IS NULL)`;
const summarySelect=`l.id::text lease_id,l.start_date::text starts_on,l.end_date::text ends_on,p.name property_label,u.label unit_label,r.label room_label,p.archived_at IS NOT NULL property_archived,u.archived_at IS NOT NULL unit_archived,coalesce(r.archived_at IS NOT NULL,false) room_archived`;
const summaryJoins=`FROM public.leases l JOIN public.organizations o ON o.id=l.org_id JOIN public.properties p ON p.org_id=l.org_id AND p.id=l.property_id JOIN public.units u ON u.org_id=l.org_id AND u.id=l.unit_id LEFT JOIN public.rooms r ON r.org_id=l.org_id AND r.id=l.target_room_id`;
function summary(row:SummaryRow):TenantEndedLeaseSummary {return {leaseId:row.lease_id,status:'ended',startsOn:row.starts_on,endsOn:row.ends_on,propertyLabel:row.property_label,unitLabel:row.unit_label,roomLabel:row.room_label,archive:{property:row.property_archived,unit:row.unit_archived,room:row.room_archived}};}
async function currentContext(c:Client,s:Session){const q=await c.query(`SELECT 1 FROM public.organizations o WHERE ${context}`,args(s));return q.rowCount===1;}

/** Read-only current context, with a keyset over the actual authorized ended leases. */
export async function tenantEndedLeaseList(s:Session,cursor?:string):Promise<TenantEndedLeaseList> {
 if(!valid(s)|| (cursor!==undefined && (typeof cursor!=='string'||!isUuid(cursor)||cursor!==cursor.toLowerCase())))return unavailable;
 try{return await tx(s.userId,async c=>{
  if(!await currentContext(c,s))return unavailable;
  const result=await c.query<SummaryRow>(`SELECT ${summarySelect} ${summaryJoins} WHERE ${context} AND ${eligibleLease} AND ($6::uuid IS NULL OR l.id>$6::uuid) ORDER BY l.id LIMIT 51`,[...args(s),cursor??null]);
  if(!await currentContext(c,s))return unavailable;
  const items=result.rows.slice(0,50).map(summary);return {state:'ready',items,nextCursor:result.rows.length>50 ? items[items.length-1].leaseId : null};
 },{orgId:s.orgId,environment:s.environment},{readOnly:true});}catch(error){logServerError('tenant_ended_lease_list',error);return unavailable;}
}

export async function tenantEndedLeaseDetail(s:Session,leaseId:string):Promise<TenantEndedLeaseDetail> {
 if(!valid(s)||typeof leaseId!=='string'||!isUuid(leaseId))return unavailable;
 try{return await tx(s.userId,async c=>{
  const found=await c.query<SummaryRow & {pdf_readable:boolean}>(`SELECT ${summarySelect},app.tenant_signed_pdf_readable(l.org_id,l.id) AS pdf_readable ${summaryJoins} WHERE ${context} AND ${eligibleLease} AND l.id=$6::uuid`,[...args(s),leaseId]);
  const row=found.rows[0];if(!row)return unavailable;
  if(!tenantSignedPdfGloballyEnabled()||row.pdf_readable!==true)return {state:'ready',lease:summary(row),pdfAvailability:'unavailable',pdfs:[]};
  const files=await c.query<{id:string;current:boolean;uploaded_at:string;size_bytes:number}>(`WITH ranked AS (
   SELECT pdf.id,pdf.created_at,octet_length(pdf.content) AS size_bytes,coalesce(pdf.file_id=l.document_file_id,false) AS matches_pointer,
     bool_or(coalesce(pdf.file_id=l.document_file_id,false)) OVER () AS has_current,row_number() OVER(ORDER BY pdf.created_at DESC,pdf.id DESC) AS newest
   FROM public.lease_signed_pdfs pdf JOIN public.leases l ON l.org_id=pdf.org_id AND l.id=pdf.lease_id JOIN public.organizations o ON o.id=l.org_id
   WHERE ${context} AND ${eligibleLease} AND l.id=$6::uuid AND app.tenant_signed_pdf_readable(pdf.org_id,pdf.lease_id) AND app.is_lease_tenant(pdf.lease_id)
  ) SELECT id::text,(matches_pointer OR (NOT has_current AND newest=1)) AS current,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS uploaded_at,size_bytes FROM ranked ORDER BY current DESC,created_at DESC,id DESC`,[...args(s),leaseId]);
  if(!await currentContext(c,s))return unavailable;
  // Recheck the exact lease and gate after the version read, including the empty case.
  const again=await c.query<{ok:boolean}>(`SELECT EXISTS(SELECT 1 FROM public.leases l JOIN public.organizations o ON o.id=l.org_id WHERE ${context} AND ${eligibleLease} AND l.id=$6::uuid AND app.tenant_signed_pdf_readable(l.org_id,l.id)) AS ok`,[...args(s),leaseId]);
  if(!again.rows[0]?.ok)return unavailable;
  return {state:'ready',lease:summary(row),pdfAvailability:'available',pdfs:files.rows.map(f=>({id:f.id,current:f.current,uploadedAt:f.uploaded_at,sizeBytes:f.size_bytes}))};
 },{orgId:s.orgId,environment:s.environment},{readOnly:true});}catch(error){logServerError('tenant_ended_lease_detail',error);return unavailable;}
}

/** One authenticated SELECT binds the current tenant, exact ended lease and PDF bytes. */
export async function tenantEndedLeaseSignedPdf(s:Session,leaseId:string,pdfId:string):Promise<TenantEndedSignedPdf|null> {
 if(!valid(s)||!tenantSignedPdfGloballyEnabled()||typeof leaseId!=='string'||!isUuid(leaseId)||typeof pdfId!=='string'||!isUuid(pdfId))return null;
 return tx(s.userId,async c=>{
  const q=await c.query<TenantEndedSignedPdf>(`SELECT pdf.id::text,pdf.content,octet_length(pdf.content) AS size_bytes,'signed-lease-'||pdf.id::text||'.pdf' AS file_name FROM public.lease_signed_pdfs pdf JOIN public.leases l ON l.org_id=pdf.org_id AND l.id=pdf.lease_id JOIN public.organizations o ON o.id=l.org_id WHERE ${context} AND ${eligibleLease} AND l.id=$6::uuid AND pdf.id=$7::uuid AND app.tenant_signed_pdf_readable(pdf.org_id,pdf.lease_id) AND app.is_lease_tenant(pdf.lease_id)`,[...args(s),leaseId,pdfId]);return q.rows[0]??null;
 },{orgId:s.orgId,environment:s.environment},{readOnly:true});
}
