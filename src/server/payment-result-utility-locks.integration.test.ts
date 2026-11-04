import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { disposableDbUrl, withDatabase } from "./test-disposable-db";
import { resetAndSeed } from "./seed";
import { ORG_ID, USERS } from "./ids";
import { decideBankMatch, importBankFile } from "./bank-matching";
import { confirmPayment } from "./domain";
import { confirmUtilityRun, currentUtilityPeriod, prepareUtilityRun } from "./utility-posting";
import type { Session } from "./types";

const source = disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let admin: Client, db: Client, name: string, previous: string | undefined, owned = false;
let session: Session, account: string;
test.before(async () => {
  name = `condola_b009_${randomUUID().replaceAll("-","")}`;
  const template=decodeURIComponent(source.pathname.slice(1)); if(!/^[a-z][a-z0-9_]{0,62}$/.test(template)) throw new Error("Invalid template");
  admin=new Client({connectionString:withDatabase(source,"postgres")}); await admin.connect();
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`); owned=true;
  db=new Client({connectionString:withDatabase(source,name)}); await db.connect();
  previous=process.env.DATABASE_URL; process.env.DATABASE_URL=withDatabase(source,name); await resetAndSeed();
  const sid=randomUUID(); await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
  session={userId:USERS.admin,sessionId:sid,orgId:ORG_ID,liveOrgId:ORG_ID,kind:"staff",role:"admin",environment:"live",locale:"en",calendar:"gregorian",leaseId:null,email:"",name:"Synthetic"};
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"bank_matching":true,"payment_results_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
  await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key IN ('bank_matching','payment_results_v2')`,[ORG_ID]);
  account=(await db.query<{id:string}>(`SELECT id::text FROM bank_accounts WHERE org_id=$1 AND archived_at IS NULL AND currency='TWD' AND property_id IS NULL LIMIT 1`,[ORG_ID])).rows[0].id;
});
test.after(async () => { if(previous===undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL=previous; await db?.end(); if(owned) await admin.query(`DROP DATABASE "${name}"`); await admin?.end(); });

async function fixture(label:string) {
  const period=currentUtilityPeriod();
  const property=(await db.query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES ($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID,label])).rows[0].id;
  const unit=(await db.query<{id:string}>(`INSERT INTO units(org_id,property_id,label,electricity_method,rate_per_kwh) VALUES ($1,$2,$3,'submeter',4) RETURNING id::text`,[ORG_ID,property,label])).rows[0].id;
  const contact=(await db.query<{id:string}>(`INSERT INTO contacts(org_id,is_tenant,display_name) VALUES ($1,true,$2) RETURNING id::text`,[ORG_ID,label])).rows[0].id;
  const lease=(await db.query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor) VALUES ($1,$2,$3,$3,'active',$4,'TWD',0) RETURNING id::text`,[ORG_ID,property,unit,period.start])).rows[0].id;
  await db.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES ($1,$2,$3,'primary')`,[ORG_ID,lease,contact]);
  const invoice=(await db.query<{id:string}>(`INSERT INTO invoices(org_id,property_id,lease_id,bill_to_contact_id,invoice_number,currency,issue_date,due_date,period_start,period_end,status,source) VALUES ($1,$2,$3,$4,$5,'TWD',$6,$7,$6,$7,'open','recurring') RETURNING id::text`,[ORG_ID,property,lease,contact,`B009-UTILITY-${randomUUID()}`,period.start,period.end])).rows[0].id;
  await db.query(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,quantity,unit_amount_minor,amount_minor) VALUES ($1,$2,1,'rent','synthetic rent',1,10000,10000)`,[ORG_ID,invoice]);
  const payment=(await db.query<{id:string}>(`INSERT INTO payments(org_id,property_id,lease_id,payer_contact_id,currency,amount_minor,paid_on,method,status,source,submitted_by) VALUES ($1,$2,$3,$4,'TWD',10000,$5,'bank_transfer','submitted','tenant_portal',$6) RETURNING id::text`,[ORG_ID,property,lease,contact,period.start,USERS.admin])).rows[0].id;
  const run=await prepareUtilityRun(session,{unitId:unit,periodStart:period.start,periodEnd:period.end,rateMajor:4,totalKwh:null,billTotalMajor:null,overrideReason:"",readings:[{spaceId:unit,kwh:10}]});
  const imported=await importBankFile(session,account,new TextEncoder().encode(`date,amount,last5,memo\n${period.start},100.00,12345,${label}`),"utf-8"); assert.ok(imported);
  const bank=(await db.query<{id:string}>(`SELECT id::text FROM bank_transactions WHERE import_id=$1`,[imported.importId])).rows[0].id;
  return {property,lease,invoice,payment,run:run.runId,bank};
}
async function waitBlocked(blocker:number) {
  for(let i=0;i<200;i++) {
    const result=await admin.query<{pid:number}>(`SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) ORDER BY pid LIMIT 1`,[blocker]);
    if(result.rows[0]) return result.rows[0].pid;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail("expected database lock wait");
}
async function barrier(table:"payment_allocations"|"invoice_lines",field:"payment_id"|"invoice_id",id:string) {
  const key=BigInt(`0x${randomBytes(7).toString("hex")}`).toString();
  const hold=new Client({connectionString:withDatabase(source,name)}); await hold.connect();
  const pid=(await hold.query<{pid:number}>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
  await hold.query(`SELECT pg_advisory_lock($1::bigint)`,[key]);
  // Both identifiers and UUID are fixture-owned and the function exists only in this disposable clone.
  await db.query(`CREATE FUNCTION app.b009_test_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.${field}='${id}'::uuid THEN PERFORM pg_advisory_xact_lock(${key}::bigint); END IF; RETURN NEW; END $$`);
  await db.query(`CREATE TRIGGER b009_test_pause AFTER INSERT ON public.${table} FOR EACH ROW EXECUTE FUNCTION app.b009_test_pause()`);
  return {pid, async release(){await hold.query(`SELECT pg_advisory_unlock($1::bigint)`,[key]);}, async cleanup(){await hold.end(); await db.query(`DROP TRIGGER b009_test_pause ON public.${table}`); await db.query(`DROP FUNCTION app.b009_test_pause()`);}};
}

test("ON bank lock first does not append utility to an invoice that became paid", async () => {
  const f=await fixture("bank-first"); const gate=await barrier("payment_allocations","payment_id",f.payment);
  const snapshot = async () => (await db.query(`SELECT
    (SELECT to_jsonb(r) FROM utility_allocation_runs r WHERE r.id=$1) AS run,
    (SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]'::jsonb) FROM utility_allocation_lines l WHERE l.run_id=$1) AS lines,
    (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM audit_log a WHERE a.row_id=$1::text OR a.row_id IN (SELECT id::text FROM utility_allocation_lines WHERE run_id=$1)) AS audit,
    (SELECT count(*)::int FROM ledger_transactions WHERE source_table='utility_allocation_lines' AND source_id IN (SELECT id FROM utility_allocation_lines WHERE run_id=$1)) AS utility_ledgers`,[f.run])).rows[0];
  const before=await snapshot();
  let bank:Promise<unknown>|undefined, utility:Promise<unknown>|undefined;
  try {
    bank=decideBankMatch(session,{bankId:f.bank,paymentId:f.payment,decision:"match",reason:"other"});
    const bankPid=await waitBlocked(gate.pid);
    utility=confirmUtilityRun(session,f.run);
    await waitBlocked(bankPid);
    await gate.release();
    const outcomes=await Promise.allSettled([bank,utility]);
    assert.equal(outcomes[0].status,"fulfilled");
    assert.equal(outcomes[1].status,"rejected");
    if (outcomes[1].status === "rejected") assert.equal(outcomes[1].reason?.key,"errors.generic");
    const state=(await db.query(`SELECT i.status::text,i.paid_minor::text,i.total_minor::text,
      (SELECT count(*)::int FROM invoice_lines l WHERE l.invoice_id=i.id AND l.charge_type='utility') AS utility_lines FROM invoices i WHERE i.id=$1`,[f.invoice])).rows[0];
    assert.equal(state.utility_lines,0,`utility appended to paid invoice: ${JSON.stringify(state)}`);
    assert.equal(state.status,"paid"); assert.equal(state.paid_minor,"10000"); assert.equal(state.total_minor,"10000");
    assert.deepEqual(await snapshot(),before);
    const bankState=(await db.query(`SELECT (SELECT count(*)::int FROM app.b009_decisions WHERE payment_id=$1 AND decision='match') AS decisions,
      (SELECT count(*)::int FROM ledger_transactions WHERE source_table='payments' AND source_id=$1) AS ledgers,
      (SELECT coalesce(sum(amount_minor),0)::text FROM payment_allocations WHERE payment_id=$1) AS allocated`,[f.payment])).rows[0];
    assert.deepEqual(bankState,{decisions:1,ledgers:1,allocated:"10000"});
    assert.equal((await db.query(`SELECT 1 FROM app.b010_source_events WHERE payment_id=$1 AND kind='payment_confirmed'`,[f.payment])).rowCount,1);
  } finally { await gate.release().catch(()=>{}); await Promise.allSettled([bank,utility].filter(Boolean) as Promise<unknown>[]); await gate.cleanup(); }
});

test("ON utility lock first preserves a full bank payment without partial posting", async () => {
  const f=await fixture("utility-first"); const gate=await barrier("invoice_lines","invoice_id",f.invoice);
  let utility:Promise<unknown>|undefined, bank:Promise<unknown>|undefined;
  try {
    utility=confirmUtilityRun(session,f.run);
    const utilityPid=await waitBlocked(gate.pid);
    bank=decideBankMatch(session,{bankId:f.bank,paymentId:f.payment,decision:"match",reason:"other"});
    await waitBlocked(utilityPid);
    await gate.release();
    const outcomes=await Promise.allSettled([utility,bank]);
    assert.equal(outcomes[0].status,"fulfilled"); assert.equal(outcomes[1].status,"fulfilled");
    const state=(await db.query(`SELECT i.status::text,i.paid_minor::text,i.total_minor::text,
      (SELECT count(*)::int FROM invoice_lines l WHERE l.invoice_id=i.id AND l.charge_type='utility') AS utility_lines,
      (SELECT coalesce(sum(amount_minor),0)::text FROM payment_allocations WHERE payment_id=$2) AS allocated,
      (SELECT count(*)::int FROM ledger_transactions WHERE source_table='payments' AND source_id=$2) AS payment_ledgers
      FROM invoices i WHERE i.id=$1`,[f.invoice,f.payment])).rows[0];
    assert.equal(state.utility_lines,1); assert.equal(state.allocated,"10000"); assert.equal(state.payment_ledgers,1); assert.equal(state.status,"partially_paid");
    assert.equal(state.paid_minor,"10000"); assert.equal(state.total_minor,"14000");
    const other=(await db.query(`SELECT (SELECT status::text FROM utility_allocation_runs WHERE id=$1) AS run,
      (SELECT count(*)::int FROM ledger_transactions WHERE source_table='utility_allocation_lines' AND source_id IN (SELECT id FROM utility_allocation_lines WHERE run_id=$1)) AS ledgers,
      (SELECT count(*)::int FROM app.b009_decisions WHERE payment_id=$2 AND decision='match') AS decisions`,[f.run,f.payment])).rows[0];
    assert.deepEqual(other,{run:"posted",ledgers:1,decisions:1});
    assert.equal((await db.query(`SELECT 1 FROM app.b010_source_events WHERE payment_id=$1 AND kind='payment_confirmed'`,[f.payment])).rowCount,1);
  } finally { await gate.release().catch(()=>{}); await Promise.allSettled([bank,utility].filter(Boolean) as Promise<unknown>[]); await gate.cleanup(); }
});


test("manual reminder first and utility first serialize without lease inversion",async()=>{
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"rent_reminders_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
  await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='rent_reminders_v2'`,[ORG_ID]);
  const one=await fixture("manual-first");
  await db.query(`UPDATE contacts SET email='manual-first@example.test' WHERE id=(SELECT contact_id FROM lease_parties WHERE lease_id=$1 AND role='primary')`,[one.lease]);
  const hold=new Client({connectionString:withDatabase(source,name)}); await hold.connect();
  let utility:Promise<unknown>|undefined;
  try {
    await hold.query("BEGIN"); await hold.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]); await hold.query("SET LOCAL ROLE service_role");
    const pid=(await hold.query<{pid:number}>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
    await hold.query(`SELECT app.b010_manual_reminder($1,$1,'live',$2,$3,$4,$5)`,[ORG_ID,session.sessionId,one.lease,one.invoice,randomUUID()]);
    utility=confirmUtilityRun(session,one.run);
    await waitBlocked(pid);
    await hold.query("COMMIT");
    assert.equal((await Promise.allSettled([utility]))[0].status,"fulfilled");
  } finally {await hold.query("ROLLBACK").catch(()=>{}); await Promise.allSettled(utility?[utility]:[]); await hold.end();}
  const two=await fixture("utility-before-manual");
  await db.query(`UPDATE contacts SET email='manual-second@example.test' WHERE id=(SELECT contact_id FROM lease_parties WHERE lease_id=$1 AND role='primary')`,[two.lease]);
  const gate=await barrier("invoice_lines","invoice_id",two.invoice);
  const waiter=new Client({connectionString:withDatabase(source,name)}); await waiter.connect();
  let pending:Promise<unknown>|undefined,manual:Promise<unknown>|undefined;
  try {
    pending=confirmUtilityRun(session,two.run); const utilityPid=await waitBlocked(gate.pid);
    await waiter.query("BEGIN"); await waiter.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]); await waiter.query("SET LOCAL ROLE service_role");
    const waiterPid=(await waiter.query<{pid:number}>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
    manual=waiter.query(`SELECT app.b010_manual_reminder($1,$1,'live',$2,$3,$4,$5)`,[ORG_ID,session.sessionId,two.lease,two.invoice,randomUUID()]);
    const observed=await waitBlocked(utilityPid); assert.equal(observed,waiterPid);
    await gate.release();
    assert.deepEqual((await Promise.allSettled([pending,manual])).map(item=>item.status),["fulfilled","fulfilled"]);
    await waiter.query("COMMIT");
  } finally {await gate.release().catch(()=>{}); await waiter.query("ROLLBACK").catch(()=>{}); await Promise.allSettled([pending,manual].filter(Boolean) as Promise<unknown>[]); await waiter.end(); await gate.cleanup();}
});


for (const first of ["confirm","bank"] as const) test(`ON ${first} first serializes confirmation and bank link`,async()=>{
  const f=await fixture(`confirm-bank-${first}`), gate=await barrier("payment_allocations","payment_id",f.payment);
  const confirm=()=>confirmPayment(session,f.payment);
  const bank=()=>decideBankMatch(session,{bankId:f.bank,paymentId:f.payment,decision:"match",reason:"other"});
  let left:Promise<unknown>|undefined,right:Promise<unknown>|undefined;
  try {
    left=first === "confirm" ? confirm() : bank();
    const holderPid=await waitBlocked(gate.pid);
    right=first === "confirm" ? bank() : confirm();
    await waitBlocked(holderPid);
    await gate.release();
    assert.deepEqual((await Promise.allSettled([left,right])).map(item=>item.status),["fulfilled","fulfilled"]);
    assert.equal((await db.query(`SELECT 1 FROM app.b010_source_events WHERE payment_id=$1 AND kind='payment_confirmed'`,[f.payment])).rowCount,1);
    assert.equal((await db.query(`SELECT 1 FROM ledger_transactions WHERE source_table='payments' AND source_id=$1 AND kind='payment'`,[f.payment])).rowCount,1);
    assert.equal((await db.query(`SELECT 1 FROM payments WHERE id=$1 AND status='confirmed' AND bank_transaction_id=$2`,[f.payment,f.bank])).rowCount,1);
  } finally {await gate.release().catch(()=>{});await Promise.allSettled([left,right].filter(Boolean) as Promise<unknown>[]);await gate.cleanup();}
});
