import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "pg";
import { stableStringify } from "../idempotency";
import { ORG_ID, USERS } from "./ids";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { resetAndSeed } from "./seed";

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone:Awaited<ReturnType<typeof cloneTestDatabase>>;
test.before(async()=>{clone=await cloneTestDatabase();const demo=process.env.DEMO_MODE,key=process.env.ID_DOC_ENCRYPTION_KEY;try{process.env.DEMO_MODE='true';process.env.ID_DOC_ENCRYPTION_KEY=randomBytes(32).toString('hex');await resetAndSeed();const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();try{await c.query(await readFile('supabase/migrations/20261031100219_b010_b028_real_producer.sql','utf8'));await c.query(await readFile('src/server/b019-manager-begin-prototype.sql','utf8'));}finally{await c.end();}}finally{if(demo===undefined)delete process.env.DEMO_MODE;else process.env.DEMO_MODE=demo;if(key===undefined)delete process.env.ID_DOC_ENCRYPTION_KEY;else process.env.ID_DOC_ENCRYPTION_KEY=key;}});
test.after(async()=>{if(clone)await clone.cleanup();});
const invoke=`SELECT * FROM app.b019_begin_probe($1,$1,'live',$2,$3,'admin',$4,$5,'2026-10-30','12345',$6)`;

test('center-only fresh key derives private operation and cannot commit incomplete',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {await c.query('BEGIN');const lease=(await c.query<{id:string}>(`SELECT l.id::text FROM leases l JOIN lease_parties lp ON lp.org_id=l.org_id AND lp.lease_id=l.id AND lp.role='primary' JOIN contacts ct ON ct.org_id=lp.org_id AND ct.id=lp.contact_id AND ct.is_tenant AND ct.archived_at IS NULL JOIN invoices i ON i.org_id=l.org_id AND i.lease_id=l.id AND i.status IN ('open','partially_paid') WHERE l.org_id=$1 ORDER BY l.id LIMIT 1`,[ORG_ID])).rows[0].id;const sid=randomUUID(),key=randomUUID();
  await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"payment_results_v2":false,"notification_center_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='notification_center_v2'`,[ORG_ID]);
  await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);await c.query('SET LOCAL ROLE service_role');
  const result=(await c.query<{disposition:string;payment_id:string|null}>(invoke,[ORG_ID,sid,lease,key,100,'fixture'])).rows[0];assert.equal(result.disposition,'new');assert.ok(result.payment_id);await c.query('RESET ROLE');
  const op=(await c.query<{payment_id:string;payload_digest:string;invoice_ids:string[];prestate_digest:string}>(`SELECT payment_id::text,payload_digest,invoice_ids::text[],prestate_digest FROM app.b019_begin_probe_ops WHERE tx_id=pg_current_xact_id()`)).rows[0];assert.equal(op.payment_id,result.payment_id);assert.ok(op.invoice_ids.length>0);assert.equal(op.prestate_digest.length,64);
  assert.equal(op.payload_digest,createHash('sha256').update(stableStringify({leaseId:lease,amount:100,paidOn:'2026-10-30',last5:'12345',reference:'fixture'})).digest('hex'));
  await c.query('SAVEPOINT incomplete');await assert.rejects(c.query('SET CONSTRAINTS app.b019_begin_probe_never_commit IMMEDIATE'),(e:unknown)=>(e as {code?:string}).code==='23514');await c.query('ROLLBACK TO SAVEPOINT incomplete');await c.query('ROLLBACK');
  assert.equal((await c.query(`SELECT 1 FROM app.b019_begin_probe_ops WHERE payment_id=$1`,[result.payment_id])).rowCount,0);
 } finally {await c.end();}
});

test('old command replays recorded under both flags off, including reversal; missing stays unknown and changed digest denied',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {await c.query('BEGIN');const p=(await c.query<{id:string;lease:string}>(`SELECT id::text,lease_id::text lease FROM payments WHERE org_id=$1 AND status='confirmed' LIMIT 1`,[ORG_ID])).rows[0];assert.ok(p);const sid=randomUUID(),key=randomUUID();
  await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"payment_results_v2":false,"notification_center_v2":false}'::jsonb WHERE id=$1`,[ORG_ID]);
  const digest=createHash('sha256').update(stableStringify({leaseId:p.lease,amount:100,paidOn:'2026-10-30',last5:'12345',reference:'fixture'})).digest('hex');
  await c.query(`INSERT INTO app.b010_payment_commands(org_id,actor_id,request_id,payload_digest,payment_id) VALUES($1,$2,$3,$4,$5)`,[ORG_ID,USERS.admin,key,digest,p.id]);
  await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);await c.query('SAVEPOINT missing_source');await c.query('SET LOCAL ROLE service_role');
  await assert.rejects(c.query(invoke,[ORG_ID,sid,p.lease,key,100,'fixture']),(e:unknown)=>(e as {code?:string}).code==='42501');await c.query('ROLLBACK TO SAVEPOINT missing_source');
  await c.query(`INSERT INTO app.b010_source_events(org_id,lease_id,payment_id,kind,occurrence_key,actor_id) VALUES($1,$2,$3,'payment_confirmed','payment_confirmed',$4)`,[ORG_ID,p.lease,p.id,USERS.admin]);await c.query('SET LOCAL ROLE service_role');
  assert.deepEqual((await c.query(invoke,[ORG_ID,sid,p.lease,key,100,'fixture'])).rows[0],{disposition:'recorded',payment_id:p.id});
  assert.deepEqual((await c.query(invoke,[ORG_ID,sid,p.lease,randomUUID(),100,'fixture'])).rows[0],{disposition:'unknown',payment_id:null});
  await c.query('SAVEPOINT mismatch');await assert.rejects(c.query(invoke,[ORG_ID,sid,p.lease,key,101,'fixture']),(e:unknown)=>(e as {code?:string}).code==='42501');await c.query('ROLLBACK TO SAVEPOINT mismatch');await c.query('RESET ROLE');
  await c.query(`UPDATE payments SET status='reversed' WHERE id=$1`,[p.id]);await c.query('SET LOCAL ROLE service_role');assert.deepEqual((await c.query(invoke,[ORG_ID,sid,p.lease,key,100,'fixture'])).rows[0],{disposition:'recorded',payment_id:p.id});await c.query('ROLLBACK');
 } finally {await c.end();}
});

test('begin denies invalid session before platform lock and private relation contention before context write',async()=>{
 const a=new Client({connectionString:process.env.DATABASE_URL}),b=new Client({connectionString:process.env.DATABASE_URL});await a.connect();await b.connect();
 try {
  const lease=(await a.query<{id:string}>(`SELECT id::text FROM leases WHERE org_id=$1 LIMIT 1`,[ORG_ID])).rows[0].id;const sid=randomUUID(),expired=randomUUID();
  await a.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$3,$4,clock_timestamp()+interval '1 hour'),($2,$3,$5,clock_timestamp()-interval '1 second')`,[sid,expired,USERS.admin,randomUUID(),randomUUID()]);
  await b.query('BEGIN');await b.query('LOCK TABLE public.platform_settings IN ACCESS EXCLUSIVE MODE');await a.query('BEGIN');await a.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);await a.query('SET LOCAL ROLE service_role');
  await assert.rejects(a.query(invoke,[ORG_ID,expired,lease,randomUUID(),100,'fixture']),(e:unknown)=>(e as {code?:string}).code==='42501');await a.query('ROLLBACK');await b.query('ROLLBACK');
  await b.query('BEGIN');await b.query('LOCK TABLE app.b019_payment_contexts IN ACCESS EXCLUSIVE MODE');await a.query('BEGIN');await a.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);await a.query('SET LOCAL ROLE service_role');
  await assert.rejects(a.query(invoke,[ORG_ID,sid,lease,randomUUID(),100,'fixture']),(e:unknown)=>(e as {code?:string}).code==='55P03');await a.query('ROLLBACK');await b.query('ROLLBACK');
  assert.equal((await a.query(`SELECT 1 FROM app.b019_begin_probe_ops`)).rowCount,0);assert.equal((await a.query(`SELECT 1 FROM app.b019_payment_contexts`)).rowCount,0);
 } finally {await a.end();await b.end();}
});

test('held old command key fails retryably, not unknown; app roles cannot call fixed entrypoint',async()=>{
 const a=new Client({connectionString:process.env.DATABASE_URL}),b=new Client({connectionString:process.env.DATABASE_URL});await a.connect();await b.connect();
 try {
  const lease=(await a.query<{id:string}>(`SELECT id::text FROM leases WHERE org_id=$1 LIMIT 1`,[ORG_ID])).rows[0].id;const sid=randomUUID(),key=randomUUID();
  await a.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
  for(const role of ['anon','authenticated'])assert.equal((await a.query<{v:boolean}>(`SELECT has_function_privilege($1,'app.b019_begin_probe(uuid,uuid,text,uuid,text,text,uuid,bigint,text,text,text)','EXECUTE') v`,[role])).rows[0].v,false);
  await b.query('BEGIN');await b.query(`SELECT pg_advisory_xact_lock(hashtextextended('b010:payment:'||$1::text||':'||$2::text||':'||$3::text,0))`,[ORG_ID,USERS.admin,key]);
  await a.query('BEGIN');await a.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);await a.query('SET LOCAL ROLE service_role');await assert.rejects(a.query(invoke,[ORG_ID,sid,lease,key,100,'fixture']),(e:unknown)=>(e as {code?:string}).code==='55P03');await a.query('ROLLBACK');await b.query('ROLLBACK');
 } finally {await a.end();await b.end();}
});

test('held old source relation prevents replay admission before context write',async()=>{
 const a=new Client({connectionString:process.env.DATABASE_URL}),b=new Client({connectionString:process.env.DATABASE_URL});await a.connect();await b.connect();
 try {const lease=(await a.query<{id:string}>(`SELECT id::text FROM leases WHERE org_id=$1 LIMIT 1`,[ORG_ID])).rows[0].id;const sid=randomUUID();await a.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
  await b.query('BEGIN');await b.query('LOCK TABLE app.b010_source_events IN ACCESS EXCLUSIVE MODE');await a.query('BEGIN');await a.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);await a.query('SET LOCAL ROLE service_role');
  await assert.rejects(a.query(invoke,[ORG_ID,sid,lease,randomUUID(),100,'fixture']),(e:unknown)=>(e as {code?:string}).code==='55P03');await a.query('ROLLBACK');await b.query('ROLLBACK');assert.equal((await a.query(`SELECT 1 FROM app.b019_payment_contexts`)).rowCount,0);
 } finally {await a.end();await b.end();}
});

test('new manager operation rejects zero or multiple primary parties',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {await c.query('BEGIN');const row=(await c.query<{lease:string;payer:string}>(`SELECT l.id::text lease,lp.contact_id::text payer FROM leases l JOIN lease_parties lp ON lp.org_id=l.org_id AND lp.lease_id=l.id AND lp.role='primary' JOIN contacts ct ON ct.org_id=lp.org_id AND ct.id=lp.contact_id AND ct.is_tenant AND ct.archived_at IS NULL JOIN invoices i ON i.org_id=l.org_id AND i.lease_id=l.id AND i.status IN ('open','partially_paid') WHERE l.org_id=$1 ORDER BY l.id LIMIT 1`,[ORG_ID])).rows[0];assert.ok(row);
  const sid=randomUUID();await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"payment_results_v2":false,"notification_center_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='notification_center_v2'`,[ORG_ID]);await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);
  await c.query('SAVEPOINT no_primary');await c.query(`DELETE FROM lease_parties WHERE org_id=$1 AND lease_id=$2 AND role='primary'`,[ORG_ID,row.lease]);await c.query('SET LOCAL ROLE service_role');await assert.rejects(c.query(invoke,[ORG_ID,sid,row.lease,randomUUID(),100,'fixture']),(e:unknown)=>(e as {code?:string}).code==='42501');await c.query('ROLLBACK TO SAVEPOINT no_primary');
  const contact=(await c.query<{id:string}>(`INSERT INTO contacts(org_id,display_name,is_tenant) VALUES($1,'local second primary',true) RETURNING id::text`,[ORG_ID])).rows[0].id;await c.query('SAVEPOINT two_primary');await c.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')`,[ORG_ID,row.lease,contact]);await c.query('SET LOCAL ROLE service_role');await assert.rejects(c.query(invoke,[ORG_ID,sid,row.lease,randomUUID(),100,'fixture']),(e:unknown)=>(e as {code?:string}).code==='42501');await c.query('ROLLBACK TO SAVEPOINT two_primary');await c.query('ROLLBACK');
 } finally {await c.end();}
});

test('new manager operation fails NOWAIT on existing invoice tuple lock',async()=>{
 const a=new Client({connectionString:process.env.DATABASE_URL}),b=new Client({connectionString:process.env.DATABASE_URL});await a.connect();await b.connect();
 try {const row=(await a.query<{lease:string;invoice:string}>(`SELECT l.id::text lease,i.id::text invoice FROM leases l JOIN lease_parties lp ON lp.org_id=l.org_id AND lp.lease_id=l.id AND lp.role='primary' JOIN contacts ct ON ct.org_id=lp.org_id AND ct.id=lp.contact_id AND ct.is_tenant AND ct.archived_at IS NULL JOIN invoices i ON i.org_id=l.org_id AND i.lease_id=l.id AND i.status IN ('open','partially_paid') WHERE l.org_id=$1 ORDER BY l.id LIMIT 1`,[ORG_ID])).rows[0];assert.ok(row);
  const sid=randomUUID();await a.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);await a.query(`UPDATE organizations SET feature_flags=feature_flags || '{"payment_results_v2":false,"notification_center_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);await a.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='notification_center_v2'`,[ORG_ID]);
  await b.query('BEGIN');await b.query(`SELECT id FROM invoices WHERE id=$1 FOR UPDATE`,[row.invoice]);await a.query('BEGIN');await a.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);await a.query('SET LOCAL ROLE service_role');await assert.rejects(a.query(invoke,[ORG_ID,sid,row.lease,randomUUID(),100,'fixture']),(e:unknown)=>(e as {code?:string}).code==='55P03');await a.query('ROLLBACK');await b.query('ROLLBACK');assert.equal((await a.query(`SELECT 1 FROM app.b019_begin_probe_ops`)).rowCount,0);
 } finally {await a.end();await b.end();}
});

test('unknown replay rechecks wall clock after its final admission returns',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {await c.query('BEGIN');const lease=(await c.query<{id:string}>(`SELECT id::text FROM leases WHERE org_id=$1 LIMIT 1`,[ORG_ID])).rows[0].id;const sid=randomUUID();
  await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '3 seconds')`,[sid,USERS.admin,randomUUID()]);
  await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"payment_results_v2":false,"notification_center_v2":false}'::jsonb WHERE id=$1`,[ORG_ID]);
  await c.query(`ALTER FUNCTION app.b019_payment_admit(uuid,uuid,text,uuid,uuid,text) RENAME TO b019_payment_admit_original_probe`);
  await c.query(`CREATE SEQUENCE app.b019_admit_delay_probe`);
  await c.query(`CREATE FUNCTION app.b019_payment_admit(uuid,uuid,text,uuid,uuid,text) RETURNS TABLE(email_on boolean,center_on boolean) LANGUAGE plpgsql SECURITY DEFINER AS $$ DECLARE n bigint; BEGIN RETURN QUERY SELECT * FROM app.b019_payment_admit_original_probe($1,$2,$3,$4,$5,$6); n:=nextval('app.b019_admit_delay_probe'); IF n=2 THEN PERFORM pg_sleep(3.2); END IF; END $$`);
  await c.query(`REVOKE ALL ON FUNCTION app.b019_payment_admit(uuid,uuid,text,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role`);await c.query(`GRANT EXECUTE ON FUNCTION app.b019_payment_admit(uuid,uuid,text,uuid,uuid,text) TO service_role`);
  assert.equal((await c.query<{valid:boolean}>(`SELECT expires_at>clock_timestamp() valid FROM auth_sessions WHERE id=$1`,[sid])).rows[0].valid,true);
  await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);await c.query('SAVEPOINT before_call');await c.query('SET LOCAL ROLE service_role');
  await assert.rejects(c.query(invoke,[ORG_ID,sid,lease,randomUUID(),100,'fixture']),(e:unknown)=>(e as {code?:string}).code==='42501');await c.query('ROLLBACK TO SAVEPOINT before_call');
  assert.equal(Number((await c.query<{last_value:string}>(`SELECT last_value FROM app.b019_admit_delay_probe`)).rows[0].last_value),2);await c.query('ROLLBACK');
 } finally {await c.end();}
});

test('new operation rejects candidate invoice with a different same-org property or currency',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {await c.query('BEGIN');const row=(await c.query<{lease:string;invoice:string;other:string}>(`SELECT l.id::text lease,i.id::text invoice,p.id::text other FROM leases l JOIN lease_parties lp ON lp.org_id=l.org_id AND lp.lease_id=l.id AND lp.role='primary' JOIN contacts ct ON ct.org_id=lp.org_id AND ct.id=lp.contact_id AND ct.is_tenant AND ct.archived_at IS NULL JOIN invoices i ON i.org_id=l.org_id AND i.lease_id=l.id AND i.status IN ('open','partially_paid') JOIN properties p ON p.org_id=l.org_id AND p.id<>l.property_id WHERE l.org_id=$1 ORDER BY l.id LIMIT 1`,[ORG_ID])).rows[0];assert.ok(row);
  const sid=randomUUID();await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"payment_results_v2":false,"notification_center_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='notification_center_v2'`,[ORG_ID]);await c.query(`UPDATE invoices SET property_id=$2 WHERE id=$1`,[row.invoice,row.other]);await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);await c.query('SAVEPOINT mismatch_property');await c.query('SET LOCAL ROLE service_role');
  await assert.rejects(c.query(invoke,[ORG_ID,sid,row.lease,randomUUID(),100,'fixture']),(e:unknown)=>(e as {code?:string;message?:string}).code==='23514' && (e as {message?:string}).message==='prototype invoice scope unavailable');await c.query('ROLLBACK TO SAVEPOINT mismatch_property');
  const currency=(await c.query<{code:string}>(`SELECT c.code::text code FROM currencies c JOIN leases l ON l.id=$1 WHERE c.code<>l.currency ORDER BY c.code LIMIT 1`,[row.lease])).rows[0];assert.ok(currency);
  await c.query(`UPDATE invoices i SET property_id=l.property_id,currency=$2 FROM leases l WHERE i.id=$1 AND l.id=i.lease_id`,[row.invoice,currency.code]);await c.query('SAVEPOINT mismatch_currency');await c.query('SET LOCAL ROLE service_role');
  await assert.rejects(c.query(invoke,[ORG_ID,sid,row.lease,randomUUID(),100,'fixture']),(e:unknown)=>(e as {code?:string;message?:string}).code==='23514' && (e as {message?:string}).message==='prototype invoice scope unavailable');await c.query('ROLLBACK TO SAVEPOINT mismatch_currency');await c.query('ROLLBACK');
 } finally {await c.end();}
});
