import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>;
test.before(async()=>{clone=await cloneTestDatabase();});
test.after(async()=>{await clone.cleanup();});

test("enabled payment transitions require a same-transaction event and leave no guard record",async()=>{
  const c=new Client({connectionString:process.env.DATABASE_URL}); await c.connect();
  try {
    await c.query("BEGIN");
    const pay=(await c.query<{id:string;lease_id:string}>(`SELECT id::text,lease_id::text FROM payments WHERE org_id=$1 AND status='confirmed' LIMIT 1`,[ORG_ID])).rows[0];
    assert.ok(pay);
    await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"payment_results_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='payment_results_v2'`,[ORG_ID]);
    const sid=randomUUID();
    await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
    await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);
    await c.query("SET LOCAL ROLE service_role"); await c.query("SAVEPOINT old_writer");
    await c.query(`UPDATE payments SET status='reversed' WHERE id=$1`,[pay.id]);
    await assert.rejects(c.query(`SET CONSTRAINTS app.b010_payment_event_required IMMEDIATE`),(e:unknown)=>(e as {code?:string}).code==='23514');
    await c.query("ROLLBACK TO SAVEPOINT old_writer");
    assert.equal((await c.query<{status:string}>(`SELECT status::text FROM payments WHERE id=$1`,[pay.id])).rows[0].status,'confirmed');
    await c.query("RESET ROLE");
    await c.query(`INSERT INTO app.b010_source_events(org_id,lease_id,payment_id,kind,occurrence_key,actor_id) VALUES ($1,$2,$3,'payment_reversed','prior',$4)`,[ORG_ID,pay.lease_id,pay.id,USERS.admin]);
    await c.query("SET LOCAL ROLE service_role");
    assert.equal((await c.query<{ok:boolean}>(`SELECT app.b010_lock_payment_context($1,$1,'live',$2,$3,'admin') AS ok`,[ORG_ID,sid,pay.lease_id])).rows[0].ok,true);
    await c.query(`UPDATE payments SET status='reversed' WHERE id=$1`,[pay.id]);
    await assert.rejects(c.query(`SET CONSTRAINTS app.b010_payment_event_required IMMEDIATE`),(e:unknown)=>(e as {code?:string}).code==='23514');
    await c.query("ROLLBACK TO SAVEPOINT old_writer");
    await c.query(`UPDATE payments SET status='reversed' WHERE id=$1`,[pay.id]);
    await assert.rejects(c.query(`SELECT app.b010_emit_payment_event($1,'payment_reversed')`,[pay.id]),(e:unknown)=>(e as {code?:string}).code==='42501');
    await c.query("ROLLBACK TO SAVEPOINT old_writer");
    assert.equal((await c.query<{ok:boolean}>(`SELECT app.b010_lock_payment_context($1,$1,'live',$2,$3,'admin') AS ok`,[ORG_ID,sid,pay.lease_id])).rows[0].ok,true);
    await c.query(`UPDATE payments SET status='reversed' WHERE id=$1`,[pay.id]);
    await c.query(`SELECT app.b010_emit_payment_event($1,'payment_reversed')`,[pay.id]);
    await assert.rejects(c.query(`UPDATE payments SET status='submitted' WHERE id=$1`,[pay.id]),(e:unknown)=>(e as {code?:string}).code==='23514');
    await c.query("ROLLBACK TO SAVEPOINT old_writer");
    for (const wrongEntries of [false,true]) {
      assert.equal((await c.query<{ok:boolean}>(`SELECT app.b010_lock_payment_context($1,$1,'live',$2,$3,'admin') AS ok`,[ORG_ID,sid,pay.lease_id])).rows[0].ok,true);
      const fake=(await c.query<{id:string}>(`INSERT INTO ledger_transactions(org_id,property_id,lease_id,kind,currency,effective_date,description,source_table,source_id,reverses_transaction_id,reason,created_by)
        SELECT t.org_id,t.property_id,t.lease_id,'reversal',t.currency,current_date,'Synthetic',t.source_table,t.source_id,t.id,'Synthetic correction',$2
        FROM ledger_transactions t JOIN payments p ON p.ledger_transaction_id=t.id WHERE p.id=$1 RETURNING id::text`,[pay.id,USERS.admin])).rows[0].id;
      if (wrongEntries) await c.query(`INSERT INTO ledger_entries(org_id,transaction_id,account,amount_minor,currency,contact_id,property_id,lease_id,invoice_id,memo)
        SELECT e.org_id,$2,e.account,-2*e.amount_minor,e.currency,e.contact_id,e.property_id,e.lease_id,e.invoice_id,'Synthetic'
        FROM ledger_entries e JOIN payments p ON p.ledger_transaction_id=e.transaction_id WHERE p.id=$1`,[pay.id,fake]);
      await c.query(`UPDATE payments SET status='reversed' WHERE id=$1`,[pay.id]);
      await c.query(`SELECT app.b010_emit_payment_event($1,'payment_reversed')`,[pay.id]);
      await assert.rejects(c.query(`SET CONSTRAINTS app.b010_payment_event_required IMMEDIATE`),(e:unknown)=>(e as {code?:string}).code==='23514');
      await c.query("ROLLBACK TO SAVEPOINT old_writer");
    }
    assert.equal((await c.query<{ok:boolean}>(`SELECT app.b010_lock_payment_context($1,$1,'live',$2,$3,'admin') AS ok`,[ORG_ID,sid,pay.lease_id])).rows[0].ok,true);
    await c.query(`SELECT post_reversal(ledger_transaction_id,'Synthetic correction') FROM payments WHERE id=$1`,[pay.id]);
    await c.query(`UPDATE payments SET status='reversed' WHERE id=$1`,[pay.id]);
    await c.query(`SELECT app.b010_emit_payment_event($1,'payment_reversed')`,[pay.id]);
    await c.query(`SET CONSTRAINTS app.b010_payment_event_required IMMEDIATE`);
    await c.query("RESET ROLE");
    assert.equal((await c.query(`SELECT 1 FROM app.b010_source_events WHERE payment_id=$1 AND kind='payment_reversed' AND actor_id=$2`,[pay.id,USERS.admin])).rowCount,1);
    assert.equal((await c.query(`SELECT 1 FROM app.b010_payment_requirements WHERE payment_id=$1`,[pay.id])).rowCount,0);
    await c.query(`SET CONSTRAINTS app.b010_payment_context_cleanup IMMEDIATE`);
    assert.equal((await c.query(`SELECT 1 FROM app.b010_payment_contexts WHERE lease_id=$1`,[pay.lease_id])).rowCount,0);
    await c.query("ROLLBACK");
  } finally { await c.end(); }
});

test("payment context grants authorized roles only and does not grant configuration updates",async()=>{
  const c=new Client({connectionString:process.env.DATABASE_URL}); await c.connect();
  try {
    await c.query("BEGIN");
    const lease=(await c.query<{id:string}>(`SELECT id::text FROM leases WHERE org_id=$1 LIMIT 1`,[ORG_ID])).rows[0].id;
    await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"payment_results_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='payment_results_v2'`,[ORG_ID]);
    for (const [actor,allowed] of [[USERS.manager,true],[USERS.accountant,true],[USERS.maintenance,false]] as const) {
      const sid=randomUUID();
      await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,actor,randomUUID()]);
      await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[actor]); await c.query("SET LOCAL ROLE authenticated"); await c.query("SAVEPOINT access_case");
      const call=()=>c.query<{ok:boolean}>(`SELECT app.b010_lock_payment_context($1,$1,'live',$2,$3,$4) AS ok`,[ORG_ID,sid,lease,actor===USERS.manager?"manager":actor===USERS.accountant?"accountant":"maintenance"]);
      if (allowed) assert.equal((await call()).rows[0].ok,true); else {
        await assert.rejects(call(),(e:unknown)=>(e as {code?:string}).code==='42501'); await c.query("ROLLBACK TO SAVEPOINT access_case");
      }
      const changed=await c.query(`UPDATE organizations SET feature_flags='{}'::jsonb WHERE id=$1`,[ORG_ID]);
      assert.equal(changed.rowCount,0);
      await c.query("ROLLBACK TO SAVEPOINT access_case");
      await assert.rejects(c.query(`SELECT app.b010_lock_payment_context($1,$2,'live',$3,$4,$5)`,[ORG_ID,ORG2_ID,sid,lease,actor===USERS.manager?"manager":actor===USERS.accountant?"accountant":"maintenance"]),(e:unknown)=>(e as {code?:string}).code==='42501');
      await c.query("ROLLBACK TO SAVEPOINT access_case"); await c.query("RESET ROLE");
    }
    await c.query("ROLLBACK");
  } finally { await c.end(); }
});

test("old financial writer fails immediately when control lock is held",async()=>{
  const owner=new Client({connectionString:process.env.DATABASE_URL}),writer=new Client({connectionString:process.env.DATABASE_URL});
  await owner.connect(); await writer.connect();
  try {
    const payment=(await owner.query<{id:string}>(`SELECT id::text FROM payments WHERE org_id=$1 AND status='confirmed' LIMIT 1`,[ORG_ID])).rows[0]; assert.ok(payment);
    await owner.query(`UPDATE organizations SET feature_flags=feature_flags || '{"payment_results_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    await owner.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='payment_results_v2'`,[ORG_ID]);
    const sid=randomUUID();
    await owner.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.maintenance,randomUUID()]);
    const lease=(await owner.query<{id:string}>(`SELECT id::text FROM leases WHERE org_id=$1 LIMIT 1`,[ORG_ID])).rows[0].id;
    await owner.query("BEGIN"); await owner.query(`UPDATE platform_settings SET value=value WHERE key='payment_results_v2'`);
    await writer.query("BEGIN"); await writer.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.maintenance]); await writer.query("SET LOCAL ROLE authenticated");
    await assert.rejects(writer.query(`SELECT app.b010_lock_payment_context($1,$1,'live',$2,$3,'maintenance')`,[ORG_ID,sid,lease]),(e:unknown)=>(e as {code?:string}).code==='42501');
    await writer.query("ROLLBACK");
    await writer.query("BEGIN"); await writer.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]); await writer.query("SET LOCAL ROLE service_role");
    await assert.rejects(writer.query(`UPDATE payments SET status='reversed' WHERE id=$1`,[payment.id]),(e:unknown)=>(e as {code?:string}).code==='55P03');
    await writer.query("ROLLBACK"); await owner.query("ROLLBACK");
    assert.equal((await owner.query<{status:string}>(`SELECT status::text FROM payments WHERE id=$1`,[payment.id])).rows[0].status,'confirmed');
  } finally {await writer.end();await owner.end();}
});
