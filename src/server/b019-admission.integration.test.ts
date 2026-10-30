import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "pg";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { resetAndSeed } from "./seed";
import { seedSandboxForNewFirm } from "./sandbox";

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>;
test.before(async()=>{
  clone=await cloneTestDatabase();
  const demo=process.env.DEMO_MODE,key=process.env.ID_DOC_ENCRYPTION_KEY;
  try {
    process.env.DEMO_MODE="true";process.env.ID_DOC_ENCRYPTION_KEY=randomBytes(32).toString("hex");
    await resetAndSeed();
    const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
    try {await c.query(await readFile("supabase/migrations/20261031100219_b010_b028_real_producer.sql","utf8"));} finally {await c.end();}
  } finally {
    if(demo===undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE=demo;
    if(key===undefined) delete process.env.ID_DOC_ENCRYPTION_KEY; else process.env.ID_DOC_ENCRYPTION_KEY=key;
  }
});
test.after(async()=>{if(clone) await clone.cleanup();});

test("dual gates are independent and admission derives actual actor and session",async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {
  await c.query('BEGIN');
  const lease=(await c.query<{id:string}>(`SELECT id::text FROM leases WHERE org_id=$1 LIMIT 1`,[ORG_ID])).rows[0].id;
  const session=randomUUID();await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[session,USERS.admin,randomUUID()]);
  for(const [email,center] of [[false,false],[true,false],[false,true],[true,true]] as const) {
   await c.query(`UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object('payment_results_v2',$2::boolean,'notification_center_v2',$3::boolean) WHERE id=$1`,[ORG_ID,email,center]);
   await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key IN ('payment_results_v2','notification_center_v2')`,[ORG_ID]);
   await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);await c.query('SET LOCAL ROLE authenticated');
   const row=(await c.query<{email_on:boolean;center_on:boolean}>(`SELECT * FROM app.b019_payment_admit($1,$1,'live',$2,$3,'admin')`,[ORG_ID,session,lease])).rows[0];
   assert.deepEqual(row,{email_on:email,center_on:center});await c.query('RESET ROLE');
  }
  await c.query('SAVEPOINT cross_scope');await c.query('SET LOCAL ROLE authenticated');
  await assert.rejects(c.query(`SELECT * FROM app.b019_payment_admit($1,$1,'live',$2,$3,'admin')`,[ORG2_ID,session,lease]),(e:unknown)=>(e as {code?:string}).code==='42501');
  await c.query('ROLLBACK TO SAVEPOINT cross_scope');
  await c.query(`UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,[session]);await c.query('SAVEPOINT expired');await c.query('SET LOCAL ROLE authenticated');
  await assert.rejects(c.query(`SELECT * FROM app.b019_payment_admit($1,$1,'live',$2,$3,'admin')`,[ORG_ID,session,lease]),(e:unknown)=>(e as {code?:string}).code==='42501');
  await c.query('ROLLBACK TO SAVEPOINT expired');
  await c.query('SET CONSTRAINTS app.b019_payment_context_cleanup IMMEDIATE');
  assert.equal((await c.query(`SELECT 1 FROM app.b019_payment_contexts WHERE tx_id=txid_current()`)).rowCount,0);
  await c.query('ROLLBACK');
 } finally {await c.end();}
});

test("only eligible current staff gain admission; malformed gate fails closed and private records stay private",async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {
  await c.query('BEGIN');
  const lease=(await c.query<{id:string}>(`SELECT id::text FROM leases WHERE org_id=$1 LIMIT 1`,[ORG_ID])).rows[0].id;
  await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"payment_results_v2":true,"notification_center_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
  await c.query(`UPDATE platform_settings SET value=CASE key WHEN 'payment_results_v2' THEN '{"enabled":"true","allowed_org_ids":[]}'::jsonb ELSE jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) END WHERE key IN ('payment_results_v2','notification_center_v2')`,[ORG_ID]);
  for(const role of ['manager','accountant','maintenance'] as const) {
   const sid=randomUUID(), user=USERS[role];await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,user,randomUUID()]);
   await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[user]);await c.query(`SAVEPOINT role_case`);await c.query('SET LOCAL ROLE authenticated');
   if(role==='maintenance') await assert.rejects(c.query(`SELECT * FROM app.b019_payment_admit($1,$1,'live',$2,$3,$4)`,[ORG_ID,sid,lease,role]),(e:unknown)=>(e as {code?:string}).code==='42501');
   else assert.deepEqual((await c.query<{email_on:boolean;center_on:boolean}>(`SELECT * FROM app.b019_payment_admit($1,$1,'live',$2,$3,$4)`,[ORG_ID,sid,lease,role])).rows[0],{email_on:false,center_on:true});
   await c.query('ROLLBACK TO SAVEPOINT role_case');
  }
  for(const role of ['anon','authenticated','service_role'] as const) {
   const checks=(await c.query<{read:boolean;write:boolean;exec:boolean}>(`SELECT has_table_privilege($1,'app.b019_payment_contexts','SELECT') AS read,has_table_privilege($1,'app.b019_payment_contexts','INSERT,UPDATE,DELETE,TRUNCATE') AS write,has_function_privilege($1,'app.b019_clean_payment_context()','EXECUTE') AS exec`,[role])).rows[0];
   assert.deepEqual(checks,{read:false,write:false,exec:false});
  }
  await c.query('ROLLBACK');
 } finally {await c.end();}
});

test("admission and organization updates exclude one another without waiting",async()=>{
 const a=new Client({connectionString:process.env.DATABASE_URL}), b=new Client({connectionString:process.env.DATABASE_URL});await a.connect();await b.connect();
 try {
  const lease=(await a.query<{id:string}>(`SELECT id::text FROM leases WHERE org_id=$1 LIMIT 1`,[ORG_ID])).rows[0].id;
  const sid=randomUUID();await a.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.manager,randomUUID()]);
  await a.query('BEGIN');await a.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.manager]);await a.query('SET LOCAL ROLE authenticated');
  await a.query(`SELECT * FROM app.b019_payment_admit($1,$1,'live',$2,$3,'manager')`,[ORG_ID,sid,lease]);
  await b.query('BEGIN');await assert.rejects(b.query(`SELECT id FROM organizations WHERE id=$1 FOR UPDATE NOWAIT`,[ORG_ID]),(e:unknown)=>(e as {code?:string}).code==='55P03');await b.query('ROLLBACK');await a.query('ROLLBACK');
  await b.query('BEGIN');await b.query(`SELECT id FROM organizations WHERE id=$1 FOR UPDATE`,[ORG_ID]);
  await a.query('BEGIN');await a.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.manager]);await a.query('SET LOCAL ROLE authenticated');
  await assert.rejects(a.query(`SELECT * FROM app.b019_payment_admit($1,$1,'live',$2,$3,'manager')`,[ORG_ID,sid,lease]),(e:unknown)=>(e as {code?:string}).code==='55P03');
  await a.query('ROLLBACK');await b.query('ROLLBACK');
 } finally {await a.end();await b.end();}
});

test("draft center transition guard rejects an unhooked old writer and rolls back its update",async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {
  await c.query('BEGIN');
  const payment=(await c.query<{id:string}>(`SELECT id::text FROM payments WHERE org_id=$1 AND status='confirmed' LIMIT 1`,[ORG_ID])).rows[0];assert.ok(payment);
  await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"payment_results_v2":false,"notification_center_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
  await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='notification_center_v2'`,[ORG_ID]);
  await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);await c.query('SAVEPOINT old_writer');await c.query('SET LOCAL ROLE service_role');
  await c.query(`UPDATE payments SET status='reversed' WHERE id=$1`,[payment.id]);
  await assert.rejects(c.query(`SET CONSTRAINTS app.b019_payment_center_required IMMEDIATE`),(e:unknown)=>(e as {code?:string}).code==='23514');
  await c.query('ROLLBACK TO SAVEPOINT old_writer');
  assert.equal((await c.query<{status:string}>(`SELECT status::text FROM payments WHERE id=$1`,[payment.id])).rows[0].status,'confirmed');
  assert.equal((await c.query(`SELECT 1 FROM app.b019_payment_requirements WHERE payment_id=$1`,[payment.id])).rowCount,0);
  await c.query('ROLLBACK');
 } finally {await c.end();}
});

test("expired session fails before privileged control locks",async()=>{
 const a=new Client({connectionString:process.env.DATABASE_URL}),b=new Client({connectionString:process.env.DATABASE_URL});await a.connect();await b.connect();
 try {
  const lease=(await a.query<{id:string}>(`SELECT id::text FROM leases WHERE org_id=$1 LIMIT 1`,[ORG_ID])).rows[0].id;
  const sid=randomUUID();await a.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()-interval '1 second')`,[sid,USERS.manager,randomUUID()]);
  await b.query('BEGIN');await b.query('LOCK TABLE public.platform_settings IN ACCESS EXCLUSIVE MODE');
  await a.query('BEGIN');await a.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.manager]);await a.query('SET LOCAL ROLE authenticated');
  await assert.rejects(a.query(`SELECT * FROM app.b019_payment_admit($1,$1,'live',$2,$3,'manager')`,[ORG_ID,sid,lease]),(e:unknown)=>(e as {code?:string}).code==='42501');
  await a.query('ROLLBACK');await b.query('ROLLBACK');
 } finally {await a.end();await b.end();}
});

test("enabled same-status lease remapping is rejected",async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {
  await c.query('BEGIN');
  const row=(await c.query<{id:string;other_lease:string}>(`SELECT p.id::text,(SELECT l.id FROM leases l WHERE l.org_id=p.org_id AND l.id<>p.lease_id LIMIT 1)::text other_lease FROM payments p WHERE p.org_id=$1 AND p.status='confirmed' LIMIT 1`,[ORG_ID])).rows[0];assert.ok(row?.other_lease);
  await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"notification_center_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
  await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='notification_center_v2'`,[ORG_ID]);
  await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);await c.query('SAVEPOINT remap');await c.query('SET LOCAL ROLE service_role');
  await assert.rejects(c.query(`UPDATE payments SET lease_id=$2 WHERE id=$1`,[row.id,row.other_lease]),(e:unknown)=>(e as {code?:string}).code==='23514');
  await c.query('ROLLBACK TO SAVEPOINT remap');await c.query('ROLLBACK');
 } finally {await c.end();}
});

test("enabled old organization cannot be bypassed by moving a submitted payment into an off organization",async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {
  await c.query('BEGIN');
  const payment=(await c.query<{id:string}>(`INSERT INTO payments(org_id,property_id,lease_id,currency,amount_minor,paid_on,method,status,source,submitted_by)
    SELECT p.org_id,p.property_id,p.lease_id,p.currency,p.amount_minor,p.paid_on,p.method,'submitted',p.source,$2 FROM payments p WHERE p.org_id=$1 LIMIT 1 RETURNING id::text`,[ORG_ID,USERS.admin])).rows[0];assert.ok(payment);
  const dest=(await c.query<{id:string;property_id:string}>(`SELECT id::text,property_id::text FROM leases WHERE org_id=$1 LIMIT 1`,[ORG2_ID])).rows[0];assert.ok(dest);
  await c.query(`UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object('notification_center_v2',id=$1::uuid) WHERE id IN ($1,$2)`,[ORG_ID,ORG2_ID]);
  await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='notification_center_v2'`,[ORG_ID]);
  await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);await c.query('SAVEPOINT cross_org');await c.query('SET LOCAL ROLE service_role');
  await assert.rejects(c.query(`UPDATE payments SET org_id=$2,lease_id=$3,property_id=$4 WHERE id=$1`,[payment.id,ORG2_ID,dest.id,dest.property_id]),(e:unknown)=>(e as {code?:string}).code==='23514');
  await c.query('ROLLBACK TO SAVEPOINT cross_org');await c.query('ROLLBACK');
 } finally {await c.end();}
});


test("sandbox admission binds and pins the canonical live organization",async()=>{
 const a=new Client({connectionString:process.env.DATABASE_URL}),b=new Client({connectionString:process.env.DATABASE_URL});await a.connect();await b.connect();
 try {
  await a.query('BEGIN');const sandbox=await seedSandboxForNewFirm(a,ORG_ID,USERS.admin);const lease=(await a.query<{id:string}>(`SELECT id::text FROM leases WHERE org_id=$1 LIMIT 1`,[sandbox])).rows[0];assert.ok(lease);
  const sid=randomUUID();await a.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);await a.query('COMMIT');
  await a.query('BEGIN');await a.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);await a.query('SET LOCAL ROLE authenticated');
  await a.query(`SELECT * FROM app.b019_payment_admit($1,$2,'sandbox',$3,$4,'admin')`,[sandbox,ORG_ID,sid,lease.id]);
  await b.query('BEGIN');await assert.rejects(b.query(`SELECT id FROM organizations WHERE id=$1 FOR UPDATE NOWAIT`,[ORG_ID]),(e:unknown)=>(e as {code?:string}).code==='55P03');await b.query('ROLLBACK');await a.query('ROLLBACK');
  await b.query('BEGIN');await b.query(`SELECT id FROM organizations WHERE id=$1 FOR UPDATE`,[ORG_ID]);
  await a.query('BEGIN');await a.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);await a.query('SET LOCAL ROLE authenticated');
  await assert.rejects(a.query(`SELECT * FROM app.b019_payment_admit($1,$2,'sandbox',$3,$4,'admin')`,[sandbox,ORG_ID,sid,lease.id]),(e:unknown)=>(e as {code?:string}).code==='55P03');await a.query('ROLLBACK');await b.query('ROLLBACK');
  await a.query('BEGIN');await a.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);await a.query('SET LOCAL ROLE authenticated');
  await assert.rejects(a.query(`SELECT * FROM app.b019_payment_admit($1,$2,'sandbox',$3,$4,'admin')`,[sandbox,ORG2_ID,sid,lease.id]),(e:unknown)=>(e as {code?:string}).code==='42501');await a.query('ROLLBACK');
 } finally {await a.end();await b.end();}
});

test("preparation resolves a new key before old source and early cleanup cannot preserve a stale proof",async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {
  await c.query('BEGIN');const pay=(await c.query<{id:string;lease_id:string}>(`SELECT id::text,lease_id::text FROM payments WHERE org_id=$1 AND status='confirmed' LIMIT 1`,[ORG_ID])).rows[0];assert.ok(pay);
  const sid=randomUUID();await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
  await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"notification_center_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
  await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='notification_center_v2'`,[ORG_ID]);
  await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);await c.query('SAVEPOINT no_context');await c.query('SET LOCAL ROLE authenticated');
  await assert.rejects(c.query(`SELECT * FROM app.b019_prepare_payment($1,$2,$3,'payment_reversed')`,[ORG_ID,pay.lease_id,pay.id]),(e:unknown)=>(e as {code?:string}).code==='42501');
  await c.query('ROLLBACK TO SAVEPOINT no_context');await c.query('SET LOCAL ROLE authenticated');
  await c.query(`SELECT * FROM app.b019_payment_admit($1,$1,'live',$2,$3,'admin')`,[ORG_ID,sid,pay.lease_id]);
  const result=(await c.query<{outcome:string;center_event_id:string|null}>(`SELECT * FROM app.b019_prepare_payment($1,$2,$3,'payment_reversed')`,[ORG_ID,pay.lease_id,pay.id])).rows[0];
  assert.deepEqual(result,{outcome:'new',center_event_id:null});
  assert.equal((await c.query<{outcome:string}>(`SELECT * FROM app.b019_prepare_payment($1,$2,$3,'payment_reversed')`,[ORG_ID,pay.lease_id,pay.id])).rows[0].outcome,'new');await c.query('RESET ROLE');
  assert.equal((await c.query(`SELECT 1 FROM app.b019_payment_preparations WHERE tx_id=txid_current() AND payment_id=$1`,[pay.id])).rowCount,1);
  await c.query(`INSERT INTO app.b010_source_events(org_id,lease_id,payment_id,kind,occurrence_key,actor_id) VALUES($1,$2,$3,'payment_reversed','payment_reversed',$4)`,[ORG_ID,pay.lease_id,pay.id,USERS.admin]);
  assert.equal((await c.query(`SELECT 1 FROM app.b019_payment_preparations WHERE tx_id=txid_current() AND payment_id=$1`,[pay.id])).rowCount,1);
  await c.query('SET LOCAL ROLE authenticated');assert.equal((await c.query<{outcome:string}>(`SELECT * FROM app.b019_prepare_payment($1,$2,$3,'payment_reversed')`,[ORG_ID,pay.lease_id,pay.id])).rows[0].outcome,'new');await c.query('RESET ROLE');
  await c.query('SET CONSTRAINTS app.b019_payment_preparation_cleanup IMMEDIATE');
  assert.equal((await c.query(`SELECT 1 FROM app.b019_payment_preparations WHERE tx_id=txid_current() AND payment_id=$1`,[pay.id])).rowCount,0);
  await c.query('SAVEPOINT after_cleanup');await c.query('SET LOCAL ROLE authenticated');
  await assert.rejects(c.query(`SELECT * FROM app.b019_prepare_payment($1,$2,$3,'payment_reversed')`,[ORG_ID,pay.lease_id,pay.id]),(e:unknown)=>(e as {code?:string}).code==='23514');
  await c.query('ROLLBACK TO SAVEPOINT after_cleanup');await c.query('ROLLBACK');
 } finally {await c.end();}
});

test("two fresh-payment preparations for one key conflict without waiting",async()=>{
 const a=new Client({connectionString:process.env.DATABASE_URL}),b=new Client({connectionString:process.env.DATABASE_URL});await a.connect();await b.connect();
 try {
  const lease=(await a.query<{id:string}>(`SELECT id::text FROM leases WHERE org_id=$1 LIMIT 1`,[ORG_ID])).rows[0].id;
  const sid=randomUUID(),payment=randomUUID();await a.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
  await a.query(`UPDATE organizations SET feature_flags=feature_flags || '{"notification_center_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
  await a.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='notification_center_v2'`,[ORG_ID]);
  for(const c of [a,b]) {await c.query('BEGIN');await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);await c.query('SET LOCAL ROLE authenticated');await c.query(`SELECT * FROM app.b019_payment_admit($1,$1,'live',$2,$3,'admin')`,[ORG_ID,sid,lease]);}
  assert.equal((await a.query<{outcome:string}>(`SELECT * FROM app.b019_prepare_payment($1,$2,$3,'payment_confirmed')`,[ORG_ID,lease,payment])).rows[0].outcome,'new');
  await assert.rejects(b.query(`SELECT * FROM app.b019_prepare_payment($1,$2,$3,'payment_confirmed')`,[ORG_ID,lease,payment]),(e:unknown)=>(e as {code?:string}).code==='55P03');
  await b.query('ROLLBACK');await a.query('ROLLBACK');
 } finally {await a.end();await b.end();}
});

test("actor parent is pinned before later source and command foreign keys",async()=>{
 const a=new Client({connectionString:process.env.DATABASE_URL}),b=new Client({connectionString:process.env.DATABASE_URL});await a.connect();await b.connect();
 try {
  const lease=(await a.query<{id:string}>(`SELECT id::text FROM leases WHERE org_id=$1 LIMIT 1`,[ORG_ID])).rows[0].id;
  const sid=randomUUID();await a.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
  await b.query('BEGIN');await b.query(`SELECT id FROM auth.users WHERE id=$1 FOR UPDATE`,[USERS.admin]);
  await a.query('BEGIN');await a.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);await a.query('SET LOCAL ROLE authenticated');
  await assert.rejects(a.query(`SELECT * FROM app.b019_payment_admit($1,$1,'live',$2,$3,'admin')`,[ORG_ID,sid,lease]),(e:unknown)=>(e as {code?:string}).code==='55P03');await a.query('ROLLBACK');await b.query('ROLLBACK');
  await a.query('BEGIN');await a.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);await a.query('SET LOCAL ROLE authenticated');await a.query(`SELECT * FROM app.b019_payment_admit($1,$1,'live',$2,$3,'admin')`,[ORG_ID,sid,lease]);
  await b.query('BEGIN');await assert.rejects(b.query(`SELECT id FROM auth.users WHERE id=$1 FOR UPDATE NOWAIT`,[USERS.admin]),(e:unknown)=>(e as {code?:string}).code==='55P03');await b.query('ROLLBACK');await a.query('ROLLBACK');
 } finally {await a.end();await b.end();}
});

test("committed old source without center resolves no-backfill, with no new preparation or recipient",async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {
  const pay=(await c.query<{id:string;lease_id:string}>(`SELECT id::text,lease_id::text FROM payments WHERE org_id=$1 AND status='confirmed' LIMIT 1`,[ORG_ID])).rows[0];assert.ok(pay);
  const sid=randomUUID();await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
  await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"notification_center_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
  await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='notification_center_v2'`,[ORG_ID]);
  const historical=(await c.query<{id:string}>(`INSERT INTO app.b010_source_events(org_id,lease_id,payment_id,kind,occurrence_key,actor_id) VALUES($1,$2,$3,'payment_reversed','payment_reversed',$4) RETURNING id::text`,[ORG_ID,pay.lease_id,pay.id,USERS.admin])).rows[0].id;
  await c.query('BEGIN');await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);await c.query('SET LOCAL ROLE authenticated');
  await c.query(`SELECT * FROM app.b019_payment_admit($1,$1,'live',$2,$3,'admin')`,[ORG_ID,sid,pay.lease_id]);
  const result=(await c.query<{outcome:string;center_event_id:string|null}>(`SELECT * FROM app.b019_prepare_payment($1,$2,$3,'payment_reversed')`,[ORG_ID,pay.lease_id,pay.id])).rows[0];assert.deepEqual(result,{outcome:'no_backfill',center_event_id:null});
  await c.query('RESET ROLE');assert.equal((await c.query(`SELECT 1 FROM app.b019_payment_preparations WHERE tx_id=txid_current() AND payment_id=$1`,[pay.id])).rowCount,0);
  assert.equal((await c.query(`SELECT 1 FROM app.b028_center_events e LEFT JOIN app.b010_source_events s ON s.id=e.b010_event_id AND s.org_id=e.org_id LEFT JOIN app.b017_occurrences n ON n.id=e.neutral_source_id AND n.org_id=e.org_id WHERE (s.payment_id=$1 OR n.payment_id=$1) AND e.kind='payment_reversed'`,[pay.id])).rowCount,0);
  await c.query('ROLLBACK');await c.query(`DELETE FROM app.b010_source_events WHERE id=$1`,[historical]);
 } finally {await c.end();}
});

test("foreign organization payment IDs are rejected before privileged payment locking",async()=>{
 const a=new Client({connectionString:process.env.DATABASE_URL}),b=new Client({connectionString:process.env.DATABASE_URL});await a.connect();await b.connect();
 try {
  const lease=(await a.query<{id:string}>(`SELECT id::text FROM leases WHERE org_id=$1 LIMIT 1`,[ORG_ID])).rows[0].id;
  const foreign=(await a.query<{id:string}>(`INSERT INTO payments(org_id,property_id,lease_id,currency,amount_minor,paid_on,method,status,source) SELECT org_id,property_id,id,currency,1,current_date,'bank_transfer','submitted','tenant_portal' FROM leases WHERE org_id=$1 LIMIT 1 RETURNING id::text`,[ORG2_ID])).rows[0];assert.ok(foreign);
  const sid=randomUUID();await a.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
  await a.query(`UPDATE organizations SET feature_flags=feature_flags || '{"notification_center_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
  await a.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='notification_center_v2'`,[ORG_ID]);
  await b.query('BEGIN');await b.query(`SELECT id FROM payments WHERE id=$1 FOR UPDATE`,[foreign.id]);
  await a.query('BEGIN');await a.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);await a.query('SET LOCAL ROLE authenticated');await a.query(`SELECT * FROM app.b019_payment_admit($1,$1,'live',$2,$3,'admin')`,[ORG_ID,sid,lease]);
  await assert.rejects(a.query(`SELECT * FROM app.b019_prepare_payment($1,$2,$3,'payment_confirmed')`,[ORG_ID,lease,foreign.id]),(e:unknown)=>(e as {code?:string}).code==='42501');await a.query('ROLLBACK');await b.query('ROLLBACK');
 } finally {await a.end();await b.end();}
});

test("draft issuer binds a same-transaction payer and retains an unavailable outcome without a center",async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {
  await c.query('BEGIN');const pay=(await c.query<{id:string;lease_id:string;payer:string|null}>(`SELECT id::text,lease_id::text,payer_contact_id::text payer FROM payments WHERE org_id=$1 AND status='confirmed' LIMIT 1`,[ORG_ID])).rows[0];assert.ok(pay);
  const sid=randomUUID();await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
  await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"payment_results_v2":false,"notification_center_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
  await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='notification_center_v2'`,[ORG_ID]);
  await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`,[USERS.admin,ORG_ID]);
  for(const unavailable of [false,true]) {
   await c.query('SAVEPOINT issuer_case');
   if(unavailable) await c.query(`UPDATE payments SET payer_contact_id=NULL WHERE id=$1`,[pay.id]);
   await c.query('SET LOCAL ROLE authenticated');await c.query(`SELECT * FROM app.b019_payment_admit($1,$1,'live',$2,$3,'admin')`,[ORG_ID,sid,pay.lease_id]);
   await c.query(`SELECT * FROM app.b019_prepare_payment($1,$2,$3,'payment_reversed')`,[ORG_ID,pay.lease_id,pay.id]);
   await c.query(`UPDATE payments SET status='reversed' WHERE id=$1`,[pay.id]);
   const result=(await c.query<{outcome:string;center_event_id:string|null}>(`SELECT * FROM app.b019_emit_payment_center($1,'payment_reversed')`,[pay.id])).rows[0];await c.query('RESET ROLE');
   if(unavailable) {assert.deepEqual(result,{outcome:'recipient_unavailable',center_event_id:null});}
   else {assert.equal(result.outcome,'issued');assert.ok(result.center_event_id);assert.equal((await c.query(`SELECT 1 FROM app.b028_center_recipients WHERE org_id=$1 AND event_id=$2 AND persona='tenant' AND contact_id=$3`,[ORG_ID,result.center_event_id,pay.payer])).rowCount,1);}
   assert.equal((await c.query(`SELECT 1 FROM app.b019_channel_outcomes o JOIN app.b017_occurrences n ON n.org_id=o.org_id AND n.id=o.neutral_source_id WHERE n.payment_id=$1 AND o.outcome=$2`,[pay.id,result.outcome])).rowCount,1);
   await assert.rejects(c.query('SET CONSTRAINTS app.b019_payment_center_required IMMEDIATE'),(e:unknown)=>(e as {code?:string}).code==='23514');
   await c.query('ROLLBACK TO SAVEPOINT issuer_case');
  }
  await c.query('ROLLBACK');
 } finally {await c.end();}
});

test("payer association decision fails closed during competing link writes in both orders",async()=>{
 const a=new Client({connectionString:process.env.DATABASE_URL}),b=new Client({connectionString:process.env.DATABASE_URL});await a.connect();await b.connect();
 try {
  const pay=(await a.query<{id:string;lease_id:string;payer:string}>(`SELECT id::text,lease_id::text,payer_contact_id::text payer FROM payments WHERE org_id=$1 AND status='confirmed' AND payer_contact_id IS NOT NULL LIMIT 1`,[ORG_ID])).rows[0];assert.ok(pay);
  const sid=randomUUID();await a.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
  await a.query(`UPDATE organizations SET feature_flags=feature_flags || '{"payment_results_v2":false,"notification_center_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
  await a.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='notification_center_v2'`,[ORG_ID]);
  await a.query('BEGIN');await a.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`,[USERS.admin,ORG_ID]);await a.query('SET LOCAL ROLE authenticated');
  await a.query(`SELECT * FROM app.b019_payment_admit($1,$1,'live',$2,$3,'admin')`,[ORG_ID,sid,pay.lease_id]);await a.query(`SELECT * FROM app.b019_prepare_payment($1,$2,$3,'payment_reversed')`,[ORG_ID,pay.lease_id,pay.id]);await a.query(`UPDATE payments SET status='reversed' WHERE id=$1`,[pay.id]);
  await b.query('BEGIN');await b.query(`UPDATE lease_parties SET role=role WHERE org_id=$1 AND lease_id=$2 AND contact_id=$3`,[ORG_ID,pay.lease_id,pay.payer]);
  await a.query('SAVEPOINT association_busy');await assert.rejects(a.query(`SELECT * FROM app.b019_emit_payment_center($1,'payment_reversed')`,[pay.id]),(e:unknown)=>(e as {code?:string}).code==='55P03');await a.query('ROLLBACK TO SAVEPOINT association_busy');await b.query('ROLLBACK');
  assert.equal((await a.query<{outcome:string}>(`SELECT * FROM app.b019_emit_payment_center($1,'payment_reversed')`,[pay.id])).rows[0].outcome,'issued');
  await b.query('BEGIN');await b.query(`SET LOCAL lock_timeout='50ms'`);await assert.rejects(b.query(`UPDATE lease_parties SET role=role WHERE org_id=$1 AND lease_id=$2 AND contact_id=$3`,[ORG_ID,pay.lease_id,pay.payer]),(e:unknown)=>(e as {code?:string}).code==='55P03');await b.query('ROLLBACK');await a.query('ROLLBACK');
 } finally {await a.end();await b.end();}
});

test("payer link and contact mutations conflict in both orders, including unrelated-org inserts",async()=>{
 const a=new Client({connectionString:process.env.DATABASE_URL}),b=new Client({connectionString:process.env.DATABASE_URL});await a.connect();await b.connect();
 try {
  const pay=(await a.query<{id:string;lease_id:string;payer:string}>(`SELECT id::text,lease_id::text,payer_contact_id::text payer FROM payments WHERE org_id=$1 AND status='confirmed' AND payer_contact_id IS NOT NULL LIMIT 1`,[ORG_ID])).rows[0];assert.ok(pay);
  const otherLease=(await a.query<{id:string}>(`SELECT id::text FROM leases WHERE org_id=$1 LIMIT 1`,[ORG2_ID])).rows[0];assert.ok(otherLease);
  const otherContact=(await a.query<{id:string}>(`INSERT INTO contacts(org_id,display_name) VALUES($1,'B019 local fixture') RETURNING id::text`,[ORG2_ID])).rows[0];const other={lease_id:otherLease.id,contact_id:otherContact.id};
  const sid=randomUUID();await a.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
  await a.query(`UPDATE organizations SET feature_flags=feature_flags || '{"payment_results_v2":false,"notification_center_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);await a.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='notification_center_v2'`,[ORG_ID]);
  await a.query('BEGIN');await a.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`,[USERS.admin,ORG_ID]);await a.query('SET LOCAL ROLE authenticated');
  await a.query(`SELECT * FROM app.b019_payment_admit($1,$1,'live',$2,$3,'admin')`,[ORG_ID,sid,pay.lease_id]);await a.query(`SELECT * FROM app.b019_prepare_payment($1,$2,$3,'payment_reversed')`,[ORG_ID,pay.lease_id,pay.id]);await a.query(`UPDATE payments SET status='reversed' WHERE id=$1`,[pay.id]);
  const changes:[string,unknown[]][]=[
   [`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'occupant')`,[ORG2_ID,other.lease_id,other.contact_id]],
   [`DELETE FROM lease_parties WHERE org_id=$1 AND lease_id=$2 AND contact_id=$3`,[ORG_ID,pay.lease_id,pay.payer]],
   [`UPDATE lease_parties SET role='guarantor' WHERE org_id=$1 AND lease_id=$2 AND contact_id=$3`,[ORG_ID,pay.lease_id,pay.payer]],
   [`UPDATE contacts SET user_id=$2 WHERE org_id=$1 AND id=$3`,[ORG_ID,USERS.admin,pay.payer]],
  ];
  for(const [sql,params] of changes) {
   await b.query('BEGIN');await b.query(sql,params);await a.query('SAVEPOINT race');await assert.rejects(a.query(`SELECT * FROM app.b019_emit_payment_center($1,'payment_reversed')`,[pay.id]),(e:unknown)=>(e as {code?:string}).code==='55P03');await a.query('ROLLBACK TO SAVEPOINT race');await b.query('ROLLBACK');
  }
  assert.equal((await a.query<{outcome:string}>(`SELECT * FROM app.b019_emit_payment_center($1,'payment_reversed')`,[pay.id])).rows[0].outcome,'issued');
  for(const [sql,params] of changes) {
   await b.query('BEGIN');await b.query(`SET LOCAL lock_timeout='50ms'`);await assert.rejects(b.query(sql,params),(e:unknown)=>(e as {code?:string}).code==='55P03');await b.query('ROLLBACK');
  }
  await a.query('ROLLBACK');
 } finally {await a.end();await b.end();}
});

test("first link to previously unlinked payer cannot race unavailable outcome",async()=>{
 const a=new Client({connectionString:process.env.DATABASE_URL}),b=new Client({connectionString:process.env.DATABASE_URL});await a.connect();await b.connect();
 try {
  const pay=(await a.query<{id:string;lease_id:string;payer:string}>(`SELECT id::text,lease_id::text,payer_contact_id::text payer FROM payments WHERE org_id=$1 AND status='confirmed' AND payer_contact_id IS NOT NULL LIMIT 1`,[ORG_ID])).rows[0];assert.ok(pay);
  const deleted=await a.query<{role:string}>(`DELETE FROM lease_parties WHERE org_id=$1 AND lease_id=$2 AND contact_id=$3 RETURNING role::text`,[ORG_ID,pay.lease_id,pay.payer]);assert.equal(deleted.rowCount,1);
  const sid=randomUUID();await a.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
  await a.query(`UPDATE organizations SET feature_flags=feature_flags || '{"payment_results_v2":false,"notification_center_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);await a.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='notification_center_v2'`,[ORG_ID]);
  await a.query('BEGIN');await a.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`,[USERS.admin,ORG_ID]);await a.query('SET LOCAL ROLE authenticated');
  await a.query(`SELECT * FROM app.b019_payment_admit($1,$1,'live',$2,$3,'admin')`,[ORG_ID,sid,pay.lease_id]);await a.query(`SELECT * FROM app.b019_prepare_payment($1,$2,$3,'payment_reversed')`,[ORG_ID,pay.lease_id,pay.id]);await a.query(`UPDATE payments SET status='reversed' WHERE id=$1`,[pay.id]);
  const sql=`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'co_tenant')`,params=[ORG_ID,pay.lease_id,pay.payer];
  await b.query('BEGIN');await b.query(sql,params);await a.query('SAVEPOINT first_link');await assert.rejects(a.query(`SELECT * FROM app.b019_emit_payment_center($1,'payment_reversed')`,[pay.id]),(e:unknown)=>(e as {code?:string}).code==='55P03');await a.query('ROLLBACK TO SAVEPOINT first_link');await b.query('ROLLBACK');
  assert.equal((await a.query<{outcome:string}>(`SELECT * FROM app.b019_emit_payment_center($1,'payment_reversed')`,[pay.id])).rows[0].outcome,'recipient_unavailable');
  await b.query('BEGIN');await b.query(`SET LOCAL lock_timeout='50ms'`);await assert.rejects(b.query(sql,params),(e:unknown)=>(e as {code?:string}).code==='55P03');await b.query('ROLLBACK');await a.query('ROLLBACK');
  await a.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,$4::lease_party_role)`,[ORG_ID,pay.lease_id,pay.payer,deleted.rows[0].role]);
 } finally {await a.end();await b.end();}
});

test("payer equal to actor is eligible; guarantor-only payer is unavailable",async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {
  await c.query('BEGIN');const pay=(await c.query<{id:string;lease_id:string;payer:string}>(`SELECT id::text,lease_id::text,payer_contact_id::text payer FROM payments WHERE org_id=$1 AND status='confirmed' AND payer_contact_id IS NOT NULL LIMIT 1`,[ORG_ID])).rows[0];assert.ok(pay);
  const sid=randomUUID();await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
  await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"payment_results_v2":false,"notification_center_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='notification_center_v2'`,[ORG_ID]);
  await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`,[USERS.admin,ORG_ID]);
  for(const role of ['co_tenant','guarantor'] as const) {
   await c.query('SAVEPOINT payer_case');await c.query(`UPDATE contacts SET user_id=$2 WHERE org_id=$1 AND id=$3`,[ORG_ID,USERS.admin,pay.payer]);await c.query(`UPDATE lease_parties SET role=$4::lease_party_role WHERE org_id=$1 AND lease_id=$2 AND contact_id=$3`,[ORG_ID,pay.lease_id,pay.payer,role]);
   await c.query('SET LOCAL ROLE authenticated');await c.query(`SELECT * FROM app.b019_payment_admit($1,$1,'live',$2,$3,'admin')`,[ORG_ID,sid,pay.lease_id]);await c.query(`SELECT * FROM app.b019_prepare_payment($1,$2,$3,'payment_reversed')`,[ORG_ID,pay.lease_id,pay.id]);await c.query(`UPDATE payments SET status='reversed' WHERE id=$1`,[pay.id]);
   const result=(await c.query<{outcome:string}>(`SELECT * FROM app.b019_emit_payment_center($1,'payment_reversed')`,[pay.id])).rows[0];assert.equal(result.outcome,role==='co_tenant'?'issued':'recipient_unavailable');await c.query('ROLLBACK TO SAVEPOINT payer_case');
  }
  await c.query('ROLLBACK');
 } finally {await c.end();}
});
