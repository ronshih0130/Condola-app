import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import test from 'node:test';
import {Client} from 'pg';
import {ORG_ID,ORG2_ID,USERS} from './ids';
import {resetAndSeed} from './seed';
import {cloneTestDatabase} from './test-database-clone';
import {disposableDbUrl} from './test-disposable-db';

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone:Awaited<ReturnType<typeof cloneTestDatabase>>,db:Client;
let target:{property:string;contact:string;ownership:string};const sessions=new Map<string,string>();
const code=(v:string)=>(e:unknown)=>(e as {code?:string}).code===v;
async function client(){const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();return c;}
async function session(user:string=USERS.owner,ms=3600000){const id=randomUUID();await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+$4*interval '1 millisecond')`,[id,user,randomUUID(),ms]);sessions.set(user,id);return id;}
async function controls(on=true){await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',$2::boolean,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='repair_approvals'`,[ORG_ID,on]);await db.query(`UPDATE organizations SET feature_flags=feature_flags||'{"repair_approvals":true}'::jsonb WHERE id=$1`,[ORG_ID]);}
async function begin(c:Client,user:string=USERS.owner,role='service_role'){assert.ok(['service_role','authenticated','anon'].includes(role));await c.query('BEGIN');await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role',$2,true)`,[user,role]);await c.query(`SET LOCAL ROLE ${role}`);}
async function invoke(c:Client,property=target.property,user:string=USERS.owner,org=ORG_ID,live=org,env='live'){return (await c.query(`SELECT app.b013_owner_view($1,$2,$3,$4,$5) v`,[org,live,env,sessions.get(user),property])).rows[0].v;}
async function view(property=target.property,user:string=USERS.owner,org=ORG_ID,live=org,env='live'){const c=await client();try{await begin(c,user);const value=await invoke(c,property,user,org,live,env);await c.query('COMMIT');return value;}finally{await c.query('ROLLBACK');await c.end();}}
test.before(async()=>{
 clone=await cloneTestDatabase();const demo=process.env.DEMO_MODE,key=process.env.ID_DOC_ENCRYPTION_KEY;
 try{process.env.DEMO_MODE='true';process.env.ID_DOC_ENCRYPTION_KEY=randomBytes(32).toString('hex');await resetAndSeed();db=await client();
  target=(await db.query(`SELECT po.property_id::text property,c.id::text contact,po.id::text ownership FROM property_owners po JOIN contacts c ON c.org_id=po.org_id AND c.id=po.owner_contact_id WHERE po.org_id=$1 AND c.user_id=$2 ORDER BY po.property_id LIMIT 1`,[ORG_ID,USERS.owner])).rows[0];assert.ok(target);
  await db.query(`UPDATE property_owners SET repair_approval_threshold_minor=777700 WHERE id=$1`,[target.ownership]);
  await session();await session(USERS.admin);
 }catch(error){await db?.end();await clone.cleanup();throw error;}
 finally{if(demo===undefined)delete process.env.DEMO_MODE;else process.env.DEMO_MODE=demo;if(key===undefined)delete process.env.ID_DOC_ENCRYPTION_KEY;else process.env.ID_DOC_ENCRYPTION_KEY=key;}
});
test.after(async()=>{await db?.end();await clone?.cleanup();});

test('strict OFF/ON views preserve a legacy override without inventing its currency provenance',async()=>{
 assert.deepEqual(await view(),{state:'disabled'});await controls();
 const original=(await db.query(`SELECT repair_approval_threshold_minor::text value FROM property_owners WHERE id=$1`,[target.ownership])).rows[0].value;assert.notEqual(original,null);
 const value=await view();assert.equal(value.defaultMinor,'500000');assert.equal(value.defaultSource,'regional_default');assert.equal(value.overrideMinor,original);assert.equal(value.effectiveMinor,null);assert.equal(value.effectiveSource,'legacy_confirmation_required');assert.equal(value.verified,false);assert.match(value.snapshot,/^[0-9a-f]{64}$/);
 assert.deepEqual(Object.keys(value).sort(),['currency','defaultMinor','defaultSource','effectiveMinor','effectiveSource','minorUnit','overrideMinor','ownershipId','propertyId','snapshot','state','verified']);
 for(const invalid of [{enabled:'true',allowed_org_ids:[ORG_ID]},{enabled:true,allowed_org_ids:[]},{enabled:true,allowed_org_ids:ORG_ID}]){await db.query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='repair_approvals'`,[JSON.stringify(invalid)]);assert.deepEqual(await view(),{state:'disabled'});}await controls();
 assert.equal((await db.query(`SELECT repair_approval_threshold_minor::text value FROM property_owners WHERE id=$1`,[target.ownership])).rows[0].value,original);
});

test('current owner scope is object authority; staff, forged company/environment and expired sessions deny before held admission',async()=>{
 await assert.rejects(view(target.property,USERS.admin),code('42501'));await assert.rejects(view(target.property,USERS.owner,ORG2_ID),code('42501'));await assert.rejects(view(target.property,USERS.owner,ORG_ID,ORG_ID,'sandbox'),code('42501'));
 const held=await client();try{await session(USERS.owner,-1000);await held.query('BEGIN');await held.query('LOCK TABLE platform_settings IN ACCESS EXCLUSIVE MODE');await assert.rejects(view(),code('42501'));}finally{await held.query('ROLLBACK');await held.end();await session();}
});

test('public role grants expose only the fixed owner view and no private policy tables or context',async()=>{
 const signatures=['app.b013_owner_view(uuid,uuid,text,uuid,uuid)','app.b013_owner_context(uuid,uuid,text,uuid,uuid)','app.b013_local_day(text)'];
 for(const role of ['anon','authenticated','service_role']){
  for(const [i,signature] of signatures.entries())assert.equal((await db.query(`SELECT has_function_privilege($1,$2,'EXECUTE') ok`,[role,signature])).rows[0].ok,role==='service_role'&&i===0);
  for(const table of ['b013_regional_defaults','b013_default_roots','b013_default_revisions','b013_override_revisions','b013_policy_commands'])for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'])assert.equal((await db.query(`SELECT has_table_privilege($1,$2,$3) ok`,[role,'app.'+table,privilege])).rows[0].ok,false);
 }
 for(const role of ['anon','authenticated']){const c=await client();try{await begin(c,USERS.owner,role);await assert.rejects(invoke(c),code('42501'));}finally{await c.query('ROLLBACK');await c.end();}}
});

test('personal default belongs to principal, not a reassigned owner-contact identity',async()=>{
 const root=randomUUID(),revision=randomUUID(),request=randomUUID(),sid=sessions.get(USERS.owner)!;
 await db.query('BEGIN');try{await db.query(`UPDATE property_owners SET repair_approval_threshold_minor=NULL WHERE id=$1`,[target.ownership]);await db.query(`INSERT INTO app.b013_default_roots(id,org_id,principal_id,currency,version,current_revision) VALUES($1,$2,$3,'TWD',1,$4)`,[root,ORG_ID,USERS.owner,revision]);await db.query(`INSERT INTO app.b013_default_revisions(id,org_id,root_id,principal_id,currency,minor_unit,revision_no,mode,threshold_minor,actor_id,session_id,request_id) VALUES($1,$2,$3,$4,'TWD',2,1,'set',123400,$4,$5,$6)`,[revision,ORG_ID,root,USERS.owner,sid,request]);await db.query('COMMIT');}catch(e){await db.query('ROLLBACK');throw e;}
 assert.equal((await view()).effectiveMinor,'123400');
 const replacement=randomUUID();await db.query(`INSERT INTO auth.users(id,email,role,aud) VALUES($1,$2,'authenticated','authenticated')`,[replacement,`${randomUUID()}@example.test`]);await session(replacement);
 try{await db.query(`UPDATE contacts SET user_id=$2 WHERE id=$1`,[target.contact,replacement]);await assert.rejects(view(),code('42501'));const changed=await view(target.property,replacement);assert.equal(changed.defaultSource,'regional_default');assert.equal(changed.defaultMinor,'500000');}
 finally{await db.query(`UPDATE contacts SET user_id=$2 WHERE id=$1`,[target.contact,USERS.owner]);}
 assert.equal((await view()).defaultMinor,'123400');
});

test('authoritative parent pins fence new overlap INSERT and ownership date updates, with real reverse-order contention',async()=>{
 const held=await client(),writer=await client();let extra:string|undefined;
 try{
  await begin(held);await invoke(held);await writer.query('BEGIN');await writer.query(`SET LOCAL lock_timeout='100ms'`);await assert.rejects(writer.query(`INSERT INTO property_owners(org_id,property_id,owner_contact_id,effective_from) VALUES($1,$2,$3,current_date-interval '1 day')`,[ORG_ID,target.property,target.contact]),code('55P03'));await writer.query('ROLLBACK');await held.query('ROLLBACK');
  await writer.query('BEGIN');extra=(await writer.query(`INSERT INTO property_owners(org_id,property_id,owner_contact_id,effective_from) VALUES($1,$2,$3,current_date-interval '1 day') RETURNING id::text`,[ORG_ID,target.property,target.contact])).rows[0].id;await assert.rejects(view(),code('55P03'));await writer.query('ROLLBACK');extra=undefined;
  extra=(await writer.query(`INSERT INTO property_owners(org_id,property_id,owner_contact_id,effective_from) VALUES($1,$2,$3,current_date+interval '10 day') RETURNING id::text`,[ORG_ID,target.property,target.contact])).rows[0].id;
  await begin(held);await invoke(held);await writer.query('BEGIN');await writer.query(`SET LOCAL lock_timeout='100ms'`);await assert.rejects(writer.query(`UPDATE property_owners SET effective_from=current_date-interval '1 day' WHERE id=$1`,[extra]),code('55P03'));await writer.query('ROLLBACK');await held.query('ROLLBACK');
  await writer.query(`UPDATE property_owners SET effective_from=current_date-interval '1 day' WHERE id=$1`,[extra]);await assert.rejects(view(),code('42501'));
 }finally{await held.query('ROLLBACK');await writer.query('ROLLBACK');await held.end();if(extra)await writer.query(`DELETE FROM property_owners WHERE id=$1`,[extra]);await writer.end();}
});

test('nonconfigured organization-region and currency stay unknown instead of using Taiwan amount',async()=>{
 const org=randomUUID(),property=randomUUID(),contact=randomUUID();
 await db.query(`INSERT INTO organizations(id,name,country_code,default_currency,timezone,feature_flags) VALUES($1,'Regional policy fixture','US','USD','America/Los_Angeles','{"repair_approvals":true}')`,[org]);await db.query(`INSERT INTO properties(id,org_id,name,country_code,currency,timezone) VALUES($1,$2,'Regional property','US','USD','America/Los_Angeles')`,[property,org]);await db.query(`INSERT INTO contacts(id,org_id,is_owner,user_id,display_name) VALUES($1,$2,true,$3,'Regional owner')`,[contact,org,USERS.owner]);await db.query(`INSERT INTO property_owners(org_id,property_id,owner_contact_id,effective_from) VALUES($1,$2,$3,current_date-interval '1 year')`,[org,property,contact]);await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text,$2::text)) WHERE key='repair_approvals'`,[ORG_ID,org]);
 const value=await view(property,USERS.owner,org);assert.equal(value.currency,'USD');assert.equal(value.defaultMinor,null);assert.equal(value.effectiveMinor,null);assert.equal(value.effectiveSource,'configuration_required');assert.equal(value.verified,false);await controls();
});

test('future/ended ownership, archived owner contact and invalid organization timezone fail closed',async()=>{
 const old=(await db.query(`SELECT effective_from::text from_day,effective_to::text to_day FROM property_owners WHERE id=$1`,[target.ownership])).rows[0],zone=(await db.query(`SELECT timezone FROM organizations WHERE id=$1`,[ORG_ID])).rows[0].timezone;
 const day=(await db.query(`SELECT app.b013_local_day($1)::text d`,[zone])).rows[0].d;
 try{
  await db.query(`UPDATE property_owners SET effective_to=$2::date WHERE id=$1`,[target.ownership,day]);await assert.rejects(view(),code('42501'));
  await db.query(`UPDATE property_owners SET effective_from=$2::date+1,effective_to=NULL WHERE id=$1`,[target.ownership,day]);await assert.rejects(view(),code('42501'));await db.query(`UPDATE property_owners SET effective_from=$2::date,effective_to=$3::date WHERE id=$1`,[target.ownership,old.from_day,old.to_day]);
  await db.query(`UPDATE contacts SET archived_at=clock_timestamp() WHERE id=$1`,[target.contact]);await assert.rejects(view(),code('42501'));await db.query(`UPDATE contacts SET archived_at=NULL WHERE id=$1`,[target.contact]);
  await db.query(`UPDATE organizations SET timezone='Invalid/PolicyFixture' WHERE id=$1`,[ORG_ID]);await assert.rejects(view(),code('42501'));
 }finally{await db.query(`UPDATE organizations SET timezone=$2 WHERE id=$1`,[ORG_ID,zone]);await db.query(`UPDATE contacts SET archived_at=NULL WHERE id=$1`,[target.contact]);await db.query(`UPDATE property_owners SET effective_from=$2::date,effective_to=$3::date WHERE id=$1`,[target.ownership,old.from_day,old.to_day]);}
});

test('current confirmation is verified, but public threshold change-and-restore invalidates its audit version',async()=>{
 await db.query(`UPDATE property_owners SET repair_approval_threshold_minor=777700 WHERE id=$1`,[target.ownership]);
 let ctx:Record<string,unknown>;await db.query('BEGIN');try{await db.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.owner]);ctx=(await db.query(`SELECT * FROM app.b013_owner_context($1,$1,'live',$2,$3)`,[ORG_ID,sessions.get(USERS.owner),target.property])).rows[0];await db.query('COMMIT');}catch(e){await db.query('ROLLBACK');throw e;}
 // Synthetic confirmation fixture tests reading; no owner mutation gateway exists yet.
 await db.query(`INSERT INTO app.b013_override_revisions(org_id,ownership_id,principal_id,currency,minor_unit,revision_no,mode,threshold_minor,source_row_version,source_row_hash,actor_id,session_id,request_id) VALUES($1,$2,$3,'TWD',2,1,'set',777700,$4,$5,$3,$6,$7)`,[ORG_ID,target.ownership,USERS.owner,ctx.source_row_version,ctx.source_row_hash,sessions.get(USERS.owner),randomUUID()]);
 const confirmed=await view();assert.equal(confirmed.effectiveSource,'property_override');assert.equal(confirmed.effectiveMinor,'777700');assert.equal(confirmed.verified,true);
 await db.query(`UPDATE property_owners SET repair_approval_threshold_minor=888800 WHERE id=$1`,[target.ownership]);await db.query(`UPDATE property_owners SET repair_approval_threshold_minor=777700 WHERE id=$1`,[target.ownership]);
 const stale=await view();assert.equal(stale.overrideMinor,'777700');assert.equal(stale.effectiveMinor,null);assert.equal(stale.verified,false);assert.equal(stale.effectiveSource,'legacy_confirmation_required');assert.notEqual(stale.snapshot,confirmed.snapshot);
});

test('contact parent pin fences an OLD-to-NEW owner-id move even when property id is unchanged',async()=>{
 const contact=randomUUID(),held=await client(),writer=await client();let ownership:string|undefined;
 try{await db.query(`INSERT INTO contacts(id,org_id,is_owner,display_name) VALUES($1,$2,true,'Unlinked owner fixture')`,[contact,ORG_ID]);ownership=(await db.query(`INSERT INTO property_owners(org_id,property_id,owner_contact_id,effective_from) VALUES($1,$2,$3,current_date-7) RETURNING id::text`,[ORG_ID,target.property,contact])).rows[0].id;
  await begin(held);await invoke(held);await writer.query('BEGIN');await writer.query(`SET LOCAL lock_timeout='100ms'`);await assert.rejects(writer.query(`UPDATE property_owners SET owner_contact_id=$2 WHERE id=$1`,[ownership,target.contact]),code('55P03'));await writer.query('ROLLBACK');await held.query('ROLLBACK');
  await writer.query('BEGIN');await writer.query(`UPDATE property_owners SET owner_contact_id=$2 WHERE id=$1`,[ownership,target.contact]);await assert.rejects(view(),code('55P03'));await writer.query('ROLLBACK');
 }finally{await held.query('ROLLBACK');await writer.query('ROLLBACK');await held.end();await writer.end();if(ownership)await db.query(`DELETE FROM property_owners WHERE id=$1`,[ownership]);await db.query(`DELETE FROM contacts WHERE id=$1`,[contact]);}
});

test('ownership cap rejects the whole cohort instead of truncating future or ended rows',async()=>{
 const property=randomUUID();await db.query(`INSERT INTO properties(id,org_id,name,country_code,currency,timezone) VALUES($1,$2,'Ownership cap fixture','TW','TWD','Asia/Taipei')`,[property,ORG_ID]);
 try{await db.query(`INSERT INTO property_owners(org_id,property_id,owner_contact_id,effective_from) SELECT $1,$2,$3,CASE WHEN g=0 THEN current_date-1 ELSE current_date+1000+g END FROM generate_series(0,255) g`,[ORG_ID,property,target.contact]);assert.equal((await view(property)).state,'enabled');await db.query(`INSERT INTO property_owners(org_id,property_id,owner_contact_id,effective_from) VALUES($1,$2,$3,current_date+2000)`,[ORG_ID,property,target.contact]);assert.equal((await db.query(`SELECT count(*)::int n FROM property_owners WHERE property_id=$1`,[property])).rows[0].n,257);await assert.rejects(view(property),code('54000'));}finally{await db.query(`DELETE FROM properties WHERE id=$1`,[property]);}
});

test('currency scale is part of source CAS and incompatible stored units are not silently rescaled',async()=>{
 await db.query(`UPDATE property_owners SET repair_approval_threshold_minor=NULL WHERE id=$1`,[target.ownership]);const before=await view(),held=await client(),writer=await client();
 try{await begin(held);await invoke(held);await writer.query('BEGIN');await writer.query(`SET LOCAL lock_timeout='100ms'`);await assert.rejects(writer.query(`UPDATE currencies SET minor_unit=3 WHERE code='TWD'`),code('55P03'));await writer.query('ROLLBACK');await held.query('ROLLBACK');
  await writer.query(`UPDATE currencies SET minor_unit=3 WHERE code='TWD'`);const changed=await view();assert.equal(changed.minorUnit,3);assert.equal(changed.defaultSource,'owner_default_confirmation_required');assert.equal(changed.defaultMinor,null);assert.equal(changed.effectiveMinor,null);assert.equal(changed.verified,false);assert.notEqual(changed.snapshot,before.snapshot);
 }finally{await held.query('ROLLBACK');await writer.query('ROLLBACK');await held.end();await writer.query(`UPDATE currencies SET minor_unit=2 WHERE code='TWD'`);await writer.end();}
});

test('explicit default-clear revision inherits regional data without erasing its prior history',async()=>{
 const root=(await db.query(`SELECT * FROM app.b013_default_roots WHERE org_id=$1 AND principal_id=$2 AND currency='TWD'`,[ORG_ID,USERS.owner])).rows[0],revision=randomUUID();
 await db.query('BEGIN');try{await db.query(`INSERT INTO app.b013_default_revisions(id,org_id,root_id,principal_id,currency,minor_unit,revision_no,mode,threshold_minor,actor_id,session_id,request_id) VALUES($1,$2,$3,$4,'TWD',2,2,'clear',NULL,$4,$5,$6)`,[revision,ORG_ID,root.id,USERS.owner,sessions.get(USERS.owner),randomUUID()]);await db.query(`UPDATE app.b013_default_roots SET current_revision=$2,version=2 WHERE id=$1`,[root.id,revision]);await db.query('COMMIT');}catch(e){await db.query('ROLLBACK');throw e;}
 const cleared=await view();assert.equal(cleared.defaultSource,'regional_default');assert.equal(cleared.effectiveMinor,'500000');assert.equal((await db.query(`SELECT count(*)::int n FROM app.b013_default_revisions WHERE root_id=$1`,[root.id])).rows[0].n,2);await assert.rejects(db.query(`UPDATE app.b013_default_revisions SET threshold_minor=123 WHERE id=$1`,[root.current_revision]),code('23514'));
});

async function policyFixture(org:string,actor:string){const root=randomUUID(),revision=randomUUID();await db.query('BEGIN');try{await db.query(`INSERT INTO app.b013_default_roots(id,org_id,principal_id,currency,version,current_revision) VALUES($1,$2,$3,'TWD',1,$4)`,[root,org,actor,revision]);await db.query(`INSERT INTO app.b013_default_revisions(id,org_id,root_id,principal_id,currency,minor_unit,revision_no,mode,threshold_minor,actor_id,session_id,request_id) VALUES($1,$2,$3,$4,'TWD',2,1,'set',0,$4,$5,$6)`,[revision,org,root,actor,randomUUID(),randomUUID()]);await db.query(`INSERT INTO app.b013_policy_commands(org_id,actor_id,request_id,environment,currency,scope_kind,requested_property_id,live_org_id,command_kind,payload_sha256,outcome,result_revision,session_id) VALUES($1,$2,$3,'live','TWD','default',$6,$1,'set',repeat('a',64),'no_change',NULLIF($4::uuid,$4::uuid),$5)`,[org,actor,randomUUID(),revision,randomUUID(),randomUUID()]);await db.query('COMMIT');return root;}catch(e){await db.query('ROLLBACK');throw e;}}

test('authorized organization and principal cascades remove cyclic private metadata without granting application deletion',async()=>{
 const actor=randomUUID(),org=randomUUID();await db.query(`INSERT INTO auth.users(id,email,role,aud) VALUES($1,$2,'authenticated','authenticated')`,[actor,`${randomUUID()}@example.test`]);await db.query(`INSERT INTO organizations(id,name,country_code,default_currency,timezone) VALUES($1,'Private lifecycle fixture','TW','TWD','Asia/Taipei')`,[org]);
 const first=await policyFixture(org,actor);await db.query(`DELETE FROM organizations WHERE id=$1`,[org]);assert.equal((await db.query(`SELECT count(*)::int n FROM app.b013_default_roots WHERE id=$1`,[first])).rows[0].n,0);assert.equal((await db.query(`SELECT count(*)::int n FROM app.b013_default_revisions WHERE root_id=$1`,[first])).rows[0].n,0);assert.equal((await db.query(`SELECT count(*)::int n FROM app.b013_policy_commands WHERE org_id=$1`,[org])).rows[0].n,0);
 const second=await policyFixture(ORG_ID,actor);await db.query(`DELETE FROM auth.users WHERE id=$1`,[actor]);assert.equal((await db.query(`SELECT count(*)::int n FROM app.b013_default_roots WHERE id=$1`,[second])).rows[0].n,0);assert.equal((await db.query(`SELECT count(*)::int n FROM app.b013_default_revisions WHERE root_id=$1`,[second])).rows[0].n,0);assert.equal((await db.query(`SELECT count(*)::int n FROM app.b013_policy_commands WHERE actor_id=$1`,[actor])).rows[0].n,0);
});

test('actual sandbox ownership is isolated from live and a staff membership cannot replace owner authority',async()=>{
 const org=randomUUID(),property=randomUUID(),contact=randomUUID();
 await db.query(`INSERT INTO organizations(id,name,country_code,default_currency,timezone,environment,live_org_id,feature_flags) VALUES($1,'Policy sandbox fixture','TW','TWD','Asia/Taipei','sandbox',$2,'{"repair_approvals":true}')`,[org,ORG_ID]);
 try{await db.query(`INSERT INTO properties(id,org_id,name,country_code,currency,timezone) VALUES($1,$2,'Sandbox property','TW','TWD','Asia/Taipei')`,[property,org]);await db.query(`INSERT INTO contacts(id,org_id,is_owner,user_id,display_name) VALUES($1,$2,true,$3,'Sandbox owner')`,[contact,org,USERS.owner]);await db.query(`INSERT INTO property_owners(org_id,property_id,owner_contact_id,effective_from) VALUES($1,$2,$3,current_date-1)`,[org,property,contact]);await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text,$2::text)) WHERE key='repair_approvals'`,[ORG_ID,org]);
  assert.equal((await view(property,USERS.owner,org,ORG_ID,'sandbox')).effectiveMinor,'500000');
  await assert.rejects(view(property,USERS.owner,org,ORG2_ID,'sandbox'),code('42501'));await assert.rejects(view(property,USERS.owner,org,ORG_ID,'live'),code('42501'));await assert.rejects(view(property,USERS.admin,org,ORG_ID,'sandbox'),code('42501'));await assert.rejects(view(target.property,USERS.owner,org,ORG_ID,'sandbox'),code('42501'));
 }finally{await db.query(`DELETE FROM property_owners WHERE org_id=$1`,[org]);await db.query(`DELETE FROM organizations WHERE id=$1`,[org]);await controls();}
});

test('natural expiry after the first owner snapshot returns no settings',async()=>{
 const original=(await db.query(`SELECT pg_get_functiondef('app.b013_owner_view(uuid,uuid,text,uuid,uuid)'::regprocedure) definition`)).rows[0].definition;
 const sid=await session(USERS.owner,1000),marker=1+randomBytes(4).readUInt32BE(0)%1000000000;let pending:Promise<unknown>|undefined;
 try{
  const instrumented=original.replace('SELECT * INTO final_ctx FROM app.b013_owner_context',`PERFORM pg_advisory_xact_lock(${marker}::bigint);PERFORM pg_sleep(1.5);SELECT * INTO final_ctx FROM app.b013_owner_context`);assert.notEqual(instrumented,original);await db.query(instrumented);
  pending=view().then(v=>({value:v}),error=>({error}));let observed=false;const deadline=Date.now()+900;
  while(Date.now()<deadline){observed=(await db.query(`SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND l.locktype='advisory' AND l.classid=0 AND l.objid=$1::oid AND l.granted) observed`,[marker])).rows[0].observed;if(observed)break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(observed,true);assert.equal((await db.query(`SELECT expires_at>clock_timestamp() valid FROM auth_sessions WHERE id=$1`,[sid])).rows[0].valid,true,'actually observed while current session was still valid');
  const result=await pending as {value?:unknown;error?:{code?:string}};assert.equal(result.error?.code,'42501');assert.equal(result.value,undefined);assert.equal((await db.query(`SELECT count(*)::int n FROM app.b013_policy_commands WHERE actor_id=$1`,[USERS.owner])).rows[0].n,0);
 }finally{await pending;await db.query(original);await session();}
});

test('actual demo reset clears policy metadata twice and retains regional configuration and unrelated data',async()=>{
 await db.query(`CREATE TABLE app.b013_unrelated_probe(value integer NOT NULL)`);await db.query(`INSERT INTO app.b013_unrelated_probe VALUES(7)`);
 for(let n=0;n<2;n++){
  if(n>0)await policyFixture(ORG_ID,USERS.owner);
  const demo=process.env.DEMO_MODE,key=process.env.ID_DOC_ENCRYPTION_KEY;try{process.env.DEMO_MODE='true';process.env.ID_DOC_ENCRYPTION_KEY=randomBytes(32).toString('hex');await resetAndSeed();}finally{if(demo===undefined)delete process.env.DEMO_MODE;else process.env.DEMO_MODE=demo;if(key===undefined)delete process.env.ID_DOC_ENCRYPTION_KEY;else process.env.ID_DOC_ENCRYPTION_KEY=key;}
  for(const table of ['b013_policy_commands','b013_override_revisions','b013_default_revisions','b013_default_roots'])assert.equal((await db.query(`SELECT count(*)::int n FROM app.${table}`)).rows[0].n,0,table);
  assert.equal((await db.query(`SELECT threshold_minor::text value FROM app.b013_regional_defaults WHERE country_code='TW' AND currency='TWD'`)).rows[0].value,'500000');assert.equal((await db.query(`SELECT value FROM app.b013_unrelated_probe`)).rows[0].value,7);
 }
});
