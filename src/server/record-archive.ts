import { isDbContention } from "./record-archive-errors";
import { createHash } from "node:crypto";
import type { Client } from "pg";
import type { ArchiveCommandInput, ArchiveItem, ArchiveList, ArchiveObserved, ArchiveOutcome, ArchiveRef, ArchiveView, RenderedArchiveScope } from "@/lib/record-archive";
import { isArchiveCommand, isArchiveRef, sameArchiveScope } from "@/lib/record-archive";
import { tx } from "./db";
import { lockArchiveAncestry } from "./record-archive-admission";
import { can } from "./perms";
import { isUuid } from "./repair-rules";
import type { Session } from "./types";

type Row = { property_id:string; unit_id:string|null; room_id:string|null; mode:"whole_unit"|"by_room"|null; property_name:string; unit_label:string|null; room_label:string|null; property_archived:string|null; unit_archived:string|null; room_archived:string|null; px:string; ux:string|null; rx:string|null; pu:string; uu:string|null; ru:string|null };
const utc = (column:string) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const unavailable = {state:"unavailable" as const};
export function archiveScope(s:Session):RenderedArchiveScope { return {actorId:s.userId,orgId:s.orgId,liveOrgId:s.liveOrgId,environment:s.environment}; }
function eligible(s:Session) { return s.kind==='staff' && !s.needsSandbox && can(s.role,'props.view') && [s.userId,s.sessionId,s.orgId,s.liveOrgId].every(isUuid) && ['live','sandbox'].includes(s.environment); }
async function current(c:Client,s:Session) {
 if (!eligible(s)) return false;
 const q=await c.query(`SELECT 1 FROM public.organizations o JOIN public.org_members m ON m.org_id=$2 AND m.user_id=$3 AND m.status='active' AND m.role::text=$4 JOIN public.auth_sessions a ON a.id=$5 AND a.user_id=$3 WHERE o.id=$1 AND o.environment::text=$6 AND ((o.environment='live' AND o.id=$2 AND o.live_org_id IS NULL) OR (o.environment='sandbox' AND o.live_org_id=$2)) AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp()`,[s.orgId,s.liveOrgId,s.userId,s.role,s.sessionId,s.environment]);
 return q.rowCount===1;
}
async function enabled(c:Client,s:Session) {
 return recordArchiveEnabledFor(c,s.orgId);
}
export async function recordArchiveEnabledFor(c:Client,orgId:string):Promise<boolean> {
 const q=await c.query(`SELECT 1 FROM public.organizations o JOIN public.platform_settings f ON f.key='record_archive' WHERE o.id=$1 AND o.feature_flags->'record_archive'='true'::jsonb AND f.value->'enabled'='true'::jsonb AND CASE WHEN jsonb_typeof(f.value->'allowed_org_ids')='array' THEN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(f.value->'allowed_org_ids') AS item(value) WHERE jsonb_typeof(item.value)<>'string' OR (item.value #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') ELSE false END AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)`,[orgId]);return q.rowCount===1;
}
export async function recordArchiveEnabled(s:Session):Promise<boolean> {
 if(!eligible(s))return false;
 try {return await tx(s.userId,c=>recordArchiveEnabledFor(c,s.orgId),{orgId:s.orgId,environment:s.environment});}catch{return false;}
}
async function observe(c:Client,s:Session,ref:ArchiveRef):Promise<ArchiveObserved|null> {
 if(ref.kind==='owner') {
  const row=(await c.query<{id:string;name:string;archived:string|null;x:string;updated:string}>(`SELECT id::text,display_name name,${utc('owner_archived_at')} archived,xmin::text x,${utc('updated_at')} updated FROM public.contacts WHERE org_id=$1 AND id=$2 AND is_owner`,[s.orgId,ref.id])).rows[0];
  if(!row)return null;
  return {ref,propertyId:null,unitId:null,roomId:null,mode:null,name:row.name,propertyName:'',unitLabel:null,roomLabel:null,archivedAtUtc:row.archived,inherited:[],version:createHash('sha256').update(JSON.stringify(row)).digest('hex')};
 }
 const joins=ref.kind==='property' ? `FROM public.properties p` : ref.kind==='unit' ? `FROM public.units u JOIN public.properties p ON p.id=u.property_id AND p.org_id=u.org_id` : `FROM public.rooms r JOIN public.units u ON u.id=r.unit_id AND u.org_id=r.org_id JOIN public.properties p ON p.id=u.property_id AND p.org_id=u.org_id`;
 const u=ref.kind==='property' ? null : 'u'; const r=ref.kind==='room' ? 'r' : null;
 const opt=(alias:string|null, expression:string, fallback='NULL::text')=>alias ? expression : fallback;
 const sql=`SELECT p.id::text property_id,${opt(u,'u.id::text')} unit_id,${opt(r,'r.id::text')} room_id,${opt(u,'u.rental_mode::text')} mode,p.name property_name,${opt(u,'u.label')} unit_label,${opt(r,'r.label')} room_label,${utc('p.archived_at')} property_archived,${opt(u,utc('u.archived_at'))} unit_archived,${opt(r,utc('r.archived_at'))} room_archived,p.xmin::text px,${opt(u,'u.xmin::text')} ux,${opt(r,'r.xmin::text')} rx,${utc('p.updated_at')} pu,${opt(u,utc('u.updated_at'))} uu,${opt(r,utc('r.updated_at'))} ru ${joins} WHERE p.org_id=$1 AND ${ref.kind==='property'?'p':ref.kind==='unit'?'u':'r'}.id=$2`;
 const row=(await c.query<Row>(sql,[s.orgId,ref.id])).rows[0]; if(!row)return null;
 const id=ref.kind==='property'?row.property_id:ref.kind==='unit'?row.unit_id!:row.room_id!;
 const inherited:ArchiveObserved['inherited']=[];
 if(ref.kind!=='property' && row.property_archived) inherited.push({ref:{kind:'property',id:row.property_id},archivedAtUtc:row.property_archived});
 if(ref.kind==='room' && row.unit_archived) inherited.push({ref:{kind:'unit',id:row.unit_id!},archivedAtUtc:row.unit_archived});
 return {ref:{kind:ref.kind,id},propertyId:row.property_id,unitId:row.unit_id,roomId:row.room_id,mode:row.mode,name:ref.kind==='property'?row.property_name:ref.kind==='unit'?row.unit_label!:row.room_label!,propertyName:row.property_name,unitLabel:row.unit_label,roomLabel:row.room_label,archivedAtUtc:ref.kind==='property'?row.property_archived:ref.kind==='unit'?row.unit_archived:row.room_archived,inherited,version:createHash('sha256').update(JSON.stringify(row)).digest('hex')};
}
type Facts={owner_active?:boolean;owner_history?:boolean;lease_active:boolean;signing_active:boolean;repair_active:boolean;dispatch_active:boolean;utility_active:boolean;finance_outstanding:boolean;invite_pending:boolean;lease_history:boolean;repair_history:boolean;utility_history:boolean;finance_history:boolean;lease_active_id:string|null;signing_lease_id:string|null;repair_active_id:string|null;dispatch_ticket_id:string|null;lease_history_id:string|null;repair_history_id:string|null;expense_history_id:string|null};
async function facts(c:Client,s:Session,o:ArchiveObserved):Promise<Facts> {
 if(o.ref.kind==='owner') {
  const row=(await c.query<{active:boolean;history:boolean}>(`SELECT EXISTS(SELECT 1 FROM property_owners po JOIN properties p ON p.org_id=po.org_id AND p.id=po.property_id WHERE po.org_id=$1 AND po.owner_contact_id=$2 AND (po.effective_to IS NULL OR po.effective_to>=current_date) AND p.archived_at IS NULL) active,EXISTS(SELECT 1 FROM property_owners WHERE org_id=$1 AND owner_contact_id=$2) history`,[s.orgId,o.ref.id])).rows[0];
  return {owner_active:row.active,owner_history:row.history,lease_active:false,signing_active:false,repair_active:false,dispatch_active:false,utility_active:false,finance_outstanding:false,invite_pending:false,lease_history:false,repair_history:false,utility_history:false,finance_history:false,lease_active_id:null,signing_lease_id:null,repair_active_id:null,dispatch_ticket_id:null,lease_history_id:null,repair_history_id:null,expense_history_id:null};
 }
 const leaseScope=`l.org_id=$1 AND l.property_id=$2 AND ($3::text='property' OR ($3='unit' AND l.unit_id=$4::uuid) OR ($3='room' AND (l.target_room_id=$5::uuid OR l.target_unit_id=$4::uuid)))`;
 const ticketScope=`t.org_id=$1 AND t.property_id=$2 AND ($3::text='property' OR ($3='unit' AND t.unit_id=$4::uuid) OR ($3='room' AND t.room_id=$5::uuid))`;
 const utilityScope=`ur.org_id=$1 AND (
   ($3::text='property' AND (u.property_id=$2 OR m.property_id=$2 OR EXISTS (SELECT 1 FROM utility_allocation_lines al LEFT JOIN leases l ON l.org_id=al.org_id AND l.id=al.lease_id LEFT JOIN rooms ar ON ar.org_id=al.org_id AND ar.id=al.room_id LEFT JOIN units au ON au.org_id=ar.org_id AND au.id=ar.unit_id WHERE al.org_id=ur.org_id AND al.run_id=ur.id AND (l.property_id=$2 OR au.property_id=$2)))) OR
   ($3='unit' AND (ur.unit_id=$4::uuid OR m.unit_id=$4::uuid OR EXISTS (SELECT 1 FROM utility_allocation_lines al LEFT JOIN leases l ON l.org_id=al.org_id AND l.id=al.lease_id LEFT JOIN rooms ar ON ar.org_id=al.org_id AND ar.id=al.room_id WHERE al.org_id=ur.org_id AND al.run_id=ur.id AND (l.unit_id=$4::uuid OR ar.unit_id=$4::uuid)))) OR
   ($3='room' AND (m.room_id=$5::uuid OR EXISTS (SELECT 1 FROM utility_allocation_lines al LEFT JOIN leases l ON l.org_id=al.org_id AND l.id=al.lease_id WHERE al.org_id=ur.org_id AND al.run_id=ur.id AND (al.room_id=$5::uuid OR l.target_room_id=$5::uuid OR l.target_unit_id=$4::uuid)))))`;
 const expenseScope=`e.org_id=$1 AND e.property_id=$2 AND ($3::text='property' OR ($3='unit' AND e.unit_id=$4::uuid) OR ($3='room' AND EXISTS (SELECT 1 FROM maintenance_tickets t WHERE t.org_id=e.org_id AND t.id=e.ticket_id AND t.room_id=$5::uuid)))`;
 const q=await c.query<Facts>(`SELECT
  EXISTS(SELECT 1 FROM leases l WHERE ${leaseScope} AND l.status IN ('active','pending_signature')) lease_active,
  EXISTS(SELECT 1 FROM leases l JOIN esign_cases ec ON ec.org_id=l.org_id AND ec.lease_id=l.id JOIN esign_versions ev ON ev.case_id=ec.id WHERE ${leaseScope} AND ev.status IN ('sent','partially_signed')) signing_active,
  EXISTS(SELECT 1 FROM maintenance_tickets t WHERE ${ticketScope} AND t.status IN ('open','triaged','assigned','in_progress','on_hold')) repair_active,
  EXISTS(SELECT 1 FROM maintenance_tickets t JOIN repair_vendor_jobs j ON j.org_id=t.org_id AND j.ticket_id=t.id WHERE ${ticketScope} AND j.active AND j.reported_at IS NULL AND j.revoked_at IS NULL AND j.expires_at>clock_timestamp()) dispatch_active,
  EXISTS(SELECT 1 FROM utility_allocation_runs ur JOIN units u ON u.org_id=ur.org_id AND u.id=ur.unit_id JOIN meters m ON m.org_id=ur.org_id AND m.id=ur.meter_id WHERE ${utilityScope} AND ur.status IN ('draft','approved')) utility_active,
  (EXISTS(SELECT 1 FROM invoices i JOIN leases l ON l.org_id=i.org_id AND l.id=i.lease_id WHERE ${leaseScope} AND i.status IN ('draft','open','partially_paid')) OR EXISTS(SELECT 1 FROM payments pay JOIN leases l ON l.org_id=pay.org_id AND l.id=pay.lease_id WHERE ${leaseScope} AND pay.status='submitted') OR EXISTS(SELECT 1 FROM expenses e WHERE ${expenseScope} AND e.status IN ('draft','submitted')) OR EXISTS(SELECT 1 FROM maintenance_tickets t JOIN repair_vendor_jobs j ON j.org_id=t.org_id AND j.ticket_id=t.id WHERE ${ticketScope} AND t.status='resolved' AND j.reported_at IS NOT NULL AND j.confirmed_at IS NULL AND j.reported_cost_minor > 0) OR EXISTS(SELECT 1 FROM utility_allocation_runs ur JOIN units u ON u.org_id=ur.org_id AND u.id=ur.unit_id JOIN meters m ON m.org_id=ur.org_id AND m.id=ur.meter_id WHERE ${utilityScope} AND ur.status='pending_repost')) finance_outstanding,
  EXISTS(SELECT 1 FROM invitations i JOIN leases l ON l.org_id=i.org_id AND l.id=i.lease_id WHERE ${leaseScope} AND l.status IN ('active','pending_signature') AND i.kind='tenant' AND i.status='pending' AND i.expires_at>clock_timestamp()) invite_pending,
  EXISTS(SELECT 1 FROM leases l WHERE ${leaseScope}) lease_history,
  EXISTS(SELECT 1 FROM maintenance_tickets t WHERE ${ticketScope}) repair_history,
  EXISTS(SELECT 1 FROM utility_allocation_runs ur JOIN units u ON u.org_id=ur.org_id AND u.id=ur.unit_id JOIN meters m ON m.org_id=ur.org_id AND m.id=ur.meter_id WHERE ${utilityScope}) utility_history,
  (EXISTS(SELECT 1 FROM invoices i JOIN leases l ON l.org_id=i.org_id AND l.id=i.lease_id WHERE ${leaseScope}) OR EXISTS(SELECT 1 FROM payments pay JOIN leases l ON l.org_id=pay.org_id AND l.id=pay.lease_id WHERE ${leaseScope}) OR EXISTS(SELECT 1 FROM expenses e WHERE ${expenseScope})) finance_history,
  (SELECT min(l.id::text) FROM leases l WHERE ${leaseScope} AND l.status IN ('active','pending_signature')) lease_active_id,
  (SELECT min(l.id::text) FROM leases l JOIN esign_cases ec ON ec.org_id=l.org_id AND ec.lease_id=l.id JOIN esign_versions ev ON ev.case_id=ec.id WHERE ${leaseScope} AND ev.status IN ('sent','partially_signed')) signing_lease_id,
  (SELECT min(t.id::text) FROM maintenance_tickets t WHERE ${ticketScope} AND t.status IN ('open','triaged','assigned','in_progress','on_hold')) repair_active_id,
  (SELECT min(t.id::text) FROM maintenance_tickets t JOIN repair_vendor_jobs j ON j.org_id=t.org_id AND j.ticket_id=t.id WHERE ${ticketScope} AND j.active AND j.reported_at IS NULL AND j.revoked_at IS NULL AND j.expires_at>clock_timestamp()) dispatch_ticket_id,
  (SELECT min(l.id::text) FROM leases l WHERE ${leaseScope}) lease_history_id,
  (SELECT min(t.id::text) FROM maintenance_tickets t WHERE ${ticketScope}) repair_history_id,
  (SELECT min(e.id::text) FROM expenses e WHERE ${expenseScope}) expense_history_id`,[s.orgId,o.propertyId,o.ref.kind,o.unitId,o.roomId]);
 if(!q.rows[0])throw new Error('Archive coverage unavailable'); return q.rows[0];
}
function factItems(f:Facts, ref:ArchiveRef) {
 const blockers:ArchiveItem[]=[];const warnings:ArchiveItem[]=[];const history:ArchiveItem[]=[];
 if(f.owner_active)blockers.push({category:'owners',label:'owner_active',href:`/m/owners/${ref.id}`});
 if(f.owner_history)history.push({category:'owners',label:'owner_history',href:`/m/owners/${ref.id}`});
 if(f.lease_active)blockers.push({category:'leases',label:'lease_active',href:f.lease_active_id?`/m/leases/${f.lease_active_id}`:'/m/leases'});
 if(f.signing_active)blockers.push({category:'signing',label:'signing_active',href:f.signing_lease_id?`/m/leases/${f.signing_lease_id}`:'/m/leases'});
 if(f.repair_active)blockers.push({category:'repairs',label:'repair_active',href:f.repair_active_id?`/m/tickets/${f.repair_active_id}`:'/m/tickets'});
 if(f.dispatch_active)blockers.push({category:'dispatch',label:'dispatch_active',href:f.dispatch_ticket_id?`/m/tickets/${f.dispatch_ticket_id}`:'/m/tickets'});
 if(f.utility_active)blockers.push({category:'utilities',label:'utility_active',href:'/m/rent/utilities'});
 if(f.finance_outstanding)warnings.push({category:'finance',label:'finance_outstanding',href:'/m/payments'});
 if(f.invite_pending)warnings.push({category:'invitations',label:'invite_pending',href:'/m/leases'});
 if(f.lease_history)history.push({category:'leases',label:'lease_history',href:f.lease_history_id?`/m/leases/${f.lease_history_id}`:'/m/leases'});
 if(f.repair_history)history.push({category:'repairs',label:'repair_history',href:f.repair_history_id?`/m/tickets/${f.repair_history_id}`:'/m/tickets'});
 if(f.utility_history)history.push({category:'utilities',label:'utility_history',href:ref.kind==='unit'?`/m/rent/utilities?historyUnit=${encodeURIComponent(ref.id)}`:'/m/rent/utilities'});
 if(f.finance_history)history.push({category:'finance',label:'finance_history',href:f.expense_history_id?`/m/expenses/${f.expense_history_id}`:'/m/payments'});
 return {blockers,warnings,history};
}
/** Dependency queries in the view are advisory; the command repeats them under locks. */
export async function archiveView(s:Session,ref:ArchiveRef):Promise<ArchiveView> {
 if(!eligible(s)||!isArchiveRef(ref))return unavailable;
 try {return await tx(s.userId,async c=>{if(!await current(c,s))return unavailable;const observed=await observe(c,s,ref);if(!observed)return unavailable;const found=await facts(c,s,observed);const writeEnabled=can(s.role,'props.edit') && await enabled(c,s);if(!await current(c,s))return unavailable;const items=factItems(found,ref);return {state:'ready',observed,writeEnabled,canArchive:writeEnabled && !observed.archivedAtUtc && items.blockers.length===0,canRestore:writeEnabled && Boolean(observed.archivedAtUtc) && observed.inherited.length===0 && (ref.kind!=='room'||observed.mode==='by_room'),...items,coverage:(ref.kind==='owner'?(['owners'] as const):(['leases','signing','repairs','dispatch','utilities','finance','invitations'] as const)).map(category=>({category,state:category==='signing'&&!can(s.role,'props.edit')?'unknown' as const:'verified' as const}))};},{orgId:s.orgId,environment:s.environment});} catch {return unavailable;}
}
export async function archiveList(s:Session,after?:string):Promise<ArchiveList> {
 if(!eligible(s))return unavailable;
 if(after!==undefined&&typeof after!=='string')return unavailable;
 const match=after===undefined?null:/^(property|unit|room|owner):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(after);
 if(after!==undefined&&!match)return unavailable;
 try {return await tx(s.userId,async c=>{if(!await current(c,s))return unavailable;const ids=(await c.query<ArchiveRef>(`SELECT kind,id FROM (SELECT 'owner'::text kind,c.id::text id FROM public.contacts c WHERE c.org_id=$1 AND c.is_owner AND c.owner_archived_at IS NOT NULL AND app.b015_archive_enabled(c.org_id) IS TRUE UNION ALL SELECT 'property'::text kind,p.id::text id FROM public.properties p WHERE p.org_id=$1 AND p.archived_at IS NOT NULL UNION ALL SELECT 'unit',u.id::text FROM public.units u JOIN public.properties p ON p.org_id=u.org_id AND p.id=u.property_id WHERE u.org_id=$1 AND (u.archived_at IS NOT NULL OR p.archived_at IS NOT NULL) UNION ALL SELECT 'room',r.id::text FROM public.rooms r JOIN public.units u ON u.org_id=r.org_id AND u.id=r.unit_id JOIN public.properties p ON p.org_id=u.org_id AND p.id=u.property_id WHERE r.org_id=$1 AND (r.archived_at IS NOT NULL OR u.archived_at IS NOT NULL OR p.archived_at IS NOT NULL)) x WHERE ($2::text IS NULL OR (kind,id)>($2::text,$3::text)) ORDER BY kind,id LIMIT 201`,[s.orgId,match?.[1]??null,match?.[2]??null])).rows;const rows:ArchiveObserved[]=[];for(const ref of ids.slice(0,200)){const item=await observe(c,s,ref);if(!item)return unavailable;rows.push(item);}if(!await current(c,s))return unavailable;const hasMore=ids.length>200,last=rows.at(-1);return {state:'ready',rows,hasMore,nextCursor:hasMore&&last?`${last.ref.kind}:${last.ref.id}`:null};},{orgId:s.orgId,environment:s.environment});} catch{return unavailable;}
}
export async function archiveCommand(s:Session,input:ArchiveCommandInput):Promise<ArchiveOutcome> {
 if(!isArchiveCommand(input)||!eligible(s)||!can(s.role,'props.edit')||!sameArchiveScope(input.renderedScope,archiveScope(s)))return {state:'forbidden'};
 let archiveEnabled=false;
 try{return await tx<ArchiveOutcome>(s.userId,async c=>{
  if(!await current(c,s))return {state:'forbidden'};
  if(!await enabled(c,s))return {state:'disabled'};
  archiveEnabled=true;
  await c.query(`SELECT set_config('lock_timeout','5s',true)`);
  if(input.ref.kind!=='owner')await lockArchiveAncestry(c,s.orgId,input.ref,true);
  if(!await current(c,s))return {state:'forbidden'};
  if(!await enabled(c,s))return {state:'disabled'};
  const path=await observe(c,s,input.ref);if(!path)return {state:'forbidden'};
  await c.query('SELECT app.b015_archive_lock_path($1,$2,$3,$4,$5,false)',[s.orgId,path.propertyId,path.unitId,path.roomId,input.ref.kind==='owner'?input.ref.id:null]);
  if(!await current(c,s))return {state:'forbidden'};
  if(!await enabled(c,s))return {state:'disabled'};
  const table=input.ref.kind==='property'?'properties':input.ref.kind==='unit'?'units':input.ref.kind==='room'?'rooms':'contacts';
  const locked=await c.query(`SELECT id,xmin::text x FROM public.${table} WHERE org_id=$1 AND id=$2 FOR NO KEY UPDATE`,[s.orgId,input.ref.id]);
  if(locked.rowCount!==1)return {state:'forbidden'};
  if(!await current(c,s))return {state:'forbidden'};
  if(!await enabled(c,s))return {state:'disabled'};
  const observed=await observe(c,s,input.ref);if(!observed)return {state:'forbidden'};
  if(observed.version!==input.expectedVersion)return {state:'stale'};
  const archived=observed.archivedAtUtc!==null;
  if(archived===(input.desired==='archived'))return {state:'already_in_desired_state'};
  if(input.desired==='active' && (observed.inherited.length>0 || (input.ref.kind==='room' && observed.mode!=='by_room')))return {state:'blocked'};
  if(input.desired==='archived' && factItems(await facts(c,s,observed),input.ref).blockers.length)return {state:'blocked'};
  // Only the trusted server connection can select service_role. Raw API roles
  // cannot execute this gateway, even with spoofed request/session GUCs.
  await c.query('SET LOCAL ROLE service_role');
  const result=(await c.query<{state:ArchiveOutcome['state']}>(`SELECT app.b015_archive_record($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) state`,[s.orgId,s.liveOrgId,s.environment,s.sessionId,input.ref.kind,input.ref.id,input.desired==='archived',locked.rows[0].x,input.reason,input.requestId])).rows[0];
  await c.query('SET LOCAL ROLE authenticated');
  if(result.state!=='changed')return {state:result.state};
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  if(!await current(c,s)||!await enabled(c,s))throw new Error('Archive authorization changed');
  return {state:'changed'};
 },{orgId:s.orgId,environment:s.environment});}catch(error){const code=(error as {cause?:{code?:string}})?.cause?.code;if(code==='23505')return {state:'conflict'};if(archiveEnabled&&isDbContention(error))return {state:'busy'};return {state:'unknown'};}
}
