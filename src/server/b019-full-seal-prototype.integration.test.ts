import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "pg";
import { ORG_ID, USERS } from "./ids";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { resetAndSeed } from "./seed";
import { allocateAndLedger, lockAllocationInvoices } from "./domain";

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone:Awaited<ReturnType<typeof cloneTestDatabase>>;
test.before(async()=>{
 clone=await cloneTestDatabase();const demo=process.env.DEMO_MODE,key=process.env.ID_DOC_ENCRYPTION_KEY;
 try {process.env.DEMO_MODE='true';process.env.ID_DOC_ENCRYPTION_KEY=randomBytes(32).toString('hex');await resetAndSeed();
  const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();try{
   await c.query(await readFile('supabase/migrations/20261031100219_b010_b028_real_producer.sql','utf8'));
   await c.query(await readFile('src/server/b019-full-seal-prototype.sql','utf8'));
  }finally{await c.end();}
 } finally {if(demo===undefined)delete process.env.DEMO_MODE;else process.env.DEMO_MODE=demo;if(key===undefined)delete process.env.ID_DOC_ENCRYPTION_KEY;else process.env.ID_DOC_ENCRYPTION_KEY=key;}
});
test.after(async()=>{if(clone)await clone.cleanup();});

test('private schema denies application roles and exact typed resources reject null or duplicate shapes',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {
  for(const table of ['b019_proto_operation','b019_proto_seals','b019_proto_resources','b019_proto_gc_permits','b019_proto_install_permits']) {
   const owner=(await c.query<{name:string;expected:string}>(`SELECT r.rolname name,current_user expected FROM pg_class x JOIN pg_roles r ON r.oid=x.relowner WHERE x.oid=$1::regclass`,[`app.${table}`])).rows[0];assert.equal(owner.name,owner.expected);assert.ok(!['anon','authenticated','service_role'].includes(owner.name));
   for(const role of ['anon','authenticated','service_role'])assert.equal((await c.query<{v:boolean}>(`SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') v`,[role,`app.${table}`])).rows[0].v,false);
  }
  for(const role of ['anon','authenticated','service_role'])for(const fn of ['b019_proto_snapshot(uuid,uuid)','b019_proto_confirmed_evidence(uuid,uuid,uuid)','b019_proto_recipient_snapshot(uuid,uuid)','b019_proto_scope_snapshot(uuid,uuid)','b019_proto_derive_resources(uuid,uuid,uuid,uuid,uuid,uuid)','b019_proto_install(uuid,text)','b019_proto_validate(uuid)','b019_proto_gc(integer)','b019_proto_immutable()'])assert.equal((await c.query<{v:boolean}>(`SELECT has_function_privilege($1,$2,'EXECUTE') v`,[role,`app.${fn}`])).rows[0].v,false,`${role} ${fn}`);
  await c.query('BEGIN');const pay=(await c.query<{id:string;lease:string}>(`SELECT id::text,lease_id::text lease FROM payments WHERE org_id=$1 LIMIT 1`,[ORG_ID])).rows[0];assert.ok(pay);
  const seal=(await c.query<{id:string}>(`INSERT INTO app.b019_proto_seals(org_id,live_org_id,environment,lease_id,payment_id,kind,actor_id,session_id,role,mode,prior_status,prestate_digest,neutral_source_id,in_app_outcome,financial_digest,recipient_digest,scope_digest)
   VALUES($1,$1,'live',$2,$3,'payment_confirmed',$4,$5,'admin','confirm_submitted','submitted',decode(repeat('11',32),'hex'),$6,'recipient_unavailable',decode(repeat('22',32),'hex'),decode(repeat('33',32),'hex'),decode(repeat('44',32),'hex')) RETURNING id::text`,[ORG_ID,pay.lease,pay.id,USERS.admin,randomUUID(),randomUUID()])).rows[0].id;
  await c.query(`INSERT INTO app.b019_proto_install_permits(tx_id,seal_id) VALUES(pg_current_xact_id(),$1)`,[seal]);
  await c.query(`INSERT INTO app.b019_proto_resources(seal_id,kind,org_id,text_key) VALUES($1,'org_control',$2,'notification_center_v2')`,[seal,ORG_ID]);
  for(const [kind,org,id1,id2,key] of [['org_control',ORG_ID,null,null,null],['currency',null,null,null,null],['lease_party_scope',ORG_ID,pay.lease,null,null],['invented',ORG_ID,pay.id,null,null]] as const) {
   await c.query('SAVEPOINT bad_shape');await assert.rejects(c.query(`INSERT INTO app.b019_proto_resources(seal_id,kind,org_id,id1,id2,text_key) VALUES($1,$2,$3,$4,$5,$6)`,[seal,kind,org,id1,id2,key]),(e:unknown)=>(e as {code?:string}).code==='23514');await c.query('ROLLBACK TO SAVEPOINT bad_shape');
  }
  await c.query('SAVEPOINT duplicate');await assert.rejects(c.query(`INSERT INTO app.b019_proto_resources(seal_id,kind,org_id,text_key) VALUES($1,'org_control',$2,'notification_center_v2')`,[seal,ORG_ID]),(e:unknown)=>(e as {code?:string}).code==='23505');await c.query('ROLLBACK TO SAVEPOINT duplicate');
  await c.query('SAVEPOINT cascade');await assert.rejects(c.query(`DELETE FROM app.b019_proto_seals WHERE id=$1`,[seal]),(e:unknown)=>(e as {code?:string}).code==='42501');await c.query('ROLLBACK TO SAVEPOINT cascade');await c.query('ROLLBACK');
 } finally {await c.end();}
});

test('bounded financial snapshot is deterministic and detects actual payment changes',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {await c.query('BEGIN');const pay=(await c.query<{id:string}>(`SELECT id::text FROM payments WHERE org_id=$1 AND status='confirmed' LIMIT 1`,[ORG_ID])).rows[0];assert.ok(pay);
  const read=async()=>(await c.query<{digest:string}>(`SELECT encode(app.b019_proto_snapshot($1,$2),'hex') digest`,[ORG_ID,pay.id])).rows[0].digest;
  const first=await read();assert.equal(first.length,64);assert.equal(await read(),first);
  await c.query(`SET LOCAL TIME ZONE 'America/Los_Angeles'`);assert.equal(await read(),first);await c.query(`SET LOCAL TIME ZONE 'Asia/Taipei'`);assert.equal(await read(),first);
  await c.query('SAVEPOINT missing');await assert.rejects(c.query(`SELECT app.b019_proto_snapshot($1,$2)`,[ORG_ID,randomUUID()]),(e:unknown)=>(e as {code?:string}).code==='23514');await c.query('ROLLBACK TO SAVEPOINT missing');
  await c.query('SAVEPOINT wrong_pointer');const bad=(await c.query<{id:string}>(`INSERT INTO ledger_transactions(org_id,property_id,lease_id,kind,currency,effective_date,source_table,source_id,created_by) SELECT org_id,property_id,lease_id,kind,currency,effective_date,source_table,gen_random_uuid(),created_by FROM ledger_transactions WHERE id=(SELECT ledger_transaction_id FROM payments WHERE id=$1) RETURNING id::text`,[pay.id])).rows[0].id;
  await c.query(`UPDATE payments SET ledger_transaction_id=$2 WHERE id=$1`,[pay.id,bad]);await assert.rejects(c.query(`SELECT app.b019_proto_snapshot($1,$2)`,[ORG_ID,pay.id]),(e:unknown)=>(e as {code?:string}).code==='23514');await c.query('ROLLBACK TO SAVEPOINT wrong_pointer');
  await c.query('SAVEPOINT line_change');await c.query(`UPDATE invoice_lines SET amount_minor=amount_minor+1 WHERE id=(SELECT il.id FROM invoice_lines il JOIN payment_allocations a ON a.invoice_id=il.invoice_id WHERE a.payment_id=$1 LIMIT 1)`,[pay.id]);assert.notEqual(await read(),first);await c.query('ROLLBACK TO SAVEPOINT line_change');
  await c.query('SAVEPOINT changed');await c.query(`UPDATE payments SET reference='synthetic change' WHERE id=$1`,[pay.id]);assert.notEqual(await read(),first);await c.query('ROLLBACK TO SAVEPOINT changed');assert.equal(await read(),first);await c.query('ROLLBACK');
 } finally {await c.end();}
});

test('header cap fails closed without truncating the snapshot',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {await c.query('BEGIN');const pay=(await c.query<{id:string}>(`SELECT id::text FROM payments WHERE org_id=$1 AND status='confirmed' LIMIT 1`,[ORG_ID])).rows[0];assert.ok(pay);
  await c.query(`INSERT INTO ledger_transactions(org_id,property_id,lease_id,kind,currency,effective_date,source_table,source_id,created_by) SELECT t.org_id,t.property_id,t.lease_id,t.kind,t.currency,t.effective_date,t.source_table,t.source_id,t.created_by FROM ledger_transactions t CROSS JOIN generate_series(1,1023) WHERE t.id=(SELECT ledger_transaction_id FROM payments WHERE id=$1)`,[pay.id]);
  const initial=(await c.query<{digest:string}>(`SELECT encode(app.b019_proto_snapshot($1,$2),'hex') digest`,[ORG_ID,pay.id])).rows[0].digest;
  await c.query('SAVEPOINT overflow');await c.query(`INSERT INTO ledger_transactions(org_id,property_id,lease_id,kind,currency,effective_date,source_table,source_id,created_by) SELECT org_id,property_id,lease_id,kind,currency,effective_date,source_table,source_id,created_by FROM ledger_transactions WHERE id=(SELECT ledger_transaction_id FROM payments WHERE id=$1)`,[pay.id]);
  await assert.rejects(c.query(`SELECT app.b019_proto_snapshot($1,$2)`,[ORG_ID,pay.id]),(e:unknown)=>(e as {code?:string}).code==='54000');await c.query('ROLLBACK TO SAVEPOINT overflow');
  assert.equal((await c.query<{digest:string}>(`SELECT encode(app.b019_proto_snapshot($1,$2),'hex') digest`,[ORG_ID,pay.id])).rows[0].digest,initial);await c.query('ROLLBACK');
 } finally {await c.end();}
});

test('synthetic provenance seal rechecks real confirmation after selected early constraints and denies changed facts',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {
  await c.query('BEGIN');const base=(await c.query<{lease:string;property:string;currency:string;payer:string}>(`SELECT l.id::text lease,l.property_id::text property,l.currency,lp.contact_id::text payer FROM leases l JOIN lease_parties lp ON lp.org_id=l.org_id AND lp.lease_id=l.id AND lp.role='primary' JOIN contacts ct ON ct.org_id=lp.org_id AND ct.id=lp.contact_id AND ct.user_id IS NOT NULL AND ct.is_tenant AND ct.archived_at IS NULL JOIN invoices i ON i.org_id=l.org_id AND i.lease_id=l.id WHERE l.org_id=$1 AND i.status IN ('open','partially_paid') AND i.balance_minor>100 ORDER BY l.id LIMIT 1`,[ORG_ID])).rows[0];assert.ok(base);
  const sid=randomUUID(),payment=randomUUID(),request=randomUUID(),digest='a'.repeat(64);
  await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
  await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"payment_results_v2":false,"notification_center_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
  await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='notification_center_v2'`,[ORG_ID]);
  await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`,[USERS.admin,ORG_ID]);
  await c.query('SET LOCAL ROLE authenticated');await c.query(`SELECT * FROM app.b019_payment_admit($1,$1,'live',$2,$3,'admin')`,[ORG_ID,sid,base.lease]);await c.query(`SELECT * FROM app.b019_prepare_payment($1,$2,$3,'payment_confirmed')`,[ORG_ID,base.lease,payment]);
  const invoices=await lockAllocationInvoices(c,ORG_ID,base.lease);
  const pay=(await c.query<{id:string;org_id:string;property_id:string;lease_id:string;currency:string;amount_minor:string;payer_contact_id:string|null}>(`INSERT INTO payments(id,org_id,property_id,lease_id,payer_contact_id,currency,amount_minor,paid_on,method,status,source,submitted_by,confirmed_by,confirmed_at) VALUES($1,$2,$3,$4,$5,$6,100,current_date,'bank_transfer','confirmed','manager_entry',$7,$7,clock_timestamp()) RETURNING id::text,org_id::text,property_id::text,lease_id::text,currency,amount_minor::text,payer_contact_id::text`,[payment,ORG_ID,base.property,base.lease,base.payer,base.currency,USERS.admin])).rows[0];
  await allocateAndLedger(c,pay,USERS.admin,invoices);await c.query(`SELECT * FROM app.b019_emit_payment_center($1,'payment_confirmed')`,[payment]);await c.query('RESET ROLE');
  // Owner-synthetic provenance and command: not a real trusted command gateway.
  await c.query(`INSERT INTO app.b010_payment_commands(org_id,actor_id,request_id,payload_digest,payment_id) VALUES($1,$2,$3,$4,$5)`,[ORG_ID,USERS.admin,request,digest,payment]);
  await c.query(`INSERT INTO app.b019_proto_operation(org_id,live_org_id,environment,lease_id,payment_id,actor_id,session_id,role,mode,prior_status,request_id,command_digest,prestate_digest) VALUES($1,$1,'live',$2,$3,$4,$5,'admin','manager_record_confirmed','absent',$6,$7,decode(repeat('11',32),'hex'))`,[ORG_ID,base.lease,payment,USERS.admin,sid,request,digest]);
  await c.query('SAVEPOINT wrong_install');await assert.rejects(c.query(`SELECT app.b019_proto_install($1,'payment_confirmed')`,[randomUUID()]),(e:unknown)=>(e as {code?:string}).code==='42501');await c.query('ROLLBACK TO SAVEPOINT wrong_install');
  await c.query('SAVEPOINT wrong_invoice_property');const otherProperty=(await c.query<{id:string}>(`SELECT id::text FROM properties WHERE org_id=$1 AND id<>$2 LIMIT 1`,[ORG_ID,base.property])).rows[0];assert.ok(otherProperty);
  await c.query(`UPDATE invoices SET property_id=$2 WHERE id=$1`,[invoices[0].id,otherProperty.id]);await assert.rejects(c.query(`SELECT app.b019_proto_install($1,'payment_confirmed')`,[payment]),(e:unknown)=>(e as {code?:string}).code==='23514');await c.query('ROLLBACK TO SAVEPOINT wrong_invoice_property');
  await c.query('SAVEPOINT invalid_finance');
  const wrong=(await c.query<{id:string}>(`INSERT INTO ledger_transactions(org_id,property_id,lease_id,kind,currency,effective_date,source_table,source_id,created_by) SELECT org_id,property_id,lease_id,kind,currency,effective_date,source_table,source_id,created_by FROM ledger_transactions WHERE id=(SELECT ledger_transaction_id FROM payments WHERE id=$1) RETURNING id::text`,[payment])).rows[0].id;
  await c.query(`INSERT INTO ledger_entries(org_id,transaction_id,account,amount_minor,currency,contact_id,property_id,lease_id,invoice_id) SELECT org_id,$2,account,2*amount_minor,currency,contact_id,property_id,lease_id,invoice_id FROM ledger_entries WHERE transaction_id=(SELECT ledger_transaction_id FROM payments WHERE id=$1)`,[payment,wrong]);
  await c.query(`UPDATE payments SET ledger_transaction_id=$2 WHERE id=$1`,[payment,wrong]);await assert.rejects(c.query(`SELECT app.b019_proto_install($1,'payment_confirmed')`,[payment]),(e:unknown)=>(e as {code?:string}).code==='23514');await c.query('ROLLBACK TO SAVEPOINT invalid_finance');
  // Diagnostic replacement creates a deterministic resource count; it tests the
  // bound mechanism only, not completeness of real resource discovery.
  for(const limit of [16384,16385]) {
   await c.query('SAVEPOINT resource_bound');await c.query(`ALTER FUNCTION app.b019_proto_derive_resources(uuid,uuid,uuid,uuid,uuid,uuid) RENAME TO b019_proto_derive_resources_inner`);
   await c.query(`CREATE FUNCTION app.b019_proto_derive_resources(uuid,uuid,uuid,uuid,uuid,uuid) RETURNS TABLE(kind text,org_id uuid,id1 uuid,id2 uuid,text_key text) LANGUAGE sql STABLE AS $$ SELECT 'auth_user'::text,NULL::uuid,md5(g::text)::uuid,NULL::uuid,NULL::text FROM generate_series(1,${limit}) g $$`);
   await c.query(`REVOKE ALL ON FUNCTION app.b019_proto_derive_resources(uuid,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role`);
   if(limit===16384) {const bounded=(await c.query<{id:string}>(`SELECT app.b019_proto_install($1,'payment_confirmed')::text id`,[payment])).rows[0].id;assert.equal((await c.query<{n:number}>(`SELECT count(*)::int n FROM app.b019_proto_resources WHERE seal_id=$1`,[bounded])).rows[0].n,16384);}
   else await assert.rejects(c.query(`SELECT app.b019_proto_install($1,'payment_confirmed')`,[payment]),(e:unknown)=>(e as {code?:string}).code==='54000');
   await c.query('ROLLBACK TO SAVEPOINT resource_bound');
  }
  const seal=(await c.query<{id:string}>(`SELECT app.b019_proto_install($1,'payment_confirmed')::text id`,[payment])).rows[0].id;
  const kinds=(await c.query<{kind:string}>(`SELECT DISTINCT kind FROM app.b019_proto_resources WHERE seal_id=$1`,[seal])).rows.map(row=>row.kind);
  for(const kind of ['payment','lease','property','contact','lease_party_scope','auth_user','session','organization','member','org_control','command','source','center_event','center_recipient','invoice','allocation','invoice_line','original_ledger','ledger_entry','currency'])assert.ok(kinds.includes(kind),kind);
  assert.equal((await c.query<{id:string}>(`SELECT app.b019_proto_install($1,'payment_confirmed')::text id`,[payment])).rows[0].id,seal);
  await c.query('SAVEPOINT resource_changed');await assert.rejects(c.query(`INSERT INTO app.b019_proto_resources(seal_id,kind,id1) VALUES($1,'auth_user',$2)`,[seal,USERS.manager]),(e:unknown)=>(e as {code?:string}).code==='42501');await c.query('ROLLBACK TO SAVEPOINT resource_changed');
  await c.query('SET CONSTRAINTS app.b019_payment_context_cleanup,app.b019_payment_preparation_cleanup IMMEDIATE');
  // These selected cleanup triggers retain both rows while the failing requirement exists.
  assert.equal((await c.query(`SELECT 1 FROM app.b019_payment_contexts WHERE tx_id=txid_current() AND actor_id=$1`,[USERS.admin])).rowCount,1);
  assert.equal((await c.query(`SELECT 1 FROM app.b019_payment_preparations WHERE tx_id=txid_current() AND payment_id=$1`,[payment])).rowCount,1);
  assert.equal((await c.query<{v:string}>(`SELECT app.b019_proto_validate($1) v`,[seal])).rows[0].v,'synthetic_consistent');
  await c.query('SAVEPOINT resource_changed_final');await assert.rejects(c.query(`INSERT INTO app.b019_proto_resources(seal_id,kind,id1) VALUES($1,'auth_user',$2)`,[seal,USERS.manager]),(e:unknown)=>(e as {code?:string}).code==='42501');await c.query('ROLLBACK TO SAVEPOINT resource_changed_final');
  await c.query('SAVEPOINT fact_changed');await c.query(`UPDATE payments SET reference='altered' WHERE id=$1`,[payment]);await assert.rejects(c.query(`SELECT app.b019_proto_validate($1)`,[seal]),(e:unknown)=>(e as {code?:string}).code==='23514');await c.query('ROLLBACK TO SAVEPOINT fact_changed');
  await c.query('SAVEPOINT contact_changed');await c.query(`UPDATE contacts SET user_id=$2 WHERE org_id=$1 AND id=$3`,[ORG_ID,USERS.admin,base.payer]);await assert.rejects(c.query(`SELECT app.b019_proto_validate($1)`,[seal]),(e:unknown)=>(e as {code?:string}).code==='23514');await c.query('ROLLBACK TO SAVEPOINT contact_changed');
  await c.query('SAVEPOINT wrong_actor');await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.manager]);await assert.rejects(c.query(`SELECT app.b019_proto_validate($1)`,[seal]),(e:unknown)=>(e as {code?:string}).code==='42501');await c.query('ROLLBACK TO SAVEPOINT wrong_actor');
  await c.query('SAVEPOINT gate_changed');await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"notification_center_v2":false}'::jsonb WHERE id=$1`,[ORG_ID]);await assert.rejects(c.query(`SELECT app.b019_proto_validate($1)`,[seal]),(e:unknown)=>(e as {code?:string}).code==='42501');await c.query('ROLLBACK TO SAVEPOINT gate_changed');
  await c.query('SAVEPOINT delayed_read');await c.query(`UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '0.2 seconds' WHERE id=$1`,[sid]);
  // Isolated instrumentation wraps the real snapshot with a controlled slow read.
  await c.query(`ALTER FUNCTION app.b019_proto_snapshot(uuid,uuid) RENAME TO b019_proto_snapshot_inner`);
  await c.query(`CREATE FUNCTION app.b019_proto_snapshot(uuid,uuid) RETURNS bytea LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ BEGIN RAISE NOTICE 'B019_DIAGNOSTIC_DELAY_ENTERED'; PERFORM pg_sleep(0.4); RETURN app.b019_proto_snapshot_inner($1,$2); END $$`);
  await c.query(`REVOKE ALL ON FUNCTION app.b019_proto_snapshot(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role`);
  let entered=0;const observe=(notice:{message?:string})=>{if(notice.message==='B019_DIAGNOSTIC_DELAY_ENTERED')entered++;};c.on('notice',observe);
  assert.equal((await c.query<{valid:boolean}>(`SELECT expires_at>clock_timestamp() valid FROM auth_sessions WHERE id=$1`,[sid])).rows[0].valid,true);
  await assert.rejects(c.query(`SELECT app.b019_proto_validate($1)`,[seal]),(e:unknown)=>(e as {code?:string}).code==='42501');c.off('notice',observe);assert.equal(entered,1);await c.query('ROLLBACK TO SAVEPOINT delayed_read');
  await c.query('SAVEPOINT expired');await c.query(`UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,[sid]);await assert.rejects(c.query(`SELECT app.b019_proto_validate($1)`,[seal]),(e:unknown)=>(e as {code?:string}).code==='42501');await c.query('ROLLBACK TO SAVEPOINT expired');
  await c.query('SAVEPOINT unapproved_commit');await assert.rejects(c.query('SET CONSTRAINTS app.b019_payment_center_required IMMEDIATE'),(e:unknown)=>(e as {code?:string}).code==='23514');await c.query('ROLLBACK TO SAVEPOINT unapproved_commit');await c.query('ROLLBACK');
 } finally {await c.end();}
});

test('snapshot includes detached-header reversals and other-payment status on an affected invoice',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {await c.query('BEGIN');await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`,[USERS.admin,ORG_ID]);
  const pay=(await c.query<{id:string;ledger:string;invoice:string}>(`SELECT p.id::text,p.ledger_transaction_id::text ledger,a.invoice_id::text invoice FROM payments p JOIN payment_allocations a ON a.org_id=p.org_id AND a.payment_id=p.id WHERE p.org_id=$1 AND p.status='confirmed' LIMIT 1`,[ORG_ID])).rows[0];assert.ok(pay);
  const read=async()=>(await c.query<{digest:string}>(`SELECT encode(app.b019_proto_snapshot($1,$2),'hex') digest`,[ORG_ID,pay.id])).rows[0].digest;
  const detached=(await c.query<{id:string}>(`INSERT INTO ledger_transactions(org_id,property_id,lease_id,kind,currency,effective_date,source_table,source_id,created_by) SELECT org_id,property_id,lease_id,kind,currency,effective_date,source_table,source_id,created_by FROM ledger_transactions WHERE id=$1 RETURNING id::text`,[pay.ledger])).rows[0].id;
  await c.query(`INSERT INTO ledger_entries(org_id,transaction_id,account,amount_minor,currency,contact_id,property_id,lease_id,invoice_id) SELECT org_id,$2,account,amount_minor,currency,contact_id,property_id,lease_id,invoice_id FROM ledger_entries WHERE transaction_id=$1`,[pay.ledger,detached]);
  const beforeReversal=await read();await c.query(`SELECT post_reversal($1,'detached diagnostic')`,[detached]);assert.notEqual(await read(),beforeReversal);
  const other=(await c.query<{id:string}>(`INSERT INTO payments(org_id,property_id,lease_id,payer_contact_id,currency,amount_minor,paid_on,method,status,source,submitted_by) SELECT org_id,property_id,lease_id,payer_contact_id,currency,1,current_date,method,'submitted','tenant_portal',submitted_by FROM payments WHERE id=$1 RETURNING id::text`,[pay.id])).rows[0].id;
  await c.query(`INSERT INTO payment_allocations(org_id,payment_id,invoice_id,amount_minor,created_by) VALUES($1,$2,$3,1,$4)`,[ORG_ID,other,pay.invoice,USERS.admin]);
  const beforeStatus=await read();await c.query(`UPDATE payments SET status='rejected',rejected_reason='local' WHERE id=$1`,[other]);assert.notEqual(await read(),beforeStatus);
  await c.query('ROLLBACK');
 } finally {await c.end();}
});

test('invoice-line diagnostic cap accepts 8192 and rejects 8193 without truncation',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {await c.query('BEGIN');await c.query(`SELECT set_config('app.active_org_id',$1,true),set_config('app.env','live',true)`,[ORG_ID]);
  const row=(await c.query<{payment:string;invoice:string;lines:number;max_line:number}>(`SELECT p.id::text payment,a.invoice_id::text invoice,(SELECT count(*)::int FROM invoice_lines WHERE invoice_id=a.invoice_id) lines,(SELECT coalesce(max(line_no),0)::int FROM invoice_lines WHERE invoice_id=a.invoice_id) max_line FROM payments p JOIN payment_allocations a ON a.payment_id=p.id AND a.org_id=p.org_id WHERE p.org_id=$1 AND p.status='confirmed' LIMIT 1`,[ORG_ID])).rows[0];assert.ok(row);assert.ok(row.lines<8192);
  const invoiceSet=await c.query<{id:string}>(`SELECT invoice_id::text id FROM payment_allocations WHERE org_id=$1 AND payment_id=$2 UNION SELECT e.invoice_id::text id FROM ledger_entries e JOIN ledger_transactions t ON t.org_id=e.org_id AND t.id=e.transaction_id WHERE t.org_id=$1 AND e.invoice_id IS NOT NULL AND (t.id=(SELECT ledger_transaction_id FROM payments WHERE id=$2) OR (t.source_table='payments' AND t.source_id=$2) OR t.reverses_transaction_id IN (SELECT id FROM ledger_transactions WHERE org_id=$1 AND (id=(SELECT ledger_transaction_id FROM payments WHERE id=$2) OR (source_table='payments' AND source_id=$2))))`,[ORG_ID,row.payment]);
  assert.deepEqual(invoiceSet.rows,[{id:row.invoice}]);
  await c.query(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,unit_amount_minor,amount_minor) SELECT $1,$2,$3+g,'rent','local bound fixture',1,1 FROM generate_series(1,$4::int) g`,[ORG_ID,row.invoice,row.max_line,8192-row.lines]);
  const digest=(await c.query<{d:string}>(`SELECT encode(app.b019_proto_snapshot($1,$2),'hex') d`,[ORG_ID,row.payment])).rows[0].d;assert.equal(digest.length,64);
  await c.query('SAVEPOINT line_overflow');await c.query(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,unit_amount_minor,amount_minor) VALUES($1,$2,$3,'rent','local overflow',1,1)`,[ORG_ID,row.invoice,row.max_line+8193-row.lines]);
  await assert.rejects(c.query(`SELECT app.b019_proto_snapshot($1,$2)`,[ORG_ID,row.payment]),(e:unknown)=>(e as {code?:string}).code==='54000');await c.query('ROLLBACK TO SAVEPOINT line_overflow');
  assert.equal((await c.query<{d:string}>(`SELECT encode(app.b019_proto_snapshot($1,$2),'hex') d`,[ORG_ID,row.payment])).rows[0].d,digest);await c.query('ROLLBACK');
 } finally {await c.end();}
});

test('related-allocation diagnostic cap accepts 8192 and rejects 8193 without truncation',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {await c.query('BEGIN');await c.query(`SELECT set_config('app.active_org_id',$1,true),set_config('app.env','live',true)`,[ORG_ID]);
  const row=(await c.query<{payment:string;invoice:string;related:number}>(`SELECT p.id::text payment,a.invoice_id::text invoice,(SELECT count(*)::int FROM payment_allocations WHERE invoice_id=a.invoice_id) related FROM payments p JOIN payment_allocations a ON a.payment_id=p.id AND a.org_id=p.org_id WHERE p.org_id=$1 AND p.status='confirmed' LIMIT 1`,[ORG_ID])).rows[0];assert.ok(row);assert.ok(row.related<8192);
  const invoiceSet=await c.query<{id:string}>(`SELECT invoice_id::text id FROM payment_allocations WHERE org_id=$1 AND payment_id=$2 UNION SELECT e.invoice_id::text id FROM ledger_entries e JOIN ledger_transactions t ON t.org_id=e.org_id AND t.id=e.transaction_id WHERE t.org_id=$1 AND e.invoice_id IS NOT NULL AND (t.id=(SELECT ledger_transaction_id FROM payments WHERE id=$2) OR (t.source_table='payments' AND t.source_id=$2) OR t.reverses_transaction_id IN (SELECT id FROM ledger_transactions WHERE org_id=$1 AND (id=(SELECT ledger_transaction_id FROM payments WHERE id=$2) OR (source_table='payments' AND source_id=$2))))`,[ORG_ID,row.payment]);assert.deepEqual(invoiceSet.rows,[{id:row.invoice}]);
  const tag=randomUUID();await c.query(`INSERT INTO payments(org_id,property_id,lease_id,payer_contact_id,currency,amount_minor,paid_on,method,status,source,reference) SELECT p.org_id,p.property_id,p.lease_id,p.payer_contact_id,p.currency,1,current_date,p.method,'submitted','tenant_portal',$2 FROM payments p CROSS JOIN generate_series(1,$3::int) WHERE p.id=$1`,[row.payment,tag,8193-row.related]);
  const others=await c.query<{id:string}>(`SELECT id::text FROM payments WHERE org_id=$1 AND reference=$2 ORDER BY id`,[ORG_ID,tag]);assert.equal(others.rowCount,8193-row.related);
  await c.query(`INSERT INTO payment_allocations(org_id,payment_id,invoice_id,amount_minor,created_by) SELECT $1,id,$2,1,$3 FROM payments WHERE org_id=$1 AND reference=$4 AND id<>$5`,[ORG_ID,row.invoice,USERS.admin,tag,others.rows[0].id]);
  const digest=(await c.query<{d:string}>(`SELECT encode(app.b019_proto_snapshot($1,$2),'hex') d`,[ORG_ID,row.payment])).rows[0].d;assert.equal(digest.length,64);
  await c.query('SAVEPOINT allocation_overflow');await c.query(`INSERT INTO payment_allocations(org_id,payment_id,invoice_id,amount_minor,created_by) VALUES($1,$2,$3,1,$4)`,[ORG_ID,others.rows[0].id,row.invoice,USERS.admin]);
  await assert.rejects(c.query(`SELECT app.b019_proto_snapshot($1,$2)`,[ORG_ID,row.payment]),(e:unknown)=>(e as {code?:string}).code==='54000');await c.query('ROLLBACK TO SAVEPOINT allocation_overflow');
  assert.equal((await c.query<{d:string}>(`SELECT encode(app.b019_proto_snapshot($1,$2),'hex') d`,[ORG_ID,row.payment])).rows[0].d,digest);await c.query('ROLLBACK');
 } finally {await c.end();}
});

test('private GC preserves current seal, denies malformed bounds and removes only later committed seal children first',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {
  const pay=(await c.query<{id:string;lease:string}>(`SELECT id::text,lease_id::text lease FROM payments WHERE org_id=$1 LIMIT 1`,[ORG_ID])).rows[0];assert.ok(pay);await c.query('BEGIN');
  const seal=(await c.query<{id:string}>(`INSERT INTO app.b019_proto_seals(org_id,live_org_id,environment,lease_id,payment_id,kind,actor_id,session_id,role,mode,prior_status,prestate_digest,neutral_source_id,in_app_outcome,financial_digest,recipient_digest,scope_digest)
   VALUES($1,$1,'live',$2,$3,'payment_confirmed',$4,$5,'admin','confirm_submitted','submitted',decode(repeat('11',32),'hex'),$6,'recipient_unavailable',decode(repeat('22',32),'hex'),decode(repeat('33',32),'hex'),decode(repeat('44',32),'hex')) RETURNING id::text`,[ORG_ID,pay.lease,pay.id,USERS.admin,randomUUID(),randomUUID()])).rows[0].id;
  await c.query(`INSERT INTO app.b019_proto_install_permits(tx_id,seal_id) VALUES(pg_current_xact_id(),$1)`,[seal]);
  await c.query(`INSERT INTO app.b019_proto_resources(seal_id,kind,org_id,id1) VALUES($1,'payment',$2,$3)`,[seal,ORG_ID,pay.id]);
  await c.query(`DELETE FROM app.b019_proto_install_permits WHERE tx_id=pg_current_xact_id() AND seal_id=$1`,[seal]);
  assert.equal((await c.query<{n:number}>(`SELECT app.b019_proto_gc(10) n`)).rows[0].n,0);
  await c.query('SAVEPOINT direct_delete');await assert.rejects(c.query(`DELETE FROM app.b019_proto_seals WHERE id=$1`,[seal]),(e:unknown)=>(e as {code?:string}).code==='42501');await c.query('ROLLBACK TO SAVEPOINT direct_delete');await c.query('COMMIT');
  for(const limit of [null,0,11])await assert.rejects(c.query(`SELECT app.b019_proto_gc($1)`,[limit]),(e:unknown)=>(e as {code?:string}).code==='22023');
  assert.equal((await c.query(`SELECT 1 FROM app.b019_proto_seals WHERE id=$1`,[seal])).rowCount,1);assert.equal((await c.query<{n:number}>(`SELECT app.b019_proto_gc(1) n`)).rows[0].n,1);
  assert.equal((await c.query(`SELECT 1 FROM app.b019_proto_seals WHERE id=$1`,[seal])).rowCount,0);assert.equal((await c.query(`SELECT 1 FROM app.b019_proto_resources WHERE seal_id=$1`,[seal])).rowCount,0);assert.equal((await c.query(`SELECT 1 FROM app.b019_proto_gc_permits`)).rowCount,0);
 } finally {await c.end();}
});

test('private GC and child-resource lock conflict without waiting in both orders',async()=>{
 const a=new Client({connectionString:process.env.DATABASE_URL}),b=new Client({connectionString:process.env.DATABASE_URL});await a.connect();await b.connect();
 try {
  const pay=(await a.query<{id:string;lease:string}>(`SELECT id::text,lease_id::text lease FROM payments WHERE org_id=$1 LIMIT 1`,[ORG_ID])).rows[0];assert.ok(pay);
  await a.query('BEGIN');const seal=(await a.query<{id:string}>(`INSERT INTO app.b019_proto_seals(org_id,live_org_id,environment,lease_id,payment_id,kind,actor_id,session_id,role,mode,prior_status,prestate_digest,neutral_source_id,in_app_outcome,financial_digest,recipient_digest,scope_digest)
   VALUES($1,$1,'live',$2,$3,'payment_confirmed',$4,$5,'admin','confirm_submitted','submitted',decode(repeat('11',32),'hex'),$6,'recipient_unavailable',decode(repeat('22',32),'hex'),decode(repeat('33',32),'hex'),decode(repeat('44',32),'hex')) RETURNING id::text`,[ORG_ID,pay.lease,pay.id,USERS.admin,randomUUID(),randomUUID()])).rows[0].id;
  await a.query(`INSERT INTO app.b019_proto_install_permits(tx_id,seal_id) VALUES(pg_current_xact_id(),$1)`,[seal]);
  const resource=(await a.query<{id:string}>(`INSERT INTO app.b019_proto_resources(seal_id,kind,org_id,id1) VALUES($1,'payment',$2,$3) RETURNING id::text`,[seal,ORG_ID,pay.id])).rows[0].id;
  await a.query(`DELETE FROM app.b019_proto_install_permits WHERE tx_id=pg_current_xact_id() AND seal_id=$1`,[seal]);await a.query('COMMIT');
  await b.query('BEGIN');await b.query(`SELECT 1 FROM app.b019_proto_resources WHERE id=$1 FOR UPDATE`,[resource]);
  await assert.rejects(a.query(`SELECT app.b019_proto_gc(1)`),(e:unknown)=>(e as {code?:string}).code==='55P03');assert.equal((await a.query(`SELECT 1 FROM app.b019_proto_seals WHERE id=$1`,[seal])).rowCount,1);await b.query('ROLLBACK');
  await a.query('BEGIN');assert.equal((await a.query<{n:number}>(`SELECT app.b019_proto_gc(1) n`)).rows[0].n,1);
  await b.query('BEGIN');await assert.rejects(b.query(`SELECT 1 FROM app.b019_proto_resources WHERE id=$1 FOR UPDATE NOWAIT`,[resource]),(e:unknown)=>(e as {code?:string}).code==='55P03');await b.query('ROLLBACK');await a.query('ROLLBACK');
  assert.equal((await a.query(`SELECT 1 FROM app.b019_proto_resources WHERE id=$1`,[resource])).rowCount,1);
 } finally {await a.end();await b.end();}
});

test('full-seal prototype GC and reset admission conflict without waiting in both orders',async()=>{
 const a=new Client({connectionString:process.env.DATABASE_URL}),b=new Client({connectionString:process.env.DATABASE_URL});await a.connect();await b.connect();
 try {await a.query('BEGIN');await a.query(`SELECT app.b019_proto_gc(1)`);await b.query('BEGIN');await assert.rejects(b.query('LOCK TABLE public.platform_settings IN SHARE ROW EXCLUSIVE MODE NOWAIT'),(e:unknown)=>(e as {code?:string}).code==='55P03');await b.query('ROLLBACK');await a.query('ROLLBACK');
  await b.query('BEGIN');await b.query('LOCK TABLE public.platform_settings IN SHARE ROW EXCLUSIVE MODE');await a.query('BEGIN');await assert.rejects(a.query(`SELECT app.b019_proto_gc(1)`),(e:unknown)=>(e as {code?:string}).code==='55P03');await a.query('ROLLBACK');await b.query('ROLLBACK');
 } finally {await a.end();await b.end();}
});

test('affected-invoice diagnostic cap accepts 1024 and rejects 1025 without truncation',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {await c.query('BEGIN');await c.query(`SELECT set_config('app.active_org_id',$1,true),set_config('app.env','live',true)`,[ORG_ID]);
  const p=(await c.query<{id:string;invoice_count:number}>(`SELECT p.id::text,(SELECT count(DISTINCT invoice_id)::int FROM payment_allocations WHERE payment_id=p.id) invoice_count FROM payments p WHERE p.org_id=$1 AND p.status='confirmed' LIMIT 1`,[ORG_ID])).rows[0];assert.ok(p);assert.equal(p.invoice_count,1);
  await c.query(`UPDATE payments SET amount_minor=amount_minor+2048 WHERE id=$1`,[p.id]); // diagnostic capacity only; rolled back
  const tag=randomUUID();await c.query(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date) SELECT p.org_id,p.property_id,p.lease_id,$2 || '-' || g::text,p.currency,current_date FROM payments p CROSS JOIN generate_series(1,1024) g WHERE p.id=$1`,[p.id,tag]);
  const invoices=await c.query<{id:string}>(`SELECT id::text FROM invoices WHERE org_id=$1 AND invoice_number LIKE $2 ORDER BY id`,[ORG_ID,`${tag}-%`]);assert.equal(invoices.rowCount,1024);
  await c.query(`INSERT INTO payment_allocations(org_id,payment_id,invoice_id,amount_minor,created_by) SELECT $1,$2,id,1,$3 FROM invoices WHERE org_id=$1 AND invoice_number LIKE $4 AND id<>$5`,[ORG_ID,p.id,USERS.admin,`${tag}-%`,invoices.rows[0].id]);
  const digest=(await c.query<{d:string}>(`SELECT encode(app.b019_proto_snapshot($1,$2),'hex') d`,[ORG_ID,p.id])).rows[0].d;assert.equal(digest.length,64);
  await c.query('SAVEPOINT invoice_overflow');await c.query(`INSERT INTO payment_allocations(org_id,payment_id,invoice_id,amount_minor,created_by) VALUES($1,$2,$3,1,$4)`,[ORG_ID,p.id,invoices.rows[0].id,USERS.admin]);
  await assert.rejects(c.query(`SELECT app.b019_proto_snapshot($1,$2)`,[ORG_ID,p.id]),(e:unknown)=>(e as {code?:string}).code==='54000');await c.query('ROLLBACK TO SAVEPOINT invoice_overflow');
  assert.equal((await c.query<{d:string}>(`SELECT encode(app.b019_proto_snapshot($1,$2),'hex') d`,[ORG_ID,p.id])).rows[0].d,digest);await c.query('ROLLBACK');
 } finally {await c.end();}
});

test('ledger-entry diagnostic cap accepts 8192 and rejects 8193 without truncation',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {await c.query('BEGIN');const p=(await c.query<{id:string;ledger:string;entries:number}>(`SELECT p.id::text,p.ledger_transaction_id::text ledger,(SELECT count(*)::int FROM ledger_entries WHERE transaction_id=p.ledger_transaction_id) entries FROM payments p WHERE p.org_id=$1 AND p.status='confirmed' LIMIT 1`,[ORG_ID])).rows[0];assert.ok(p);assert.equal(p.entries,2);
  await c.query(`INSERT INTO ledger_entries(org_id,transaction_id,account,amount_minor,currency,contact_id,property_id,lease_id,invoice_id) SELECT e.org_id,e.transaction_id,e.account,e.amount_minor,e.currency,e.contact_id,e.property_id,e.lease_id,e.invoice_id FROM ledger_entries e CROSS JOIN generate_series(1,4095) WHERE e.transaction_id=$1`,[p.ledger]);
  const digest=(await c.query<{d:string}>(`SELECT encode(app.b019_proto_snapshot($1,$2),'hex') d`,[ORG_ID,p.id])).rows[0].d;assert.equal(digest.length,64);
  await c.query('SAVEPOINT entry_overflow');await c.query(`INSERT INTO ledger_entries(org_id,transaction_id,account,amount_minor,currency,contact_id,property_id,lease_id,invoice_id) SELECT org_id,transaction_id,account,amount_minor,currency,contact_id,property_id,lease_id,invoice_id FROM ledger_entries WHERE transaction_id=$1 LIMIT 1`,[p.ledger]);
  await assert.rejects(c.query(`SELECT app.b019_proto_snapshot($1,$2)`,[ORG_ID,p.id]),(e:unknown)=>(e as {code?:string}).code==='54000');await c.query('ROLLBACK TO SAVEPOINT entry_overflow');
  assert.equal((await c.query<{d:string}>(`SELECT encode(app.b019_proto_snapshot($1,$2),'hex') d`,[ORG_ID,p.id])).rows[0].d,digest);await c.query('ROLLBACK');
 } finally {await c.end();}
});
