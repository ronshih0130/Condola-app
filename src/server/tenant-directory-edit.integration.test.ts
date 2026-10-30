import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import test from 'node:test';
import { Client } from 'pg';
import { ORG_ID,ORG2_ID,USERS } from './ids';
import { resetAndSeed } from './seed';
import { cloneTestDatabase } from './test-database-clone';
import { disposableDbUrl } from './test-disposable-db';
import { closeDirectoryEdit,directoryContactEditView,directoryEditStatus,editDirectoryContact } from './tenant-directory-edit';
import type { Session } from './types';
import { createConnection,createServer,type Socket } from 'node:net';

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone:Awaited<ReturnType<typeof cloneTestDatabase>>,owner:Client;
const sessions=new Map<string,string>();
async function session(user:string=USERS.manager,ms=3600000){const id=randomUUID();await owner.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+$4*interval '1 millisecond')`,[id,user,randomUUID(),ms]);sessions.set(user,id);return id;}
async function contact(name='Edit Source'){const id=randomUUID();await owner.query(`INSERT INTO contacts(id,org_id,is_tenant,display_name,email,phone_e164) VALUES($1,$2,true,$3,$4,'+19995550111')`,[id,ORG_ID,name,`${randomUUID()}@example.test`]);return id;}
async function snapshot(id:string){return (await owner.query<{s:string}>(`SELECT app.b015_contact_snapshot($1,$2) s`,[ORG_ID,id])).rows[0].s;}
async function controls(on=true){await owner.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',$2::boolean,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='tenant_directory_edit'`,[ORG_ID,on]);await owner.query(`UPDATE organizations SET feature_flags=feature_flags||'{"tenant_directory_edit":true}'::jsonb WHERE id=$1`,[ORG_ID]);}
async function client(){const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();return c;}
async function begin(c:Client,user:string){await c.query('BEGIN');await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','service_role',true)`,[user]);await c.query('SET LOCAL ROLE service_role');}
type Intent={contact:string;request:string;expected:string;name:string;email:string;phone:string;org?:string;live?:string;env?:string;sid?:string;user?:string};
async function invoke(c:Client,i:Intent){return (await c.query<{r:{status:string;outcome:string;request_id:string;recorded_at:string}}>(`SELECT app.b015_edit_contact($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) r`,[i.org??ORG_ID,i.live??ORG_ID,i.env??'live',i.sid??sessions.get(i.user??USERS.manager),i.contact,i.request,i.expected,i.name,i.email,i.phone])).rows[0].r;}
async function edit(i:Intent,after?:(c:Client)=>Promise<void>){const c=await client();try{await begin(c,i.user??USERS.manager);const result=await invoke(c,i);await after?.(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{await c.end();}}
async function status(id:string,request:string,user:string=USERS.manager){const c=await client();try{await begin(c,user);const r=(await c.query(`SELECT app.b015_edit_status($1,$1,'live',$2,$3,$4) r`,[ORG_ID,sessions.get(user),id,request])).rows[0].r;await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{await c.end();}}
async function facts(id:string){return (await owner.query(`SELECT to_jsonb(c) c,(SELECT count(*)::integer FROM auth.users) users,(SELECT count(*)::integer FROM profiles) profiles,(SELECT count(*)::integer FROM audit_log WHERE table_name='contacts' AND row_id=$1::text) audits FROM contacts c WHERE c.id=$1::uuid`,[id])).rows[0];}
async function intent(id:string):Promise<Intent>{return {contact:id,request:randomUUID(),expected:await snapshot(id),name:'Edited Name',email:`${randomUUID()}@example.test`,phone:'+19995550222'};}
const code=(expected:string)=>(e:unknown)=>(e as {code?:string}).code===expected;

test.before(async()=>{
 clone=await cloneTestDatabase();const demo=process.env.DEMO_MODE,key=process.env.ID_DOC_ENCRYPTION_KEY;
 try{process.env.DEMO_MODE='true';process.env.ID_DOC_ENCRYPTION_KEY=randomBytes(32).toString('hex');await resetAndSeed();owner=await client();await session();await session(USERS.admin);await session(USERS.accountant);await controls();}
 catch(e){await owner?.end();await clone.cleanup();throw e;}
 finally{if(demo===undefined)delete process.env.DEMO_MODE;else process.env.DEMO_MODE=demo;if(key===undefined)delete process.env.ID_DOC_ENCRYPTION_KEY;else process.env.ID_DOC_ENCRYPTION_KEY=key;}
});
test.after(async()=>{await owner?.end();await clone?.cleanup();});

test('three-field update audits actual actor/request and preserves identity, roles, login/profile and other contact facts',async()=>{
 const id=await contact();await owner.query(`UPDATE contacts SET is_owner=true,is_vendor=true WHERE id=$1`,[id]);const before=await facts(id);const i=await intent(id);const result=await edit(i);assert.equal(result.outcome,'changed');const after=await facts(id);
 assert.equal(after.c.display_name,i.name);assert.equal(after.c.email,i.email);assert.equal(after.c.phone_e164,i.phone);
 for(const key of Object.keys(before.c)){if(!['display_name','email','phone_e164','updated_at'].includes(key))assert.deepEqual(after.c[key],before.c[key],key);}
 assert.equal(after.users,before.users);assert.equal(after.profiles,before.profiles);assert.equal(after.audits,before.audits+1);
 const audit=(await owner.query(`SELECT actor_user_id::text,request_id,reason,changed_cols FROM audit_log WHERE table_name='contacts' AND row_id=$1 ORDER BY id DESC LIMIT 1`,[id])).rows[0];
 assert.equal(audit.actor_user_id,USERS.manager);assert.equal(audit.request_id,i.request);assert.equal(audit.reason,'tenant_directory_contact_edit');assert.deepEqual([...audit.changed_cols].sort(),['display_name','email','phone_e164']);
 const command=(await owner.query(`SELECT * FROM app.b015_edit_commands WHERE request_id=$1`,[i.request])).rows[0];assert.equal(command.actor_role,'manager');assert.equal(command.result_sha256,await snapshot(id));assert.equal(Object.keys(command).some(k=>['name','email','phone','old_row','new_row','payload'].includes(k)),false);
 assert.deepEqual(await edit(i),result);assert.equal((await facts(id)).audits,after.audits);
 await assert.rejects(edit({...i,name:'Other'}),code('23514'));assert.equal((await status(id,i.request)).outcome,'changed');
});

test('terminal stale/invalid/disabled/unavailable/email rejections are saved once and recover without changing contacts',async()=>{
 const id=await contact();const first=await intent(id);await edit(first);const old=await intent(id);old.expected=first.expected;const before=await facts(id);
 assert.equal((await edit(old)).outcome,'rejected_conflict');assert.equal((await status(id,old.request)).outcome,'rejected_conflict');assert.equal((await edit(old)).outcome,'rejected_conflict');
 for(const invalid of [{name:''},{phone:'0912345678'},{email:'two@@example.test'},{expected:'invalid'}]){const i={...await intent(id),...invalid};assert.equal((await edit(i)).outcome,'rejected_invalid');assert.equal((await status(id,i.request)).outcome,'rejected_invalid');}
 await controls(false);const off=await intent(id);assert.equal((await edit(off)).outcome,'rejected_disabled');assert.equal((await edit(first)).outcome,'changed');assert.equal((await status(id,first.request)).outcome,'changed');await controls();
 const unavailable={...await intent(id),contact:randomUUID()};assert.equal((await edit(unavailable)).outcome,'rejected_unavailable');assert.equal((await status(unavailable.contact,unavailable.request)).outcome,'rejected_unavailable');
 const duplicate=await contact();const email=(await owner.query(`SELECT email::text FROM contacts WHERE id=$1`,[duplicate])).rows[0].email;
 const conflict={...await intent(id),email:email.toUpperCase()};assert.equal((await edit(conflict)).outcome,'rejected_email_exists');assert.equal((await status(id,conflict.request)).outcome,'rejected_email_exists');
 assert.deepEqual(await facts(id),before);
});

test('new UUID and fresh CAS are explicit; no-op is recorded without a fake contact audit or mutation',async()=>{
 const id=await contact();const row=(await owner.query(`SELECT display_name,email::text,phone_e164 FROM contacts WHERE id=$1`,[id])).rows[0];const before=await facts(id);const i={...await intent(id),name:row.display_name,email:row.email,phone:row.phone_e164};
 assert.equal((await edit(i)).outcome,'no_change');assert.equal((await status(id,i.request)).outcome,'no_change');assert.deepEqual(await facts(id),before);
 const changed=await intent(id);assert.equal((await edit(changed)).outcome,'changed');await assert.rejects(edit({...changed,contact:randomUUID()}),code('23514'));assert.equal((await status(id,randomUUID())).status,'unknown');
});

test('current canonical editor scope and function/table ACL reject accountant, forged scope and direct application access',async()=>{
 const id=await contact();const i=await intent(id);
 for(const bad of [{user:USERS.accountant},{org:ORG2_ID,live:ORG2_ID},{env:'sandbox'},{sid:randomUUID()}])await assert.rejects(edit({...i,request:randomUUID(),...bad}),code('42501'));
 const c=await client();try{for(const role of ['anon','authenticated','service_role']){await c.query('BEGIN');await c.query(`SET LOCAL ROLE ${role}`);await assert.rejects(c.query('SELECT * FROM app.b015_edit_commands'),code('42501'));await c.query('ROLLBACK');}
  for(const role of ['anon','authenticated']){await c.query('BEGIN');await c.query(`SET LOCAL ROLE ${role}`);await assert.rejects(c.query(`SELECT app.b015_edit_status($1,$1,'live',$2,$3,$4)`,[ORG_ID,sessions.get(USERS.manager),id,i.request]),code('42501'));await c.query('ROLLBACK');}}
 finally{await c.query('ROLLBACK');await c.end();}
 assert.equal((await facts(id)).c.display_name,'Edit Source');
});

test('two editor contention is retryable, then stale CAS is a terminal recorded rejection; exact in-flight request remains unknown',async()=>{
 const id=await contact(),one=await intent(id),two=await intent(id),held=await client();
 try{await begin(held,USERS.manager);assert.equal((await invoke(held,one)).outcome,'changed');assert.equal((await status(id,one.request)).status,'unknown');
  await assert.rejects(edit(one),code('55P03'));await assert.rejects(edit(two),code('55P03'));await held.query('COMMIT');
  assert.equal((await edit(one)).outcome,'changed');assert.equal((await edit(two)).outcome,'rejected_conflict');assert.equal((await status(id,two.request)).outcome,'rejected_conflict');
 }finally{await held.query('ROLLBACK');await held.end();}
});

test('wall-clock expiry at actual deferred commit rolls back contact, audit and command together',async()=>{
 const id=await contact(),before=await facts(id),sid=await session(USERS.manager,500),i={...await intent(id),sid};
 await assert.rejects(edit(i,c=>c.query('SELECT pg_sleep(0.7)').then(()=>{})),code('42501'));
 assert.deepEqual(await facts(id),before);assert.equal(Number((await owner.query(`SELECT count(*) n FROM app.b015_edit_commands WHERE request_id=$1`,[i.request])).rows[0].n),0);await session();
});

test('recovery after contact archival is metadata only, and an authorized parent delete cascades private hashes',async()=>{
 const id=await contact(),i=await intent(id);await edit(i);await owner.query(`UPDATE contacts SET archived_at=clock_timestamp(),is_tenant=false WHERE id=$1`,[id]);await controls(false);
 const result=await status(id,i.request);assert.equal(result.status,'recorded');assert.equal(result.outcome,'changed');assert.deepEqual(Object.keys(result).sort(),['outcome','recorded_at','request_id','status']);assert.deepEqual(await edit(i),result);
 await owner.query(`DELETE FROM contacts WHERE id=$1`,[id]);assert.equal(Number((await owner.query(`SELECT count(*) n FROM app.b015_edit_commands WHERE request_id=$1`,[i.request])).rows[0].n),0);await controls();
});

test('audit context is restored for later unrelated writes after success and handled email rejection',async()=>{
 const a=await contact(),b=await contact(),duplicate=await contact();const taken=(await owner.query(`SELECT email::text FROM contacts WHERE id=$1`,[duplicate])).rows[0].email;
 for(const conflict of [false,true]) {
  const i={...await intent(a),...(conflict?{email:taken}:{})},c=await client();
  try{await begin(c,USERS.manager);await c.query(`SELECT set_config('app.change_reason','outer-operation',true),set_config('app.request_id','outer-request',true)`);
   assert.equal((await invoke(c,i)).outcome,conflict?'rejected_email_exists':'changed');
   const setting=(await c.query(`SELECT current_setting('app.change_reason') reason,current_setting('app.request_id') request`)).rows[0];assert.deepEqual(setting,{reason:'outer-operation',request:'outer-request'});
   await c.query(`UPDATE public.contacts SET display_name=display_name||'x' WHERE id=$1`,[b]);await c.query('COMMIT');
  }finally{await c.query('ROLLBACK');await c.end();}
  const audit=(await owner.query(`SELECT reason,request_id FROM audit_log WHERE table_name='contacts' AND row_id=$1 ORDER BY id DESC LIMIT 1`,[b])).rows[0];assert.deepEqual(audit,{reason:'outer-operation',request_id:'outer-request'});
 }
});

test('an actual audit insertion failure rolls back the contact and command, retaining safe exact retry',async()=>{
 const id=await contact(),i=await intent(id),before=await facts(id);
 await owner.query(`CREATE FUNCTION app.b015_test_audit_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic audit failure'; END $$`);
 await owner.query(`CREATE TRIGGER b015_test_audit_abort AFTER INSERT ON public.audit_log FOR EACH ROW WHEN (NEW.request_id='${i.request}') EXECUTE FUNCTION app.b015_test_audit_abort()`);
 try{await assert.rejects(edit(i),code('P0001'));assert.deepEqual(await facts(id),before);assert.equal((await status(id,i.request)).status,'unknown');}
 finally{await owner.query(`DROP TRIGGER b015_test_audit_abort ON public.audit_log`);await owner.query(`DROP FUNCTION app.b015_test_audit_abort()`);}
 assert.equal((await edit(i)).outcome,'changed');
});

test('actual sandbox editor uses canonical live membership; sandbox-only elevation cannot grant edit or recovery',async()=>{
 const {insertSandboxOrg}=await import('./sandbox');const sandbox=await insertSandboxOrg(owner,ORG_ID,USERS.admin),id=randomUUID();
 await owner.query(`INSERT INTO contacts(id,org_id,is_tenant,display_name,phone_e164) VALUES($1,$2,true,'Sandbox Editor','+19995550333')`,[id,sandbox]);
 await owner.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text,$2::text)) WHERE key='tenant_directory_edit'`,[ORG_ID,sandbox]);
 const expected=(await owner.query<{s:string}>(`SELECT app.b015_contact_snapshot($1,$2) s`,[sandbox,id])).rows[0].s;
 const i={...await intent(await contact()),contact:id,expected,org:sandbox,live:ORG_ID,env:'sandbox'};
 assert.equal((await edit(i)).outcome,'changed');
 await owner.query(`UPDATE org_members SET role='admin',is_billing_owner=false WHERE org_id=$1 AND user_id=$2`,[sandbox,USERS.accountant]);
 await assert.rejects(edit({...i,request:randomUUID(),user:USERS.accountant,sid:sessions.get(USERS.accountant)}),code('42501'));
 const denied=await client();try{await begin(denied,USERS.accountant);await assert.rejects(denied.query(`SELECT app.b015_edit_status($1,$2,'sandbox',$3,$4,$5)`,[sandbox,ORG_ID,sessions.get(USERS.accountant),id,i.request]),code('42501'));}finally{await denied.query('ROLLBACK');await denied.end();}
 await controls();
});

test('actual session and member writers are fenced, then revoked/demoted requests fail under current authorization',async()=>{
 const id=await contact(),i=await intent(id),held=await client();
 try{await held.query('BEGIN');await held.query(`SELECT 1 FROM auth_sessions WHERE id=$1 FOR UPDATE`,[sessions.get(USERS.manager)]);await assert.rejects(edit(i),code('55P03'));await held.query('ROLLBACK');
  await held.query('BEGIN');await held.query(`SELECT 1 FROM org_members WHERE org_id=$1 AND user_id=$2 FOR UPDATE`,[ORG_ID,USERS.manager]);await assert.rejects(edit(i),code('55P03'));await held.query('ROLLBACK');
  await owner.query(`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1`,[sessions.get(USERS.manager)]);await assert.rejects(edit(i),code('42501'));await session();
  await owner.query(`UPDATE org_members SET role='accountant' WHERE org_id=$1 AND user_id=$2`,[ORG_ID,USERS.manager]);await assert.rejects(edit(i),code('42501'));
 }finally{await held.query('ROLLBACK');await held.end();await owner.query(`UPDATE org_members SET role='manager' WHERE org_id=$1 AND user_id=$2`,[ORG_ID,USERS.manager]);}
 assert.equal((await edit(i)).outcome,'changed');
});

test('actual function privileges and private table write privileges are narrow, independent of auth rejection',async()=>{
 const signatures=['app.b015_edit_contact(uuid,uuid,text,uuid,uuid,uuid,text,text,text,text)','app.b015_edit_status(uuid,uuid,text,uuid,uuid,uuid)','app.b015_close_edit_request(uuid,uuid,text,uuid,uuid,uuid)','app.b015_finish_edit_request(uuid,uuid,text,uuid,uuid,uuid,text)','app.b015_edit_view(uuid,uuid,text,uuid,uuid)'];
 for(const role of ['anon','authenticated','service_role']) {
  for(const fn of signatures) assert.equal((await owner.query(`SELECT has_function_privilege($1,$2,'EXECUTE') ok`,[role,fn])).rows[0].ok,role==='service_role');
  for(const fn of ['app.b015_edit_context(uuid,uuid,text,uuid)','app.b015_contact_snapshot(uuid,uuid)'])assert.equal((await owner.query(`SELECT has_function_privilege($1,$2,'EXECUTE') ok`,[role,fn])).rows[0].ok,false);
  for(const privilege of ['SELECT','INSERT','UPDATE','DELETE'])assert.equal((await owner.query(`SELECT has_table_privilege($1,'app.b015_edit_commands',$2) ok`,[role,privilege])).rows[0].ok,false);
 }
});

test('a real concurrent tenant email conflict is bounded and preserves the losing intent until exact terminal retry',async()=>{
 const firstId=await contact(),secondId=await contact(),email=`${randomUUID()}@example.test`,one={...await intent(firstId),email},two={...await intent(secondId),email},before=await facts(secondId),held=await client();
 try{await begin(held,USERS.manager);assert.equal((await invoke(held,one)).outcome,'changed');
  await assert.rejects(edit(two),code('55P03'));assert.deepEqual(await facts(secondId),before);assert.equal((await status(secondId,two.request)).status,'unknown');await held.query('COMMIT');
  assert.equal((await edit(two)).outcome,'rejected_email_exists');assert.equal((await status(secondId,two.request)).outcome,'rejected_email_exists');assert.deepEqual(await facts(secondId),before);
 }finally{await held.query('ROLLBACK');await held.end();}
});

test('authorized organization and actor deletion cascade hash metadata without granting private delete',async()=>{
 const org=randomUUID(),id=randomUUID();
 await owner.query(`INSERT INTO organizations(id,name,country_code,default_currency,timezone,feature_flags) SELECT $1,'Directory lifecycle fixture',country_code,default_currency,timezone,'{"tenant_directory_edit":true}'::jsonb FROM organizations WHERE id=$2`,[org,ORG_ID]);
 await owner.query(`INSERT INTO org_members(org_id,user_id,role,status) VALUES($1,$2,'manager','active')`,[org,USERS.manager]);
 await owner.query(`INSERT INTO contacts(id,org_id,is_tenant,display_name) VALUES($1,$2,true,'Org lifecycle contact')`,[id,org]);
 await owner.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text,$2::text)) WHERE key='tenant_directory_edit'`,[ORG_ID,org]);
 const expected=(await owner.query<{s:string}>(`SELECT app.b015_contact_snapshot($1,$2) s`,[org,id])).rows[0].s;
 const i={...await intent(await contact()),contact:id,expected,org,live:org};assert.equal((await edit(i)).outcome,'changed');
 await owner.query(`DELETE FROM organizations WHERE id=$1`,[org]);assert.equal(Number((await owner.query(`SELECT count(*) n FROM app.b015_edit_commands WHERE org_id=$1`,[org])).rows[0].n),0);await controls();
 const actor=randomUUID(),sid=await(async()=>{await owner.query(`INSERT INTO auth.users(id,email,role,aud) VALUES($1,$2,'authenticated','authenticated')`,[actor,`${randomUUID()}@example.test`]);await owner.query(`INSERT INTO org_members(org_id,user_id,role,status) VALUES($1,$2,'manager','active')`,[ORG_ID,actor]);return session(actor);})();
 const target=await contact(),j={...await intent(target),user:actor,sid};assert.equal((await edit(j)).outcome,'changed');
 await owner.query(`DELETE FROM auth.users WHERE id=$1`,[actor]);assert.equal(Number((await owner.query(`SELECT count(*) n FROM app.b015_edit_commands WHERE actor_id=$1`,[actor])).rows[0].n),0);
 assert.equal((await facts(target)).c.display_name,j.name);
});


async function closeIntent(c:Client,id:string,request:string){return (await c.query(`SELECT app.b015_close_edit_request($1,$1,'live',$2,$3,$4) r`,[ORG_ID,sessions.get(USERS.manager),id,request])).rows[0].r;}
async function close(id:string,request:string){const c=await client();try{await begin(c,USERS.manager);const r=await closeIntent(c,id,request);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{await c.end();}}

test('closing an unknown intent is hashless deny-only metadata; lost acknowledgement and late submits recover cancellation',async()=>{
 const id=await contact(),i=await intent(id),before=await facts(id);await controls(false);
 const closed=await close(id,i.request);assert.equal(closed.outcome,'cancelled');assert.equal((await status(id,i.request)).outcome,'cancelled');assert.deepEqual(await close(id,i.request),closed);
 await controls();assert.deepEqual(await edit(i),closed);assert.deepEqual(await edit({...i,name:'Later intent with same closed key'}),closed);assert.deepEqual(await facts(id),before);
 const row=(await owner.query(`SELECT command_kind,payload_sha256,result_sha256 FROM app.b015_edit_commands WHERE request_id=$1`,[i.request])).rows[0];assert.deepEqual(row,{command_kind:'close',payload_sha256:null,result_sha256:null});
 await assert.rejects(close(randomUUID(),i.request),code('23514'));assert.equal((await edit(await intent(id))).outcome,'changed');
});

test('close-first and edit-first share the same request lock; committed edits are never cancelled or undone',async()=>{
 for(const first of ['close','edit']) {
  const id=await contact(),i=await intent(id),before=await facts(id),held=await client();
  try{await begin(held,USERS.manager);const result=first==='close'?await closeIntent(held,id,i.request):await invoke(held,i);
   assert.equal((await status(id,i.request)).status,'unknown');
   if(first==='close')await assert.rejects(edit(i),code('55P03'));else await assert.rejects(close(id,i.request),code('55P03'));
   await held.query('COMMIT');assert.deepEqual(await close(id,i.request),result);assert.deepEqual(await edit(i),result);
   const after=await facts(id);if(first==='close')assert.deepEqual(after,before);else {assert.equal(after.c.display_name,i.name);assert.equal(after.audits,before.audits+1);}
  }finally{await held.query('ROLLBACK');await held.end();}
 }
});

test('edit-first pins current membership/session against actual revocation writers until transaction end',async()=>{
 const id=await contact(),i=await intent(id),held=await client(),writer=await client();
 try{await begin(held,USERS.manager);await invoke(held,i);
  for(const sql of [`SELECT 1 FROM auth_sessions WHERE id=$1 FOR UPDATE NOWAIT`,`SELECT 1 FROM org_members WHERE org_id=$1 AND user_id=$2 FOR UPDATE NOWAIT`]){
   await writer.query('BEGIN');await assert.rejects(writer.query(sql,sql.includes('auth_sessions')?[sessions.get(USERS.manager)]:[ORG_ID,USERS.manager]),code('55P03'));await writer.query('ROLLBACK');
  }
  await held.query('COMMIT');
  await writer.query(`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1`,[sessions.get(USERS.manager)]);
  await assert.rejects(status(id,i.request),code('42501'));await session();assert.equal((await status(id,i.request)).outcome,'changed');
 }finally{await held.query('ROLLBACK');await writer.query('ROLLBACK');await held.end();await writer.end();}
});

test('close intent requires current authorization and natural deferred expiry rolls back the tombstone',async()=>{
 const id=await contact(),request=randomUUID(),held=await client();
 try{await session(USERS.manager,500);await begin(held,USERS.manager);assert.equal((await closeIntent(held,id,request)).outcome,'cancelled');
  await held.query('SELECT pg_sleep(0.7)');await assert.rejects(held.query('COMMIT'),code('42501'));await held.query('ROLLBACK');
  assert.equal(Number((await owner.query(`SELECT count(*) n FROM app.b015_edit_commands WHERE request_id=$1`,[request])).rows[0].n),0);
  await session();await owner.query(`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1`,[sessions.get(USERS.manager)]);await assert.rejects(close(id,request),code('42501'));await session();
  assert.equal((await close(id,request)).outcome,'cancelled');
 }finally{await held.query('ROLLBACK');await held.end();await session();}
});

async function seedOwned(){const demo=process.env.DEMO_MODE,key=process.env.ID_DOC_ENCRYPTION_KEY;try{process.env.DEMO_MODE='true';process.env.ID_DOC_ENCRYPTION_KEY=randomBytes(32).toString('hex');await resetAndSeed();}finally{if(demo===undefined)delete process.env.DEMO_MODE;else process.env.DEMO_MODE=demo;if(key===undefined)delete process.env.ID_DOC_ENCRYPTION_KEY;else process.env.ID_DOC_ENCRYPTION_KEY=key;}}
async function resetBlockedBy(pid:number,admitted:boolean){const end=Date.now()+4000;while(Date.now()<end){const ok=(await owner.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE a.datname=current_database() AND $1::int=ANY(pg_blocking_pids(a.pid)) AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.relation='public.platform_settings'::regclass AND l.mode='ShareRowExclusiveLock' AND l.granted=$2)) ok`,[pid,admitted])).rows[0].ok;if(ok)return true;await new Promise(r=>setTimeout(r,20));}return false;}

test('actual demo reset clears edits and cancellation metadata twice, preserves unrelated private data and handover GC',async()=>{
 await owner.query(`CREATE TABLE app.b015_reset_unrelated_probe(value integer NOT NULL)`);await owner.query(`INSERT INTO app.b015_reset_unrelated_probe VALUES(7)`);
 const path=`org/${ORG_ID}/handover/${randomUUID()}/${randomUUID()}`;await owner.query(`INSERT INTO app.handover_gc_tombstones(storage_path,reason) VALUES($1,'demo_reset')`,[path]);
 for(let n=0;n<2;n++){
  await controls();await session();const id=await contact();await edit(await intent(id));await close(id,randomUUID());assert.ok(Number((await owner.query(`SELECT count(*) n FROM app.b015_edit_commands`)).rows[0].n)>=2);
  await seedOwned();assert.equal(Number((await owner.query(`SELECT count(*) n FROM app.b015_edit_commands`)).rows[0].n),0);
  assert.equal((await owner.query(`SELECT value FROM app.b015_reset_unrelated_probe`)).rows[0].value,7);assert.equal((await owner.query(`SELECT 1 FROM app.handover_gc_tombstones WHERE storage_path=$1`,[path])).rowCount,1);
  assert.equal((await owner.query(`SELECT 1 FROM organizations WHERE id=$1`,[ORG_ID])).rowCount,1);
 }
 await controls();await session();
});

test('actual editor and actual demo reset serialize at admission in both orders without private orphans',async()=>{
 const held=await client();const pending:Promise<void>[]=[];
 try{
  await controls();await session();const id=await contact(),i=await intent(id);await begin(held,USERS.manager);await invoke(held,i);
  const pid=(await held.query(`SELECT pg_backend_pid() id`)).rows[0].id;const reset=seedOwned();pending.push(reset);assert.equal(await resetBlockedBy(pid,false),true);await held.query('COMMIT');await reset;
  assert.equal(Number((await owner.query(`SELECT count(*) n FROM app.b015_edit_commands`)).rows[0].n),0);
  await controls();await session();const target=await contact(),intentAfter=await intent(target);
  await held.query('BEGIN');await held.query(`SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE`,[ORG_ID]);const resetFirst=seedOwned();pending.push(resetFirst);assert.equal(await resetBlockedBy(pid,true),true);
  await assert.rejects(edit(intentAfter),code('55P03'));await assert.rejects(close(target,randomUUID()),code('55P03'));await held.query('COMMIT');await resetFirst;
  assert.equal(Number((await owner.query(`SELECT count(*) n FROM app.b015_edit_commands`)).rows[0].n),0);
 }finally{await held.query('ROLLBACK');await held.end();await Promise.allSettled(pending);await controls();await session();}
});

async function finish(c:Client,id:string,request:string,mode:string|null){return (await c.query(`SELECT app.b015_finish_edit_request($1,$1,'live',$2,$3,$4,$5) result`,[ORG_ID,sessions.get(USERS.manager),id,request,mode])).rows[0].result;}

test('fixed wrapper performs actual edit/status/close and recovers terminal results even OFF',async()=>{
 const s:Session={kind:'staff',role:'manager',userId:USERS.manager,sessionId:sessions.get(USERS.manager)!,orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'zh-TW',calendar:'gregorian',leaseId:null,email:'synthetic@example.test',name:'Synthetic Manager'};
 const id=await contact(),i=await intent(id),input={requestId:i.request,contactId:id,expected:i.expected,name:i.name,email:i.email,phone:i.phone};
 assert.deepEqual(await directoryEditStatus(s,id,i.request),{status:'unknown'});const before=await facts(id),result=await editDirectoryContact(s,input);assert.equal(result.status,'recorded');assert.equal(result.status==='recorded'?result.outcome:null,'changed');
 await controls(false);assert.deepEqual(await directoryEditStatus(s,id,i.request),result);assert.deepEqual(await editDirectoryContact(s,input),result);assert.deepEqual(await closeDirectoryEdit(s,id,i.request),result);
 const cancel=randomUUID();assert.equal((await closeDirectoryEdit(s,id,cancel)).status,'recorded');await controls();assert.equal((await editDirectoryContact(s,{...input,requestId:cancel})).status==='recorded',true);assert.equal((await facts(id)).audits,before.audits+1);
 assert.deepEqual(await editDirectoryContact({...s,kind:'tenant'},input),{status:'unavailable'});assert.deepEqual(await directoryEditStatus({...s,sessionId:randomUUID()},id,i.request),{status:'unavailable'});
 assert.deepEqual(await editDirectoryContact(s,{...input,name:'Mismatched retry'}),{status:'request_mismatch'});
});

test('final helper validates exact mode/scope, allows cross-kind recovery and rejects expiry after an early constraint flush',async()=>{
 const id=await contact(),i=await intent(id),c=await client();
 for(const mode of [null,'other','edit','close']){try{await begin(c,USERS.manager);await assert.rejects(finish(c,id,i.request,mode),code(mode===null||mode==='other'?'42501':'23514'));}finally{await c.query('ROLLBACK');}}
 try{await begin(c,USERS.manager);assert.deepEqual(await finish(c,id,i.request,'status'),{status:'unknown'});await c.query('COMMIT');}finally{await c.query('ROLLBACK');}
 await edit(i);
 try{await begin(c,USERS.manager);for(const mode of ['edit','close','status'])assert.equal((await finish(c,id,i.request,mode)).outcome,'changed');await assert.rejects(finish(c,randomUUID(),i.request,'status'),code('23514'));}finally{await c.query('ROLLBACK');}
 const request=randomUUID();await session(USERS.manager,500);
 try{await begin(c,USERS.manager);await closeIntent(c,id,request);await c.query('SET CONSTRAINTS ALL IMMEDIATE');await c.query('SELECT pg_sleep(0.7)');await assert.rejects(finish(c,id,request,'close'),code('42501'));}finally{await c.query('ROLLBACK');await c.end();await session();}
 assert.equal((await status(id,request)).status,'unknown');
});

test('final command pin and authorized parent cascade serialize in both orders without returning deleted metadata',async()=>{
 const held=await client(),writer=await client();
 try{
  const id=await contact(),i=await intent(id);await edit(i);await writer.query('BEGIN');await writer.query(`DELETE FROM contacts WHERE id=$1`,[id]);
  await begin(held,USERS.manager);await assert.rejects(finish(held,id,i.request,'status'),code('55P03'));await held.query('ROLLBACK');await writer.query('COMMIT');
  await begin(held,USERS.manager);assert.deepEqual(await finish(held,id,i.request,'status'),{status:'unknown'});await held.query('COMMIT');
  const target=await contact(),j=await intent(target);await edit(j);await begin(held,USERS.manager);assert.equal((await finish(held,target,j.request,'status')).outcome,'changed');
  await writer.query('BEGIN');await writer.query(`SET LOCAL lock_timeout='100ms'`);await assert.rejects(writer.query(`DELETE FROM contacts WHERE id=$1`,[target]),code('55P03'));await writer.query('ROLLBACK');await held.query('COMMIT');
  assert.ok(await facts(target));assert.equal((await status(target,j.request)).outcome,'changed');await writer.query(`DELETE FROM contacts WHERE id=$1`,[target]);assert.equal((await status(target,j.request)).status,'unknown');
 }finally{await held.query('ROLLBACK');await writer.query('ROLLBACK');await held.end();await writer.end();}
});

/** Test-only local PostgreSQL wire fault; never installs a runtime callback. */
async function wireFault<T>(fault:'rollback'|'before_commit'|'after_commit',fn:()=>Promise<T>){
 const previous=process.env.DATABASE_URL!,url=new URL(previous),upstreamPort=Number(url.port);assert.equal(url.hostname,'127.0.0.1');
 const sockets=new Set<Socket>(),statements:string[]=[];let tripped=false;
 const server=createServer(front=>{
  const back=createConnection({host:'127.0.0.1',port:upstreamPort});sockets.add(front);sockets.add(back);
  for(const s of [front,back]){s.on('error',()=>{});s.on('close',()=>{sockets.delete(s);});}
  front.on('close',()=>back.destroy());back.on('close',()=>front.destroy());
  let startup=true,input=Buffer.alloc(0),suppress=false,output=Buffer.alloc(0);
  front.on('data',chunk=>{
   input=Buffer.concat([input,chunk]);let cut=false;
   while(input.length>=5){const length=startup?input.readInt32BE(0):input.readInt32BE(1)+1;if(length<5||length>1048576){front.destroy();back.destroy();return;}if(input.length<length)break;
    const frame=input.subarray(0,length);input=input.subarray(length);
    if(startup){startup=false;continue;}
    let sql='';if(frame[0]===81)sql=frame.subarray(5,-1).toString();else if(frame[0]===80){const end=frame.indexOf(0,5);const endSql=frame.indexOf(0,end+1);if(end>=5&&endSql>end)sql=frame.subarray(end+1,endSql).toString();}
    if(sql)statements.push(sql);
    if((fault==='rollback'&&sql==='ROLLBACK')||(fault==='before_commit'&&sql==='COMMIT')){tripped=true;cut=true;front.destroy();back.destroy();break;}
    if(fault==='after_commit'&&sql==='COMMIT')suppress=true;
   }
   if(!cut)back.write(chunk);
  });
  back.on('data',chunk=>{
   if(!suppress){front.write(chunk);return;}
   output=Buffer.concat([output,chunk]);
   while(output.length>=5){const length=output.readInt32BE(1)+1;if(output.length<length)break;const type=output[0];output=output.subarray(length);if(type===90){tripped=true;front.destroy();back.destroy();break;}}
  });
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');url.port=String(address.port);process.env.DATABASE_URL=url.toString();
 try{return {value:await fn(),statements,tripped};}
 finally{process.env.DATABASE_URL=previous;for(const s of sockets)s.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}

test('actual wire faults before and after COMMIT preserve uncertainty and same-key recovery without duplicate edits',async()=>{
 const s:Session={kind:'staff',role:'manager',userId:USERS.manager,sessionId:sessions.get(USERS.manager)!,orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'zh-TW',calendar:'gregorian',leaseId:null,email:'synthetic@example.test',name:'Synthetic Manager'};
 for(const fault of ['before_commit','after_commit'] as const){
  const id=await contact(),i=await intent(id),input={requestId:i.request,contactId:id,expected:i.expected,name:i.name,email:i.email,phone:i.phone},before=await facts(id);
  const result=await wireFault(fault,()=>editDirectoryContact(s,input));assert.equal(result.tripped,true);assert.deepEqual(result.value,{status:'unknown'});
  const flush=result.statements.indexOf('SET CONSTRAINTS ALL IMMEDIATE'),final=result.statements.findIndex(q=>q.includes('b015_finish_edit_request'));assert.ok(flush>=0&&final===flush+1);assert.equal(result.statements[final+1],'COMMIT');
  const recovered=await directoryEditStatus(s,id,i.request);
  if(fault==='after_commit'){assert.equal(recovered.status==='recorded'?recovered.outcome:null,'changed');assert.deepEqual(await editDirectoryContact(s,input),recovered);assert.deepEqual(await closeDirectoryEdit(s,id,i.request),recovered);assert.equal((await facts(id)).audits,before.audits+1);}
  else{assert.deepEqual(recovered,{status:'unknown'});assert.deepEqual(await facts(id),before);assert.equal((await closeDirectoryEdit(s,id,i.request)).status,'recorded');assert.equal((await editDirectoryContact(s,input)).status,'recorded');assert.deepEqual(await facts(id),before);}
 }
});

test('rollback acknowledgement failure is unknown and unrelated CHECK errors are not reported as request mismatch',async()=>{
 const s:Session={kind:'staff',role:'manager',userId:USERS.manager,sessionId:sessions.get(USERS.manager)!,orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'zh-TW',calendar:'gregorian',leaseId:null,email:'synthetic@example.test',name:'Synthetic Manager'};
 const id=await contact(),i=await intent(id),input={requestId:i.request,contactId:id,expected:i.expected,name:i.name,email:i.email,phone:i.phone},held=await client(),before=await facts(id);
 try{await held.query('BEGIN');await held.query(`SELECT 1 FROM auth_sessions WHERE id=$1 FOR UPDATE`,[s.sessionId]);const result=await wireFault('rollback',()=>editDirectoryContact(s,input));assert.equal(result.tripped,true);assert.deepEqual(result.value,{status:'unknown'});}finally{await held.query('ROLLBACK');await held.end();}
 assert.deepEqual(await directoryEditStatus(s,id,i.request),{status:'unknown'});assert.deepEqual(await facts(id),before);
 await owner.query(`CREATE FUNCTION app.b015_test_check_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic audit CHECK defect' USING ERRCODE='23514'; END $$`);await owner.query(`CREATE TRIGGER b015_test_check_abort AFTER INSERT ON public.audit_log FOR EACH ROW WHEN (NEW.request_id='${i.request}') EXECUTE FUNCTION app.b015_test_check_abort()`);
 try{assert.deepEqual(await editDirectoryContact(s,input),{status:'unknown'});assert.deepEqual(await facts(id),before);assert.deepEqual(await directoryEditStatus(s,id,i.request),{status:'unknown'});}
 finally{await owner.query(`DROP TRIGGER b015_test_check_abort ON public.audit_log`);await owner.query(`DROP FUNCTION app.b015_test_check_abort()`);}
});

function managerSession():Session{return {kind:'staff',role:'manager',userId:USERS.manager,sessionId:sessions.get(USERS.manager)!,orgId:ORG_ID,liveOrgId:ORG_ID,environment:'live',locale:'zh-TW',calendar:'gregorian',leaseId:null,email:'synthetic@example.test',name:'Synthetic Manager'};}

test('editor view exposes only current allowed fields, usable CAS and shared-role warning without mutations',async()=>{
 const id=await contact(),s=managerSession(),before=await facts(id),commands=(await owner.query(`SELECT count(*) n FROM app.b015_edit_commands`)).rows[0].n;
 const view=await directoryContactEditView(s,id);assert.equal(view.state,'enabled');if(view.state!=='enabled')throw new Error('Missing view');
 assert.deepEqual(Object.keys(view).sort(),['contactId','email','expected','isOwner','isVendor','name','phone','state']);assert.equal(view.expected,await snapshot(id));assert.deepEqual(await facts(id),before);assert.equal((await owner.query(`SELECT count(*) n FROM app.b015_edit_commands`)).rows[0].n,commands);
 const result=await editDirectoryContact(s,{contactId:id,requestId:randomUUID(),expected:view.expected,name:'View CAS edit',email:view.email??'',phone:view.phone??''});assert.equal(result.status==='recorded'?result.outcome:null,'changed');
 const linked=randomUUID();await owner.query(`INSERT INTO auth.users(id,email,role,aud) VALUES($1,$2,'authenticated','authenticated')`,[linked,`${randomUUID()}@example.test`]);await owner.query(`UPDATE contacts SET is_owner=true,is_vendor=true,user_id=$2 WHERE id=$1`,[id,linked]);const changed=await directoryContactEditView(s,id);assert.equal(changed.state,'enabled');if(changed.state==='enabled'){assert.equal(changed.isOwner,true);assert.equal(changed.isVendor,true);assert.notEqual(changed.expected,view.expected);}
 await owner.query(`UPDATE contacts SET is_tenant=false WHERE id=$1`,[id]);assert.deepEqual(await directoryContactEditView(s,id),{state:'recovery_only'});await owner.query(`UPDATE contacts SET is_tenant=true,archived_at=clock_timestamp() WHERE id=$1`,[id]);assert.deepEqual(await directoryContactEditView(s,id),{state:'recovery_only'});
 await controls(false);assert.deepEqual(await directoryContactEditView(s,await contact()),{state:'disabled'});await controls();
 await session(USERS.accountant);assert.deepEqual(await directoryContactEditView({...s,userId:USERS.accountant,sessionId:sessions.get(USERS.accountant)!,role:'admin'},await contact()),{state:'unavailable'});
 assert.deepEqual(await directoryContactEditView({...s,orgId:ORG2_ID},await contact()),{state:'unavailable'});
});

test('editor view and actual contact updates conflict in both orders and reload returns fresh source',async()=>{
 const id=await contact(),s=managerSession(),held=await client(),writer=await client();
 try{
  await writer.query('BEGIN');await writer.query(`UPDATE contacts SET display_name='Writer before view' WHERE id=$1`,[id]);assert.deepEqual(await directoryContactEditView(s,id),{state:'busy'});await writer.query('COMMIT');
  const fresh=await directoryContactEditView(s,id);assert.equal(fresh.state==='enabled'?fresh.name:null,'Writer before view');
  await begin(held,USERS.manager);assert.equal((await held.query(`SELECT app.b015_edit_view($1,$1,'live',$2,$3) v`,[ORG_ID,s.sessionId,id])).rows[0].v.state,'enabled');
  await writer.query('BEGIN');await writer.query(`SET LOCAL lock_timeout='100ms'`);await assert.rejects(writer.query(`UPDATE contacts SET display_name='Writer after view' WHERE id=$1`,[id]),code('55P03'));await writer.query('ROLLBACK');await held.query('COMMIT');
  await writer.query(`UPDATE contacts SET display_name='Writer after view' WHERE id=$1`,[id]);const after=await directoryContactEditView(s,id);assert.equal(after.state==='enabled'?after.name:null,'Writer after view');
 }finally{await held.query('ROLLBACK');await writer.query('ROLLBACK');await held.end();await writer.end();}
});

test('natural expiry during editor snapshot reads yields no fields and no mutations',async()=>{
 const id=await contact(),before=await facts(id),commands=(await owner.query(`SELECT count(*) n FROM app.b015_edit_commands`)).rows[0].n;
 const original=(await owner.query(`SELECT pg_get_functiondef(p.oid) definition,p.prosrc body FROM pg_proc p WHERE p.oid='app.b015_contact_snapshot(uuid,uuid)'::regprocedure`)).rows[0];
 let pending:ReturnType<typeof directoryContactEditView>|undefined;
 try{
  // Only this owned clone is instrumented; the runtime SQL is restored below.
  const sid=await session(USERS.manager,1000),marker=1+randomBytes(4).readUInt32BE(0)%1000000000;
  await owner.query(`CREATE OR REPLACE FUNCTION app.b015_contact_snapshot(p_org uuid,p_contact uuid) RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS $test$ BEGIN
   IF NOT EXISTS(SELECT 1 FROM public.auth_sessions WHERE id='${sid}'::uuid AND user_id=auth.uid() AND expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'Fixture expired before snapshot entry'; END IF;
   PERFORM pg_advisory_xact_lock(${marker}::bigint);PERFORM pg_sleep(1.5);RETURN (${original.body.trim().replace(/;$/,'')});END $test$`);
  pending=directoryContactEditView(managerSession(),id);let observed=false;
  const deadline=Date.now()+1300;
  while(Date.now()<deadline){observed=(await owner.query(`SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND l.locktype='advisory' AND l.classid=0 AND l.objid=$1::oid AND l.granted) observed`,[marker])).rows[0].observed;if(observed)break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(observed,true,'snapshot-entry marker was actually reached');assert.equal((await owner.query(`SELECT expires_at>clock_timestamp() valid FROM auth_sessions WHERE id=$1`,[sid])).rows[0].valid,true,'session was still valid at observed snapshot entry');
  assert.deepEqual(await pending,{state:'unavailable'});
  assert.deepEqual(await facts(id),before);assert.equal((await owner.query(`SELECT count(*) n FROM app.b015_edit_commands`)).rows[0].n,commands);
 }finally{await pending?.catch(()=>{});await owner.query(original.definition);await session();}
});
