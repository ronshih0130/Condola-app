import assert from 'node:assert/strict';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Client } from 'pg';
import { query, tx, withClient } from './db';
import { ORG_ID, ORG2_ID, USERS } from './ids';
import { resetAndSeed } from './seed';
import { cloneTestDatabase } from './test-database-clone';
import { disposableDbUrl } from './test-disposable-db';
import { archiveCommand, archiveList, archiveScope, archiveView, recordArchiveEnabled } from './record-archive';
import { listOwnerDirectory, listOwners, listTenants, ownerEditor } from './queries';
import type { Session } from './types';
import type { ArchiveRef } from '@/lib/record-archive';

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone:Awaited<ReturnType<typeof cloneTestDatabase>>;
let staff:Session;
test.before(async()=>{
 clone=await cloneTestDatabase();
 const names=['DEMO_MODE','ID_DOC_ENCRYPTION_KEY','ID_DOC_HMAC_KEY','ID_DOC_SIGNING_SECRET','CRON_SECRET'] as const;
 const saved=Object.fromEntries(names.map(k=>[k,process.env[k]]));
 try{process.env.DEMO_MODE='true';for(const k of names.slice(1))process.env[k]=randomBytes(32).toString('hex');await resetAndSeed();}
 finally{for(const k of names){const v=saved[k];if(v===undefined)delete process.env[k];else process.env[k]=v;}}
 const sid=randomUUID();await query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')`,[sid,USERS.admin,randomUUID()]);
 staff={userId:USERS.admin,sessionId:sid,email:'',name:'admin',kind:'staff',role:'admin',orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'en',calendar:'gregorian',leaseId:null};
});
test.after(async()=>{await clone?.cleanup();});
async function flags(on=true){
 await query(`INSERT INTO platform_settings(key,value) VALUES('record_archive',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text))) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,[ORG_ID]);
 await query(`UPDATE organizations SET feature_flags=coalesce(feature_flags,'{}')||jsonb_build_object('record_archive',$2::boolean) WHERE id=$1`,[ORG_ID,on]);
}
async function fixture(org=ORG_ID){
 const p=(await query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[org,`DB archive ${randomUUID()}`])).rows[0].id;
 const u=(await query<{id:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode) VALUES($1,$2,'unit','by_room') RETURNING id::text`,[org,p])).rows[0].id;
 const r=(await query<{id:string}>(`INSERT INTO rooms(org_id,unit_id,label) VALUES($1,$2,'room') RETURNING id::text`,[org,u])).rows[0].id;
 const c=(await query<{id:string}>(`INSERT INTO contacts(org_id,is_owner,is_tenant,is_vendor,display_name) VALUES($1,true,true,true,$2) RETURNING id::text`,[org,`Owner ${randomUUID()}`])).rows[0].id;
 return {p,u,r,c};
}
const raw=(sql:string,args:unknown[]=[])=>tx(USERS.admin,c=>c.query(sql,args),{orgId:ORG_ID,environment:'live'});
const code=(e:unknown)=>{const x=e as {code?:string;cause?:{code?:string}};return x.code??x.cause?.code;};
const rejected=(fn:()=>Promise<unknown>,expected='23514')=>assert.rejects(fn,e=>code(e)===expected);
const leaseSql=`INSERT INTO leases(org_id,property_id,unit_id,target_room_id,status,start_date,end_date,currency,rent_amount_minor) VALUES($1,$2,$3,$4,'active','2097-01-01','2097-12-31','TWD',0)`;
const ownerSql=`INSERT INTO property_owners(org_id,property_id,owner_contact_id) VALUES($1,$2,$3)`;
async function command(ref:ArchiveRef,desired:'active'|'archived'='archived'){
 const view=await archiveView(staff,ref);assert.equal(view.state,'ready');if(view.state!=='ready')throw new Error('Missing archive view');
 return archiveCommand(staff,{ref,desired,expectedVersion:view.observed.version,renderedScope:archiveScope(staff),reason:'Local invariant test',requestId:randomUUID()});
}
async function begin(c:Client,role:'authenticated'|'service_role'='authenticated'){
 await c.query('BEGIN');await c.query(`SET LOCAL statement_timeout='10s'`);
 await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`,[USERS.admin,ORG_ID]);
 await c.query(`SET LOCAL ROLE ${role}`);
}
async function gateway(c:Client,ref:ArchiveRef,x?:string,desired=true){
 const table={property:'properties',unit:'units',room:'rooms',owner:'contacts'}[ref.kind];
 const xmin=x??(await c.query<{x:string}>(`SELECT xmin::text x FROM ${table} WHERE id=$1`,[ref.id])).rows[0].x;
 return (await c.query<{state:string}>(`SELECT app.b015_archive_record($1,$2,'live',$3,$4,$5,$6,$7,'DB gateway test',$8) state`,[ORG_ID,ORG_ID,staff.sessionId,ref.kind,ref.id,desired,xmin,randomUUID()])).rows[0].state;
}
async function directGateway(ref:ArchiveRef,desired=true){return withClient(async c=>{await begin(c,'service_role');try{const result=await gateway(c,ref,undefined,desired);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}});}

test('owner archive/restore preserves mixed roles, login identity and authorized history; only active owner lists hide it',async()=>{
 await flags();const f=await fixture();
 const contact=(await query<{id:string}>(`SELECT id::text FROM contacts WHERE org_id=$1 AND user_id=$2`,[ORG_ID,USERS.tenant])).rows[0].id;
 await query(`UPDATE contacts SET is_owner=true,is_vendor=true WHERE id=$1`,[contact]);
 await query(`INSERT INTO property_owners(org_id,property_id,owner_contact_id,effective_from,effective_to) VALUES($1,$2,$3,'2000-01-01','2001-01-01')`,[ORG_ID,f.p,contact]);
 const before=(await query(`SELECT to_jsonb(c)-ARRAY['owner_archived_at','owner_archived_by','owner_archive_reason','updated_at'] snapshot FROM contacts c WHERE id=$1`,[contact])).rows[0];
 const histories=async()=>tx(USERS.admin,async c=>{
  const result:Record<string,unknown>={};
  for(const table of ['property_owners','leases','lease_parties','identity_documents','files','owner_statements'])result[table]=(await c.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') rows FROM ${table} t WHERE org_id=$1`,[ORG_ID])).rows[0].rows;
  return result;
 },{orgId:ORG_ID});
 const history=await histories();
 const ref={kind:'owner' as const,id:contact};assert.equal((await command(ref)).state,'changed');
 const marker=(await query(`SELECT owner_archived_at,owner_archived_by::text,owner_archive_reason FROM contacts WHERE id=$1`,[contact])).rows[0];assert.ok(marker.owner_archived_at);assert.equal(marker.owner_archived_by,USERS.admin);
 assert.deepEqual((await query(`SELECT to_jsonb(c)-ARRAY['owner_archived_at','owner_archived_by','owner_archive_reason','updated_at'] snapshot FROM contacts c WHERE id=$1`,[contact])).rows[0],before);
 assert.deepEqual(await histories(),history);
 assert.ok((await listTenants(staff)).some(c=>c.id===contact));
 assert.ok(!(await listOwners(staff)).some(c=>c.id===contact));assert.ok(!(await listOwnerDirectory(staff)).some(c=>c.id===contact));
 assert.ok((await listOwners(staff,true)).some(c=>c.id===contact));assert.ok(await ownerEditor(staff,contact));
 const list=await archiveList(staff);assert.equal(list.state,'ready');if(list.state==='ready')assert.ok(list.rows.some(r=>r.ref.kind==='owner'&&r.ref.id===contact));
 await flags(false);assert.ok((await listOwners(staff)).some(c=>c.id===contact));assert.ok((await listOwnerDirectory(staff)).some(c=>c.id===contact));
 const offBefore=await query(`SELECT to_jsonb(c) snapshot FROM contacts c WHERE id=$1`,[contact]);assert.equal((await command(ref,'active')).state,'disabled');assert.deepEqual((await query(`SELECT to_jsonb(c) snapshot FROM contacts c WHERE id=$1`,[contact])).rows,offBefore.rows);
 await flags();assert.equal((await command(ref,'active')).state,'changed');assert.ok((await listOwners(staff)).some(c=>c.id===contact));assert.deepEqual(await histories(),history);
 assert.deepEqual((await query(`SELECT owner_archived_at,owner_archived_by,owner_archive_reason FROM contacts WHERE id=$1`,[contact])).rows[0],{owner_archived_at:null,owner_archived_by:null,owner_archive_reason:null});
});

for(const parent of ['property','unit','room'] as const)test(`raw active/pending lease insert and draft activation reject archived ${parent}; OFF preserves old behavior`,async()=>{
 const f=await fixture();await flags();const id={property:f.p,unit:f.u,room:f.r}[parent];assert.equal(await directGateway({kind:parent,id}),'changed');
 const args=[ORG_ID,f.p,f.u,f.r];await rejected(()=>raw(leaseSql,args));
 await rejected(()=>raw(leaseSql.replace("'active'","'pending_signature'"),args));
 const draft=(await raw(leaseSql.replace("'active'","'draft'")+' RETURNING id',args)).rows[0].id;
 await rejected(()=>raw(`UPDATE leases SET status='active' WHERE id=$1`,[draft]));
 await flags(false);await raw(`UPDATE leases SET status='active' WHERE id=$1`,[draft]);
});
for(const parent of ['property','owner'] as const)test(`raw owner assignment rejects archived ${parent}; OFF preserves old behavior`,async()=>{
 const f=await fixture();await flags();assert.equal(await directGateway({kind:parent,id:parent==='owner'?f.c:f.p}),'changed');
 await rejected(()=>raw(ownerSql,[ORG_ID,f.p,f.c]));await flags(false);await raw(ownerSql,[ORG_ID,f.p,f.c]);
});
for(const parent of ['property','unit'] as const)test(`raw child insertion rejects archived ${parent}; OFF preserves old behavior`,async()=>{
 const f=await fixture();await flags();assert.equal(await directGateway({kind:parent,id:parent==='property'?f.p:f.u}),'changed');
 const sql=parent==='property'?`INSERT INTO units(org_id,property_id,label) VALUES($1,$2,$3)`:`INSERT INTO rooms(org_id,unit_id,label) VALUES($1,$2,$3)`;
 const args=[ORG_ID,parent==='property'?f.p:f.u,randomUUID()];await rejected(()=>raw(sql,args));await flags(false);await raw(sql,args);
});
for(const kind of ['property','unit','room','owner'] as const)test(`${kind} markers reject raw UPDATE and nonnull INSERT; unchanged-marker edits and trusted service remain allowed`,async()=>{
 const f=await fixture();await flags();const table={property:'properties',unit:'units',room:'rooms',owner:'contacts'}[kind],id={property:f.p,unit:f.u,room:f.r,owner:f.c}[kind],col=kind==='owner'?'owner_archived_at':'archived_at';
 await rejected(()=>raw(`UPDATE ${table} SET ${col}=clock_timestamp() WHERE id=$1`,[id]),'42501');
 const insert={property:`INSERT INTO properties(org_id,name,country_code,currency,timezone,archived_at) VALUES($1,'marker','TW','TWD','Asia/Taipei',now())`,unit:`INSERT INTO units(org_id,property_id,label,archived_at) VALUES($1,$2,'marker',now())`,room:`INSERT INTO rooms(org_id,unit_id,label,archived_at) VALUES($1,$2,'marker',now())`,owner:`INSERT INTO contacts(org_id,is_owner,display_name,owner_archived_at) VALUES($1,true,'marker',now())`}[kind];
 await rejected(()=>raw(insert,kind==='unit'?[ORG_ID,f.p]:kind==='room'?[ORG_ID,f.u]:[ORG_ID]),'42501');
 await raw(`UPDATE ${table} SET ${col}=${col} WHERE id=$1`,[id]);
 await withClient(async c=>{await begin(c,'service_role');try{await c.query(`UPDATE ${table} SET ${col}=clock_timestamp() WHERE id=$1`,[id]);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}});
 await rejected(()=>raw(`UPDATE ${table} SET ${col}=NULL WHERE id=$1`,[id]),'42501');
 await flags(false);await raw(`UPDATE ${table} SET ${col}=NULL WHERE id=$1`,[id]);
});

test('owner actor/reason metadata is sealed independently; flags and GUCs cannot grant gateway execution',async()=>{
 await flags();const f=await fixture();
 for(const col of ['owner_archived_by','owner_archive_reason'])await rejected(()=>raw(`UPDATE contacts SET ${col}=$2 WHERE id=$1`,[f.c,col==='owner_archived_by'?USERS.admin:'forged']),'42501');
 await rejected(()=>tx(USERS.admin,async c=>{await c.query(`SELECT set_config('app.archive_gateway','true',true),set_config('request.jwt.claim.role','service_role',true)`);return gateway(c,{kind:'owner',id:f.c});},{orgId:ORG_ID}),'42501');
});

test('SQL gateway independently rejects active lease/ownership dependencies and permits ended history',async()=>{
 await flags();const f=await fixture();await raw(leaseSql,[ORG_ID,f.p,f.u,f.r]);
 for(const ref of [{kind:'property',id:f.p},{kind:'unit',id:f.u},{kind:'room',id:f.r}] as const)assert.equal(await directGateway(ref),'blocked');
 await raw(ownerSql,[ORG_ID,f.p,f.c]);assert.equal(await directGateway({kind:'owner',id:f.c}),'blocked');
 await raw(`UPDATE leases SET status='ended' WHERE property_id=$1`,[f.p]);await raw(`UPDATE property_owners SET effective_to=current_date-1 WHERE property_id=$1`,[f.p]);
 assert.equal(await directGateway({kind:'owner',id:f.c}),'changed');assert.equal(await directGateway({kind:'property',id:f.p}),'changed');
});

test('SQL gateway mirrors repair blockers; resolved work remains readable',async()=>{
 await flags();const f=await fixture();
 const ticket=(await query<{id:string}>(`INSERT INTO maintenance_tickets(org_id,ticket_number,property_id,unit_id,room_id,category,title,description,status) VALUES($1,990015,$2,$3,$4,'other','Synthetic','Synthetic','open') RETURNING id::text`,[ORG_ID,f.p,f.u,f.r])).rows[0].id;
 assert.equal(await directGateway({kind:'unit',id:f.u}),'blocked');await query(`UPDATE maintenance_tickets SET status='resolved' WHERE id=$1`,[ticket]);assert.equal(await directGateway({kind:'unit',id:f.u}),'changed');assert.equal((await raw(`SELECT id FROM maintenance_tickets WHERE id=$1`,[ticket])).rowCount,1);
});

test('cross-org ancestry and owner references fail closed; gateway does not expose another org target',async()=>{
 await flags();const local=await fixture(),foreign=await fixture(ORG2_ID);
 await rejected(()=>raw(ownerSql,[ORG_ID,local.p,foreign.c]));await rejected(()=>raw(ownerSql,[ORG_ID,foreign.p,local.c]));
 await rejected(()=>raw(leaseSql,[ORG_ID,local.p,foreign.u,foreign.r]),'P0001');
 await rejected(()=>directGateway({kind:'owner',id:foreign.c}));
 assert.equal((await archiveView(staff,{kind:'owner',id:foreign.c})).state,'unavailable');
});

for(const control of [null,false,{enabled:false,allowed_org_ids:[ORG_ID]},{enabled:'true',allowed_org_ids:[ORG_ID]},{enabled:true,allowed_org_ids:null},{enabled:true,allowed_org_ids:[]},{enabled:true,allowed_org_ids:[ORG_ID,'bad']}] )test(`strict SQL flag OFF ${JSON.stringify(control)} causes no gateway writes or rejection side effects`,async()=>{
 await flags();const f=await fixture();if(control===null)await query(`DELETE FROM platform_settings WHERE key='record_archive'`);else await query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='record_archive'`,[JSON.stringify(control)]);
 const before=(await query(`SELECT to_jsonb(p) snapshot FROM properties p WHERE id=$1`,[f.p])).rows;
 const audit=(await query(`SELECT count(*)::int n FROM audit_log`)).rows[0].n;
 assert.equal(await recordArchiveEnabled(staff),false);assert.equal(await directGateway({kind:'property',id:f.p}),'disabled');assert.deepEqual((await query(`SELECT to_jsonb(p) snapshot FROM properties p WHERE id=$1`,[f.p])).rows,before);assert.equal((await query(`SELECT count(*)::int n FROM audit_log`)).rows[0].n,audit);
 await raw(`UPDATE properties SET archived_at=now() WHERE id=$1`,[f.p]);await raw(leaseSql,[ORG_ID,f.p,f.u,f.r]);
});

async function waitBlocked(waiter:Client,holderPid:number){
 const pid=(waiter as Client & {processID:number}).processID;
 for(let n=0;n<150;n++){
  const r=await query<{blocked:boolean}>(`SELECT $1=ANY(pg_blocking_pids($2)) blocked`,[holderPid,pid]);if(r.rows[0].blocked)return;
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 throw new Error('Expected database lock wait was not observed');
}
for(const scenario of ['owner','unit'] as const)for(const first of ['archive','work'] as const)test(`deterministic ${scenario} race: ${first} holds parent; exactly one operation wins`,async()=>{
 await flags();const f=await fixture();const ref={kind:scenario,id:scenario==='owner'?f.c:f.u};
 const a=new Client({connectionString:clone.url}),b=new Client({connectionString:clone.url});await a.connect();await b.connect();
 let pending:Promise<unknown>|undefined;
 try{
  await begin(a,first==='archive'?'service_role':'authenticated');await begin(b,first==='archive'?'authenticated':'service_role');
  const table=scenario==='owner'?'contacts':'units';
  // Explicit lock by the first transaction establishes the order, not a timer.
  if(scenario==='unit')await a.query(`SELECT id FROM properties WHERE id=$1 FOR NO KEY UPDATE`,[f.p]);
  await a.query(`SELECT id FROM ${table} WHERE id=$1 FOR NO KEY UPDATE`,[ref.id]);
  const holderPid=(await a.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0].pid;
  const x=(await a.query<{x:string}>(`SELECT xmin::text x FROM ${table} WHERE id=$1`,[ref.id])).rows[0].x;
  const work=(c:Client)=>scenario==='owner'?c.query(ownerSql,[ORG_ID,f.p,f.c]):c.query(leaseSql,[ORG_ID,f.p,f.u,f.r]);
  if(first==='archive'){
   assert.equal(await gateway(a,ref,x),'changed');pending=work(b);pending.catch(()=>{});await waitBlocked(b,holderPid);await a.query('COMMIT');await rejected(()=>pending!);
  }else{
   await work(a);pending=gateway(b,ref,x);pending.catch(()=>{});await waitBlocked(b,holderPid);await a.query('COMMIT');assert.equal(await pending,'blocked');await b.query('COMMIT');
  }
  const marker=(await query<{archived:boolean}>(`SELECT ${scenario==='owner'?'owner_archived_at':'archived_at'} IS NOT NULL archived FROM ${table} WHERE id=$1`,[ref.id])).rows[0].archived;
  const count=(await query<{n:number}>(scenario==='owner'?`SELECT count(*)::int n FROM property_owners WHERE owner_contact_id=$1`:`SELECT count(*)::int n FROM leases WHERE unit_id=$1`,[ref.id])).rows[0].n;
  assert.equal(Number(marker)+Number(count===1),1);assert.equal(marker,first==='archive');
 }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');if(pending)await Promise.allSettled([pending]);await a.end();await b.end();}
});

test('function catalog restricts the gateway, seals helpers, and fixes every definer search path',async()=>{
 const rows=(await query<{name:string;definer:boolean;config:string[];anon:boolean;authenticated:boolean;service:boolean;public:boolean}>(`SELECT p.proname name,p.prosecdef definer,p.proconfig config,has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,has_function_privilege('service_role',p.oid,'EXECUTE') service,EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) WHERE grantee=0 AND privilege_type='EXECUTE') public FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname LIKE 'b015_archive_%'`)).rows;
 assert.equal(rows.length,8);
 for(const r of rows){assert.equal(r.public,false);assert.ok(r.config.includes('search_path=pg_catalog, public, app, pg_temp'));if(r.name==='b015_archive_record'){assert.equal(r.definer,true);assert.equal(r.anon,false);assert.equal(r.authenticated,false);assert.equal(r.service,true);}else if(['b015_archive_enabled','b015_archive_lock_path','b015_archive_lock_ticket'].includes(r.name)){assert.equal(r.authenticated,true);}else {assert.equal(r.anon,false);assert.equal(r.authenticated,false);assert.equal(r.service,false);}}
});

for(const optIn of [null,false,'true',1])test(`org opt-in ${JSON.stringify(optIn)} is strictly OFF for gateway and raw admission`,async()=>{
 await flags();const f=await fixture();
 await query(`UPDATE organizations SET feature_flags=CASE WHEN $2::jsonb='null'::jsonb THEN feature_flags-'record_archive' ELSE feature_flags||jsonb_build_object('record_archive',$2::jsonb) END WHERE id=$1`,[ORG_ID,JSON.stringify(optIn)]);
 assert.equal(await recordArchiveEnabled(staff),false);assert.equal(await directGateway({kind:'owner',id:f.c}),'disabled');
 await raw(`UPDATE contacts SET owner_archived_at=now() WHERE id=$1`,[f.c]);await raw(ownerSql,[ORG_ID,f.p,f.c]);
});

test('raw reparent, active lease move, and owner reassignment cannot enter archived ancestry',async()=>{
 await flags();const a=await fixture(),b=await fixture();
 await raw(leaseSql,[ORG_ID,a.p,a.u,a.r]);await raw(ownerSql,[ORG_ID,a.p,a.c]);
 assert.equal(await directGateway({kind:'property',id:b.p}),'changed');assert.equal(await directGateway({kind:'owner',id:b.c}),'changed');
 await rejected(()=>raw(`UPDATE units SET property_id=$2 WHERE id=$1`,[a.u,b.p]));
 await rejected(()=>raw(`UPDATE rooms SET unit_id=$2 WHERE id=$1`,[a.r,b.u]));
 await rejected(()=>raw(`UPDATE leases SET property_id=$2,unit_id=$3,target_room_id=$4 WHERE unit_id=$1`,[a.u,b.p,b.u,b.r]));
 await rejected(()=>raw(`UPDATE property_owners SET owner_contact_id=$2 WHERE owner_contact_id=$1`,[a.c,b.c]));
});

test('anon guards use actual current_user even with a spoofed service claim',async()=>{
 await flags();const f=await fixture();
 await withClient(async c=>{
  await c.query('BEGIN');
  try{
   // Transaction-local test grants/policies only: reach the trigger under anon
   // despite production RLS denying these writes already. Always rolled back.
   await c.query('GRANT SELECT,UPDATE ON public.properties TO anon');
   await c.query('CREATE POLICY b015_test_anon_read ON public.properties FOR SELECT TO anon USING(true)');
   await c.query('CREATE POLICY b015_test_anon_update ON public.properties FOR UPDATE TO anon USING(true) WITH CHECK(true)');
   await c.query(`SELECT set_config('request.jwt.claim.role','service_role',true)`);
   await c.query('SET LOCAL ROLE anon');await c.query('SAVEPOINT marker');
   await assert.rejects(()=>c.query(`UPDATE properties SET archived_at=now() WHERE id=$1`,[f.p]),e=>code(e)==='42501'&&(e as Error).message==='Use the archive gateway');
   await c.query('ROLLBACK TO SAVEPOINT marker');
   await c.query('RESET ROLE');await c.query(`UPDATE organizations SET feature_flags=feature_flags||'{"record_archive":false}'::jsonb WHERE id=$1`,[ORG_ID]);await c.query('SET LOCAL ROLE anon');
   assert.equal((await c.query(`UPDATE properties SET archived_at=now() WHERE id=$1`,[f.p])).rowCount,1);
  }finally{await c.query('ROLLBACK');}
 });
});

test('raw UPDATE fails promptly if it already holds a child row and the parent is busy',async()=>{
 await flags();const a=await fixture(),b=await fixture();const holder=new Client({connectionString:clone.url}),writer=new Client({connectionString:clone.url});await holder.connect();await writer.connect();
 try{await begin(holder);await holder.query(`SELECT id FROM properties WHERE id=$1 FOR NO KEY UPDATE`,[b.p]);await begin(writer);await rejected(()=>writer.query(`UPDATE units SET property_id=$2 WHERE id=$1`,[a.u,b.p]),'55P03');}
 finally{await holder.query('ROLLBACK');await writer.query('ROLLBACK');await holder.end();await writer.end();}
});

test('SQL gateway mirrors live dispatch and signing dependencies independently of lease/ticket status',async()=>{
 await flags();const f=await fixture();
 const ticket=(await query<{id:string}>(`INSERT INTO maintenance_tickets(org_id,ticket_number,property_id,unit_id,room_id,category,title,status) VALUES($1,990016,$2,$3,$4,'other','Synthetic','resolved') RETURNING id::text`,[ORG_ID,f.p,f.u,f.r])).rows[0].id;
 const job=(await query<{id:string}>(`INSERT INTO repair_vendor_jobs(org_id,ticket_id,vendor_name,vendor_phone,contact_window,token_hash,expires_at,active,created_by) VALUES($1,$2,'Synthetic','+19995550101','daytime',$3,clock_timestamp()+interval '1 day',true,$4) RETURNING id::text`,[ORG_ID,ticket,randomBytes(32).toString('hex'),USERS.admin])).rows[0].id;
 assert.equal(await directGateway({kind:'room',id:f.r}),'blocked');await query(`UPDATE repair_vendor_jobs SET expires_at=clock_timestamp()-interval '1 day' WHERE id=$1`,[job]);
 const lease=(await query<{id:string}>(leaseSql.replace("'active'","'draft'")+' RETURNING id::text',[ORG_ID,f.p,f.u,f.r])).rows[0].id;
 const caseId=(await query<{id:string}>(`INSERT INTO esign_cases(org_id,lease_id,created_by,retention_until) VALUES($1,$2,$3,'2100-01-01') RETURNING id::text`,[ORG_ID,lease,USERS.admin])).rows[0].id;
 await query(`INSERT INTO esign_versions(id,case_id,status,body,pdf_bytes,content_digest,state,retention_until) VALUES($1,$2,'draft','Synthetic',decode('01','hex'),encode(sha256(decode('01','hex')),'hex'),jsonb_build_object('id',$1::uuid::text,'body','Synthetic','documentDigest',encode(sha256(decode('01','hex')),'hex'),'status','draft'),'2100-01-01')`,[randomUUID(),caseId]);
 await query(`UPDATE esign_versions SET status='sent',state=jsonb_set(state,'{status}','\"sent\"'::jsonb) WHERE case_id=$1`,[caseId]);
 assert.equal(await directGateway({kind:'room',id:f.r}),'blocked');
});

test('SQL gateway mirrors draft utility contribution and permits void history',async()=>{
 await flags();const f=await fixture();
 const meter=(await query<{id:string}>(`INSERT INTO meters(org_id,property_id,unit_id,utility,rate_source) VALUES($1,$2,$3,'electricity','bill_average') RETURNING id::text`,[ORG_ID,f.p,f.u])).rows[0];assert.ok(meter);
 const run=(await query<{id:string}>(`INSERT INTO utility_allocation_runs(org_id,unit_id,meter_id,period_start,period_end,split_method,rate_source,currency,total_usage,rate_minor_per_unit,total_amount_minor) VALUES($1,$2,$3,'2096-01-01','2096-02-01','even','bill_average','TWD',1,100,100) RETURNING id::text`,[ORG_ID,f.u,meter.id])).rows[0].id;
 assert.equal(await directGateway({kind:'unit',id:f.u}),'blocked');assert.equal(await directGateway({kind:'property',id:f.p}),'blocked');
 await query(`UPDATE utility_allocation_runs SET status='void',void_reason='Synthetic correction',voided_by=$2,voided_at=clock_timestamp() WHERE id=$1`,[run,USERS.admin]);assert.equal(await directGateway({kind:'unit',id:f.u}),'changed');
});

test('owner portal statements, files and property history remain authorized after owner-only archive',async()=>{
 await flags();const owner=(await query<{id:string}>(`SELECT id::text FROM contacts WHERE org_id=$1 AND user_id=$2`,[ORG_ID,USERS.owner])).rows[0].id;
 await query(`INSERT INTO files(org_id,storage_bucket,storage_path,file_name,mime_type,size_bytes,uploaded_by) VALUES($1,'synthetic',$2,'history.pdf','application/pdf',1,$3)`,[ORG_ID,randomUUID(),USERS.owner]);
 // Retired properties allow retaining the actual current ownership links. The
 // owner-only command must not remove those links or revoke portal entitlement.
 await query(`UPDATE properties SET archived_at=clock_timestamp() WHERE org_id=$1 AND id IN(SELECT property_id FROM property_owners WHERE owner_contact_id=$2)`,[ORG_ID,owner]);
 const visible=()=>tx(USERS.owner,async c=>({statements:(await c.query(`SELECT to_jsonb(s) row FROM owner_statements s WHERE org_id=$1 ORDER BY id`,[ORG_ID])).rows,files:(await c.query(`SELECT to_jsonb(f) row FROM files f WHERE org_id=$1 ORDER BY id`,[ORG_ID])).rows,properties:(await c.query(`SELECT id::text FROM properties WHERE org_id=$1 ORDER BY id`,[ORG_ID])).rows}),{orgId:ORG_ID});
 const before=await visible();assert.ok(before.statements.length>0);assert.ok(before.properties.length>0);assert.ok(before.files.length>0);
 const links=(await query(`SELECT to_jsonb(p) row FROM property_owners p WHERE owner_contact_id=$1 ORDER BY id`,[owner])).rows;
 assert.equal((await command({kind:'owner',id:owner})).state,'changed');assert.deepEqual(await visible(),before);assert.deepEqual((await query(`SELECT to_jsonb(p) row FROM property_owners p WHERE owner_contact_id=$1 ORDER BY id`,[owner])).rows,links);
 assert.equal((await command({kind:'owner',id:owner},'active')).state,'changed');assert.deepEqual(await visible(),before);
});

test('gateway rejects old transaction snapshots that could miss a committed child after a lock wait',async()=>{
 await flags();const f=await fixture();await withClient(async c=>{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');try{await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);await c.query('SET LOCAL ROLE service_role');await rejected(()=>gateway(c,{kind:'owner',id:f.c}),'25001');}finally{await c.query('ROLLBACK');}});
});

const wholeLeaseSql=leaseSql.replace('target_room_id','target_unit_id');
const ticketSql=`INSERT INTO maintenance_tickets(org_id,ticket_number,property_id,unit_id,room_id,category,title,status) VALUES($1,$2,$3,$4,$5,'other','Synthetic','open')`;

test('unit reparent rejects dependent records between active properties; later archive cannot miss the lease',async()=>{
 await flags();const a=await fixture(),b=await fixture();
 // No room dependency: exercise the whole-unit lease itself.
 await query(`DELETE FROM rooms WHERE id=$1`,[a.r]);await raw(`UPDATE units SET rental_mode='whole_unit' WHERE id=$1`,[a.u]);
 await raw(wholeLeaseSql,[ORG_ID,a.p,a.u,a.u]);
 await rejected(()=>raw(`UPDATE units SET property_id=$2 WHERE id=$1`,[a.u,b.p]));
 assert.equal((await query(`SELECT property_id::text FROM units WHERE id=$1`,[a.u])).rows[0].property_id,a.p);
 assert.equal(await directGateway({kind:'property',id:a.p}),'blocked');assert.equal(await directGateway({kind:'property',id:b.p}),'changed');
 await raw(`UPDATE leases SET status='ended' WHERE unit_id=$1`,[a.u]);
 await rejected(()=>raw(`UPDATE units SET property_id=$2 WHERE id=$1`,[a.u,b.p]));
});

test('empty units cannot escape archived ancestry or their own marker without explicit restore',async()=>{
 await flags();const a=await fixture(),b=await fixture();await query(`DELETE FROM rooms WHERE id=$1`,[a.r]);
 assert.equal(await directGateway({kind:'property',id:a.p}),'changed');
 await rejected(()=>raw(`UPDATE units SET property_id=$2 WHERE id=$1`,[a.u,b.p]));
 assert.equal(await directGateway({kind:'property',id:a.p},false),'changed');
 assert.equal(await directGateway({kind:'unit',id:a.u}),'changed');await rejected(()=>raw(`UPDATE units SET property_id=$2 WHERE id=$1`,[a.u,b.p]));
 assert.equal(await directGateway({kind:'unit',id:a.u},false),'changed');await raw(`UPDATE units SET property_id=$2,label='moved' WHERE id=$1`,[a.u,b.p]);
});

for(const source of ['property','unit','room'] as const)test(`room move cannot escape archived ${source}; restore and OFF retain allowed moves`,async()=>{
 await flags();const a=await fixture(),b=await fixture();
 const ref={kind:source,id:{property:a.p,unit:a.u,room:a.r}[source]};
 assert.equal(await directGateway(ref),'changed');
 const move=()=>raw(`UPDATE rooms SET unit_id=$2,label='moved' WHERE id=$1`,[a.r,b.u]);
 await rejected(move);
 assert.equal((await query(`SELECT unit_id::text FROM rooms WHERE id=$1`,[a.r])).rows[0].unit_id,a.u);
 assert.equal(await directGateway(ref,false),'changed');await move();
 await raw(`UPDATE rooms SET unit_id=$2 WHERE id=$1`,[a.r,a.u]);
 assert.equal(await directGateway(ref),'changed');await flags(false);await move();
 assert.equal((await query(`SELECT unit_id::text FROM rooms WHERE id=$1`,[a.r])).rows[0].unit_id,b.u);
});

for(const source of ['property','unit'] as const)test(`room move NOWAIT serializes with concurrent source ${source} archive and reports scoped busy`,async()=>{
 await flags();const a=await fixture(),b=await fixture();
 const ref={kind:source,id:source==='property'?a.p:a.u};
 const holder=new Client({connectionString:clone.url});await holder.connect();
 try{
  await begin(holder,'service_role');assert.equal(await gateway(holder,ref),'changed');
  await assert.rejects(()=>raw(`UPDATE rooms SET unit_id=$2,label='moved' WHERE id=$1`,[a.r,b.u]),e=>code(e)==='55P03'&&(e as {key?:string}).key==='errors.busy');
  await holder.query('COMMIT');
  await rejected(()=>raw(`UPDATE rooms SET unit_id=$2,label='moved' WHERE id=$1`,[a.r,b.u]));
  assert.equal((await query(`SELECT unit_id::text FROM rooms WHERE id=$1`,[a.r])).rows[0].unit_id,a.u);
 }finally{await holder.query('ROLLBACK');await holder.end();}
});

for(const enabled of [false,true])test(`untagged row contention preserves generic mapping with archive flag ${enabled}`,async()=>{
 await flags(enabled);const f=await fixture();const holder=new Client({connectionString:clone.url});await holder.connect();
 try{
  await begin(holder);await holder.query(`SELECT id FROM properties WHERE id=$1 FOR NO KEY UPDATE`,[f.p]);
  await assert.rejects(()=>raw(`SELECT id FROM properties WHERE id=$1 FOR NO KEY UPDATE NOWAIT`,[f.p]),e=>code(e)==='55P03'&&(e as {key?:string}).key==='errors.generic');
 }finally{await holder.query('ROLLBACK');await holder.end();}
});

test('property restore rejects owner-archived current assignments until explicit owner restore',async()=>{
 await flags();const f=await fixture();await raw(ownerSql,[ORG_ID,f.p,f.c]);
 assert.equal(await directGateway({kind:'property',id:f.p}),'changed');assert.equal(await directGateway({kind:'owner',id:f.c}),'changed');
 assert.equal(await directGateway({kind:'property',id:f.p},false),'blocked');
 assert.equal((await command({kind:'property',id:f.p},'active')).state,'blocked');
 assert.equal(await directGateway({kind:'owner',id:f.c},false),'changed');assert.equal(await directGateway({kind:'property',id:f.p},false),'changed');
});

for(const first of ['restore','archive'] as const)test(`property restore vs owner archive: ${first} holds contact; exactly one wins`,async()=>{
 await flags();const f=await fixture();await raw(ownerSql,[ORG_ID,f.p,f.c]);await directGateway({kind:'property',id:f.p});
 const a=new Client({connectionString:clone.url}),b=new Client({connectionString:clone.url});await a.connect();await b.connect();let pending:Promise<string>|undefined;
 try{
  await begin(a,'service_role');await begin(b,'service_role');
  const owner={kind:'owner' as const,id:f.c},property={kind:'property' as const,id:f.p};
  assert.equal(await gateway(a,first==='restore'?property:owner,undefined,first!=='restore'),'changed');
  pending=gateway(b,first==='restore'?owner:property,undefined,first==='restore');pending.catch(()=>{});
  await waitBlocked(b,(a as Client & {processID:number}).processID);await a.query('COMMIT');assert.equal(await pending,'blocked');await b.query('COMMIT');
  const row=(await query(`SELECT p.archived_at IS NOT NULL pa,c.owner_archived_at IS NOT NULL ca FROM properties p,contacts c WHERE p.id=$1 AND c.id=$2`,[f.p,f.c])).rows[0];
  assert.equal(row.pa,first==='archive');assert.equal(row.ca,first==='archive');
 }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');if(pending)await Promise.allSettled([pending]);await a.end();await b.end();}
});

test('whole-unit admission rechecks mode after waiting behind a committed by-room change',async()=>{
 await flags();const f=await fixture();await query(`DELETE FROM rooms WHERE id=$1`,[f.r]);await raw(`UPDATE units SET rental_mode='whole_unit' WHERE id=$1`,[f.u]);
 const a=new Client({connectionString:clone.url}),b=new Client({connectionString:clone.url});await a.connect();await b.connect();let pending:Promise<unknown>|undefined;
 try{
  await begin(a);await begin(b);await a.query(`UPDATE units SET rental_mode='by_room' WHERE id=$1`,[f.u]);
  pending=b.query(wholeLeaseSql,[ORG_ID,f.p,f.u,f.u]);pending.catch(()=>{});await waitBlocked(b,(a as Client & {processID:number}).processID);
  await a.query('COMMIT');await rejected(()=>pending!);
  assert.equal((await query(`SELECT count(*)::int n FROM leases WHERE unit_id=$1`,[f.u])).rows[0].n,0);
 }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');if(pending)await Promise.allSettled([pending]);await a.end();await b.end();}
});

for(const parent of ['property','unit','room'] as const)test(`maintenance insert/reopen rejects archived ${parent}, OFF retains legacy writes`,async()=>{
 await flags();const f=await fixture();const args=[ORG_ID,randomInt(1000000000),f.p,f.u,f.r];
 const ticket=(await raw(ticketSql.replace("'open'","'resolved'")+' RETURNING id',args)).rows[0].id;
 assert.equal(await directGateway({kind:parent,id:f[parent==='property'?'p':parent==='unit'?'u':'r']}),'changed');
 await rejected(()=>raw(ticketSql,[...args.slice(0,1),Number(args[1])+1,...args.slice(2)]));
 await rejected(()=>raw(`UPDATE maintenance_tickets SET status='open' WHERE id=$1`,[ticket]));
 // A room-only reference must still resolve/lock its actual unit.
 await rejected(()=>raw(ticketSql,[ORG_ID,Number(args[1])+2,f.p,null,f.r]));
 await flags(false);await raw(`UPDATE maintenance_tickets SET status='open' WHERE id=$1`,[ticket]);
});

for(const first of ['ticket','archive'] as const)test(`maintenance ${first}-first race serializes with property archive`,async()=>{
 await flags();const f=await fixture();const a=new Client({connectionString:clone.url}),b=new Client({connectionString:clone.url});await a.connect();await b.connect();let pending:Promise<unknown>|undefined;
 try{
  await begin(a,first==='archive'?'service_role':'authenticated');await begin(b,first==='archive'?'authenticated':'service_role');
  const work=(c:Client)=>c.query(ticketSql,[ORG_ID,randomInt(1000000000),f.p,f.u,f.r]);
  if(first==='archive'){assert.equal(await gateway(a,{kind:'property',id:f.p}),'changed');pending=work(b);}
  else {await work(a);pending=gateway(b,{kind:'property',id:f.p});}
  pending.catch(()=>{});await waitBlocked(b,(a as Client & {processID:number}).processID);await a.query('COMMIT');
  if(first==='archive')await rejected(()=>pending!);else {assert.equal(await pending,'blocked');await b.query('COMMIT');}
 }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');if(pending)await Promise.allSettled([pending]);await a.end();await b.end();}
});

for(const table of ['units','rooms','leases','property_owners','maintenance_tickets'] as const)test(`${table} ON CONFLICT admission rejects archived parents on insert and conflict paths`,async()=>{
 await flags();const f=await fixture();const id=randomUUID();
 const sql={units:`INSERT INTO units(id,org_id,property_id,label) VALUES($1,$2,$3,'upsert') ON CONFLICT(id) DO UPDATE SET label=EXCLUDED.label`,rooms:`INSERT INTO rooms(id,org_id,unit_id,label) VALUES($1,$2,$3,'upsert') ON CONFLICT(id) DO UPDATE SET label=EXCLUDED.label`,leases:`INSERT INTO leases(id,org_id,property_id,unit_id,target_room_id,status,start_date,end_date,currency,rent_amount_minor) VALUES($1,$2,$3,$4,$5,'draft','2098-01-01','2098-12-31','TWD',0) ON CONFLICT(id) DO UPDATE SET status='active'`,property_owners:`INSERT INTO property_owners(id,org_id,property_id,owner_contact_id) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET effective_to=NULL`,maintenance_tickets:`INSERT INTO maintenance_tickets(id,org_id,property_id,unit_id,room_id,ticket_number,title,status) VALUES($1,$2,$3,$4,$5,$6,'upsert','resolved') ON CONFLICT(id) DO UPDATE SET status='open'`}[table];
 const args=table==='rooms'?[id,ORG_ID,f.u]:table==='units'?[id,ORG_ID,f.p]:table==='property_owners'?[id,ORG_ID,f.p,f.c]:table==='leases'?[id,ORG_ID,f.p,f.u,f.r]:[id,ORG_ID,f.p,f.u,f.r,randomInt(1000000000)];
 await raw(sql,args);assert.equal(await directGateway({kind:'property',id:f.p}),'changed');
 await rejected(()=>raw(sql,args));
 const activeSql=sql.replace("'draft'","'active'").replace("'resolved'","'open'");
 await rejected(()=>raw(activeSql,[randomUUID(),...args.slice(1)]));
});

for(const upsert of [false,true])test(`opposing multi-parent ${upsert?'upsert':'insert'} batches abort one whole transaction with bounded 40P01`,async()=>{
 await flags();const x=await fixture(),y=await fixture();const a=new Client({connectionString:clone.url}),b=new Client({connectionString:clone.url});await a.connect();await b.connect();let pa:Promise<unknown>|undefined,pb:Promise<unknown>|undefined;
 const labelA=randomUUID(),labelB=randomUUID();
 const batch=`INSERT INTO units(id,org_id,property_id,label) VALUES($1,$3,$4,$6),($2,$3,$5,$6) ${upsert?'ON CONFLICT(id) DO UPDATE SET label=EXCLUDED.label':''}`;
 const ids=[randomUUID(),randomUUID(),randomUUID(),randomUUID()];
 if(upsert)for(const [i,p] of [x.p,y.p,y.p,x.p].entries())await query(`INSERT INTO units(id,org_id,property_id,label) VALUES($1,$2,$3,$4)`,[ids[i],ORG_ID,p,`before-${i}`]);
 try{
  await begin(a);await begin(b);
  // Establish opposite first-parent ownership before issuing actual two-row
  // statements. Observe a real wait edge before closing the deadlock cycle.
  await a.query(`SELECT id FROM properties WHERE id=$1 FOR NO KEY UPDATE`,[x.p]);await b.query(`SELECT id FROM properties WHERE id=$1 FOR NO KEY UPDATE`,[y.p]);
  pa=a.query(batch,[ids[0],ids[1],ORG_ID,x.p,y.p,labelA]);pa.catch(()=>{});await waitBlocked(a,(b as Client & {processID:number}).processID);
  pb=b.query(batch,[ids[2],ids[3],ORG_ID,y.p,x.p,labelB]);pb.catch(()=>{});
  const results=await Promise.allSettled([pa,pb]);
  assert.equal(results.filter(r=>r.status==='rejected').length,1);
  for(const [i,r] of results.entries()){
   if(r.status==='rejected'){assert.equal(code(r.reason),'40P01');assert.equal((r.reason as {detail?:string}).detail,'b015_archive_enabled_contention');await [a,b][i].query('ROLLBACK');}else await [a,b][i].query('COMMIT');
  }
  const counts=(await query(`SELECT label,count(*)::int n FROM units WHERE label=ANY($1::text[]) GROUP BY label`,[[labelA,labelB]])).rows;
  assert.equal(counts.length,1);assert.equal(counts[0].n,2);
 }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');await Promise.allSettled([pa,pb]);await a.end();await b.end();}
});

test('definer dependency reads ignore temporary shadow relations',async()=>{
 await flags();const f=await fixture();await raw(leaseSql,[ORG_ID,f.p,f.u,f.r]);
 await withClient(async c=>{await begin(c,'service_role');try{
  await c.query('CREATE TEMP TABLE leases (LIKE public.leases INCLUDING ALL)');
  assert.equal(await gateway(c,{kind:'property',id:f.p}),'blocked');
 }finally{await c.query('ROLLBACK');}});
});

test('runner transaction rolls back all migration DDL when appended history insertion fails',async()=>{
 const {readFileSync}=await import('node:fs');const migration=readFileSync('supabase/migrations/20261107010000_b015_archive_db_invariants.sql','utf8');
 const before=(await query(`SELECT oid::text FROM pg_proc WHERE pronamespace='app'::regnamespace AND proname LIKE 'b015_archive_%' ORDER BY oid`)).rows;
 await withClient(async c=>{await c.query('BEGIN');try{
  await c.query('CREATE TABLE public.b015_runner_rollback_probe(id integer)');
  const fs=(await c.query<{signature:string}>(`SELECT oid::regprocedure::text signature FROM pg_proc WHERE pronamespace='app'::regnamespace AND proname LIKE 'b015_archive_%'`)).rows;
  for(const f of fs)await c.query(`DROP FUNCTION ${f.signature} CASCADE`);
  await c.query('ALTER TABLE public.contacts DROP COLUMN owner_archived_at,DROP COLUMN owner_archived_by,DROP COLUMN owner_archive_reason');
  await c.query(migration);
  // Model the runner's appended history insert failing after every file statement.
  await assert.rejects(()=>c.query('INSERT INTO public.b015_runner_rollback_probe VALUES(1/0)'),e=>code(e)==='22012');
 }finally{await c.query('ROLLBACK');}});
 assert.equal((await query(`SELECT to_regclass('public.b015_runner_rollback_probe') r`)).rows[0].r,null);
 assert.deepEqual((await query(`SELECT oid::text FROM pg_proc WHERE pronamespace='app'::regnamespace AND proname LIKE 'b015_archive_%' ORDER BY oid`)).rows,before);
});

test('room-only maintenance admission retains its unit so unit archive sees the active work',async()=>{
 await flags();const f=await fixture();const ticket=(await raw(ticketSql+' RETURNING unit_id::text',[ORG_ID,randomInt(1000000000),f.p,null,f.r])).rows[0];
 assert.equal(ticket.unit_id,f.u);assert.equal(await directGateway({kind:'unit',id:f.u}),'blocked');
});

test('maintenance reopening while archive holds the parent returns NOWAIT, then rejects after archive commits',async()=>{
 await flags();const f=await fixture();const ticket=(await raw(ticketSql.replace("'open'","'resolved'")+' RETURNING id',[ORG_ID,randomInt(1000000000),f.p,f.u,f.r])).rows[0].id;
 await withClient(async holder=>{await begin(holder,'service_role');try{
  assert.equal(await gateway(holder,{kind:'unit',id:f.u}),'changed');
  await rejected(()=>raw(`UPDATE maintenance_tickets SET status='open' WHERE id=$1`,[ticket]),'55P03');
  await holder.query('COMMIT');
 }finally{await holder.query('ROLLBACK');}});
 await rejected(()=>raw(`UPDATE maintenance_tickets SET status='open' WHERE id=$1`,[ticket]));
});

test('ticket lock helper allows maintenance and exact tenant ancestry without allowing cross-org or arbitrary lease paths',async()=>{
 await flags();const f=await fixture(),foreign=await fixture(ORG2_ID);
 await query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text,$2::text)) WHERE key='record_archive'`,[ORG_ID,ORG2_ID]);
 await query(`UPDATE organizations SET feature_flags=feature_flags||'{"record_archive":true}'::jsonb WHERE id=$1`,[ORG2_ID]);
 const lock=`SELECT app.b015_archive_lock_ticket($1,$2,$3,$4,$5,false)`;
 await tx(USERS.maintenance,c=>c.query(lock,[ORG_ID,f.p,f.u,f.r,null]),{orgId:ORG_ID});
 await rejected(()=>tx(USERS.maintenance,c=>c.query(lock,[ORG2_ID,foreign.p,foreign.u,foreign.r,null]),{orgId:ORG_ID}),'42501');
 await rejected(()=>tx(USERS.tenant,c=>c.query(lock,[ORG_ID,f.p,f.u,f.r,null]),{orgId:ORG_ID}),'42501');
 const tenantLease=(await raw(leaseSql+' RETURNING id::text',[ORG_ID,f.p,f.u,f.r])).rows[0].id;
 await query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) SELECT $1,$2,id,'primary' FROM contacts WHERE org_id=$1 AND user_id=$3 AND is_tenant LIMIT 1`,[ORG_ID,tenantLease,USERS.tenant]);
 await tx(USERS.tenant,c=>c.query(lock,[ORG_ID,f.p,f.u,f.r,tenantLease]),{orgId:ORG_ID});
 const other=await fixture();
 await rejected(()=>tx(USERS.tenant,c=>c.query(lock,[ORG_ID,other.p,other.u,other.r,tenantLease]),{orgId:ORG_ID}),'42501');
 await flags();
});
