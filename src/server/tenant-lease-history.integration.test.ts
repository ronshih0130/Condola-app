import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import test from 'node:test';
import { query,tx } from './db';
import { buildStoredConsent } from './consent';
import { archiveCommand,archiveScope,archiveView } from './record-archive';
import { uploadSignedLeasePdf } from './domain';
import { writeSignedPdfDownload } from './audit';
import { tenantSignedPdfDownload } from './tenant-signed-pdf-download';
import { tenantEndedLeaseDetail,tenantEndedLeaseList,tenantEndedLeaseSignedPdf } from './tenant-lease-history';
import { ORG_ID,ORG2_ID,USERS } from './ids';
import { cloneTestDatabase } from './test-database-clone';
import { disposableDbUrl } from './test-disposable-db';
import { resetAndSeed } from './seed';
import type { Session } from './types';

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
const previousTenantPdf = process.env.TENANT_SIGNED_PDF_ENABLED;
process.env.TENANT_SIGNED_PDF_ENABLED = "true";
let clone:Awaited<ReturnType<typeof cloneTestDatabase>>;
test.before(async()=>{clone=await cloneTestDatabase();const keys=['DEMO_MODE','ID_DOC_ENCRYPTION_KEY','ID_DOC_HMAC_KEY','ID_DOC_SIGNING_SECRET','CRON_SECRET'] as const;const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));try{process.env.DEMO_MODE='true';for(const k of keys.slice(1))process.env[k]=randomBytes(32).toString('hex');await resetAndSeed();}finally{for(const k of keys){const v=saved[k];if(v===undefined)delete process.env[k];else process.env[k]=v;}}});
test.after(async()=>{if(previousTenantPdf===undefined)delete process.env.TENANT_SIGNED_PDF_ENABLED;else process.env.TENANT_SIGNED_PDF_ENABLED=previousTenantPdf;await clone?.cleanup();});

async function tenant(org=ORG_ID) {
 const userId=randomUUID(),sessionId=randomUUID(),consent=buildStoredConsent('signup');
 await query(`INSERT INTO auth.users(id,email,role,aud) VALUES($1,$2,'authenticated','authenticated')`,[userId,`${randomUUID()}@example.test`]);
 await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sessionId,userId,randomUUID()]);
 await query(`INSERT INTO public.consents(user_id,accepted_at,terms_version,privacy_version,source) VALUES($1,$2,$3,$4,$5)`,[userId,consent.accepted_at,consent.terms_version,consent.privacy_version,consent.source]);
 const contact=(await query<{id:string}>(`INSERT INTO contacts(org_id,user_id,is_tenant,display_name) VALUES($1,$2,true,'Synthetic tenant') RETURNING id::text`,[org,userId])).rows[0].id;
 const s:Session={userId,sessionId,email:'',name:'Synthetic',kind:'tenant',role:null,orgId:org,liveOrgId:org,environment:'live',locale:'en',calendar:'gregorian',leaseId:null,consent};return {s,contact};
}
async function admin(org:string=ORG_ID,user:string=USERS.admin) {const sessionId=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sessionId,user,randomUUID()]);const s:Session={userId:user,sessionId,email:'',name:'admin',kind:'staff',role:'admin',orgId:org,liveOrgId:org,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};return s;}
async function fixture(contact:string,org=ORG_ID,status='ended') {
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[org,`Tenant history ${randomUUID()}`])).rows[0].id;
 const u=(await query<{id:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES($1,$2,'Floor','by_room') RETURNING id::text`,[org,p])).rows[0].id;
 const room=(await query<{id:string}>(`INSERT INTO rooms(org_id,unit_id,label) VALUES($1,$2,'A') RETURNING id::text`,[org,u])).rows[0].id;
 const lease=(await query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_room_id,status,esign_status,start_date,end_date,currency,rent_amount_minor) VALUES($1,$2,$3,$4,$5::lease_status,'imported','2090-01-01','2090-12-31','TWD',0) RETURNING id::text`,[org,p,u,room,status])).rows[0].id;
 await query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')`,[org,lease,contact]);return {p,u,room,lease};
}
async function enable(org=ORG_ID){await query(`INSERT INTO platform_settings(key,value) VALUES('tenant_signed_pdf','true'::jsonb),('record_archive',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text))) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,[org]);await query(`UPDATE organizations SET feature_flags=jsonb_set(jsonb_set(coalesce(feature_flags,'{}'::jsonb),'{tenant_signed_pdf}','true'::jsonb,true),'{record_archive}','true'::jsonb,true) WHERE id=$1`,[org]);}

function read(s:Session,l:string,p:string){return tenantEndedLeaseSignedPdf(s,l,p);}
async function ready(s:Session,lease:string){const d=await tenantEndedLeaseDetail(s,lease);assert.equal(d.state,'ready');if(d.state!=='ready')throw new Error('Detail unavailable');return d;}

test('ended tenant with no selected or active lease retains exact signed-paper bytes and audit across archive and restore',async()=>{
 const actor=await tenant(),staff=await admin(),f=await fixture(actor.contact);await enable();assert.equal(actor.s.leaseId,null);
 assert.equal((await query(`SELECT l.id FROM leases l JOIN lease_parties lp ON lp.lease_id=l.id WHERE lp.contact_id=$1 AND l.status IN ('active','pending_signature')`,[actor.contact])).rowCount,0);
 const first=new TextEncoder().encode('%PDF-1.4 synthetic first'),second=new TextEncoder().encode('%PDF-1.4 synthetic second');
 await uploadSignedLeasePdf(staff,f.lease,{bytes:first,fileName:'first.pdf',replaceReason:'Synthetic correction'});await uploadSignedLeasePdf(staff,f.lease,{bytes:second,fileName:'second.pdf',replaceReason:'Synthetic correction'});
 const business=async()=> (await query(`SELECT (SELECT to_jsonb(l) FROM leases l WHERE l.id=$1) lease,(SELECT count(*)::int FROM lease_parties WHERE lease_id=$1) parties,(SELECT count(*)::int FROM lease_signatures WHERE lease_id=$1) signatures,(SELECT count(*)::int FROM invoices WHERE lease_id=$1) invoices,(SELECT count(*)::int FROM payments WHERE lease_id=$1) payments,(SELECT count(*)::int FROM identity_documents WHERE lease_id=$1) documents,(SELECT count(*)::int FROM lease_signed_pdfs WHERE lease_id=$1) pdfs`,[f.lease])).rows[0];const before=await business();
 let detail=await ready(actor.s,f.lease);assert.equal(detail.pdfAvailability,'available');assert.equal(detail.pdfs.length,2);assert.equal(detail.pdfs.filter(p=>p.current).length,1);const current=detail.pdfs.find(p=>p.current)!;assert.deepEqual(Uint8Array.from((await read(actor.s,f.lease,current.id))!.content),second);
 const requestId=randomUUID();const response=await tenantSignedPdfDownload({orgId:actor.s.orgId,userId:actor.s.userId,leaseId:f.lease,pdfId:current.id,requestId},{read:()=>read(actor.s,f.lease,current.id),audit:writeSignedPdfDownload,logError:()=>{throw new Error('Unexpected audit failure');}});
 assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/pdf');assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.equal(response.headers.get('content-length'),String(second.length));assert.equal(response.headers.get('content-disposition'),`attachment; filename="signed-lease-${current.id}.pdf"`);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),second);
 const audit=await query<{actor:string;org_id:string;row_id:string;request_id:string;new_row:unknown}>(`SELECT actor_user_id::text actor,org_id::text,row_id,request_id,new_row FROM audit_log WHERE event_type='signed_pdf_downloaded' AND request_id=$1`,[requestId]);assert.equal(audit.rowCount,1);assert.equal(audit.rows[0].actor,actor.s.userId);assert.equal(audit.rows[0].org_id,ORG_ID);assert.equal(audit.rows[0].row_id,current.id);assert.deepEqual(audit.rows[0].new_row,{event:'signed_pdf_downloaded',lease_id:f.lease});
 const failed=await tenantSignedPdfDownload({orgId:ORG_ID,userId:actor.s.userId,leaseId:f.lease,pdfId:current.id,requestId:randomUUID()},{read:()=>read(actor.s,f.lease,current.id),audit:async()=>{throw new Error('synthetic audit failure');},logError:()=>{}});assert.equal(failed.status,503);assert.equal(failed.headers.get('cache-control'),'private, no-store');assert.equal(failed.headers.get('x-content-type-options'),'nosniff');assert.notDeepEqual(new Uint8Array(await failed.arrayBuffer()),second);
 assert.deepEqual(await business(),before);
 const ref={kind:'property' as const,id:f.p};const view=await archiveView(staff,ref);assert.equal(view.state,'ready');if(view.state!=='ready')throw new Error('Archive view unavailable');
 const action={ref,desired:'archived' as const,expectedVersion:view.observed.version,renderedScope:archiveScope(staff),reason:'Ended operations',requestId:randomUUID()};assert.equal((await archiveCommand(staff,action)).state,'changed');
 detail=await ready(actor.s,f.lease);assert.equal(detail.lease.archive.property,true);assert.deepEqual(Uint8Array.from((await read(actor.s,f.lease,current.id))!.content),second);assert.equal(actor.s.leaseId,null);
 const archived=await archiveView(staff,ref);assert.equal(archived.state,'ready');if(archived.state!=='ready')throw new Error('Archive view unavailable');assert.equal((await archiveCommand(staff,{...action,desired:'active',expectedVersion:archived.observed.version,requestId:randomUUID()})).state,'changed');
 detail=await ready(actor.s,f.lease);assert.equal(detail.lease.archive.property,false);assert.deepEqual(Uint8Array.from((await read(actor.s,f.lease,current.id))!.content),second);
 for(const [kind,id] of [['unit',f.u],['room',f.room]] as const){const child={kind,id};const v=await archiveView(staff,child);assert.equal(v.state,'ready');if(v.state!=='ready')throw new Error('Child unavailable');assert.equal((await archiveCommand(staff,{...action,ref:child,expectedVersion:v.observed.version,requestId:randomUUID()})).state,'changed');const d=await ready(actor.s,f.lease);assert.equal(d.lease.archive[kind],true);assert.deepEqual(Uint8Array.from((await read(actor.s,f.lease,current.id))!.content),second);const archivedChild=await archiveView(staff,child);assert.equal(archivedChild.state,'ready');if(archivedChild.state!=='ready')throw new Error('Child unavailable');assert.equal((await archiveCommand(staff,{...action,ref:child,desired:'active',expectedVersion:archivedChild.observed.version,requestId:randomUUID()})).state,'changed');}
 await query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',false,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='record_archive'`,[ORG_ID]);assert.equal((await ready(actor.s,f.lease)).pdfAvailability,'available');assert.deepEqual(Uint8Array.from((await read(actor.s,f.lease,current.id))!.content),second);
});

test('only current tenant party/session/context and exact ended-lease PDF pairs are authorized',async()=>{
 const a=await tenant(),b=await tenant(),staff=await admin(),f=await fixture(a.contact),g=await fixture(b.contact);await enable();await uploadSignedLeasePdf(staff,f.lease,{bytes:new TextEncoder().encode('%PDF-1.4 synthetic own'),fileName:'own.pdf'});await uploadSignedLeasePdf(staff,g.lease,{bytes:new TextEncoder().encode('%PDF-1.4 synthetic other'),fileName:'other.pdf'});
 const own=(await ready(a.s,f.lease)).pdfs[0].id,other=(await ready(b.s,g.lease)).pdfs[0].id;
 assert.equal(await read(a.s,f.lease,other),null);assert.equal(await read(a.s,g.lease,own),null);assert.equal((await tenantEndedLeaseDetail(a.s,g.lease)).state,'unavailable');
 const c=await tenant(ORG2_ID),outside=await fixture(c.contact,ORG2_ID),otherStaff=await admin(ORG2_ID,USERS.coastAdmin);await uploadSignedLeasePdf(otherStaff,outside.lease,{bytes:new TextEncoder().encode('%PDF-1.4 foreign'),fileName:'foreign.pdf'});const foreignPdf=(await query<{id:string}>(`SELECT id::text FROM lease_signed_pdfs WHERE lease_id=$1`,[outside.lease])).rows[0].id;assert.equal(await read(a.s,f.lease,foreignPdf),null);assert.equal((await tenantEndedLeaseDetail(a.s,outside.lease)).state,'unavailable');
 const list=await tenantEndedLeaseList(a.s);assert.equal(list.state,'ready');if(list.state!=='ready')throw new Error('List unavailable');assert.ok(list.items.some(x=>x.leaseId===f.lease));assert.ok(!list.items.some(x=>x.leaseId===g.lease||x.leaseId===outside.lease));
 assert.equal((await tenantEndedLeaseDetail({...a.s,orgId:ORG2_ID,liveOrgId:ORG2_ID},f.lease)).state,'unavailable');assert.equal((await tenantEndedLeaseDetail({...a.s,environment:'sandbox'},f.lease)).state,'unavailable');
 assert.equal((await tenantEndedLeaseDetail({...a.s,liveOrgId:ORG2_ID},f.lease)).state,'unavailable');
 assert.equal((await tenantEndedLeaseDetail({...a.s,kind:'staff',role:'admin'},f.lease)).state,'unavailable');assert.equal((await tenantEndedLeaseDetail({...a.s,kind:'owner'},f.lease)).state,'unavailable');assert.equal((await tenantEndedLeaseDetail({...a.s,consent:null},f.lease)).state,'unavailable');assert.equal(await read(a.s,'bad',own),null);assert.equal(await read(a.s,f.lease,'bad'),null);
 const membership=(await query<{id:string}>(`INSERT INTO org_members(org_id,user_id,role,status) VALUES($1,$2,'maintenance','active') RETURNING id::text`,[ORG_ID,a.s.userId])).rows[0].id;assert.equal((await tenantEndedLeaseDetail(a.s,f.lease)).state,'unavailable');await query(`DELETE FROM org_members WHERE id=$1`,[membership]);
 const foreignMembership=(await query<{id:string}>(`INSERT INTO org_members(org_id,user_id,role,status) VALUES($1,$2,'maintenance','active') RETURNING id::text`,[ORG2_ID,a.s.userId])).rows[0].id;
 const visibility=await tx(a.s.userId,async c=>({member:(await c.query(`SELECT id FROM org_members WHERE id=$1`,[foreignMembership])).rowCount,org:(await c.query(`SELECT id FROM organizations WHERE id=$1`,[ORG2_ID])).rowCount}),{orgId:ORG_ID,environment:'live'},{readOnly:true});
 assert.equal(visibility.member,1);assert.equal(visibility.org,0);assert.equal((await tenantEndedLeaseList(a.s)).state,'unavailable');assert.equal((await tenantEndedLeaseDetail(a.s,f.lease)).state,'unavailable');assert.equal(await read(a.s,f.lease,own),null);await query(`DELETE FROM org_members WHERE id=$1`,[foreignMembership]);
 await query(`UPDATE contacts SET is_owner=true WHERE id=$1`,[a.contact]);assert.ok(await read(a.s,f.lease,own));assert.equal(await read({...a.s,kind:'owner'},f.lease,own),null);await query(`UPDATE contacts SET is_owner=false WHERE id=$1`,[a.contact]);
 await query(`UPDATE lease_parties SET role='co_tenant' WHERE lease_id=$1 AND contact_id=$2`,[f.lease,a.contact]);assert.ok(await read(a.s,f.lease,own));await query(`UPDATE lease_parties SET role='primary' WHERE lease_id=$1 AND contact_id=$2`,[f.lease,a.contact]);
 const replacement=randomUUID();await query(`INSERT INTO auth.users(id,email,role,aud) VALUES($1,$2,'authenticated','authenticated')`,[replacement,`${randomUUID()}@example.test`]);await query(`UPDATE contacts SET user_id=$2 WHERE id=$1`,[a.contact,replacement]);assert.equal(await read(a.s,f.lease,own),null);await query(`UPDATE contacts SET user_id=$2 WHERE id=$1`,[a.contact,a.s.userId]);
 await query(`UPDATE contacts SET archived_at=now() WHERE id=$1`,[a.contact]);assert.equal((await tenantEndedLeaseList(a.s)).state,'unavailable');assert.equal(await read(a.s,f.lease,own),null);await query(`UPDATE contacts SET archived_at=NULL,is_tenant=false WHERE id=$1`,[a.contact]);assert.equal(await read(a.s,f.lease,own),null);await query(`UPDATE contacts SET is_tenant=true WHERE id=$1`,[a.contact]);
 await query(`DELETE FROM lease_parties WHERE lease_id=$1 AND contact_id=$2`,[f.lease,a.contact]);assert.equal(await read(a.s,f.lease,own),null);await query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')`,[ORG_ID,f.lease,a.contact]);
 await query(`UPDATE auth_sessions SET revoked_at=now() WHERE id=$1`,[a.s.sessionId]);assert.equal(await read(a.s,f.lease,own),null);await query(`UPDATE auth_sessions SET revoked_at=NULL,expires_at=now()-interval '1 second' WHERE id=$1`,[a.s.sessionId]);assert.equal(await read(a.s,f.lease,own),null);await query(`UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE id=$1`,[a.s.sessionId]);
 for(const status of ['draft','active']){await query(`UPDATE leases SET status=$2::lease_status WHERE id=$1`,[f.lease,status]);assert.equal((await tenantEndedLeaseDetail(a.s,f.lease)).state,'unavailable');assert.equal(await read(a.s,f.lease,own),null);}await query(`UPDATE leases SET status='ended' WHERE id=$1`,[f.lease]);
 let audits=0;const deniedId=randomUUID();const denied=await tenantSignedPdfDownload({orgId:ORG_ID,userId:a.s.userId,leaseId:f.lease,pdfId:other,requestId:deniedId},{read:()=>read(a.s,f.lease,other),audit:async event=>{audits++;await writeSignedPdfDownload(event);},logError:()=>{}});assert.equal(denied.status,404);assert.equal(denied.headers.get('cache-control'),'private, no-store');assert.equal(denied.headers.get('x-content-type-options'),'nosniff');assert.equal(audits,0);assert.equal((await query(`SELECT id FROM audit_log WHERE request_id=$1`,[deniedId])).rowCount,0);
});

test('PDF gates fail closed without hiding lease history or exposing a document count',async()=>{
 const a=await tenant(),staff=await admin(),f=await fixture(a.contact);await enable();await uploadSignedLeasePdf(staff,f.lease,{bytes:new TextEncoder().encode('%PDF-1.4 synthetic gate'),fileName:'gate.pdf'});const id=(await ready(a.s,f.lease)).pdfs[0].id;
 for(const value of [false,'true',{enabled:true},null]){await query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='tenant_signed_pdf'`,[JSON.stringify(value)]);const d=await ready(a.s,f.lease);assert.equal(d.pdfAvailability,'unavailable');assert.deepEqual(d.pdfs,[]);assert.equal(await read(a.s,f.lease,id),null);}
 await query(`DELETE FROM platform_settings WHERE key='tenant_signed_pdf'`);assert.equal((await ready(a.s,f.lease)).pdfAvailability,'unavailable');assert.equal(await read(a.s,f.lease,id),null);await query(`INSERT INTO platform_settings(key,value) VALUES('tenant_signed_pdf','true'::jsonb)`);
 for(const value of [false,'true',null]){await query(`UPDATE organizations SET feature_flags=jsonb_set(feature_flags,'{tenant_signed_pdf}',$2::jsonb,true) WHERE id=$1`,[ORG_ID,JSON.stringify(value)]);const d=await ready(a.s,f.lease);assert.equal(d.pdfAvailability,'unavailable');assert.deepEqual(d.pdfs,[]);assert.equal(await read(a.s,f.lease,id),null);}
 await query(`UPDATE organizations SET feature_flags=feature_flags-'tenant_signed_pdf' WHERE id=$1`,[ORG_ID]);assert.equal((await ready(a.s,f.lease)).pdfAvailability,'unavailable');
});

test('paper metadata preserves source versions and falls back to the newest if no current pointer exists',async()=>{
 const a=await tenant(),staff=await admin(),f=await fixture(a.contact);await enable();
 await uploadSignedLeasePdf(staff,f.lease,{bytes:new TextEncoder().encode('%PDF-1.4 old synthetic'),fileName:'old.pdf',replaceReason:'Synthetic'});await uploadSignedLeasePdf(staff,f.lease,{bytes:new TextEncoder().encode('%PDF-1.4 new synthetic'),fileName:'new.pdf',replaceReason:'Synthetic'});
 const ids=await query<{id:string}>(`SELECT id::text FROM lease_signed_pdfs WHERE org_id=$1 AND lease_id=$2 ORDER BY created_at DESC,id DESC`,[ORG_ID,f.lease]);assert.equal(ids.rowCount,2);await query(`UPDATE leases SET document_file_id=NULL WHERE org_id=$1 AND id=$2`,[ORG_ID,f.lease]);
 const d=await ready(a.s,f.lease);assert.equal(d.pdfAvailability,'available');assert.deepEqual(new Set(d.pdfs.map(p=>p.id)),new Set(ids.rows.map(p=>p.id)));assert.equal(d.pdfs.filter(p=>p.current).length,1);assert.equal(d.pdfs.find(p=>p.current)?.id,ids.rows[0].id);for(const pdf of d.pdfs)assert.match(pdf.uploadedAt,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
});

test('a purged synthetic paper version is not a successful byte read',async()=>{
 const a=await tenant(),staff=await admin(),f=await fixture(a.contact);await enable();await uploadSignedLeasePdf(staff,f.lease,{bytes:new TextEncoder().encode('%PDF-1.4 synthetic purge'),fileName:'purge.pdf'});
 const file=(await query<{id:string;file_id:string}>(`SELECT id::text,file_id::text FROM lease_signed_pdfs WHERE org_id=$1 AND lease_id=$2`,[ORG_ID,f.lease])).rows[0];assert.ok(file);assert.ok(await read(a.s,f.lease,file.id));
 await query(`UPDATE leases SET document_file_id=NULL WHERE org_id=$1 AND id=$2`,[ORG_ID,f.lease]);await query(`DELETE FROM files WHERE org_id=$1 AND id=$2`,[ORG_ID,file.file_id]);
 assert.equal(await read(a.s,f.lease,file.id),null);const d=await ready(a.s,f.lease);assert.equal(d.pdfAvailability,'available');assert.deepEqual(d.pdfs,[]);
});

test('more than 50 ended leases paginate without duplicates while another active selection stays untouched',async()=>{
 const a=await tenant(),f=await fixture(a.contact);const ids=(await query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_room_id,status,esign_status,start_date,end_date,currency,rent_amount_minor) SELECT $1,$2,$3,$4,'ended','imported','2091-01-01','2091-12-31','TWD',0 FROM generate_series(1,55) RETURNING id::text`,[ORG_ID,f.p,f.u,f.room])).rows.map(r=>r.id);
 await query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) SELECT $1,x,$2,'primary' FROM unnest($3::uuid[]) AS t(x)`,[ORG_ID,a.contact,ids]);
 const unit=(await query<{id:string}>(`INSERT INTO units(org_id,property_id,label) VALUES($1,$2,'active') RETURNING id::text`,[ORG_ID,f.p])).rows[0].id;
 const active=(await query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor) VALUES($1,$2,$3,$3,'active','2098-01-01','TWD',0) RETURNING id::text`,[ORG_ID,f.p,unit])).rows[0].id;
 await query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')`,[ORG_ID,active,a.contact]);const selected:Session={...a.s,leaseId:active};
 const wanted=new Set([f.lease,...ids]),seen=new Set<string>();let cursor:string|undefined,pages=0;
 do{const result=await tenantEndedLeaseList(selected,cursor);assert.equal(result.state,'ready');if(result.state!=='ready')throw new Error('List unavailable');pages++;assert.ok(pages<10);for(const row of result.items){assert.equal(seen.has(row.leaseId),false);seen.add(row.leaseId);}cursor=result.nextCursor??undefined;}while(cursor!==undefined);
 assert.ok(pages>=2);for(const id of wanted)assert.ok(seen.has(id));assert.equal(seen.has(active),false);assert.equal(selected.leaseId,active);for(const bad of ['','bad','AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'])assert.equal((await tenantEndedLeaseList(selected,bad)).state,'unavailable');
});
