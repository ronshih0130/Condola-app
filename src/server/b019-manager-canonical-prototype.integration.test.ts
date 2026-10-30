import assert from "node:assert/strict";
import { createHash,randomBytes,randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "pg";
import { stableStringify } from "../idempotency";
import { ORG_ID,USERS } from "./ids";
import { disposableDbUrl } from "./test-disposable-db";
import { resetAndSeed } from "./seed";
import { localCanonicalBytes,createLocalCanonicalProbe } from "./test-support/b019-manager-canonical-prototype";
disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone:Awaited<ReturnType<typeof createLocalCanonicalProbe>>;const previousDemo=process.env.DEMO_MODE,previousKey=process.env.ID_DOC_ENCRYPTION_KEY;
test.before(async()=>{process.env.DEMO_MODE='true';clone=await createLocalCanonicalProbe();process.env.ID_DOC_ENCRYPTION_KEY=randomBytes(32).toString('hex');await resetAndSeed();const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();try{await c.query(await readFile('supabase/migrations/20261031100219_b010_b028_real_producer.sql','utf8'));await c.query(await readFile('src/server/b019-manager-begin-prototype.sql','utf8'));}finally{await c.end();}});
test.after(async()=>{if(previousDemo===undefined)delete process.env.DEMO_MODE;else process.env.DEMO_MODE=previousDemo;if(previousKey===undefined)delete process.env.ID_DOC_ENCRYPTION_KEY;else process.env.ID_DOC_ENCRYPTION_KEY=previousKey;if(clone)await clone.cleanup();});

test('fixed wrapper bytes exactly match old JS with case, unicode, escapes and numeric edges',()=>{
 for(const input of [
  {leaseId:'ABCDEF00-1111-4111-8111-111111111111',amount:1,paidOn:'2026-10-30',last5:'01234',reference:''},
  {leaseId:'abcdef00-1111-4111-8111-111111111111',amount:123456,paidOn:'2026-10-30',last5:'',reference:'測試 "quotes" \\ slash\nline\t🙂'},
  {leaseId:'abcdef00-1111-4111-8111-111111111111',amount:Number.MAX_SAFE_INTEGER,paidOn:'2026-10-30',last5:'',reference:'\u2028\u2029 café'},
 ])assert.deepEqual(localCanonicalBytes(input),Buffer.from(stableStringify(input),'utf8'));
 const a={leaseId:'ABCDEF00-1111-4111-8111-111111111111',amount:1,paidOn:'2026-10-30',last5:'',reference:''};assert.notDeepEqual(localCanonicalBytes(a),localCanonicalBytes({...a,leaseId:a.leaseId.toLowerCase()}));
 for(const s of ['\ud800','\udc00','ok\ud800x'])assert.throws(()=>localCanonicalBytes({...a,reference:s}),/Prototype input unavailable/);
 assert.throws(()=>localCanonicalBytes({...a,amount:Number.MAX_SAFE_INTEGER+1}),/Prototype input unavailable/);
});

test('owned clone service begin keeps existing key recovery and never commits fresh work',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {const p=(await c.query<{id:string;lease:string}>(`SELECT id::text,lease_id::text lease FROM payments WHERE org_id=$1 AND status='confirmed' LIMIT 1`,[ORG_ID])).rows[0];assert.ok(p);const session=randomUUID(),request=randomUUID();
  await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[session,USERS.admin,randomUUID()]);
  await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"payment_results_v2":false,"notification_center_v2":false}'::jsonb WHERE id=$1`,[ORG_ID]);
  const input={leaseId:p.lease.toUpperCase(),amount:100,paidOn:'2026-10-30',last5:'12345',reference:'測試 "x" 🙂'};const digest=createHash('sha256').update(localCanonicalBytes(input)).digest('hex');
  await c.query(`INSERT INTO app.b010_source_events(org_id,lease_id,payment_id,kind,occurrence_key,actor_id) VALUES($1,$2,$3,'payment_confirmed','payment_confirmed',$4)`,[ORG_ID,p.lease,p.id,USERS.admin]);await c.query(`INSERT INTO app.b010_payment_commands(org_id,actor_id,request_id,payload_digest,payment_id) VALUES($1,$2,$3,$4,$5)`,[ORG_ID,USERS.admin,request,digest,p.id]);
  assert.equal(await clone.run(input,{org:ORG_ID,session,actor:USERS.admin,request}),'recorded');
  assert.equal(await clone.run(input,{org:ORG_ID,session,actor:USERS.admin,request:randomUUID()}),'unknown');
  await assert.rejects(clone.run({...input,reference:'different'},{org:ORG_ID,session,actor:USERS.admin,request}),(e:unknown)=>(e as {code?:string}).code==='42501');
  const fresh=(await c.query<{id:string}>(`SELECT l.id::text FROM leases l JOIN lease_parties lp ON lp.org_id=l.org_id AND lp.lease_id=l.id AND lp.role='primary' JOIN contacts ct ON ct.org_id=lp.org_id AND ct.id=lp.contact_id AND ct.is_tenant AND ct.archived_at IS NULL JOIN invoices i ON i.org_id=l.org_id AND i.lease_id=l.id AND i.status IN ('open','partially_paid') WHERE l.org_id=$1 ORDER BY l.id LIMIT 1`,[ORG_ID])).rows[0];assert.ok(fresh);
  await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"notification_center_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='notification_center_v2'`,[ORG_ID]);
  assert.equal(await clone.run({...input,leaseId:fresh.id},{org:ORG_ID,session,actor:USERS.admin,request:randomUUID()}),'new_rollback_only');assert.equal((await c.query(`SELECT 1 FROM app.b019_begin_probe_ops`)).rowCount,0);
  const historicalRequest=randomUUID();const historicalDigest=createHash('sha256').update(stableStringify({...input,reference:'\ud800'})).digest('hex');await assert.rejects(clone.run({...input,reference:'\ud800'},{org:ORG_ID,session,actor:USERS.admin,request:historicalRequest}),/Prototype input unavailable/);await c.query(`INSERT INTO app.b010_payment_commands(org_id,actor_id,request_id,payload_digest,payment_id) VALUES($1,$2,$3,$4,$5)`,[ORG_ID,USERS.admin,historicalRequest,historicalDigest,p.id]);
  await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"payment_results_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='payment_results_v2'`,[ORG_ID]);await c.query('BEGIN');await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);await c.query('SET LOCAL ROLE authenticated');
  assert.equal((await c.query<{status:string}>(`SELECT app.b010_payment_command_status($1,$1,'live',$2,$3,'admin',$4) status`,[ORG_ID,session,p.lease,historicalRequest])).rows[0].status,'recorded');assert.equal((await c.query<{status:string}>(`SELECT app.b010_payment_command_status($1,$1,'live',$2,$3,'admin',$4) status`,[ORG_ID,session,p.lease,randomUUID()])).rows[0].status,'unknown');await c.query('ROLLBACK');
  const badSession=randomUUID();await assert.rejects(clone.run(input,{org:ORG_ID,session:badSession,actor:USERS.admin,request}),(e:unknown)=>(e as {code?:string}).code==='42501');
 } finally {await c.end();}
});

test('clone and demo guards fail closed before connection',async()=>{
 const old=process.env.DEMO_MODE,oldUrl=process.env.DATABASE_URL;const input={leaseId:randomUUID(),amount:1,paidOn:'2026-10-30',last5:'',reference:''},context={org:ORG_ID,session:randomUUID(),actor:USERS.admin,request:randomUUID()};try{process.env.DEMO_MODE='false';await assert.rejects(clone.run(input,context),/Prototype input unavailable/);await assert.rejects(createLocalCanonicalProbe(),/Prototype input unavailable/);process.env.DEMO_MODE='true';const other=new URL(clone.url);other.pathname='/condola_test_'+randomUUID().replaceAll('-','');process.env.DATABASE_URL=other.href;await assert.rejects(clone.run(input,context),/Prototype input unavailable/);}finally{process.env.DEMO_MODE=old;if(oldUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=oldUrl;}
});
