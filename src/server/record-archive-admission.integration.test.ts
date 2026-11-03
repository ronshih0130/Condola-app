import assert from 'node:assert/strict';
import { randomBytes,randomInt,randomUUID } from 'node:crypto';
import test from 'node:test';
import { query,tx,withClient } from './db';
import { createLease,createTicket,signLease,updateLease,updateTicket,uploadSignedLeasePdf } from './domain';
import { createExpense } from './expenses';
import { updateSpace } from './portfolio';
import { prepareUtilityRun } from './utility-posting';
import { commitImportBatch } from './import-batch';
import { addressKey } from './owner-import';
import { dispatchVendor } from './vendor-repair';
import { EsignFlow } from './esign/flow';
import { EsignRepo } from './esign/repo';
import { buildStoredConsent } from './consent';
import { PDFDocument } from 'pdf-lib';
import { FlowError } from './errors';
import { ORG_ID,ORG2_ID,USERS } from './ids';
import { admitActiveArchiveAncestry,admitFreshLeaseAncestry } from './record-archive-admission';
import { archiveCommand,archiveScope,archiveView } from './record-archive';
import { cloneTestDatabase } from './test-database-clone';
import { disposableDbUrl } from './test-disposable-db';
import { resetAndSeed } from './seed';
import type { Session } from './types';

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone:Awaited<ReturnType<typeof cloneTestDatabase>>;
test.before(async()=>{clone=await cloneTestDatabase();const names=['DEMO_MODE','ID_DOC_ENCRYPTION_KEY','ID_DOC_HMAC_KEY','ID_DOC_SIGNING_SECRET','CRON_SECRET'] as const;const saved=Object.fromEntries(names.map(k=>[k,process.env[k]]));try{process.env.DEMO_MODE='true';for(const k of names.slice(1))process.env[k]=randomBytes(32).toString('hex');await resetAndSeed();}finally{for(const k of names){const v=saved[k];if(v===undefined)delete process.env[k];else process.env[k]=v;}}});
test.after(async()=>{await clone?.cleanup();});
function bounded<T>(p:Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;return Promise.race([p,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Operation did not finish')),10000);})]).finally(()=>{if(timer)clearTimeout(timer);});}

test('manager utility creation denied after session revoked during archive lock wait',async()=>{
 const sid=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.manager,randomUUID()]);
 const s:Session={userId:USERS.manager,sessionId:sid,email:'',name:'manager',kind:'staff',role:'manager',orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,`B015 utility revoked ${randomUUID()}`])).rows[0].id;
 const u=(await query<{id:string}>(`INSERT INTO units(org_id,property_id,label) VALUES($1,$2,'one') RETURNING id::text`,[ORG_ID,p])).rows[0].id;
 const input={unitId:u,periodStart:'2099-01-01',periodEnd:'2099-02-01',rateMajor:5,totalKwh:1,readings:[],billTotalMajor:5,overrideReason:''};
 await withClient(async holder=>{let held=false;let pending:ReturnType<typeof prepareUtilityRun>|undefined;let primary:unknown;let failed=false;
  try{await holder.query('BEGIN');held=true;const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid;await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`condola:record-archive:${ORG_ID}:property:${p}`]);
   pending=prepareUtilityRun(s,input);pending.catch(()=>{});
   const waiter=await withClient(async observer=>{for(let n=0;n<100;n++){await observer.query('SELECT pg_catalog.pg_stat_clear_snapshot()');const r=await observer.query<{pid:number}>(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%pg_advisory_xact_lock_shared%'`,[pid]);if(r.rows.length===1)return r.rows[0].pid;if(r.rows.length>1)throw new Error('Ambiguous waiter');await new Promise(resolve=>setTimeout(resolve,30));}return 0;});assert.ok(waiter);
   await query(`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1`,[sid]);await holder.query('COMMIT');held=false;await assert.rejects(()=>bounded(pending!),error=>error instanceof FlowError&&error.key==='errors.notFound');
  }catch(error){failed=true;primary=error;}
  const cleanup:unknown[]=[];if(held)try{await holder.query('ROLLBACK');}catch(error){cleanup.push(error);}if(pending)try{await bounded(Promise.allSettled([pending]));}catch(error){cleanup.push(error);}
  if(failed&&cleanup.length)throw new AggregateError([primary,...cleanup],'Utility session race and cleanup failed');if(failed)throw primary;if(cleanup.length)throw new AggregateError(cleanup,'Cleanup failed');
 });
 assert.equal((await query(`SELECT id FROM utility_allocation_runs WHERE org_id=$1 AND unit_id=$2`,[ORG_ID,u])).rowCount,0);
});

test('tenant ticket creation denied after session revoked during archive lock wait',async()=>{
 const sid=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.tenant,randomUUID()]);
 const s:Session={userId:USERS.tenant,sessionId:sid,email:'',name:'tenant',kind:'tenant',role:null,orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,`B015 tenant revoked ${randomUUID()}`])).rows[0].id;
 const u=(await query<{id:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES($1,$2,'one','whole_unit') RETURNING id::text`,[ORG_ID,p])).rows[0].id;
 const lease=(await query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,end_date,currency,rent_amount_minor) VALUES($1,$2,$3,$3,'active','2098-01-01','2098-12-31','TWD',0) RETURNING id::text`,[ORG_ID,p,u])).rows[0].id;
 const contact=(await query<{id:string}>(`SELECT id::text FROM contacts WHERE org_id=$1 AND user_id=$2 AND is_tenant AND archived_at IS NULL`,[ORG_ID,USERS.tenant])).rows[0];assert.ok(contact);await query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')`,[ORG_ID,lease,contact.id]);
 await withClient(async holder=>{let held=false;let pending:ReturnType<typeof createTicket>|undefined;let primary:unknown;let failed=false;
  try{await holder.query('BEGIN');held=true;const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid;await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`condola:record-archive:${ORG_ID}:property:${p}`]);
   pending=createTicket(s,{leaseId:lease,category:'other',title:'Synthetic',description:'Synthetic'});pending.catch(()=>{});
   const waiter=await withClient(async observer=>{for(let n=0;n<100;n++){await observer.query('SELECT pg_catalog.pg_stat_clear_snapshot()');const r=await observer.query<{pid:number}>(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%pg_advisory_xact_lock_shared%'`,[pid]);if(r.rows.length===1)return r.rows[0].pid;if(r.rows.length>1)throw new Error('Ambiguous waiter');await new Promise(resolve=>setTimeout(resolve,30));}return 0;});assert.ok(waiter);
   await query(`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1`,[sid]);await holder.query('COMMIT');held=false;await assert.rejects(()=>bounded(pending!),error=>error instanceof FlowError&&error.key==='errors.notFound');
  }catch(error){failed=true;primary=error;}
  const cleanup:unknown[]=[];if(held)try{await holder.query('ROLLBACK');}catch(error){cleanup.push(error);}if(pending)try{await bounded(Promise.allSettled([pending]));}catch(error){cleanup.push(error);}
  if(failed&&cleanup.length)throw new AggregateError([primary,...cleanup],'Tenant session race and cleanup failed');if(failed)throw primary;if(cleanup.length)throw new AggregateError(cleanup,'Cleanup failed');
 });
 assert.equal((await query(`SELECT id FROM maintenance_tickets WHERE org_id=$1 AND lease_id=$2`,[ORG_ID,lease])).rowCount,0);
});

test('tenant ticket rollback leaves repair trial progress unchanged and a committed ticket marks it',async()=>{
 const sid=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.tenant,randomUUID()]);
 const s:Session={userId:USERS.tenant,sessionId:sid,email:'',name:'tenant',kind:'tenant',role:null,orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,`B015 ticket rollback ${randomUUID()}`])).rows[0].id;
 const u=(await query<{id:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES($1,$2,'one','whole_unit') RETURNING id::text`,[ORG_ID,p])).rows[0].id;
 const lease=(await query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,end_date,currency,rent_amount_minor) VALUES($1,$2,$3,$3,'active','2098-01-01','2098-12-31','TWD',0) RETURNING id::text`,[ORG_ID,p,u])).rows[0].id;
 const contact=(await query<{id:string}>(`SELECT id::text FROM contacts WHERE org_id=$1 AND user_id=$2 AND is_tenant AND archived_at IS NULL`,[ORG_ID,USERS.tenant])).rows[0];assert.ok(contact);await query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')`,[ORG_ID,lease,contact.id]);
 await query(`UPDATE organizations SET settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{tryout}',(CASE WHEN jsonb_typeof(settings->'tryout')='object' THEN settings->'tryout' ELSE '{}'::jsonb END)||'{"repair":false}'::jsonb,true) WHERE id=$1`,[ORG_ID]);
 const input={leaseId:lease,category:'other',title:'Synthetic trial rollback',description:'Synthetic'};
 await withClient(async holder=>{let held=false;let pending:ReturnType<typeof createTicket>|undefined;let primary:unknown;let failed=false;
  try{await holder.query('BEGIN');held=true;const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid;await holder.query('LOCK TABLE public.audit_log IN SHARE MODE');
   pending=createTicket(s,input);pending.catch(()=>{});
   const waiter=await withClient(async observer=>{for(let n=0;n<100;n++){await observer.query('SELECT pg_catalog.pg_stat_clear_snapshot()');const r=await observer.query<{pid:number}>(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%INSERT INTO maintenance_tickets%'`,[pid]);if(r.rows.length===1)return r.rows[0].pid;if(r.rows.length>1)throw new Error('Ambiguous waiter');await new Promise(resolve=>setTimeout(resolve,30));}return 0;});assert.ok(waiter,'ticket insert must wait at its audit write');
   await query(`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1`,[sid]);await holder.query('COMMIT');held=false;await assert.rejects(()=>bounded(pending!),error=>error instanceof FlowError&&error.key==='errors.notFound');
  }catch(error){failed=true;primary=error;}
  const cleanup:unknown[]=[];if(held)try{await holder.query('ROLLBACK');}catch(error){cleanup.push(error);}if(pending)try{await bounded(Promise.allSettled([pending]));}catch(error){cleanup.push(error);}
  if(failed&&cleanup.length)throw new AggregateError([primary,...cleanup],'Ticket trial rollback and cleanup failed');if(failed)throw primary;if(cleanup.length)throw new AggregateError(cleanup,'Cleanup failed');
 });
 assert.equal((await query(`SELECT id FROM maintenance_tickets WHERE org_id=$1 AND lease_id=$2`,[ORG_ID,lease])).rowCount,0);
 assert.equal((await query<{progress:boolean}>(`SELECT (settings->'tryout'->>'repair')::boolean AS progress FROM organizations WHERE id=$1`,[ORG_ID])).rows[0].progress,false);
 const nextId=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[nextId,USERS.tenant,randomUUID()]);
 const ticket=await createTicket({...s,sessionId:nextId},{...input,title:'Synthetic trial success'});
 assert.equal((await query(`SELECT id FROM maintenance_tickets WHERE id=$1 AND org_id=$2 AND lease_id=$3`,[ticket,ORG_ID,lease])).rowCount,1);
 assert.equal((await query<{progress:boolean}>(`SELECT (settings->'tryout'->>'repair')::boolean AS progress FROM organizations WHERE id=$1`,[ORG_ID])).rows[0].progress,true);
});

test('a newly active other-firm staff membership invalidates the waiting tenant persona',async()=>{
 const user=randomUUID(),sid=randomUUID();await query(`INSERT INTO auth.users(id,email,role,aud) VALUES($1,$2,'authenticated','authenticated')`,[user,`${randomUUID()}@example.test`]);await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,user,randomUUID()]);
 const s:Session={userId:user,sessionId:sid,email:'',name:'tenant',kind:'tenant',role:null,orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,`B015 persona ${randomUUID()}`])).rows[0].id;
 const u=(await query<{id:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES($1,$2,'one','whole_unit') RETURNING id::text`,[ORG_ID,p])).rows[0].id;
 const lease=(await query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,end_date,currency,rent_amount_minor) VALUES($1,$2,$3,$3,'active','2098-01-01','2098-12-31','TWD',0) RETURNING id::text`,[ORG_ID,p,u])).rows[0].id;
 const contact=(await query<{id:string}>(`INSERT INTO contacts(org_id,user_id,is_tenant,display_name) VALUES($1,$2,true,'Synthetic') RETURNING id::text`,[ORG_ID,user])).rows[0].id;await query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')`,[ORG_ID,lease,contact]);
 const signature=(await query<{id:string}>(`INSERT INTO lease_signatures(org_id,lease_id,signer_role,contact_id) VALUES($1,$2,'tenant',$3) RETURNING id::text`,[ORG_ID,lease,contact])).rows[0].id;
 const progress=(await query<{value:unknown}>(`SELECT settings->'tryout'->'repair' AS value FROM organizations WHERE id=$1`,[ORG_ID])).rows[0].value;
 await withClient(async holder=>{let held=false;let pending:ReturnType<typeof createTicket>|undefined;let signing:ReturnType<typeof signLease>|undefined;let primary:unknown;let failed=false;
  try{await holder.query('BEGIN');held=true;const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid;await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`condola:record-archive:${ORG_ID}:property:${p}`]);
   pending=createTicket(s,{leaseId:lease,category:'other',title:'Synthetic persona',description:'Synthetic'});pending.catch(()=>{});
   const waiter=await withClient(async observer=>{for(let n=0;n<100;n++){await observer.query('SELECT pg_catalog.pg_stat_clear_snapshot()');const r=await observer.query<{pid:number}>(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%pg_advisory_xact_lock_shared%'`,[pid]);if(r.rows.length===1)return r.rows[0].pid;if(r.rows.length>1)throw new Error('Ambiguous waiter');await new Promise(resolve=>setTimeout(resolve,30));}return 0;});assert.ok(waiter);
   signing=signLease(s,{leaseId:lease,signedName:'Synthetic',consent:true});signing.catch(()=>{});
   const signingWaiter=await withClient(async observer=>{for(let n=0;n<100;n++){await observer.query('SELECT pg_catalog.pg_stat_clear_snapshot()');const r=await observer.query<{pid:number}>(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%pg_advisory_xact_lock_shared%' AND pid<>$2`,[pid,waiter]);if(r.rows.length===1)return r.rows[0].pid;if(r.rows.length>1)throw new Error('Ambiguous signing waiter');await new Promise(resolve=>setTimeout(resolve,30));}return 0;});assert.ok(signingWaiter);
   const member=(await query<{id:string}>(`INSERT INTO org_members(org_id,user_id,role,status) VALUES($1,$2,'maintenance','active') RETURNING id::text`,[ORG2_ID,user])).rows[0].id;
   const visible=await tx(user,async c=>({member:(await c.query(`SELECT id FROM org_members WHERE id=$1`,[member])).rowCount,org:(await c.query(`SELECT id FROM organizations WHERE id=$1`,[ORG2_ID])).rowCount}),{orgId:ORG_ID,environment:'live'},{readOnly:true});assert.equal(visible.member,1);assert.equal(visible.org,0);
   await holder.query('COMMIT');held=false;await assert.rejects(()=>bounded(pending!),error=>error instanceof FlowError&&error.key==='errors.notFound');await assert.rejects(()=>bounded(signing!),error=>error instanceof FlowError&&error.key==='errors.notFound');
  }catch(error){failed=true;primary=error;}
  const cleanup:unknown[]=[];if(held)try{await holder.query('ROLLBACK');}catch(error){cleanup.push(error);}try{await bounded(Promise.allSettled([...(pending?[pending]:[]),...(signing?[signing]:[])]));}catch(error){cleanup.push(error);}if(failed&&cleanup.length)throw new AggregateError([primary,...cleanup],'Persona race and cleanup failed');if(failed)throw primary;if(cleanup.length)throw new AggregateError(cleanup,'Cleanup failed');
 });
 assert.equal((await query(`SELECT id FROM maintenance_tickets WHERE org_id=$1 AND lease_id=$2`,[ORG_ID,lease])).rowCount,0);
 assert.equal((await query(`SELECT id FROM audit_log WHERE table_name='maintenance_tickets' AND new_row->>'lease_id'=$1`,[lease])).rowCount,0);
 assert.equal((await query<{status:string}>(`SELECT status::text FROM lease_signatures WHERE id=$1`,[signature])).rows[0].status,'pending');assert.equal((await query(`SELECT id FROM lease_signature_events WHERE signature_id=$1`,[signature])).rowCount,0);assert.equal((await query(`SELECT id FROM audit_log WHERE table_name='lease_signatures' AND row_id=$1 AND action='update'`,[signature])).rowCount,0);
 assert.deepEqual((await query<{value:unknown}>(`SELECT settings->'tryout'->'repair' AS value FROM organizations WHERE id=$1`,[ORG_ID])).rows[0].value,progress);
});

test('maintenance ticket reopening denied after session revoked during archive lock wait',async()=>{
 const sid=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.maintenance,randomUUID()]);
 const s:Session={userId:USERS.maintenance,sessionId:sid,email:'',name:'maintenance',kind:'staff',role:'maintenance',orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,`B015 maintenance revoked ${randomUUID()}`])).rows[0].id;
 const member=(await query<{id:string}>(`SELECT id::text FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='active'`,[ORG_ID,USERS.maintenance])).rows[0];assert.ok(member);
 const ticket=(await query<{id:string}>(`INSERT INTO maintenance_tickets(org_id,ticket_number,property_id,category,priority,status,title,assigned_member_id) VALUES($1,900006,$2,'other','normal','resolved','Synthetic',$3) RETURNING id::text`,[ORG_ID,p,member.id])).rows[0].id;
 await withClient(async holder=>{let held=false;let pending:ReturnType<typeof updateTicket>|undefined;let primary:unknown;let failed=false;
  try{await holder.query('BEGIN');held=true;const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid;await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`condola:record-archive:${ORG_ID}:property:${p}`]);
   pending=updateTicket(s,ticket,{status:'open'});pending.catch(()=>{});
   const waiter=await withClient(async observer=>{for(let n=0;n<100;n++){await observer.query('SELECT pg_catalog.pg_stat_clear_snapshot()');const r=await observer.query<{pid:number}>(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%pg_advisory_xact_lock_shared%'`,[pid]);if(r.rows.length===1)return r.rows[0].pid;if(r.rows.length>1)throw new Error('Ambiguous waiter');await new Promise(resolve=>setTimeout(resolve,30));}return 0;});assert.ok(waiter);
   await query(`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1`,[sid]);await holder.query('COMMIT');held=false;await assert.rejects(()=>bounded(pending!),error=>error instanceof FlowError&&error.key==='errors.notFound');
  }catch(error){failed=true;primary=error;}
  const cleanup:unknown[]=[];if(held)try{await holder.query('ROLLBACK');}catch(error){cleanup.push(error);}if(pending)try{await bounded(Promise.allSettled([pending]));}catch(error){cleanup.push(error);}
  if(failed&&cleanup.length)throw new AggregateError([primary,...cleanup],'Maintenance session race and cleanup failed');if(failed)throw primary;if(cleanup.length)throw new AggregateError(cleanup,'Cleanup failed');
 });
 assert.equal((await query<{status:string}>(`SELECT status::text FROM maintenance_tickets WHERE id=$1`,[ticket])).rows[0].status,'resolved');
});

test('archived draft lease rejects direct rent and deposit edits without changing either amount',async()=>{
 const sid=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
 const s:Session={userId:USERS.admin,sessionId:sid,email:'',name:'admin',kind:'staff',role:'admin',orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,`B015 draft ${randomUUID()}`])).rows[0].id;
 const u=(await query<{id:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES($1,$2,'one','whole_unit') RETURNING id::text`,[ORG_ID,p])).rows[0].id;
 const lease=(await query<{id:string;updated_at:string;rent:string;deposit:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,end_date,currency,rent_amount_minor,deposit_amount_minor) VALUES($1,$2,$3,$3,'draft','2098-01-01','2098-12-31','TWD',100000,200000) RETURNING id::text,updated_at::text,rent_amount_minor::text AS rent,deposit_amount_minor::text AS deposit`,[ORG_ID,p,u])).rows[0];
 await query(`UPDATE properties SET archived_at=clock_timestamp() WHERE id=$1`,[p]);
 await assert.rejects(updateLease(s,{leaseId:lease.id,rentMajor:1500,depositMonths:1,depositReason:'',updatedAt:lease.updated_at}),(error:unknown)=>error instanceof FlowError&&error.key==='errors.notFound');
 const after=(await query<{rent:string;deposit:string}>(`SELECT rent_amount_minor::text AS rent,deposit_amount_minor::text AS deposit FROM leases WHERE id=$1`,[lease.id])).rows[0];
 assert.equal(after.rent,lease.rent);assert.equal(after.deposit,lease.deposit);
});

test('an admitted new ticket completes first and the waiting archive observes it',async()=>{
 const sid=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
 const s:Session={userId:USERS.admin,sessionId:sid,email:'',name:'admin',kind:'staff',role:'admin',orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};
 await query(`INSERT INTO platform_settings(key,value) VALUES('record_archive',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text))) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,[ORG_ID]);
 await query(`UPDATE organizations SET feature_flags=jsonb_set(coalesce(feature_flags,'{}'::jsonb),'{record_archive}','true'::jsonb,true) WHERE id=$1`,[ORG_ID]);
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,`B015 race ${randomUUID()}`])).rows[0].id;
 const ref={kind:'property' as const,id:p};const view=await archiveView(s,ref);assert.equal(view.state,'ready');if(view.state!=='ready')throw new Error('View unavailable');
 await withClient(async holder=>{let held=false;let pending:ReturnType<typeof archiveCommand>|undefined;let primary:unknown;let failed=false;
  try{await holder.query('BEGIN');held=true;await holder.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`,[s.userId,s.orgId]);await holder.query('SET LOCAL ROLE authenticated');
   await admitActiveArchiveAncestry(holder,s.orgId,ref);
   const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid;
   pending=archiveCommand(s,{ref,desired:'archived',expectedVersion:view.observed.version,renderedScope:archiveScope(s),reason:'retire',requestId:randomUUID()});pending.catch(()=>{});
   const waiter=await withClient(async observer=>{for(let n=0;n<100;n++){await observer.query('SELECT pg_catalog.pg_stat_clear_snapshot()');const rows=await observer.query<{pid:number}>(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%pg_advisory_xact_lock%'`,[pid]);if(rows.rows.length===1)return rows.rows[0].pid;if(rows.rows.length>1)throw new Error('Ambiguous waiter');await new Promise(resolve=>setTimeout(resolve,30));}return 0;});assert.ok(waiter,'archive must wait for the admitted transaction');
   await holder.query(`INSERT INTO maintenance_tickets(org_id,ticket_number,property_id,category,priority,status,title) VALUES($1,900001,$2,'other','normal','open','B015 race')`,[ORG_ID,p]);
   await holder.query('COMMIT');held=false;assert.equal((await bounded(pending)).state,'blocked');
  }catch(error){failed=true;primary=error;}
  const cleanup:unknown[]=[];if(held)try{await holder.query('ROLLBACK');}catch(error){cleanup.push(error);}if(pending)try{await bounded(Promise.allSettled([pending]));}catch(error){cleanup.push(error);}
  if(failed&&cleanup.length)throw new AggregateError([primary,...cleanup],'Race and cleanup failed');if(failed)throw primary;if(cleanup.length)throw new AggregateError(cleanup,'Cleanup failed');
 });
 const current=await query<{archived:boolean}>(`SELECT archived_at IS NOT NULL archived FROM properties WHERE id=$1`,[p]);assert.equal(current.rows[0].archived,false);
 await tx(s.userId,c=>admitActiveArchiveAncestry(c,s.orgId,ref),{orgId:s.orgId,environment:s.environment});
});

test('archive-first blocks the real lease writer, then rejects the archived target without creating a lease',async()=>{
 const sid=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
 const s:Session={userId:USERS.admin,sessionId:sid,email:'',name:'admin',kind:'staff',role:'admin',orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,`B015 archive-first ${randomUUID()}`])).rows[0].id;
 const u=(await query<{id:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode,base_rent_minor) VALUES($1,$2,'one','whole_unit',1000000) RETURNING id::text`,[ORG_ID,p])).rows[0].id;
 const snapshot=async()=> (await query(`SELECT (SELECT count(*)::int FROM leases WHERE property_id=$1) leases,(SELECT count(*)::int FROM lease_signatures s JOIN leases l ON l.id=s.lease_id WHERE l.property_id=$1) signatures,(SELECT count(*)::int FROM invoices WHERE property_id=$1) invoices,(SELECT count(*)::int FROM contacts WHERE org_id=$2) contacts,(SELECT count(*)::int FROM auth.users) users`,[p,ORG_ID])).rows[0];
 const before=await snapshot();
 const key=randomUUID();const input={roomId:u,tenantName:`B015 ${key}`,tenantPhone:'0912345678',tenantEmail:'',lineUserId:'',startDate:'2094-01-01',endDate:'2094-12-31',rentMajor:10000,depositMonths:2,depositReason:'',dueDay:5,splitMethod:'even' as const,periodStart:'2094-01-01',periodEnd:'2094-01-31',billTotalMajor:null,usageKwh:null,rateMajor:null,rateSource:'bill_average' as const,overrideReason:'',subUsages:[],idempotencyKey:key};
 await withClient(async holder=>{let held=false;let pending:ReturnType<typeof createLease>|undefined;let failure:unknown;let failed=false;
  try{await holder.query('BEGIN');held=true;const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid;
   await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`condola:record-archive:${ORG_ID}:property:${p}`]);
   await holder.query(`UPDATE properties SET archived_at=clock_timestamp() WHERE id=$1`,[p]);
   pending=createLease(s,input);pending.catch(()=>{});
   const waiter=await withClient(async observer=>{for(let n=0;n<100;n++){await observer.query('SELECT pg_catalog.pg_stat_clear_snapshot()');const r=await observer.query<{pid:number}>(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%pg_advisory_xact_lock_shared%'`,[pid]);if(r.rows.length===1)return r.rows[0].pid;if(r.rows.length>1)throw new Error('Ambiguous waiter');await new Promise(resolve=>setTimeout(resolve,30));}return 0;});assert.ok(waiter,'lease must wait on the owning archive transaction');
   await holder.query('COMMIT');held=false;await assert.rejects(()=>bounded(pending!),error=>error instanceof FlowError && error.key==='errors.notFound');
  }catch(error){failed=true;failure=error;}
  const cleanup:unknown[]=[];if(held)try{await holder.query('ROLLBACK');}catch(error){cleanup.push(error);}if(pending)try{await bounded(Promise.allSettled([pending]));}catch(error){cleanup.push(error);}
  if(failed&&cleanup.length)throw new AggregateError([failure,...cleanup],'Race and cleanup failed');if(failed)throw failure;if(cleanup.length)throw new AggregateError(cleanup,'Cleanup failed');
 });
 assert.deepEqual(await snapshot(),before);
});

test('fresh lease admission canonicalizes nonstandard UUID text without allowing an ineligible colliding room to shadow a whole unit',async()=>{
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,`B015 collision ${randomUUID()}`])).rows[0].id;
 const units=await query<{id:string;label:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES($1,$2,'whole','whole_unit'),($1,$2,'rooms','by_room') RETURNING id::text,label`,[ORG_ID,p]);
 const whole=units.rows.find(x=>x.label==='whole')!.id;const rooms=units.rows.find(x=>x.label==='rooms')!.id;
 await query(`INSERT INTO rooms(id,org_id,unit_id,label,archived_at) VALUES($1,$2,$3,'shadow',now())`,[whole,ORG_ID,rooms]);
 for(const input of [whole.replaceAll('-',''),`{${whole}}`]) {
  const found=await tx(USERS.admin,c=>admitFreshLeaseAncestry(c,ORG_ID,input),{orgId:ORG_ID,environment:'live'});
  assert.equal(found.kind,'unit');assert.equal(found.ancestry.unitId,whole);
 }
});

test('tenant and maintenance ticket work and accountant finance retain their existing roles',async()=>{
 const session=async(role:'tenant'|'maintenance'|'accountant'):Promise<Session>=>{const sid=randomUUID();const userId=USERS[role];await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,userId,randomUUID()]);return {userId,sessionId:sid,email:'',name:role,kind:role==='tenant'?'tenant':'staff',role:role==='tenant'?null:role,orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};};
 const tenant=await session('tenant'),maintenance=await session('maintenance'),accountant=await session('accountant');
 const payer=(await query<{id:string}>(`SELECT id::text FROM contacts WHERE org_id=$1 AND user_id=$2 AND is_tenant AND archived_at IS NULL`,[ORG_ID,tenant.userId])).rows[0];assert.ok(payer);
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,`B015 roles ${randomUUID()}`])).rows[0].id;
 const u=(await query<{id:string}>(`INSERT INTO units(org_id,property_id,label) VALUES($1,$2,'one') RETURNING id::text`,[ORG_ID,p])).rows[0].id;
 const lease=(await query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,end_date,currency,rent_amount_minor) VALUES($1,$2,$3,$3,'active','2098-01-01','2098-12-31','TWD',0) RETURNING id::text`,[ORG_ID,p,u])).rows[0].id;
 await query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')`,[ORG_ID,lease,payer.id]);
 const ticket=await createTicket(tenant,{leaseId:lease,category:'other',title:'B015 role check',description:'Synthetic'});
 await updateTicket(maintenance,ticket,{status:'triaged'});
 assert.equal((await query<{status:string}>(`SELECT status::text FROM maintenance_tickets WHERE id=$1`,[ticket])).rows[0].status,'triaged');
 const expense=await createExpense(accountant,{propertyId:p,unitId:u,category:'cleaning',amountCents:10000,incurredOn:'2099-06-15',description:'Synthetic'});
 assert.ok(expense.expenseId);
});

test('a session revoked while archive waits cannot change the target',async()=>{
 const sid=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
 const s:Session={userId:USERS.admin,sessionId:sid,email:'',name:'admin',kind:'staff',role:'admin',orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};
 await query(`INSERT INTO platform_settings(key,value) VALUES('record_archive',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text))) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,[ORG_ID]);
 await query(`UPDATE organizations SET feature_flags=jsonb_set(coalesce(feature_flags,'{}'::jsonb),'{record_archive}','true'::jsonb,true) WHERE id=$1`,[ORG_ID]);
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,`B015 revoked ${randomUUID()}`])).rows[0].id;
 const ref={kind:'property' as const,id:p};const view=await archiveView(s,ref);assert.equal(view.state,'ready');if(view.state!=='ready')throw new Error('View unavailable');
 await withClient(async holder=>{let held=false;let pending:ReturnType<typeof archiveCommand>|undefined;let failure:unknown;let failed=false;
  try{await holder.query('BEGIN');held=true;const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid;await holder.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))`,[`condola:record-archive:${ORG_ID}:property:${p}`]);
   pending=archiveCommand(s,{ref,desired:'archived',expectedVersion:view.observed.version,renderedScope:archiveScope(s),reason:'Retired',requestId:randomUUID()});pending.catch(()=>{});
   const waiter=await withClient(async observer=>{for(let n=0;n<100;n++){await observer.query('SELECT pg_catalog.pg_stat_clear_snapshot()');const r=await observer.query<{pid:number}>(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%pg_advisory_xact_lock%'`,[pid]);if(r.rows.length===1)return r.rows[0].pid;if(r.rows.length>1)throw new Error('Ambiguous waiter');await new Promise(resolve=>setTimeout(resolve,30));}return 0;});assert.ok(waiter);
   await query(`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1`,[sid]);await holder.query('COMMIT');held=false;assert.equal((await bounded(pending)).state,'forbidden');
  }catch(error){failed=true;failure=error;}
  const cleanup:unknown[]=[];if(held)try{await holder.query('ROLLBACK');}catch(error){cleanup.push(error);}if(pending)try{await bounded(Promise.allSettled([pending]));}catch(error){cleanup.push(error);}
  if(failed&&cleanup.length)throw new AggregateError([failure,...cleanup],'Revocation race and cleanup failed');if(failed)throw failure;if(cleanup.length)throw new AggregateError(cleanup,'Cleanup failed');
 });
 assert.equal((await query<{archived:boolean}>(`SELECT archived_at IS NOT NULL archived FROM properties WHERE id=$1`,[p])).rows[0].archived,false);
});

test('a real room move holding its property admission completes before a waiting property archive',async()=>{
 const sid=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
 const s:Session={userId:USERS.admin,sessionId:sid,email:'',name:'admin',kind:'staff',role:'admin',orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};
 await query(`INSERT INTO platform_settings(key,value) VALUES('record_archive',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text))) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,[ORG_ID]);
 await query(`UPDATE organizations SET feature_flags=jsonb_set(coalesce(feature_flags,'{}'::jsonb),'{record_archive}','true'::jsonb,true) WHERE id=$1`,[ORG_ID]);
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,`B015 move ${randomUUID()}`])).rows[0].id;
 const owner=(await query<{id:string}>(`INSERT INTO contacts(org_id,is_owner,display_name) VALUES($1,true,$2) RETURNING id::text`,[ORG_ID,`B015 owner ${randomUUID()}`])).rows[0].id;
 await query(`INSERT INTO property_owners(org_id,property_id,owner_contact_id) VALUES($1,$2,$3)`,[ORG_ID,p,owner]);
 const units=await query<{id:string;label:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES($1,$2,'A','by_room'),($1,$2,'B','by_room') RETURNING id::text,label`,[ORG_ID,p]);const a=units.rows.find(x=>x.label==='A')!.id,b=units.rows.find(x=>x.label==='B')!.id;
 const room=(await query<{id:string}>(`INSERT INTO rooms(org_id,unit_id,label) VALUES($1,$2,'R') RETURNING id::text`,[ORG_ID,a])).rows[0].id;
 const ref={kind:'property' as const,id:p};const v=await archiveView(s,ref);assert.equal(v.state,'ready');if(v.state!=='ready')throw new Error('View unavailable');
 const other=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,`B015 independent ${randomUUID()}`])).rows[0].id;
 const otherRef={kind:'property' as const,id:other};const otherView=await archiveView(s,otherRef);assert.equal(otherView.state,'ready');if(otherView.state!=='ready')throw new Error('Independent view unavailable');
 const input={propertyId:p,ownerContactId:owner,kind:'room',floor:'B',roomLabel:'R',roomType:'suite',area:null,rentMajor:100,electricityMethod:'shared',ratePerKwh:null,rateCapReason:'',taipowerKwh:null,taipowerAmountMajor:null,notes:''};
 await withClient(async holder=>{let held=false;const jobs:Promise<unknown>[]=[];let primary:unknown;let failed=false;
  const start=<T>(work:Promise<T>)=>{work.catch(()=>{});jobs.push(work);return work;};
  const wait=async(blocker:number,fragment:string)=>withClient(async observer=>{for(let n=0;n<100;n++){await observer.query('SELECT pg_catalog.pg_stat_clear_snapshot()');const q=await observer.query<{pid:number}>(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE $2`,[blocker,`%${fragment}%`]);if(q.rows.length===1)return q.rows[0].pid;if(q.rows.length>1)throw new Error('Ambiguous waiter');await new Promise(resolve=>setTimeout(resolve,30));}throw new Error('Expected waiter absent');});
  try{await holder.query('BEGIN');held=true;const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid;await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`condola:record-archive:${ORG_ID}:unit:${[a,b].sort()[0]}`]);
   const moving=start(updateSpace(s,'room',room,input));const movePid=await wait(pid,'pg_advisory_xact_lock_shared');
   const archiving=start(archiveCommand(s,{ref,desired:'archived',expectedVersion:v.observed.version,renderedScope:archiveScope(s),reason:'Retired',requestId:randomUUID()}));await wait(movePid,'pg_advisory_xact_lock');
   const independent=await bounded(archiveCommand(s,{ref:otherRef,desired:'archived',expectedVersion:otherView.observed.version,renderedScope:archiveScope(s),reason:'Independent',requestId:randomUUID()}));assert.equal(independent.state,'changed');
   await holder.query('COMMIT');held=false;await bounded(moving);assert.equal((await bounded(archiving)).state,'changed');
  }catch(error){failed=true;primary=error;}
  const cleanup:unknown[]=[];if(held)try{await holder.query('ROLLBACK');}catch(error){cleanup.push(error);}try{await bounded(Promise.allSettled(jobs));}catch(error){cleanup.push(error);}
  if(failed&&cleanup.length)throw new AggregateError([primary,...cleanup],'Move race and cleanup failed');if(failed)throw primary;if(cleanup.length)throw new AggregateError(cleanup,'Cleanup failed');
 });
 assert.equal((await query<{unit_id:string}>(`SELECT unit_id::text FROM rooms WHERE id=$1`,[room])).rows[0].unit_id,b);
});

test('an archive-first property blocks and rejects a real room move',async()=>{
 const sid=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
 const s:Session={userId:USERS.admin,sessionId:sid,email:'',name:'admin',kind:'staff',role:'admin',orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,`B015 archive move ${randomUUID()}`])).rows[0].id;
 const owner=(await query<{id:string}>(`INSERT INTO contacts(org_id,is_owner,display_name) VALUES($1,true,$2) RETURNING id::text`,[ORG_ID,`B015 owner ${randomUUID()}`])).rows[0].id;await query(`INSERT INTO property_owners(org_id,property_id,owner_contact_id) VALUES($1,$2,$3)`,[ORG_ID,p,owner]);
 const units=await query<{id:string;label:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES($1,$2,'A','by_room'),($1,$2,'B','by_room') RETURNING id::text,label`,[ORG_ID,p]);const a=units.rows.find(x=>x.label==='A')!.id;
 const room=(await query<{id:string}>(`INSERT INTO rooms(org_id,unit_id,label) VALUES($1,$2,'R') RETURNING id::text`,[ORG_ID,a])).rows[0].id;
 const input={propertyId:p,ownerContactId:owner,kind:'room',floor:'B',roomLabel:'R',roomType:'suite',area:null,rentMajor:100,electricityMethod:'shared',ratePerKwh:null,rateCapReason:'',taipowerKwh:null,taipowerAmountMajor:null,notes:''};
 await withClient(async holder=>{let held=false;let pending:ReturnType<typeof updateSpace>|undefined;let primary:unknown;let failed=false;
  try{await holder.query('BEGIN');held=true;const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid;await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`condola:record-archive:${ORG_ID}:property:${p}`]);await holder.query(`UPDATE properties SET archived_at=clock_timestamp() WHERE id=$1`,[p]);
   pending=updateSpace(s,'room',room,input);pending.catch(()=>{});
   const waiter=await withClient(async observer=>{for(let n=0;n<100;n++){await observer.query('SELECT pg_catalog.pg_stat_clear_snapshot()');const r=await observer.query<{pid:number}>(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%pg_advisory_xact_lock_shared%'`,[pid]);if(r.rows.length===1)return r.rows[0].pid;if(r.rows.length>1)throw new Error('Ambiguous waiter');await new Promise(resolve=>setTimeout(resolve,30));}return 0;});assert.ok(waiter);
   await holder.query('COMMIT');held=false;await assert.rejects(()=>bounded(pending!),error=>error instanceof FlowError && error.key==='errors.notFound');
  }catch(error){failed=true;primary=error;}
  const cleanup:unknown[]=[];if(held)try{await holder.query('ROLLBACK');}catch(error){cleanup.push(error);}if(pending)try{await bounded(Promise.allSettled([pending]));}catch(error){cleanup.push(error);}
  if(failed&&cleanup.length)throw new AggregateError([primary,...cleanup],'Archive-first move and cleanup failed');if(failed)throw primary;if(cleanup.length)throw new AggregateError(cleanup,'Cleanup failed');
 });
 assert.equal((await query<{unit_id:string}>(`SELECT unit_id::text FROM rooms WHERE id=$1`,[room])).rows[0].unit_id,a);
});

test('archive-first blocks and rejects new utility preparation',async()=>{
 const sid=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.manager,randomUUID()]);
 const s:Session={userId:USERS.manager,sessionId:sid,email:'',name:'manager',kind:'staff',role:'manager',orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,`B015 utility ${randomUUID()}`])).rows[0].id;
 const u=(await query<{id:string}>(`INSERT INTO units(org_id,property_id,label) VALUES($1,$2,'one') RETURNING id::text`,[ORG_ID,p])).rows[0].id;
 const input={unitId:u,periodStart:'2099-01-01',periodEnd:'2099-02-01',rateMajor:5,totalKwh:1,readings:[],billTotalMajor:5,overrideReason:''};
 await withClient(async holder=>{let held=false;let pending:ReturnType<typeof prepareUtilityRun>|undefined;let primary:unknown;let failed=false;
  try{await holder.query('BEGIN');held=true;const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid;await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`condola:record-archive:${ORG_ID}:property:${p}`]);await holder.query(`UPDATE properties SET archived_at=clock_timestamp() WHERE id=$1`,[p]);
   pending=prepareUtilityRun(s,input);pending.catch(()=>{});
   const waiter=await withClient(async observer=>{for(let n=0;n<100;n++){await observer.query('SELECT pg_catalog.pg_stat_clear_snapshot()');const r=await observer.query<{pid:number}>(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%pg_advisory_xact_lock_shared%'`,[pid]);if(r.rows.length===1)return r.rows[0].pid;if(r.rows.length>1)throw new Error('Ambiguous waiter');await new Promise(resolve=>setTimeout(resolve,30));}return 0;});assert.ok(waiter);
   await holder.query('COMMIT');held=false;await assert.rejects(()=>bounded(pending!),error=>error instanceof FlowError && error.key==='errors.notFound');
  }catch(error){failed=true;primary=error;}
  const cleanup:unknown[]=[];if(held)try{await holder.query('ROLLBACK');}catch(error){cleanup.push(error);}if(pending)try{await bounded(Promise.allSettled([pending]));}catch(error){cleanup.push(error);}
  if(failed&&cleanup.length)throw new AggregateError([primary,...cleanup],'Utility race and cleanup failed');if(failed)throw primary;if(cleanup.length)throw new AggregateError(cleanup,'Cleanup failed');
 });
 assert.equal((await query(`SELECT id FROM utility_allocation_runs WHERE org_id=$1 AND unit_id=$2`,[ORG_ID,u])).rowCount,0);
});

test('archive-first blocks a real import that reuses the property and prevents its new lease',async()=>{
 const sid=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
 const s:Session={userId:USERS.admin,sessionId:sid,email:'',name:'admin',kind:'staff',role:'admin',orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};
 const suffix=randomUUID(),name=`B015 import ${suffix}`,address=`台北市大安區測試路${suffix}號`,email=`owner.${suffix}@example.test`;
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,address_display,address_key,country_code,currency,timezone) VALUES($1,$2,$3,$4,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,name,address,addressKey(address)])).rows[0].id;
 const owner=(await query<{id:string}>(`INSERT INTO contacts(org_id,is_owner,display_name,email) VALUES($1,true,'B015 Owner',$2) RETURNING id::text`,[ORG_ID,email])).rows[0].id;
 await query(`INSERT INTO property_owners(org_id,property_id,owner_contact_id) VALUES($1,$2,$3)`,[ORG_ID,p,owner]);
 const row={line:2,propertyName:name,address,ownerName:'B015 Owner',ownerEmail:email,rentalMode:'整層',unitLabel:'A',roomLabel:'',roomType:'',area:'12',rent:'10000',tenantName:'B015 Tenant',tenantPhone:'0912000222',tenantEmail:'',startDate:'2098-01-01',endDate:'2098-12-31',deposit:'20000',dueDay:'5',electricity:'',rate:'',billKwh:'',billAmount:'',opening:'',depositReason:'',rateReason:'',notes:''};
 const snapshot=async()=> (await query(`SELECT (SELECT count(*)::int FROM leases WHERE property_id=$1) leases,(SELECT count(*)::int FROM units WHERE property_id=$1) units,(SELECT count(*)::int FROM contacts WHERE org_id=$2) contacts`,[p,ORG_ID])).rows[0];const before=await snapshot();
 await withClient(async holder=>{let held=false;let pending:ReturnType<typeof commitImportBatch>|undefined;let primary:unknown;let failed=false;
  try{await holder.query('BEGIN');held=true;const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid;await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`condola:record-archive:${ORG_ID}:property:${p}`]);await holder.query(`UPDATE properties SET archived_at=clock_timestamp() WHERE id=$1`,[p]);
   pending=commitImportBatch(s,{fileName:'b015-import.csv',rows:[row]});pending.catch(()=>{});
   const waiter=await withClient(async observer=>{for(let n=0;n<100;n++){await observer.query('SELECT pg_catalog.pg_stat_clear_snapshot()');const r=await observer.query<{pid:number}>(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%pg_advisory_xact_lock_shared%'`,[pid]);if(r.rows.length===1)return r.rows[0].pid;if(r.rows.length>1)throw new Error('Ambiguous waiter');await new Promise(resolve=>setTimeout(resolve,30));}return 0;});assert.ok(waiter);
   await holder.query('COMMIT');held=false;await assert.rejects(()=>bounded(pending!),error=>error instanceof FlowError && error.key==='errors.notFound');
  }catch(error){failed=true;primary=error;}
  const cleanup:unknown[]=[];if(held)try{await holder.query('ROLLBACK');}catch(error){cleanup.push(error);}if(pending)try{await bounded(Promise.allSettled([pending]));}catch(error){cleanup.push(error);}
  if(failed&&cleanup.length)throw new AggregateError([primary,...cleanup],'Import race and cleanup failed');if(failed)throw primary;if(cleanup.length)throw new AggregateError(cleanup,'Cleanup failed');
 });
 assert.deepEqual(await snapshot(),before);
});

test('archive-first blocks live tenant signing and paper activation before any file or signature write',async()=>{
 const adminId=randomUUID(),tenantId=randomUUID();for(const [id,user] of [[adminId,USERS.admin],[tenantId,USERS.tenant]])await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[id,user,randomUUID()]);
 const admin:Session={userId:USERS.admin,sessionId:adminId,email:'',name:'admin',kind:'staff',role:'admin',orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};
 const tenant:Session={...admin,userId:USERS.tenant,sessionId:tenantId,kind:'tenant',role:null};
 const payer=(await query<{id:string}>(`SELECT id::text FROM contacts WHERE org_id=$1 AND user_id=$2 AND is_tenant AND archived_at IS NULL`,[ORG_ID,tenant.userId])).rows[0];assert.ok(payer);
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,`B015 signing ${randomUUID()}`])).rows[0].id;
 const u=(await query<{id:string}>(`INSERT INTO units(org_id,property_id,label) VALUES($1,$2,'one') RETURNING id::text`,[ORG_ID,p])).rows[0].id;
 const lease=(await query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,end_date,currency,rent_amount_minor) VALUES($1,$2,$3,$3,'draft','2098-01-01','2098-12-31','TWD',0) RETURNING id::text`,[ORG_ID,p,u])).rows[0].id;
 await query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')`,[ORG_ID,lease,payer.id]);
 const snapshot=async()=> (await query(`SELECT (SELECT count(*)::int FROM lease_signatures WHERE lease_id=$1) signatures,(SELECT count(*)::int FROM lease_signed_pdfs WHERE lease_id=$1) pdfs,(SELECT count(*)::int FROM invoices WHERE lease_id=$1) invoices,(SELECT status::text FROM leases WHERE id=$1) status`,[lease])).rows[0];const before=await snapshot();
 await withClient(async holder=>{let held=false;const jobs:Promise<unknown>[]=[];let primary:unknown;let failed=false;const start=<T>(work:Promise<T>)=>{work.catch(()=>{});jobs.push(work);return work;};
  try{await holder.query('BEGIN');held=true;const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid;await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`condola:record-archive:${ORG_ID}:property:${p}`]);await holder.query(`UPDATE properties SET archived_at=clock_timestamp() WHERE id=$1`,[p]);
   const signing=start(signLease(tenant,{leaseId:lease,signedName:'Synthetic',consent:true}));const paper=start(uploadSignedLeasePdf(admin,lease,{bytes:new TextEncoder().encode('%PDF-1.4 synthetic'),fileName:'synthetic.pdf'}));
   const waiters=await withClient(async observer=>{for(let n=0;n<100;n++){await observer.query('SELECT pg_catalog.pg_stat_clear_snapshot()');const r=await observer.query<{pid:number}>(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%pg_advisory_xact_lock_shared%' ORDER BY pid`,[pid]);if(r.rows.length===2)return r.rows.map(x=>x.pid);if(r.rows.length>2)throw new Error('Ambiguous waiters');await new Promise(resolve=>setTimeout(resolve,30));}return [];});assert.equal(new Set(waiters).size,2);
   await holder.query('COMMIT');held=false;await assert.rejects(()=>bounded(signing),error=>error instanceof FlowError&&error.key==='errors.notFound');await assert.rejects(()=>bounded(paper),error=>error instanceof FlowError&&error.key==='errors.notFound');
  }catch(error){failed=true;primary=error;}
  const cleanup:unknown[]=[];if(held)try{await holder.query('ROLLBACK');}catch(error){cleanup.push(error);}try{await bounded(Promise.allSettled(jobs));}catch(error){cleanup.push(error);}
  if(failed&&cleanup.length)throw new AggregateError([primary,...cleanup],'Signing race and cleanup failed');if(failed)throw primary;if(cleanup.length)throw new AggregateError(cleanup,'Cleanup failed');
 });
 assert.deepEqual(await snapshot(),before);
});

test('an archived ended imported lease retains historical paper upload and replacement',async()=>{
 const sid=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
 const s:Session={userId:USERS.admin,sessionId:sid,email:'',name:'admin',kind:'staff',role:'admin',orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone,archived_at) VALUES($1,$2,'TW','TWD','Asia/Taipei',now()) RETURNING id::text`,[ORG_ID,`B015 historical ${randomUUID()}`])).rows[0].id;
 const u=(await query<{id:string}>(`INSERT INTO units(org_id,property_id,label) VALUES($1,$2,'one') RETURNING id::text`,[ORG_ID,p])).rows[0].id;
 const lease=(await query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,esign_status,start_date,end_date,currency,rent_amount_minor) VALUES($1,$2,$3,$3,'ended','imported','2098-01-01','2098-12-31','TWD',0) RETURNING id::text`,[ORG_ID,p,u])).rows[0].id;
 const bytes=new TextEncoder().encode('%PDF-1.4 synthetic historical file');
 assert.equal((await uploadSignedLeasePdf(s,lease,{bytes,fileName:'first.pdf',replaceReason:'Historical correction'})).activated,false);
 assert.equal((await uploadSignedLeasePdf(s,lease,{bytes:new TextEncoder().encode('%PDF-1.4 synthetic corrected file'),fileName:'second.pdf',replaceReason:'Historical correction'})).activated,false);
 const saved=await query<{status:string;pdfs:number}>(`SELECT l.status::text,(SELECT count(*)::int FROM lease_signed_pdfs d WHERE d.lease_id=l.id) pdfs FROM leases l WHERE l.id=$1`,[lease]);assert.equal(saved.rows[0].status,'ended');assert.equal(saved.rows[0].pdfs,2);
});

test('an admitted real import finishes first and its active lease blocks archive',async()=>{
 const sid=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
 const s:Session={userId:USERS.admin,sessionId:sid,email:'',name:'admin',kind:'staff',role:'admin',orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};
 await query(`INSERT INTO platform_settings(key,value) VALUES('record_archive',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text))) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,[ORG_ID]);
 await query(`UPDATE organizations SET feature_flags=jsonb_set(coalesce(feature_flags,'{}'::jsonb),'{record_archive}','true'::jsonb,true) WHERE id=$1`,[ORG_ID]);
 const suffix=randomUUID(),name=`B015 import first ${suffix}`,address=`台北市大安區測試路${suffix}號`,email=`owner.${suffix}@example.test`;
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,address_display,address_key,country_code,currency,timezone) VALUES($1,$2,$3,$4,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,name,address,addressKey(address)])).rows[0].id;
 const owner=(await query<{id:string}>(`INSERT INTO contacts(org_id,is_owner,display_name,email) VALUES($1,true,'B015 Owner',$2) RETURNING id::text`,[ORG_ID,email])).rows[0].id;await query(`INSERT INTO property_owners(org_id,property_id,owner_contact_id) VALUES($1,$2,$3)`,[ORG_ID,p,owner]);
 const unit=(await query<{id:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode,import_address_key) VALUES($1,$2,'A','whole_unit',$3) RETURNING id::text`,[ORG_ID,p,addressKey(address)])).rows[0].id;
 const row={line:2,propertyName:name,address,ownerName:'B015 Owner',ownerEmail:email,rentalMode:'整層',unitLabel:'A',roomLabel:'',roomType:'',area:'12',rent:'10000',tenantName:'B015 Tenant',tenantPhone:`09${randomInt(10000000,99999999)}`,tenantEmail:'',startDate:'2098-01-01',endDate:'2098-12-31',deposit:'20000',dueDay:'5',electricity:'',rate:'',billKwh:'',billAmount:'',opening:'',depositReason:'',rateReason:'',notes:''};
 const ref={kind:'property' as const,id:p};const view=await archiveView(s,ref);assert.equal(view.state,'ready');if(view.state!=='ready')throw new Error('View unavailable');
 await withClient(async holder=>{let held=false;const jobs:Promise<unknown>[]=[];let primary:unknown;let failed=false;const start=<T>(work:Promise<T>)=>{work.catch(()=>{});jobs.push(work);return work;};
  const wait=async(blocker:number,fragment:string)=>withClient(async observer=>{for(let n=0;n<100;n++){await observer.query('SELECT pg_catalog.pg_stat_clear_snapshot()');const r=await observer.query<{pid:number}>(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE $2`,[blocker,`%${fragment}%`]);if(r.rows.length===1)return r.rows[0].pid;if(r.rows.length>1)throw new Error('Ambiguous waiter');await new Promise(resolve=>setTimeout(resolve,30));}throw new Error('Expected waiter absent');});
  try{await holder.query('BEGIN');held=true;const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid;await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`condola:record-archive:${ORG_ID}:unit:${unit}`]);
   const importing=start(commitImportBatch(s,{fileName:'b015-import-first.csv',rows:[row]}));const importPid=await wait(pid,'pg_advisory_xact_lock_shared');
   const archiving=start(archiveCommand(s,{ref,desired:'archived',expectedVersion:view.observed.version,renderedScope:archiveScope(s),reason:'Retired',requestId:randomUUID()}));await wait(importPid,'pg_advisory_xact_lock');
   await holder.query('COMMIT');held=false;const result=await bounded(importing);assert.equal(result.created.leases,1);assert.equal((await bounded(archiving)).state,'blocked');
  }catch(error){failed=true;primary=error;}
  const cleanup:unknown[]=[];if(held)try{await holder.query('ROLLBACK');}catch(error){cleanup.push(error);}try{await bounded(Promise.allSettled(jobs));}catch(error){cleanup.push(error);}
  if(failed&&cleanup.length)throw new AggregateError([primary,...cleanup],'Import-first race and cleanup failed');if(failed)throw primary;if(cleanup.length)throw new AggregateError(cleanup,'Cleanup failed');
 });
 assert.equal((await query(`SELECT id FROM leases WHERE property_id=$1 AND status='active'`,[p])).rowCount,1);
});

test('archive-first rejects a real new dispatch without creating a job',async()=>{
 const sid=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
 const s:Session={userId:USERS.admin,sessionId:sid,email:'',name:'admin',kind:'staff',role:'admin',orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};
 await query(`UPDATE organizations SET plan_tier='beta',feature_flags=jsonb_set(coalesce(feature_flags,'{}'::jsonb),'{vendor_dispatch}','true'::jsonb,true) WHERE id=$1`,[ORG_ID]);
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,`B015 dispatch ${randomUUID()}`])).rows[0].id;
 const ticket=(await query<{id:string}>(`INSERT INTO maintenance_tickets(org_id,ticket_number,property_id,category,priority,status,title) VALUES($1,900003,$2,'other','normal','open','Synthetic') RETURNING id::text`,[ORG_ID,p])).rows[0].id;
 await withClient(async holder=>{let held=false;let pending:ReturnType<typeof dispatchVendor>|undefined;let primary:unknown;let failed=false;
  try{await holder.query('BEGIN');held=true;const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid;await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`condola:record-archive:${ORG_ID}:property:${p}`]);await holder.query(`UPDATE properties SET archived_at=clock_timestamp() WHERE id=$1`,[p]);
   pending=dispatchVendor(s,ticket,{vendorName:'Synthetic',vendorPhone:'0912000111',contactWindow:'Daytime'},'http://127.0.0.1:43123');pending.catch(()=>{});
   const waiter=await withClient(async observer=>{for(let n=0;n<100;n++){await observer.query('SELECT pg_catalog.pg_stat_clear_snapshot()');const r=await observer.query<{pid:number}>(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%pg_advisory_xact_lock_shared%'`,[pid]);if(r.rows.length===1)return r.rows[0].pid;if(r.rows.length>1)throw new Error('Ambiguous waiter');await new Promise(resolve=>setTimeout(resolve,30));}return 0;});assert.ok(waiter);
   await holder.query('COMMIT');held=false;await assert.rejects(()=>bounded(pending!),error=>error instanceof FlowError&&error.key==='errors.notFound');
  }catch(error){failed=true;primary=error;}
  const cleanup:unknown[]=[];if(held)try{await holder.query('ROLLBACK');}catch(error){cleanup.push(error);}if(pending)try{await bounded(Promise.allSettled([pending]));}catch(error){cleanup.push(error);}
  if(failed&&cleanup.length)throw new AggregateError([primary,...cleanup],'Dispatch race and cleanup failed');if(failed)throw primary;if(cleanup.length)throw new AggregateError(cleanup,'Cleanup failed');
 });
 assert.equal((await query(`SELECT id FROM repair_vendor_jobs WHERE org_id=$1 AND ticket_id=$2`,[ORG_ID,ticket])).rowCount,0);
});

test('a real admitted dispatch finishes before a property archive and leaves active work blocking it',async()=>{
 const sid=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
 const s:Session={userId:USERS.admin,sessionId:sid,email:'',name:'admin',kind:'staff',role:'admin',orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};
 await query(`INSERT INTO platform_settings(key,value) VALUES('record_archive',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text))) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,[ORG_ID]);
 await query(`UPDATE organizations SET plan_tier='beta',feature_flags=jsonb_set(jsonb_set(coalesce(feature_flags,'{}'::jsonb),'{record_archive}','true'::jsonb,true),'{vendor_dispatch}','true'::jsonb,true) WHERE id=$1`,[ORG_ID]);
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,`B015 dispatch first ${randomUUID()}`])).rows[0].id;
 const ticket=(await query<{id:string}>(`INSERT INTO maintenance_tickets(org_id,ticket_number,property_id,category,priority,status,title) VALUES($1,900004,$2,'other','normal','open','Synthetic') RETURNING id::text`,[ORG_ID,p])).rows[0].id;
 const ref={kind:'property' as const,id:p};const v=await archiveView(s,ref);assert.equal(v.state,'ready');if(v.state!=='ready')throw new Error('View unavailable');
 await withClient(async holder=>{let held=false;const jobs:Promise<unknown>[]=[];let primary:unknown;let failed=false;const start=<T>(work:Promise<T>)=>{work.catch(()=>{});jobs.push(work);return work;};
  const wait=async(blocker:number,fragment:string)=>withClient(async observer=>{for(let n=0;n<100;n++){await observer.query('SELECT pg_catalog.pg_stat_clear_snapshot()');const r=await observer.query<{pid:number}>(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE $2`,[blocker,`%${fragment}%`]);if(r.rows.length===1)return r.rows[0].pid;if(r.rows.length>1)throw new Error('Ambiguous waiter');await new Promise(resolve=>setTimeout(resolve,30));}throw new Error('Expected waiter absent');});
  try{await holder.query('BEGIN');held=true;const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid;await holder.query(`SELECT id FROM maintenance_tickets WHERE id=$1 FOR UPDATE`,[ticket]);
   const dispatch=start(dispatchVendor(s,ticket,{vendorName:'Synthetic',vendorPhone:'0912000111',vendorTrade:'水電',contactWindow:'Daytime'},'http://127.0.0.1:43123'));const dispatchPid=await wait(pid,'FOR UPDATE');
   const archiving=start(archiveCommand(s,{ref,desired:'archived',expectedVersion:v.observed.version,renderedScope:archiveScope(s),reason:'Retired',requestId:randomUUID()}));await wait(dispatchPid,'pg_advisory_xact_lock');
   await holder.query('COMMIT');held=false;const issued=await bounded(dispatch);assert.ok(issued.jobId);assert.equal((await bounded(archiving)).state,'blocked');
  }catch(error){failed=true;primary=error;}
  const cleanup:unknown[]=[];if(held)try{await holder.query('ROLLBACK');}catch(error){cleanup.push(error);}try{await bounded(Promise.allSettled(jobs));}catch(error){cleanup.push(error);}
  if(failed&&cleanup.length)throw new AggregateError([primary,...cleanup],'Dispatch-first race and cleanup failed');if(failed)throw primary;if(cleanup.length)throw new AggregateError(cleanup,'Cleanup failed');
 });
 assert.equal((await query(`SELECT id FROM repair_vendor_jobs WHERE org_id=$1 AND ticket_id=$2 AND active`,[ORG_ID,ticket])).rowCount,1);
});

test('utility preparation admitted first leaves a draft run that blocks archive',async()=>{
 const sid=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.manager,randomUUID()]);
 const s:Session={userId:USERS.manager,sessionId:sid,email:'',name:'manager',kind:'staff',role:'manager',orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};
 await query(`INSERT INTO platform_settings(key,value) VALUES('record_archive',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text))) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,[ORG_ID]);
 await query(`UPDATE organizations SET feature_flags=jsonb_set(coalesce(feature_flags,'{}'::jsonb),'{record_archive}','true'::jsonb,true) WHERE id=$1`,[ORG_ID]);
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,`B015 utility first ${randomUUID()}`])).rows[0].id;
 const u=(await query<{id:string}>(`INSERT INTO units(org_id,property_id,label,electricity_method) VALUES($1,$2,'one','even') RETURNING id::text`,[ORG_ID,p])).rows[0].id;
 const ref={kind:'property' as const,id:p};const view=await archiveView(s,ref);assert.equal(view.state,'ready');if(view.state!=='ready')throw new Error('View unavailable');
 const input={unitId:u,periodStart:'2099-01-01',periodEnd:'2099-02-01',rateMajor:5,totalKwh:20,readings:[],billTotalMajor:100,overrideReason:''};
 await withClient(async holder=>{let held=false;const jobs:Promise<unknown>[]=[];let primary:unknown;let failed=false;const start=<T>(work:Promise<T>)=>{work.catch(()=>{});jobs.push(work);return work;};
  const wait=async(blocker:number,fragment:string)=>withClient(async observer=>{for(let n=0;n<100;n++){await observer.query('SELECT pg_catalog.pg_stat_clear_snapshot()');const r=await observer.query<{pid:number}>(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE $2`,[blocker,`%${fragment}%`]);if(r.rows.length===1)return r.rows[0].pid;if(r.rows.length>1)throw new Error('Ambiguous waiter');await new Promise(resolve=>setTimeout(resolve,30));}throw new Error('Expected waiter absent');});
  try{await holder.query('BEGIN');held=true;const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid;await holder.query(`SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))`,[ORG_ID,u]);
   const preparing=start(prepareUtilityRun(s,input));const utilityPid=await wait(pid,'pg_advisory_xact_lock');
   const archiving=start(archiveCommand(s,{ref,desired:'archived',expectedVersion:view.observed.version,renderedScope:archiveScope(s),reason:'Retired',requestId:randomUUID()}));await wait(utilityPid,'pg_advisory_xact_lock');
   await holder.query('COMMIT');held=false;await bounded(preparing);assert.equal((await bounded(archiving)).state,'blocked');
  }catch(error){failed=true;primary=error;}
  const cleanup:unknown[]=[];if(held)try{await holder.query('ROLLBACK');}catch(error){cleanup.push(error);}try{await bounded(Promise.allSettled(jobs));}catch(error){cleanup.push(error);}
  if(failed&&cleanup.length)throw new AggregateError([primary,...cleanup],'Utility-first race and cleanup failed');if(failed)throw primary;if(cleanup.length)throw new AggregateError(cleanup,'Cleanup failed');
 });
 assert.equal((await query(`SELECT id FROM utility_allocation_runs WHERE org_id=$1 AND unit_id=$2 AND status='draft'`,[ORG_ID,u])).rowCount,1);
});

test('a real signer admitted first completes before archive observes the pending lease',async()=>{
 const sid=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
 const s:Session={userId:USERS.admin,sessionId:sid,email:'',name:'admin',kind:'staff',role:'admin',orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};
 await query(`INSERT INTO platform_settings(key,value) VALUES('record_archive',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text))) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,[ORG_ID]);
 await query(`UPDATE organizations SET feature_flags=jsonb_set(coalesce(feature_flags,'{}'::jsonb),'{record_archive}','true'::jsonb,true) WHERE id=$1`,[ORG_ID]);
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,`B015 signing first ${randomUUID()}`])).rows[0].id;
 const u=(await query<{id:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode,base_rent_minor) VALUES($1,$2,'one','whole_unit',1000000) RETURNING id::text`,[ORG_ID,p])).rows[0].id;
 const key=randomUUID();const created=await createLease(s,{roomId:u,tenantName:`B015 ${key}`,tenantPhone:`09${randomInt(10000000,99999999)}`,tenantEmail:'',lineUserId:'',startDate:'2094-01-01',endDate:'2094-12-31',rentMajor:10000,depositMonths:2,depositReason:'',dueDay:5,splitMethod:'even',periodStart:'2094-01-01',periodEnd:'2094-01-31',billTotalMajor:null,usageKwh:null,rateMajor:null,rateSource:'bill_average',overrideReason:'',subUsages:[],idempotencyKey:key});
 const party=(await query<{id:string}>(`SELECT contact_id::text id FROM lease_parties WHERE org_id=$1 AND lease_id=$2 AND role='primary'`,[ORG_ID,created.leaseId])).rows[0];assert.ok(party);
 const doc=(await query<{id:string}>(`INSERT INTO identity_documents(org_id,contact_id,lease_id,doc_type,number_masked,storage_path,encryption_key_ref,review_status,created_by) VALUES($1,$2,$3,'passport','A**789',$4,'synthetic','pending_review',$5) RETURNING id::text`,[ORG_ID,party.id,created.leaseId,`b015/${key}/document`,s.userId])).rows[0].id;
 for(const slot of ['front','selfie'])await query(`INSERT INTO identity_document_photos(org_id,document_id,slot,storage_path,mime_type,size_bytes,sha256) VALUES($1,$2,$3,$4,'image/jpeg',4,'synthetic')`,[ORG_ID,doc,slot,`b015/${key}/${slot}`]);
 const ref={kind:'property' as const,id:p};const view=await archiveView(s,ref);assert.equal(view.state,'ready');if(view.state!=='ready')throw new Error('View unavailable');
 await withClient(async holder=>{let held=false;const jobs:Promise<unknown>[]=[];let primary:unknown;let failed=false;const start=<T>(work:Promise<T>)=>{work.catch(()=>{});jobs.push(work);return work;};
  const wait=async(blocker:number,fragment:string)=>withClient(async observer=>{for(let n=0;n<100;n++){await observer.query('SELECT pg_catalog.pg_stat_clear_snapshot()');const r=await observer.query<{pid:number}>(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE $2`,[blocker,`%${fragment}%`]);if(r.rows.length===1)return r.rows[0].pid;if(r.rows.length>1)throw new Error('Ambiguous waiter');await new Promise(resolve=>setTimeout(resolve,30));}throw new Error('Expected waiter absent');});
  try{await holder.query('BEGIN');held=true;const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid;await holder.query(`SELECT id FROM leases WHERE id=$1 FOR UPDATE`,[created.leaseId]);
   const signing=start(signLease(s,{leaseId:created.leaseId,signedName:'Synthetic Manager',consent:true}));const signerPid=await wait(pid,'FOR UPDATE');
   const archiving=start(archiveCommand(s,{ref,desired:'archived',expectedVersion:view.observed.version,renderedScope:archiveScope(s),reason:'Retired',requestId:randomUUID()}));await wait(signerPid,'pg_advisory_xact_lock');
   await holder.query('COMMIT');held=false;assert.equal((await bounded(signing)).esign,'partially_signed');assert.equal((await bounded(archiving)).state,'blocked');
  }catch(error){failed=true;primary=error;}
  const cleanup:unknown[]=[];if(held)try{await holder.query('ROLLBACK');}catch(error){cleanup.push(error);}try{await bounded(Promise.allSettled(jobs));}catch(error){cleanup.push(error);}
  if(failed&&cleanup.length)throw new AggregateError([primary,...cleanup],'Signing-first race and cleanup failed');if(failed)throw primary;if(cleanup.length)throw new AggregateError(cleanup,'Cleanup failed');
 });
 assert.equal((await query(`SELECT id FROM lease_signatures WHERE lease_id=$1 AND signer_role='manager' AND status='signed'`,[created.leaseId])).rowCount,1);
});

test('a real fresh lease admitted first commits before archive observes its pending work',async()=>{
 const sid=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
 const s:Session={userId:USERS.admin,sessionId:sid,email:'',name:'admin',kind:'staff',role:'admin',orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};
 await query(`INSERT INTO platform_settings(key,value) VALUES('record_archive',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text))) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,[ORG_ID]);
 await query(`UPDATE organizations SET feature_flags=jsonb_set(coalesce(feature_flags,'{}'::jsonb),'{record_archive}','true'::jsonb,true) WHERE id=$1`,[ORG_ID]);
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,`B015 lease first ${randomUUID()}`])).rows[0].id;
 const u=(await query<{id:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode,base_rent_minor) VALUES($1,$2,'one','whole_unit',1000000) RETURNING id::text`,[ORG_ID,p])).rows[0].id;
 const ref={kind:'property' as const,id:p};const view=await archiveView(s,ref);assert.equal(view.state,'ready');if(view.state!=='ready')throw new Error('View unavailable');
 const key=randomUUID();const input={roomId:u,tenantName:`B015 ${key}`,tenantPhone:`09${randomInt(10000000,99999999)}`,tenantEmail:'',lineUserId:'',startDate:'2094-01-01',endDate:'2094-12-31',rentMajor:10000,depositMonths:2,depositReason:'',dueDay:5,splitMethod:'even' as const,periodStart:'2094-01-01',periodEnd:'2094-01-31',billTotalMajor:null,usageKwh:null,rateMajor:null,rateSource:'bill_average' as const,overrideReason:'',subUsages:[],idempotencyKey:key};
 await withClient(async holder=>{let held=false;const jobs:Promise<unknown>[]=[];let primary:unknown;let failed=false;const start=<T>(work:Promise<T>)=>{work.catch(()=>{});jobs.push(work);return work;};
  const wait=async(blocker:number,fragment:string)=>withClient(async observer=>{for(let n=0;n<100;n++){await observer.query('SELECT pg_catalog.pg_stat_clear_snapshot()');const r=await observer.query<{pid:number}>(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE $2`,[blocker,`%${fragment}%`]);if(r.rows.length===1)return r.rows[0].pid;if(r.rows.length>1)throw new Error('Ambiguous waiter');await new Promise(resolve=>setTimeout(resolve,30));}throw new Error('Expected waiter absent');});
  try{await holder.query('BEGIN');held=true;const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid;await holder.query(`SELECT id FROM properties WHERE id=$1 FOR UPDATE`,[p]);
   const creating=start(createLease(s,input));const createPid=await wait(pid,'FOR SHARE');
   const archiving=start(archiveCommand(s,{ref,desired:'archived',expectedVersion:view.observed.version,renderedScope:archiveScope(s),reason:'Retired',requestId:randomUUID()}));await wait(createPid,'pg_advisory_xact_lock');
   await holder.query('COMMIT');held=false;const created=await bounded(creating);assert.ok(created.leaseId);assert.equal((await bounded(archiving)).state,'blocked');
  }catch(error){failed=true;primary=error;}
  const cleanup:unknown[]=[];if(held)try{await holder.query('ROLLBACK');}catch(error){cleanup.push(error);}try{await bounded(Promise.allSettled(jobs));}catch(error){cleanup.push(error);}
  if(failed&&cleanup.length)throw new AggregateError([primary,...cleanup],'Lease-first race and cleanup failed');if(failed)throw primary;if(cleanup.length)throw new AggregateError(cleanup,'Cleanup failed');
 });
 assert.equal((await query(`SELECT id FROM leases WHERE property_id=$1 AND status='pending_signature'`,[p])).rowCount,1);
});

test('real tenant ticket creation obeys both archive and work lock orders',async()=>{
 const adminId=randomUUID(),tenantId=randomUUID();for(const [id,user] of [[adminId,USERS.admin],[tenantId,USERS.tenant]])await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[id,user,randomUUID()]);
 const admin:Session={userId:USERS.admin,sessionId:adminId,email:'',name:'admin',kind:'staff',role:'admin',orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};const tenant:Session={...admin,userId:USERS.tenant,sessionId:tenantId,kind:'tenant',role:null};
 await query(`INSERT INTO platform_settings(key,value) VALUES('record_archive',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text))) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,[ORG_ID]);
 await query(`UPDATE organizations SET feature_flags=jsonb_set(coalesce(feature_flags,'{}'::jsonb),'{record_archive}','true'::jsonb,true) WHERE id=$1`,[ORG_ID]);
 const payer=(await query<{id:string}>(`SELECT id::text FROM contacts WHERE org_id=$1 AND user_id=$2 AND is_tenant AND archived_at IS NULL`,[ORG_ID,tenant.userId])).rows[0];assert.ok(payer);
 for(const archiveFirst of [true,false]) {
  const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,`B015 ticket ${randomUUID()}`])).rows[0].id;
  const u=(await query<{id:string}>(`INSERT INTO units(org_id,property_id,label) VALUES($1,$2,'one') RETURNING id::text`,[ORG_ID,p])).rows[0].id;
  const lease=(await query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,end_date,currency,rent_amount_minor) VALUES($1,$2,$3,$3,'active','2098-01-01','2098-12-31','TWD',0) RETURNING id::text`,[ORG_ID,p,u])).rows[0].id;
  await query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')`,[ORG_ID,lease,payer.id]);
  const ref={kind:'property' as const,id:p};const view=await archiveView(admin,ref);assert.equal(view.state,'ready');if(view.state!=='ready')throw new Error('View unavailable');
  await withClient(async holder=>{let held=false;const jobs:Promise<unknown>[]=[];let primary:unknown;let failed=false;const start=<T>(work:Promise<T>)=>{work.catch(()=>{});jobs.push(work);return work;};
   const wait=async(blocker:number,fragment:string)=>withClient(async observer=>{for(let n=0;n<100;n++){await observer.query('SELECT pg_catalog.pg_stat_clear_snapshot()');const r=await observer.query<{pid:number}>(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE $2`,[blocker,`%${fragment}%`]);if(r.rows.length===1)return r.rows[0].pid;if(r.rows.length>1)throw new Error('Ambiguous waiter');await new Promise(resolve=>setTimeout(resolve,30));}throw new Error('Expected waiter absent');});
   try{await holder.query('BEGIN');held=true;const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid;
    if(archiveFirst){await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`condola:record-archive:${ORG_ID}:property:${p}`]);await holder.query(`UPDATE properties SET archived_at=clock_timestamp() WHERE id=$1`,[p]);}
    else await holder.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,[`tickets:${ORG_ID}`]);
    const creating=start(createTicket(tenant,{leaseId:lease,category:'other',title:'B015 real ticket',description:'Synthetic'}));const writerPid=await wait(pid,'pg_advisory_xact_lock');
    const archiving=archiveFirst?null:start(archiveCommand(admin,{ref,desired:'archived',expectedVersion:view.observed.version,renderedScope:archiveScope(admin),reason:'Retired',requestId:randomUUID()}));if(archiving)await wait(writerPid,'pg_advisory_xact_lock');
    await holder.query('COMMIT');held=false;if(archiveFirst)await assert.rejects(()=>bounded(creating),error=>error instanceof FlowError&&error.key==='errors.notFound');else {assert.ok(await bounded(creating));assert.equal((await bounded(archiving!)).state,'blocked');}
   }catch(error){failed=true;primary=error;}
   const cleanup:unknown[]=[];if(held)try{await holder.query('ROLLBACK');}catch(error){cleanup.push(error);}try{await bounded(Promise.allSettled(jobs));}catch(error){cleanup.push(error);}
   if(failed&&cleanup.length)throw new AggregateError([primary,...cleanup],'Ticket race and cleanup failed');if(failed)throw primary;if(cleanup.length)throw new AggregateError(cleanup,'Cleanup failed');
  });
  assert.equal((await query(`SELECT id FROM maintenance_tickets WHERE org_id=$1 AND lease_id=$2`,[ORG_ID,lease])).rowCount,archiveFirst?0:1);
 }
});

test('a role removed during an archive wait cannot authorize the write',async()=>{
 const sid=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.manager,randomUUID()]);
 const s:Session={userId:USERS.manager,sessionId:sid,email:'',name:'manager',kind:'staff',role:'manager',orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};
 await query(`INSERT INTO platform_settings(key,value) VALUES('record_archive',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text))) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,[ORG_ID]);
 await query(`UPDATE organizations SET feature_flags=jsonb_set(coalesce(feature_flags,'{}'::jsonb),'{record_archive}','true'::jsonb,true) WHERE id=$1`,[ORG_ID]);
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,`B015 role change ${randomUUID()}`])).rows[0].id;
 const ref={kind:'property' as const,id:p};const view=await archiveView(s,ref);assert.equal(view.state,'ready');if(view.state!=='ready')throw new Error('View unavailable');
 try{await withClient(async holder=>{let held=false;let pending:ReturnType<typeof archiveCommand>|undefined;let primary:unknown;let failed=false;
  try{await holder.query('BEGIN');held=true;const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid;await holder.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))`,[`condola:record-archive:${ORG_ID}:property:${p}`]);
   pending=archiveCommand(s,{ref,desired:'archived',expectedVersion:view.observed.version,renderedScope:archiveScope(s),reason:'Retired',requestId:randomUUID()});pending.catch(()=>{});
   const waiter=await withClient(async observer=>{for(let n=0;n<100;n++){await observer.query('SELECT pg_catalog.pg_stat_clear_snapshot()');const r=await observer.query<{pid:number}>(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%pg_advisory_xact_lock%'`,[pid]);if(r.rows.length===1)return r.rows[0].pid;if(r.rows.length>1)throw new Error('Ambiguous waiter');await new Promise(resolve=>setTimeout(resolve,30));}return 0;});assert.ok(waiter);
   await query(`UPDATE org_members SET role='maintenance' WHERE org_id=$1 AND user_id=$2`,[ORG_ID,s.userId]);await holder.query('COMMIT');held=false;assert.equal((await bounded(pending)).state,'forbidden');
  }catch(error){failed=true;primary=error;}
  const cleanup:unknown[]=[];if(held)try{await holder.query('ROLLBACK');}catch(error){cleanup.push(error);}if(pending)try{await bounded(Promise.allSettled([pending]));}catch(error){cleanup.push(error);}
  if(failed&&cleanup.length)throw new AggregateError([primary,...cleanup],'Role-change race and cleanup failed');if(failed)throw primary;if(cleanup.length)throw new AggregateError(cleanup,'Cleanup failed');
 });}finally{await query(`UPDATE org_members SET role='manager' WHERE org_id=$1 AND user_id=$2`,[ORG_ID,s.userId]);}
 assert.equal((await query<{archived:boolean}>(`SELECT archived_at IS NOT NULL archived FROM properties WHERE id=$1`,[p])).rows[0].archived,false);
});

test('archive-first rejects real enhanced signing creation before generating or sending anything',async()=>{
 const sid=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
 const s:Session={userId:USERS.admin,sessionId:sid,email:'',name:'admin',kind:'staff',role:'admin',orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null,consent:buildStoredConsent('reconsent')};
 await query(`UPDATE organizations SET feature_flags=jsonb_set(coalesce(feature_flags,'{}'::jsonb),'{esign}','true'::jsonb,true) WHERE id=$1`,[ORG_ID]);
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,`B015 esign ${randomUUID()}`])).rows[0].id;
 const u=(await query<{id:string}>(`INSERT INTO units(org_id,property_id,label) VALUES($1,$2,'one') RETURNING id::text`,[ORG_ID,p])).rows[0].id;
 const lease=(await query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,end_date,currency,rent_amount_minor) VALUES($1,$2,$3,$3,'draft','2098-01-01','2098-12-31','TWD',0) RETURNING id::text`,[ORG_ID,p,u])).rows[0].id;
 const flow=new EsignFlow({enabled:()=>true,mail:async()=>{throw new Error('Synthetic mail must not run');}});
 await withClient(async holder=>{let held=false;let pending:ReturnType<typeof flow.execute>|undefined;let primary:unknown;let failed=false;
  try{await holder.query('BEGIN');held=true;const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid;await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`condola:record-archive:${ORG_ID}:property:${p}`]);await holder.query(`UPDATE properties SET archived_at=clock_timestamp() WHERE id=$1`,[p]);
   pending=flow.execute(s,{type:'create',leaseId:lease,pdf:new TextEncoder().encode('%PDF-1.4 synthetic'),ownerId:USERS.owner,tenantId:USERS.tenant,ownerDocument:false,tenantDocument:false,order:'parallel',deadline:'2099-01-01'});pending.catch(()=>{});
   const waiter=await withClient(async observer=>{for(let n=0;n<100;n++){await observer.query('SELECT pg_catalog.pg_stat_clear_snapshot()');const r=await observer.query<{pid:number}>(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%pg_advisory_xact_lock_shared%'`,[pid]);if(r.rows.length===1)return r.rows[0].pid;if(r.rows.length>1)throw new Error('Ambiguous waiter');await new Promise(resolve=>setTimeout(resolve,30));}return 0;});assert.ok(waiter);
   await holder.query('COMMIT');held=false;await assert.rejects(()=>bounded(pending!),error=>error instanceof FlowError&&error.key==='errors.notFound');
  }catch(error){failed=true;primary=error;}
  const cleanup:unknown[]=[];if(held)try{await holder.query('ROLLBACK');}catch(error){cleanup.push(error);}if(pending)try{await bounded(Promise.allSettled([pending]));}catch(error){cleanup.push(error);}
  if(failed&&cleanup.length)throw new AggregateError([primary,...cleanup],'Enhanced-signing race and cleanup failed');if(failed)throw primary;if(cleanup.length)throw new AggregateError(cleanup,'Cleanup failed');
 });
 assert.equal((await query(`SELECT id FROM esign_cases WHERE org_id=$1 AND lease_id=$2`,[ORG_ID,lease])).rowCount,0);
});

test('an existing enhanced-signing email challenge can be read-only replayed after archive',async()=>{
 const adminId=randomUUID(),tenantId=randomUUID();for(const [id,user] of [[adminId,USERS.admin],[tenantId,USERS.tenant]])await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[id,user,randomUUID()]);
 const admin:Session={userId:USERS.admin,sessionId:adminId,email:'',name:'admin',kind:'staff',role:'admin',orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null,consent:buildStoredConsent('reconsent')};const tenant:Session={...admin,userId:USERS.tenant,sessionId:tenantId,kind:'tenant',role:null};
 await query(`UPDATE organizations SET feature_flags=jsonb_set(coalesce(feature_flags,'{}'::jsonb),'{esign}','true'::jsonb,true) WHERE id=$1`,[ORG_ID]);
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,`B015 replay ${randomUUID()}`])).rows[0].id;
 const u=(await query<{id:string}>(`INSERT INTO units(org_id,property_id,label) VALUES($1,$2,'one') RETURNING id::text`,[ORG_ID,p])).rows[0].id;
 const lease=(await query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,end_date,currency,rent_amount_minor) VALUES($1,$2,$3,$3,'draft','2098-01-01','2098-12-31','TWD',0) RETURNING id::text`,[ORG_ID,p,u])).rows[0].id;
 const caseId=randomUUID(),versionId=randomUUID(),at=new Date().toISOString(),expiresAt=new Date(Date.now()+3600000).toISOString();
 const repo=new EsignRepo({check:async()=>false},undefined,()=>true);
 await repo.createCase(admin,{caseId,leaseId:lease,versionId,body:'Synthetic',pdfBytes:new TextEncoder().encode('%PDF-1.7 synthetic'),signers:[{id:USERS.owner,role:'owner',email:'owner@example.test'},{id:USERS.tenant,role:'tenant',email:'tenant@example.test'}]});
 await repo.apply(admin,caseId,{type:'send',versionId,at,termsVersion:'synthetic',presumedConsentDeadline:expiresAt});
 const managerId=randomUUID(),accountantId=randomUUID();for(const [id,user] of [[managerId,USERS.manager],[accountantId,USERS.accountant]])await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[id,user,randomUUID()]);
 const manager:Session={...admin,userId:USERS.manager,sessionId:managerId,role:'manager'};const accountant:Session={...admin,userId:USERS.accountant,sessionId:accountantId,role:'accountant'};
 const managerView=await archiveView(manager,{kind:'property',id:p}),accountantView=await archiveView(accountant,{kind:'property',id:p});
 assert.equal(managerView.state,'ready');assert.equal(accountantView.state,'ready');
 if(managerView.state!=='ready'||accountantView.state!=='ready')throw new Error('Signing coverage unavailable');
 assert.ok(managerView.blockers.some(item=>item.label==='signing_active'));assert.equal(managerView.coverage.find(item=>item.category==='signing')?.state,'verified');
 assert.equal(accountantView.coverage.find(item=>item.category==='signing')?.state,'unknown');
 await repo.apply(tenant,caseId,{type:'consent',versionId,signerId:tenant.userId,kind:'explicit',at});
 await repo.apply(tenant,caseId,{type:'issue_identity',versionId,signerId:tenant.userId,method:'email',expiresAt,attemptCap:5,at});
 await query(`UPDATE leases SET status='ended' WHERE id=$1`,[lease]);await query(`UPDATE properties SET archived_at=clock_timestamp() WHERE id=$1`,[p]);
 const before=(await query<{state:string}>(`SELECT state::text FROM esign_versions WHERE id=$1`,[versionId])).rows[0].state;
 const flow=new EsignFlow({enabled:()=>true,mail:async()=>{throw new Error('Replay must not send');}});
 assert.equal((await flow.execute(tenant,{type:'email',caseId,versionId})).leaseId,lease);
 assert.equal((await query<{state:string}>(`SELECT state::text FROM esign_versions WHERE id=$1`,[versionId])).rows[0].state,before);
 await repo.voidUnsigned(admin,caseId,versionId,'Synthetic withdrawal',new Date().toISOString());
 assert.equal((await query<{status:string}>(`SELECT status FROM esign_versions WHERE id=$1`,[versionId])).rows[0].status,'voided');
});

test('authorization loss after the update begins rolls back both marker and audit',async()=>{
 const sid=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
 const s:Session={userId:USERS.admin,sessionId:sid,email:'',name:'admin',kind:'staff',role:'admin',orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};
 await query(`INSERT INTO platform_settings(key,value) VALUES('record_archive',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text))) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,[ORG_ID]);await query(`UPDATE organizations SET feature_flags=jsonb_set(coalesce(feature_flags,'{}'::jsonb),'{record_archive}','true'::jsonb,true) WHERE id=$1`,[ORG_ID]);
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,`B015 rollback ${randomUUID()}`])).rows[0].id;
 const ref={kind:'property' as const,id:p};const view=await archiveView(s,ref);assert.equal(view.state,'ready');if(view.state!=='ready')throw new Error('View unavailable');const requestId=randomUUID();
 await withClient(async holder=>{let held=false;let pending:ReturnType<typeof archiveCommand>|undefined;let primary:unknown;let failed=false;
  try{await holder.query('BEGIN');held=true;const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid;await holder.query(`LOCK TABLE public.audit_log IN SHARE MODE`);
   pending=archiveCommand(s,{ref,desired:'archived',expectedVersion:view.observed.version,renderedScope:archiveScope(s),reason:'Retired',requestId});pending.catch(()=>{});
   const waiter=await withClient(async observer=>{for(let n=0;n<100;n++){await observer.query('SELECT pg_catalog.pg_stat_clear_snapshot()');const r=await observer.query<{pid:number}>(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%UPDATE public.properties%'`,[pid]);if(r.rows.length===1)return r.rows[0].pid;if(r.rows.length>1)throw new Error('Ambiguous waiter');await new Promise(resolve=>setTimeout(resolve,30));}return 0;});assert.ok(waiter,'update must be waiting at the existing audit trigger');
   await query(`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1`,[sid]);await holder.query('COMMIT');held=false;assert.equal((await bounded(pending)).state,'unknown');
  }catch(error){failed=true;primary=error;}
  const cleanup:unknown[]=[];if(held)try{await holder.query('ROLLBACK');}catch(error){cleanup.push(error);}if(pending)try{await bounded(Promise.allSettled([pending]));}catch(error){cleanup.push(error);}
  if(failed&&cleanup.length)throw new AggregateError([primary,...cleanup],'Rollback race and cleanup failed');if(failed)throw primary;if(cleanup.length)throw new AggregateError(cleanup,'Cleanup failed');
 });
 assert.equal((await query<{archived:boolean}>(`SELECT archived_at IS NOT NULL archived FROM properties WHERE id=$1`,[p])).rows[0].archived,false);assert.equal((await query(`SELECT id FROM audit_log WHERE request_id=$1`,[requestId])).rowCount,0);
});

test('paper activation admitted first finishes before archive observes the active lease',async()=>{
 const sid=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
 const s:Session={userId:USERS.admin,sessionId:sid,email:'',name:'admin',kind:'staff',role:'admin',orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};
 await query(`INSERT INTO platform_settings(key,value) VALUES('record_archive',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text))) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,[ORG_ID]);await query(`UPDATE organizations SET feature_flags=jsonb_set(coalesce(feature_flags,'{}'::jsonb),'{record_archive}','true'::jsonb,true) WHERE id=$1`,[ORG_ID]);
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,`B015 paper first ${randomUUID()}`])).rows[0].id;
 const u=(await query<{id:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode,base_rent_minor) VALUES($1,$2,'one','whole_unit',1000000) RETURNING id::text`,[ORG_ID,p])).rows[0].id;
 const key=randomUUID();const created=await createLease(s,{roomId:u,tenantName:`B015 ${key}`,tenantPhone:`09${randomInt(10000000,99999999)}`,tenantEmail:'',lineUserId:'',startDate:'2094-01-01',endDate:'2094-12-31',rentMajor:10000,depositMonths:2,depositReason:'',dueDay:5,splitMethod:'even',periodStart:'2094-01-01',periodEnd:'2094-01-31',billTotalMajor:null,usageKwh:null,rateMajor:null,rateSource:'bill_average',overrideReason:'',subUsages:[],idempotencyKey:key});
 const party=(await query<{id:string}>(`SELECT contact_id::text id FROM lease_parties WHERE org_id=$1 AND lease_id=$2 AND role='primary'`,[ORG_ID,created.leaseId])).rows[0];assert.ok(party);
 const doc=(await query<{id:string}>(`INSERT INTO identity_documents(org_id,contact_id,lease_id,doc_type,number_masked,storage_path,encryption_key_ref,review_status,created_by) VALUES($1,$2,$3,'passport','A**789',$4,'synthetic','pending_review',$5) RETURNING id::text`,[ORG_ID,party.id,created.leaseId,`b015/${key}/document`,s.userId])).rows[0].id;
 for(const slot of ['front','selfie'])await query(`INSERT INTO identity_document_photos(org_id,document_id,slot,storage_path,mime_type,size_bytes,sha256) VALUES($1,$2,$3,$4,'image/jpeg',4,'synthetic')`,[ORG_ID,doc,slot,`b015/${key}/${slot}`]);
 const ref={kind:'property' as const,id:p};const view=await archiveView(s,ref);assert.equal(view.state,'ready');if(view.state!=='ready')throw new Error('View unavailable');
 await withClient(async holder=>{let held=false;const jobs:Promise<unknown>[]=[];let primary:unknown;let failed=false;const start=<T>(work:Promise<T>)=>{work.catch(()=>{});jobs.push(work);return work;};
  const wait=async(blocker:number,fragment:string)=>withClient(async observer=>{for(let n=0;n<100;n++){await observer.query('SELECT pg_catalog.pg_stat_clear_snapshot()');const r=await observer.query<{pid:number}>(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE $2`,[blocker,`%${fragment}%`]);if(r.rows.length===1)return r.rows[0].pid;if(r.rows.length>1)throw new Error('Ambiguous waiter');await new Promise(resolve=>setTimeout(resolve,30));}throw new Error('Expected waiter absent');});
  try{await holder.query('BEGIN');held=true;const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid;await holder.query(`SELECT id FROM leases WHERE id=$1 FOR UPDATE`,[created.leaseId]);
   const paper=start(uploadSignedLeasePdf(s,created.leaseId,{bytes:new TextEncoder().encode('%PDF-1.4 synthetic paper'),fileName:'synthetic.pdf'}));const paperPid=await wait(pid,'FOR UPDATE');
   const archiving=start(archiveCommand(s,{ref,desired:'archived',expectedVersion:view.observed.version,renderedScope:archiveScope(s),reason:'Retired',requestId:randomUUID()}));await wait(paperPid,'pg_advisory_xact_lock');
   await holder.query('COMMIT');held=false;assert.equal((await bounded(paper)).activated,true);assert.equal((await bounded(archiving)).state,'blocked');
  }catch(error){failed=true;primary=error;}
  const cleanup:unknown[]=[];if(held)try{await holder.query('ROLLBACK');}catch(error){cleanup.push(error);}try{await bounded(Promise.allSettled(jobs));}catch(error){cleanup.push(error);}
  if(failed&&cleanup.length)throw new AggregateError([primary,...cleanup],'Paper-first race and cleanup failed');if(failed)throw primary;if(cleanup.length)throw new AggregateError(cleanup,'Cleanup failed');
 });
 assert.equal((await query<{status:string}>(`SELECT status::text FROM leases WHERE id=$1`,[created.leaseId])).rows[0].status,'active');
});

test('enhanced signing creation admitted first leaves live signing that blocks archive',async()=>{
 const sid=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
 const s:Session={userId:USERS.admin,sessionId:sid,email:'',name:'admin',kind:'staff',role:'admin',orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null,consent:buildStoredConsent('reconsent')};
 await query(`INSERT INTO platform_settings(key,value) VALUES('record_archive',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text))) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,[ORG_ID]);
 await query(`UPDATE organizations SET feature_flags=jsonb_set(jsonb_set(coalesce(feature_flags,'{}'::jsonb),'{record_archive}','true'::jsonb,true),'{esign}','true'::jsonb,true) WHERE id=$1`,[ORG_ID]);
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,`B015 esign first ${randomUUID()}`])).rows[0].id;
 const u=(await query<{id:string}>(`INSERT INTO units(org_id,property_id,label) VALUES($1,$2,'one') RETURNING id::text`,[ORG_ID,p])).rows[0].id;
 const contacts=await query<{id:string;user_id:string}>(`SELECT id::text,user_id::text FROM contacts WHERE org_id=$1 AND user_id=ANY($2::uuid[]) AND archived_at IS NULL`,[ORG_ID,[USERS.owner,USERS.tenant]]);const owner=contacts.rows.find(x=>x.user_id===USERS.owner),tenant=contacts.rows.find(x=>x.user_id===USERS.tenant);assert.ok(owner&&tenant);
 await query(`INSERT INTO property_owners(org_id,property_id,owner_contact_id) VALUES($1,$2,$3)`,[ORG_ID,p,owner.id]);
 const lease=(await query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,end_date,currency,rent_amount_minor) VALUES($1,$2,$3,$3,'draft','2098-01-01','2098-12-31','TWD',0) RETURNING id::text`,[ORG_ID,p,u])).rows[0].id;
 await query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')`,[ORG_ID,lease,tenant.id]);
 const document=await PDFDocument.create();document.addPage();const bytes=await document.save();let sends=0;const flow=new EsignFlow({enabled:()=>true,mail:async()=>{sends++;return {ok:true,messageId:'synthetic',provider:'cloudflare'};}});
 const ref={kind:'property' as const,id:p};const view=await archiveView(s,ref);assert.equal(view.state,'ready');if(view.state!=='ready')throw new Error('View unavailable');
 await withClient(async holder=>{let held=false;const jobs:Promise<unknown>[]=[];let primary:unknown;let failed=false;const start=<T>(work:Promise<T>)=>{work.catch(()=>{});jobs.push(work);return work;};
  const wait=async(blocker:number,fragment:string)=>withClient(async observer=>{for(let n=0;n<100;n++){await observer.query('SELECT pg_catalog.pg_stat_clear_snapshot()');const r=await observer.query<{pid:number}>(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE $2`,[blocker,`%${fragment}%`]);if(r.rows.length===1)return r.rows[0].pid;if(r.rows.length>1)throw new Error('Ambiguous waiter');await new Promise(resolve=>setTimeout(resolve,30));}throw new Error('Expected waiter absent');});
  try{await holder.query('BEGIN');held=true;const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid;await holder.query(`SELECT id FROM leases WHERE id=$1 FOR UPDATE`,[lease]);
   const creating=start(flow.execute(s,{type:'create',leaseId:lease,pdf:bytes,ownerId:USERS.owner,tenantId:USERS.tenant,ownerDocument:false,tenantDocument:false,order:'parallel',deadline:'2099-01-01'}));const signerPid=await wait(pid,'FOR UPDATE');
   const archiving=start(archiveCommand(s,{ref,desired:'archived',expectedVersion:view.observed.version,renderedScope:archiveScope(s),reason:'Retired',requestId:randomUUID()}));await wait(signerPid,'pg_advisory_xact_lock');
   await holder.query('COMMIT');held=false;assert.equal((await bounded(creating)).leaseId,lease);assert.equal((await bounded(archiving)).state,'blocked');
  }catch(error){failed=true;primary=error;}
  const cleanup:unknown[]=[];if(held)try{await holder.query('ROLLBACK');}catch(error){cleanup.push(error);}try{await bounded(Promise.allSettled(jobs));}catch(error){cleanup.push(error);}
  if(failed&&cleanup.length)throw new AggregateError([primary,...cleanup],'Enhanced-signing-first race and cleanup failed');if(failed)throw primary;if(cleanup.length)throw new AggregateError(cleanup,'Cleanup failed');
 });
 assert.equal(sends,2);assert.equal((await query(`SELECT v.id FROM esign_versions v JOIN esign_cases c ON c.id=v.case_id WHERE c.lease_id=$1 AND v.status='sent'`,[lease])).rowCount,1);
});

test('unchanged historical ticket assignment and notes remain available after archive',async()=>{
 const sid=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.manager,randomUUID()]);
 const s:Session={userId:USERS.manager,sessionId:sid,email:'',name:'manager',kind:'staff',role:'manager',orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};
 const member=(await query<{id:string}>(`SELECT id::text FROM org_members WHERE org_id=$1 AND user_id=$2`,[ORG_ID,s.userId])).rows[0];assert.ok(member);
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone,archived_at) VALUES($1,$2,'TW','TWD','Asia/Taipei',now()) RETURNING id::text`,[ORG_ID,`B015 historical ticket ${randomUUID()}`])).rows[0].id;
 const ticket=(await query<{id:string}>(`INSERT INTO maintenance_tickets(org_id,ticket_number,property_id,category,priority,status,title,assigned_member_id) VALUES($1,900005,$2,'other','normal','resolved','Historical',$3) RETURNING id::text`,[ORG_ID,p,member.id])).rows[0].id;
 await updateTicket(s,ticket,{status:'resolved',assigneeMemberId:member.id,note:'Synthetic historical note'});
 assert.equal((await query(`SELECT id FROM ticket_comments WHERE org_id=$1 AND ticket_id=$2 AND body='Synthetic historical note'`,[ORG_ID,ticket])).rowCount,1);
});
