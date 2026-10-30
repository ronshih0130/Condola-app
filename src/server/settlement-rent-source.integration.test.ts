import assert from "node:assert/strict";
import { randomUUID,randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "pg";
import { disposableDbUrl,withDatabase } from "./test-disposable-db";
import { resetAndSeed } from "./seed";
import { ORG_ID,USERS } from "./ids";
import { svc } from "./db";
import { FlowError } from "./errors";
import { settlementAccess } from "./settlement-access";
import { confirmPayment,recordPayment } from "./domain";
import { confirmUtilityRun,currentUtilityPeriod,prepareUtilityRun } from "./utility-posting";
import type { Session } from "./types";
import { scanRentSourcesUnderFence } from "./settlement-rent-source";
const source=disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let admin:Client,db:Client,name:string,owned=false;const previous=process.env.DATABASE_URL;
test.before(async()=>{const template=decodeURIComponent(source.pathname.slice(1));if(!/^[a-z][a-z0-9_]{0,62}$/.test(template))throw new Error("Invalid template");name=`condola_b011_${randomUUID().replaceAll("-","")}`;admin=new Client({connectionString:withDatabase(source,"postgres")});await admin.connect();await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);owned=true;db=new Client({connectionString:withDatabase(source,name)});await db.connect();for(const [table,file] of [["handover_records","20261031100214_b011_handover_records.sql"],["settlement_sources","20261031100216_b011_settlement.sql"]])if(!(await db.query(`SELECT to_regclass($1) IS NOT NULL AS installed`,[`app.${table}`])).rows[0].installed)await db.query(await readFile(new URL(`../../supabase/migrations/${file}`,import.meta.url),"utf8"));process.env.DATABASE_URL=withDatabase(source,name);await resetAndSeed();});
test.after(async()=>{if(previous===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous;await db?.end();if(owned)await admin.query(`DROP DATABASE "${name}"`);await admin?.end();});
test("rent source scan rejects an existing writer and fences later inserts in another org",async t=>{
  const targets=(await db.query<{id:string;org_id:string;property_id:string}>(`SELECT DISTINCT ON(org_id) id,org_id,property_id FROM leases WHERE status<>'draft' ORDER BY org_id,id`)).rows;
  assert.ok(targets.length>=2);const [target,other]=targets;
  const invoice=(await db.query<{id:string}>(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date,status) VALUES($1,$2,$3,$4,'TWD',current_date,'draft') RETURNING id`,[target.org_id,target.property_id,target.id,`B011-SCAN-${randomUUID()}`])).rows[0].id;
  const line=(await db.query<{id:string}>(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,quantity,unit_amount_minor,amount_minor,service_period) VALUES($1,$2,1,'rent','synthetic ambiguous',1,100,100,NULL) RETURNING id`,[target.org_id,invoice])).rows[0].id;
  const empty=(await db.query<{id:string}>(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,quantity,unit_amount_minor,amount_minor,service_period) VALUES($1,$2,4,'rent','synthetic empty',1,100,100,'empty'::daterange) RETURNING id`,[target.org_id,invoice])).rows[0].id;
  const credit=(await db.query<{id:string}>(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,quantity,unit_amount_minor,amount_minor,service_period) VALUES($1,$2,2,'credit','synthetic unbound',1,-10,-10,NULL) RETURNING id`,[target.org_id,invoice])).rows[0].id;
  const scan=new Client({connectionString:withDatabase(source,name)}),writer=new Client({connectionString:withDatabase(source,name)});await scan.connect();await writer.connect();
  try {
    await assert.rejects(scanRentSourcesUnderFence(scan,target.org_id,target.id,"2026-02-30","2026-03-30"));
    await assert.rejects(scanRentSourcesUnderFence(scan,target.org_id,target.id,"2026-03-30","2026-03-01"));
    await writer.query("BEGIN");
    await writer.query(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date,status) VALUES($1,$2,$3,$4,'TWD',current_date,'draft')`,[other.org_id,other.property_id,other.id,`B011-FENCE-${randomUUID()}`]);
    await scan.query("BEGIN");await scan.query("SET LOCAL ROLE service_role");
    await assert.rejects(scanRentSourcesUnderFence(scan,target.org_id,target.id,"2026-10-01","2026-10-31"),(error:unknown)=>(error as {code?:string}).code==="55P03");
    await scan.query("ROLLBACK");await writer.query("ROLLBACK");
    await writer.query("BEGIN");await writer.query(`SELECT id FROM invoices WHERE id=$1 FOR UPDATE`,[invoice]);
    await scan.query("BEGIN");await scan.query("SET LOCAL ROLE service_role");
    await assert.rejects(scanRentSourcesUnderFence(scan,target.org_id,target.id,"2026-10-01","2026-10-31"),(error:unknown)=>(error as {code?:string}).code==="55P03");
    await scan.query("ROLLBACK");await writer.query("ROLLBACK");
    await scan.query("BEGIN");await scan.query("SET LOCAL ROLE service_role");
    const started=performance.now();const snapshot=await scanRentSourcesUnderFence(scan,target.org_id,target.id,"2026-10-01","2026-10-31");assert.equal(snapshot.authoritative,false);
    assert.ok(snapshot.lines.some(r=>r.id===line && r.ambiguous_period));assert.ok(snapshot.lines.some(r=>r.id===empty && r.ambiguous_period));assert.ok(snapshot.lines.some(r=>r.id===credit && r.charge_type==='credit'));
    const backend=(await writer.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await writer.query("BEGIN");const pending=writer.query(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date,status) VALUES($1,$2,$3,$4,'TWD',current_date,'draft')`,[other.org_id,other.property_id,other.id,`B011-FENCE-${randomUUID()}`]);
    let blocked=false;for(let n=0;n<40&&!blocked;n++){await new Promise(resolve=>setTimeout(resolve,25));blocked=(await db.query<{blocked:boolean}>(`SELECT cardinality(pg_blocking_pids($1))>0 AS blocked`,[backend])).rows[0].blocked;}
    assert.ok(blocked,"unrelated organization's invoice insert must actually wait");
    await scan.query("COMMIT");await pending;await writer.query("ROLLBACK");
    const elapsed=performance.now()-started;assert.ok(elapsed<10000);
    await writer.query("BEGIN");await writer.query(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,quantity,unit_amount_minor,amount_minor) VALUES($1,$2,3,'adjustment','synthetic concurrent',1,-5,-5)`,[target.org_id,invoice]);
    await scan.query("BEGIN");await scan.query("SET LOCAL ROLE service_role");await assert.rejects(scanRentSourcesUnderFence(scan,target.org_id,target.id,"2026-10-01","2026-10-31"),(error:unknown)=>(error as {code?:string}).code==="55P03");await scan.query("ROLLBACK");await writer.query("ROLLBACK");
    const later=(await db.query<{id:string}>(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,quantity,unit_amount_minor,amount_minor) VALUES($1,$2,3,'adjustment','synthetic later',1,-5,-5) RETURNING id`,[target.org_id,invoice])).rows[0].id;
    await scan.query("BEGIN");await scan.query("SET LOCAL ROLE service_role");const rescanned=await scanRentSourcesUnderFence(scan,target.org_id,target.id,"2026-10-01","2026-10-31");await scan.query("COMMIT");
    assert.ok(!snapshot.lines.some(r=>r.id===later));assert.ok(rescanned.lines.some(r=>r.id===later));assert.notEqual(JSON.stringify(snapshot),JSON.stringify(rescanned));
    t.diagnostic(`Synthetic held-fence duration including observation: ${Math.round(elapsed)} ms`);
  } finally {await scan.query("ROLLBACK").catch(()=>{});await writer.query("ROLLBACK").catch(()=>{});await scan.end();await writer.end();}
});
async function utilityFixture() {
  const period=currentUtilityPeriod(),label=`B011-FENCE-${randomUUID()}`;
  const property=(await db.query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id`,[ORG_ID,label])).rows[0].id;
  const unit=(await db.query<{id:string}>(`INSERT INTO units(org_id,property_id,label,electricity_method,rate_per_kwh) VALUES($1,$2,$3,'submeter',4) RETURNING id`,[ORG_ID,property,label])).rows[0].id;
  const contact=(await db.query<{id:string}>(`INSERT INTO contacts(org_id,is_tenant,display_name) VALUES($1,true,$2) RETURNING id`,[ORG_ID,label])).rows[0].id;
  const lease=(await db.query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor) VALUES($1,$2,$3,$3,'active',$4,'TWD',0) RETURNING id`,[ORG_ID,property,unit,period.start])).rows[0].id;
  await db.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')`,[ORG_ID,lease,contact]);
  const invoice=(await db.query<{id:string}>(`INSERT INTO invoices(org_id,property_id,lease_id,bill_to_contact_id,invoice_number,currency,issue_date,due_date,period_start,period_end,status,source) VALUES($1,$2,$3,$4,$5,'TWD',$6,$7,$6,$7,'open','recurring') RETURNING id`,[ORG_ID,property,lease,contact,label,period.start,period.end])).rows[0].id;
  await db.query(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,quantity,unit_amount_minor,amount_minor) VALUES($1,$2,1,'rent','Synthetic rent',1,10000,10000)`,[ORG_ID,invoice]);
  const sid=randomUUID();await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
  const session={userId:USERS.admin,sessionId:sid,orgId:ORG_ID,liveOrgId:ORG_ID,kind:"staff",role:"admin",environment:"live",locale:"en",calendar:"gregorian",leaseId:null,email:"",name:"Synthetic"} as Session;
  const run=await prepareUtilityRun(session,{unitId:unit,periodStart:period.start,periodEnd:period.end,rateMajor:4,totalKwh:null,billTotalMajor:null,overrideReason:"",readings:[{spaceId:unit,kwh:10}]});
  return {period,property,contact,lease,invoice,session,run:run.runId};
}
async function waitBlockedBy(blocker:number) {
  for(let i=0;i<200;i++){const row=(await db.query<{pid:number}>(`SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) LIMIT 1`,[blocker])).rows[0];if(row)return row.pid;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.fail("Expected actual PostgreSQL blocking");
}
async function utilityState(run:string,invoice:string) {
  return (await db.query(`SELECT (SELECT to_jsonb(r) FROM utility_allocation_runs r WHERE r.id=$1) AS run,(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]'::jsonb) FROM utility_allocation_lines l WHERE l.run_id=$1) AS lines,(SELECT to_jsonb(i) FROM invoices i WHERE i.id=$2) AS invoice,(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]'::jsonb) FROM invoice_lines l WHERE l.invoice_id=$2) AS invoice_lines,(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM ledger_transactions t WHERE t.source_table='utility_allocation_lines' AND t.source_id IN (SELECT id FROM utility_allocation_lines WHERE run_id=$1)) AS ledgers,(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id),'[]'::jsonb) FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE t.source_table='utility_allocation_lines' AND t.source_id IN (SELECT id FROM utility_allocation_lines WHERE run_id=$1)) AS ledger_entries,(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM audit_log a WHERE a.row_id=$1::text OR a.row_id IN (SELECT id::text FROM utility_allocation_lines WHERE run_id=$1)) AS audit`,[run,invoice])).rows[0];
}
test("scanner-first fences the actual utility writer until release",async()=>{
  const f=await utilityFixture(),before=await utilityState(f.run,f.invoice);const scan=new Client({connectionString:withDatabase(source,name)});await scan.connect();let writer:Promise<unknown>|undefined;
  try {await scan.query("BEGIN");await scan.query("SET LOCAL ROLE service_role");const old=await scanRentSourcesUnderFence(scan,ORG_ID,f.lease,f.period.start,f.period.end);const pid=(await scan.query<{pid:number}>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
    writer=confirmUtilityRun(f.session,f.run);await waitBlockedBy(pid);assert.deepEqual(await utilityState(f.run,f.invoice),before);
    await scan.query("COMMIT");await writer;const after=await utilityState(f.run,f.invoice);assert.notDeepEqual(after,before);
    await scan.query("BEGIN");await scan.query("SET LOCAL ROLE service_role");const now=await scanRentSourcesUnderFence(scan,ORG_ID,f.lease,f.period.start,f.period.end);await scan.query("COMMIT");assert.notEqual(JSON.stringify(old),JSON.stringify(now));
  } finally {await scan.query("ROLLBACK").catch(()=>{});await Promise.allSettled(writer?[writer]:[]);await scan.end();}
});
test("utility-first causes scanner NOWAIT rejection without altering writer state",async()=>{
  const f=await utilityFixture(),before=await utilityState(f.run,f.invoice),gate=new Client({connectionString:withDatabase(source,name)}),scan=new Client({connectionString:withDatabase(source,name)});await gate.connect();await scan.connect();
  const key=BigInt(`0x${randomBytes(7).toString("hex")}`).toString(),pid=(await gate.query<{pid:number}>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;await gate.query(`SELECT pg_advisory_lock($1::bigint)`,[key]);
  await db.query(`CREATE FUNCTION app.b011_utility_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.invoice_id='${f.invoice}'::uuid THEN PERFORM pg_advisory_xact_lock(${key}::bigint); END IF; RETURN NEW; END $$`);await db.query(`CREATE TRIGGER b011_utility_pause AFTER INSERT ON public.invoice_lines FOR EACH ROW EXECUTE FUNCTION app.b011_utility_pause()`);
  let writer:Promise<unknown>|undefined;
  try {writer=confirmUtilityRun(f.session,f.run);await waitBlockedBy(pid);await scan.query("BEGIN");await scan.query("SET LOCAL ROLE service_role");await assert.rejects(scanRentSourcesUnderFence(scan,ORG_ID,f.lease,f.period.start,f.period.end),(error:unknown)=>(error as {code?:string}).code==="55P03");await scan.query("ROLLBACK");assert.deepEqual(await utilityState(f.run,f.invoice),before);
    await gate.query(`SELECT pg_advisory_unlock($1::bigint)`,[key]);await writer;assert.notDeepEqual(await utilityState(f.run,f.invoice),before);
  } finally {await scan.query("ROLLBACK").catch(()=>{});await gate.query(`SELECT pg_advisory_unlock($1::bigint)`,[key]).catch(()=>{});await Promise.allSettled(writer?[writer]:[]);await db.query(`DROP TRIGGER b011_utility_pause ON public.invoice_lines`);await db.query(`DROP FUNCTION app.b011_utility_pause()`);await gate.end();await scan.end();}
});
async function paymentState(lease:string,invoice:string) {
  return (await db.query(`SELECT (SELECT to_jsonb(i) FROM invoices i WHERE i.id=$2) AS invoice,(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]'::jsonb) FROM payments p WHERE p.lease_id=$1) AS payments,(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM payment_allocations a JOIN payments p ON p.id=a.payment_id WHERE p.lease_id=$1) AS allocations,(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM ledger_transactions t WHERE t.lease_id=$1) AS ledgers,(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id),'[]'::jsonb) FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.transaction_id WHERE t.lease_id=$1) AS ledger_entries,(SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]'::jsonb) FROM invoice_lines l WHERE l.invoice_id=$2) AS invoice_lines`,[lease,invoice])).rows[0];
}
test("scanner-first fences the actual payment confirmation until release",async()=>{
  const f=await utilityFixture(),before=await paymentState(f.lease,f.invoice),scan=new Client({connectionString:withDatabase(source,name)});await scan.connect();let writer:Promise<unknown>|undefined;
  try {await scan.query("BEGIN");await scan.query("SET LOCAL ROLE service_role");const old=await scanRentSourcesUnderFence(scan,ORG_ID,f.lease,f.period.start,f.period.end);const pid=(await scan.query<{pid:number}>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
    writer=recordPayment(f.session,{leaseId:f.lease,amountMajor:100,paidOn:f.period.start,last5:"12345",reference:"Synthetic fence payment"});await waitBlockedBy(pid);assert.deepEqual(await paymentState(f.lease,f.invoice),before);
    await scan.query("COMMIT");await writer;const after=await paymentState(f.lease,f.invoice);assert.notDeepEqual(after,before);
    await scan.query("BEGIN");await scan.query("SET LOCAL ROLE service_role");const now=await scanRentSourcesUnderFence(scan,ORG_ID,f.lease,f.period.start,f.period.end);await scan.query("COMMIT");assert.notEqual(JSON.stringify(old),JSON.stringify(now));
  } finally {await scan.query("ROLLBACK").catch(()=>{});await Promise.allSettled(writer?[writer]:[]);await scan.end();}
});
test("payment-first causes scanner NOWAIT rejection without altering writer state",async()=>{
  const f=await utilityFixture(),before=await paymentState(f.lease,f.invoice),gate=new Client({connectionString:withDatabase(source,name)}),scan=new Client({connectionString:withDatabase(source,name)});await gate.connect();await scan.connect();
  const key=BigInt(`0x${randomBytes(7).toString("hex")}`).toString(),pid=(await gate.query<{pid:number}>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;await gate.query(`SELECT pg_advisory_lock($1::bigint)`,[key]);
  await db.query(`CREATE FUNCTION app.b011_payment_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.invoice_id='${f.invoice}'::uuid THEN PERFORM pg_advisory_xact_lock(${key}::bigint); END IF; RETURN NEW; END $$`);await db.query(`CREATE TRIGGER b011_payment_pause AFTER INSERT ON public.payment_allocations FOR EACH ROW EXECUTE FUNCTION app.b011_payment_pause()`);
  let writer:Promise<unknown>|undefined;
  try {writer=recordPayment(f.session,{leaseId:f.lease,amountMajor:100,paidOn:f.period.start,last5:"12345",reference:"Synthetic fence payment"});await waitBlockedBy(pid);await scan.query("BEGIN");await scan.query("SET LOCAL ROLE service_role");await assert.rejects(scanRentSourcesUnderFence(scan,ORG_ID,f.lease,f.period.start,f.period.end),(error:unknown)=>(error as {code?:string}).code==="55P03");await scan.query("ROLLBACK");assert.deepEqual(await paymentState(f.lease,f.invoice),before);
    await gate.query(`SELECT pg_advisory_unlock($1::bigint)`,[key]);await writer;assert.notDeepEqual(await paymentState(f.lease,f.invoice),before);
  } finally {await scan.query("ROLLBACK").catch(()=>{});await gate.query(`SELECT pg_advisory_unlock($1::bigint)`,[key]).catch(()=>{});await Promise.allSettled(writer?[writer]:[]);await db.query(`DROP TRIGGER b011_payment_pause ON public.payment_allocations`);await db.query(`DROP FUNCTION app.b011_payment_pause()`);await gate.end();await scan.end();}
});
async function submittedPayment(f:Awaited<ReturnType<typeof utilityFixture>>) {
  return (await db.query<{id:string}>(`INSERT INTO payments(org_id,property_id,lease_id,payer_contact_id,currency,amount_minor,paid_on,method,status,source,submitted_by) VALUES($1,$2,$3,$4,'TWD',10000,$5,'bank_transfer','submitted','tenant_portal',$6) RETURNING id`,[ORG_ID,f.property,f.lease,f.contact,f.period.start,USERS.admin])).rows[0].id;
}
test("scanner-first fences actual confirmation of a submitted payment",async()=>{
  const f=await utilityFixture(),payment=await submittedPayment(f),before=await paymentState(f.lease,f.invoice),scan=new Client({connectionString:withDatabase(source,name)});await scan.connect();let writer:Promise<unknown>|undefined;
  try {await scan.query("BEGIN");await scan.query("SET LOCAL ROLE service_role");const old=await scanRentSourcesUnderFence(scan,ORG_ID,f.lease,f.period.start,f.period.end);const pid=(await scan.query<{pid:number}>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
    writer=confirmPayment(f.session,payment);await waitBlockedBy(pid);assert.deepEqual(await paymentState(f.lease,f.invoice),before);
    await scan.query("COMMIT");await writer;const after=await paymentState(f.lease,f.invoice);assert.notDeepEqual(after,before);
    assert.equal((await db.query<{status:string}>(`SELECT status::text FROM payments WHERE id=$1`,[payment])).rows[0].status,"confirmed");
    await scan.query("BEGIN");await scan.query("SET LOCAL ROLE service_role");const now=await scanRentSourcesUnderFence(scan,ORG_ID,f.lease,f.period.start,f.period.end);await scan.query("COMMIT");assert.notEqual(JSON.stringify(old),JSON.stringify(now));
  } finally {await scan.query("ROLLBACK").catch(()=>{});await Promise.allSettled(writer?[writer]:[]);await scan.end();}
});
test("submitted-payment confirmation first makes scanner reject NOWAIT",async()=>{
  const f=await utilityFixture(),payment=await submittedPayment(f),before=await paymentState(f.lease,f.invoice),gate=new Client({connectionString:withDatabase(source,name)}),scan=new Client({connectionString:withDatabase(source,name)});await gate.connect();await scan.connect();
  const key=BigInt(`0x${randomBytes(7).toString("hex")}`).toString(),pid=(await gate.query<{pid:number}>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;await gate.query(`SELECT pg_advisory_lock($1::bigint)`,[key]);
  await db.query(`CREATE FUNCTION app.b011_confirm_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.payment_id='${payment}'::uuid THEN PERFORM pg_advisory_xact_lock(${key}::bigint); END IF; RETURN NEW; END $$`);await db.query(`CREATE TRIGGER b011_confirm_pause AFTER INSERT ON public.payment_allocations FOR EACH ROW EXECUTE FUNCTION app.b011_confirm_pause()`);
  let writer:Promise<unknown>|undefined;
  try {writer=confirmPayment(f.session,payment);await waitBlockedBy(pid);await scan.query("BEGIN");await scan.query("SET LOCAL ROLE service_role");await assert.rejects(scanRentSourcesUnderFence(scan,ORG_ID,f.lease,f.period.start,f.period.end),(error:unknown)=>(error as {code?:string}).code==="55P03");await scan.query("ROLLBACK");assert.deepEqual(await paymentState(f.lease,f.invoice),before);
    await gate.query(`SELECT pg_advisory_unlock($1::bigint)`,[key]);await writer;assert.notDeepEqual(await paymentState(f.lease,f.invoice),before);assert.equal((await db.query<{status:string}>(`SELECT status::text FROM payments WHERE id=$1`,[payment])).rows[0].status,"confirmed");
  } finally {await scan.query("ROLLBACK").catch(()=>{});await gate.query(`SELECT pg_advisory_unlock($1::bigint)`,[key]).catch(()=>{});await Promise.allSettled(writer?[writer]:[]);await db.query(`DROP TRIGGER b011_confirm_pause ON public.payment_allocations`);await db.query(`DROP FUNCTION app.b011_confirm_pause()`);await gate.end();await scan.end();}
});
test("OFF-to-ON source scan sees actual historical lines and makes no financial changes",async()=>{
  const f=await utilityFixture();const flag=(await db.query<{value:unknown}>(`SELECT value FROM platform_settings WHERE key='deposit_settlements'`)).rows[0].value;
  const org=(await db.query<{feature_flags:unknown}>(`SELECT feature_flags FROM organizations WHERE id=$1`,[ORG_ID])).rows[0].feature_flags;
  try {
    await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"deposit_settlements":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    await db.query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key='deposit_settlements'`);
    await assert.rejects(svc(f.session.userId,client=>settlementAccess(client,f.session,f.lease,"read")),(error:unknown)=>error instanceof FlowError&&error.key==="errors.notFound");
    const historical=(await db.query<{id:string}>(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,quantity,unit_amount_minor,amount_minor) VALUES($1,$2,2,'adjustment','Synthetic while disabled',1,-100,-100) RETURNING id`,[ORG_ID,f.invoice])).rows[0].id;
    const before=await paymentState(f.lease,f.invoice);
    await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='deposit_settlements'`,[ORG_ID]);
    const snapshot=await svc(f.session.userId,async client=>{await settlementAccess(client,f.session,f.lease,"read");return scanRentSourcesUnderFence(client,ORG_ID,f.lease,f.period.start,f.period.end);});
    assert.ok(snapshot.lines.some(line=>line.id===historical));assert.equal(snapshot.authoritative,false);assert.deepEqual(await paymentState(f.lease,f.invoice),before);
  } finally {await db.query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='deposit_settlements'`,[JSON.stringify(flag)]);await db.query(`UPDATE organizations SET feature_flags=$2::jsonb WHERE id=$1`,[ORG_ID,JSON.stringify(org)]);}
});
