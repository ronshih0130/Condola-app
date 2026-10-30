import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "pg";
import { ORG_ID, USERS } from "./ids";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { resetAndSeed } from "./seed";

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone:Awaited<ReturnType<typeof cloneTestDatabase>>;
test.before(async()=>{
 clone=await cloneTestDatabase();const demo=process.env.DEMO_MODE,key=process.env.ID_DOC_ENCRYPTION_KEY;
 try {process.env.DEMO_MODE='true';process.env.ID_DOC_ENCRYPTION_KEY=randomBytes(32).toString('hex');await resetAndSeed();}
 finally {if(demo===undefined)delete process.env.DEMO_MODE;else process.env.DEMO_MODE=demo;if(key===undefined)delete process.env.ID_DOC_ENCRYPTION_KEY;else process.env.ID_DOC_ENCRYPTION_KEY=key;}
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {await c.query(await readFile('supabase/migrations/20261031100219_b010_b028_real_producer.sql','utf8'));await c.query(`
  CREATE TABLE app.b019_seal_probe(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,tx_id xid8 NOT NULL,org_id uuid NOT NULL,payment_id uuid NOT NULL);
  REVOKE ALL ON app.b019_seal_probe FROM PUBLIC,anon,authenticated,service_role;
  CREATE FUNCTION app.b019_probe_derive_seal(p_payment uuid,p_kind text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
  DECLARE r app.b019_payment_requirements;
  BEGIN
   SELECT req.* INTO r FROM app.b019_payment_requirements req JOIN app.b019_payment_contexts ctx ON ctx.tx_id=req.tx_id AND ctx.org_id=req.org_id AND ctx.lease_id=req.lease_id AND ctx.actor_id=req.actor_id
    JOIN app.b019_payment_preparations prep ON prep.tx_id=req.tx_id AND prep.org_id=req.org_id AND prep.payment_id=req.payment_id AND prep.kind=req.kind AND prep.actor_id=req.actor_id AND prep.session_id=ctx.session_id
    JOIN public.auth_sessions s ON s.id=ctx.session_id AND s.user_id=ctx.actor_id AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
    JOIN app.b017_occurrences n ON n.org_id=req.org_id AND n.id=req.occurrence_id AND n.created_tx_id=req.tx_id AND n.payment_id=req.payment_id AND n.kind=req.kind AND n.actor_id=req.actor_id
    JOIN app.b019_channel_outcomes o ON o.org_id=n.org_id AND o.neutral_source_id=n.id AND o.channel='in_app'
    WHERE req.tx_id=txid_current() AND req.payment_id=p_payment AND req.kind=p_kind AND req.actor_id=auth.uid();
   IF NOT FOUND THEN RAISE EXCEPTION 'no derived requirement' USING ERRCODE='42501'; END IF;
   INSERT INTO app.b019_seal_probe(tx_id,org_id,payment_id) VALUES(pg_current_xact_id(),r.org_id,r.payment_id);
  END $$;
  REVOKE ALL ON FUNCTION app.b019_probe_derive_seal(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
  CREATE FUNCTION app.b019_probe_payment_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
  BEGIN
   IF EXISTS(SELECT 1 FROM app.b019_seal_probe s WHERE s.tx_id=pg_current_xact_id() AND
     ((s.org_id=OLD.org_id AND s.payment_id=OLD.id) OR (s.org_id=NEW.org_id AND s.payment_id=NEW.id))) THEN
    RAISE EXCEPTION 'sealed payment' USING ERRCODE='23514'; END IF;
   RETURN NEW;
  END $$;
  REVOKE ALL ON FUNCTION app.b019_probe_payment_guard() FROM PUBLIC,anon,authenticated,service_role;
  CREATE TRIGGER z_b019_probe_payment_guard BEFORE UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION app.b019_probe_payment_guard();
  CREATE FUNCTION app.b019_probe_gc(p_limit integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
  DECLARE n integer;
  BEGIN
   IF p_limit IS NULL OR p_limit<1 OR p_limit>10 THEN RAISE EXCEPTION 'invalid limit' USING ERRCODE='22023'; END IF;
   LOCK TABLE public.platform_settings IN SHARE MODE NOWAIT;
   WITH candidate AS (SELECT id FROM app.b019_seal_probe WHERE tx_id<>pg_current_xact_id() AND pg_xact_status(tx_id)='committed' ORDER BY id FOR UPDATE SKIP LOCKED LIMIT p_limit),
   removed AS (DELETE FROM app.b019_seal_probe s USING candidate c WHERE s.id=c.id RETURNING s.id)
   SELECT count(*)::integer INTO n FROM removed;
   RETURN n;
  END $$;
  REVOKE ALL ON FUNCTION app.b019_probe_gc(integer) FROM PUBLIC,anon,authenticated,service_role;
 `);}finally{await c.end();}
});
test.after(async()=>{if(clone)await clone.cleanup();});

test('owned prototype seal survives early constraints, blocks same payment and later GC sees only committed foreign transaction',async()=>{
 const a=new Client({connectionString:process.env.DATABASE_URL}),b=new Client({connectionString:process.env.DATABASE_URL});await a.connect();await b.connect();
 try {
  const payment=(await a.query<{id:string}>(`SELECT id::text FROM payments WHERE org_id=$1 LIMIT 1`,[ORG_ID])).rows[0];assert.ok(payment);
  const second=(await a.query<{id:string}>(`INSERT INTO payments(org_id,property_id,lease_id,currency,amount_minor,paid_on,method,status,source,submitted_by) SELECT org_id,property_id,lease_id,currency,1,current_date,method,'submitted',source,$2 FROM payments WHERE id=$1 RETURNING id::text`,[payment.id,USERS.admin])).rows[0];
  const owner=(await a.query<{role:string}>(`SELECT r.rolname role FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid='app.b019_seal_probe'::regclass`)).rows[0].role;
  const expectedOwner=(await a.query<{owner:string}>(`SELECT current_user AS owner`)).rows[0].owner;
  assert.equal(owner,expectedOwner);assert.ok(!['anon','authenticated','service_role'].includes(owner));
  for(const role of ['anon','authenticated','service_role']) {
   const acl=(await a.query<{read:boolean;write:boolean;gc:boolean}>(`SELECT has_table_privilege($1,'app.b019_seal_probe','SELECT') read,has_table_privilege($1,'app.b019_seal_probe','INSERT,UPDATE,DELETE,TRUNCATE') write,has_function_privilege($1,'app.b019_probe_gc(integer)','EXECUTE') gc`,[role])).rows[0];assert.deepEqual(acl,{read:false,write:false,gc:false});
  }
  await a.query('BEGIN');const seal=(await a.query<{id:string;txid:string}>(`INSERT INTO app.b019_seal_probe(tx_id,org_id,payment_id) VALUES(pg_current_xact_id(),$1,$2) RETURNING id::text,tx_id::text txid`,[ORG_ID,payment.id])).rows[0];
  assert.equal((await a.query<{status:string}>(`SELECT pg_xact_status($1::xid8) status`,[seal.txid])).rows[0].status,'in progress');
  assert.equal((await b.query(`SELECT 1 FROM app.b019_seal_probe WHERE id=$1`,[seal.id])).rowCount,0);
  assert.equal((await b.query<{n:number}>(`SELECT app.b019_probe_gc(10) n`)).rows[0].n,0);
  await a.query('SET CONSTRAINTS ALL IMMEDIATE');await a.query('SAVEPOINT sealed');
  await assert.rejects(a.query(`UPDATE payments SET reference='blocked' WHERE id=$1`,[payment.id]),(e:unknown)=>(e as {code?:string}).code==='23514');await a.query('ROLLBACK TO SAVEPOINT sealed');
  await a.query(`UPDATE payments SET reference='unsealed' WHERE id=$1`,[second.id]);await a.query('COMMIT');
  assert.equal((await b.query<{status:string}>(`SELECT pg_xact_status($1::xid8) status`,[seal.txid])).rows[0].status,'committed');
  assert.equal((await b.query(`SELECT 1 FROM app.b019_seal_probe WHERE id=$1`,[seal.id])).rowCount,1);
  assert.equal((await b.query<{n:number}>(`SELECT app.b019_probe_gc(10) n`)).rows[0].n,1);
  assert.equal((await b.query(`SELECT 1 FROM app.b019_seal_probe WHERE id=$1`,[seal.id])).rowCount,0);
 } finally {await a.end();await b.end();}
});

test('GC rejects absent and out-of-range bounds without deleting rows',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {const p=(await c.query<{id:string}>(`SELECT id::text FROM payments WHERE org_id=$1 LIMIT 1`,[ORG_ID])).rows[0].id;
  const marker=(await c.query<{id:string}>(`INSERT INTO app.b019_seal_probe(tx_id,org_id,payment_id) VALUES(pg_current_xact_id(),$1,$2) RETURNING id::text`,[ORG_ID,p])).rows[0].id;
  for(const limit of [null,0,11])await assert.rejects(c.query(`SELECT app.b019_probe_gc($1)`,[limit]),(e:unknown)=>(e as {code?:string}).code==='22023');
  assert.equal((await c.query(`SELECT 1 FROM app.b019_seal_probe WHERE id=$1`,[marker])).rowCount,1);assert.equal((await c.query<{n:number}>(`SELECT app.b019_probe_gc(1) n`)).rows[0].n,1);
 } finally {await c.end();}
});

test('GC excludes own and unknown status; rollback never leaves a seal',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {
  const p=(await c.query<{id:string}>(`SELECT id::text FROM payments WHERE org_id=$1 LIMIT 1`,[ORG_ID])).rows[0].id;
  await c.query(`INSERT INTO app.b019_seal_probe(tx_id,org_id,payment_id) VALUES('3'::xid8,$1,$2)`,[ORG_ID,p]);
  assert.equal((await c.query<{status:string|null}>(`SELECT pg_xact_status('3'::xid8) status`)).rows[0].status,null);
  await c.query('BEGIN');const aborted=(await c.query<{txid:string}>(`INSERT INTO app.b019_seal_probe(tx_id,org_id,payment_id) VALUES(pg_current_xact_id(),$1,$2) RETURNING tx_id::text txid`,[ORG_ID,p])).rows[0].txid;
  assert.equal((await c.query<{n:number}>(`SELECT app.b019_probe_gc(10) n`)).rows[0].n,0);await c.query('ROLLBACK');
  assert.equal((await c.query<{status:string}>(`SELECT pg_xact_status($1::xid8) status`,[aborted])).rows[0].status,'aborted');
  assert.equal((await c.query<{n:number}>(`SELECT count(*)::int n FROM app.b019_seal_probe`)).rows[0].n,1);
  assert.equal((await c.query<{n:number}>(`SELECT app.b019_probe_gc(10) n`)).rows[0].n,0);
 } finally {await c.end();}
});

test('bounded later GC skips a locked committed seal and reclaims it after release',async()=>{
 const a=new Client({connectionString:process.env.DATABASE_URL}),b=new Client({connectionString:process.env.DATABASE_URL});await a.connect();await b.connect();
 try {
  const p=(await a.query<{id:string}>(`SELECT id::text FROM payments WHERE org_id=$1 LIMIT 1`,[ORG_ID])).rows[0].id;
  const one=(await a.query<{id:string}>(`INSERT INTO app.b019_seal_probe(tx_id,org_id,payment_id) VALUES(pg_current_xact_id(),$1,$2) RETURNING id::text`,[ORG_ID,p])).rows[0].id;
  const two=(await a.query<{id:string}>(`INSERT INTO app.b019_seal_probe(tx_id,org_id,payment_id) VALUES(pg_current_xact_id(),$1,$2) RETURNING id::text`,[ORG_ID,p])).rows[0].id;
  await b.query('BEGIN');await b.query(`SELECT 1 FROM app.b019_seal_probe WHERE id=$1 FOR UPDATE`,[one]);
  assert.equal((await a.query<{n:number}>(`SELECT app.b019_probe_gc(1) n`)).rows[0].n,1);
  assert.equal((await a.query(`SELECT 1 FROM app.b019_seal_probe WHERE id=$1`,[one])).rowCount,1);assert.equal((await a.query(`SELECT 1 FROM app.b019_seal_probe WHERE id=$1`,[two])).rowCount,0);
  await b.query('ROLLBACK');assert.equal((await a.query<{n:number}>(`SELECT app.b019_probe_gc(1) n`)).rows[0].n,1);
  assert.equal((await a.query(`SELECT 1 FROM app.b019_seal_probe WHERE id=$1`,[one])).rowCount,0);
 } finally {await a.end();await b.end();}
});

test('GC and demo-reset admission conflict in both orders without waiting',async()=>{
 const a=new Client({connectionString:process.env.DATABASE_URL}),b=new Client({connectionString:process.env.DATABASE_URL});await a.connect();await b.connect();
 try {
  await a.query('BEGIN');await a.query(`SELECT app.b019_probe_gc(1)`);await b.query('BEGIN');
  await assert.rejects(b.query('LOCK TABLE public.platform_settings IN SHARE ROW EXCLUSIVE MODE NOWAIT'),(e:unknown)=>(e as {code?:string}).code==='55P03');await b.query('ROLLBACK');await a.query('ROLLBACK');
  await b.query('BEGIN');await b.query('LOCK TABLE public.platform_settings IN SHARE ROW EXCLUSIVE MODE');await a.query('BEGIN');
  await assert.rejects(a.query(`SELECT app.b019_probe_gc(1)`),(e:unknown)=>(e as {code?:string}).code==='55P03');await a.query('ROLLBACK');await b.query('ROLLBACK');
 } finally {await a.end();await b.end();}
});

test('owner-only draft seal derives actual transaction requirement and cannot bypass fail-closed completion',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {
  await c.query('BEGIN');const pay=(await c.query<{id:string;lease_id:string}>(`SELECT id::text,lease_id::text FROM payments WHERE org_id=$1 AND status='confirmed' LIMIT 1`,[ORG_ID])).rows[0];assert.ok(pay);
  const sid=randomUUID();await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
  await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"payment_results_v2":false,"notification_center_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='notification_center_v2'`,[ORG_ID]);
  await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`,[USERS.admin,ORG_ID]);
  await c.query('SAVEPOINT no_requirement');await assert.rejects(c.query(`SELECT app.b019_probe_derive_seal($1,'payment_reversed')`,[pay.id]),(e:unknown)=>(e as {code?:string}).code==='42501');await c.query('ROLLBACK TO SAVEPOINT no_requirement');
  for(const role of ['anon','authenticated','service_role'])assert.equal((await c.query<{allowed:boolean}>(`SELECT has_function_privilege($1,'app.b019_probe_derive_seal(uuid,text)','EXECUTE') allowed`,[role])).rows[0].allowed,false);
  await c.query('SET LOCAL ROLE authenticated');await c.query(`SELECT * FROM app.b019_payment_admit($1,$1,'live',$2,$3,'admin')`,[ORG_ID,sid,pay.lease_id]);await c.query(`SELECT * FROM app.b019_prepare_payment($1,$2,$3,'payment_reversed')`,[ORG_ID,pay.lease_id,pay.id]);await c.query(`UPDATE payments SET status='reversed' WHERE id=$1`,[pay.id]);await c.query(`SELECT * FROM app.b019_emit_payment_center($1,'payment_reversed')`,[pay.id]);await c.query('RESET ROLE');
  await c.query(`SELECT app.b019_probe_derive_seal($1,'payment_reversed')`,[pay.id]);await c.query('SAVEPOINT sealed_mutation');await assert.rejects(c.query(`UPDATE payments SET payer_contact_id=NULL WHERE id=$1`,[pay.id]),(e:unknown)=>(e as {code?:string}).code==='23514');await c.query('ROLLBACK TO SAVEPOINT sealed_mutation');
  await c.query('SAVEPOINT final_guard');await assert.rejects(c.query('SET CONSTRAINTS app.b019_payment_center_required IMMEDIATE'),(e:unknown)=>(e as {code?:string}).code==='23514');await c.query('ROLLBACK TO SAVEPOINT final_guard');await c.query('ROLLBACK');
 } finally {await c.end();}
});

test('experimental final-decision recheck rejects an expired session before commit',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {
  const payment=(await c.query<{id:string}>(`SELECT id::text FROM payments WHERE org_id=$1 LIMIT 1`,[ORG_ID])).rows[0].id;const sid=randomUUID();
  await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '0.3 seconds')`,[sid,USERS.admin,randomUUID()]);
  await c.query('BEGIN');await c.query(`INSERT INTO app.b019_seal_probe(tx_id,org_id,payment_id) VALUES(pg_current_xact_id(),$1,$2)`,[ORG_ID,payment]);
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');await c.query('SELECT pg_sleep(0.5)');
  const valid=(await c.query<{valid:boolean}>(`SELECT EXISTS(SELECT 1 FROM auth_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()) valid`,[sid,USERS.admin])).rows[0].valid;
  assert.equal(valid,false);await c.query('ROLLBACK');
 } finally {await c.end();}
});

test('invalid future xid makes GC fail closed without removing a marker',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {
  const payment=(await c.query<{id:string}>(`SELECT id::text FROM payments WHERE org_id=$1 LIMIT 1`,[ORG_ID])).rows[0].id;
  const marker=(await c.query<{id:string}>(`INSERT INTO app.b019_seal_probe(tx_id,org_id,payment_id) VALUES('999999999999'::xid8,$1,$2) RETURNING id::text`,[ORG_ID,payment])).rows[0].id;
  await assert.rejects(c.query(`SELECT app.b019_probe_gc(10)`),(e:unknown)=>(e as {code?:string}).code==='22023');
  assert.equal((await c.query(`SELECT 1 FROM app.b019_seal_probe WHERE id=$1`,[marker])).rowCount,1);
  await c.query(`DELETE FROM app.b019_seal_probe WHERE id=$1`,[marker]);
 } finally {await c.end();}
});
