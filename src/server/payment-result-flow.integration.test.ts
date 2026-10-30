import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { ORG_ID, USERS } from "./ids";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { approveMatch, confirmPayment, recordPayment, rejectPayment, reversePayment } from "./domain";
import { decideBankMatch } from "./bank-matching";
import type { Session } from "./types";
import { paymentRequestEnabled, paymentRequestStatus } from "./payment-request-status";

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>;
test.before(async()=>{clone=await cloneTestDatabase();});
test.after(async()=>{await clone.cleanup();});

test("ON manager entry is request-bound and confirmation/rejection/reversal emit atomically",async()=>{
  const c=new Client({connectionString:process.env.DATABASE_URL}); await c.connect();
  try {
    const sid=randomUUID();
    await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.manager,randomUUID()]);
    await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"payment_results_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='payment_results_v2'`,[ORG_ID]);
    const lease=(await c.query<{id:string;property_id:string;currency:string;contact_id:string}>(`SELECT l.id::text,l.property_id::text,l.currency,lp.contact_id::text FROM leases l JOIN lease_parties lp ON lp.lease_id=l.id AND lp.role='primary' WHERE l.org_id=$1 AND EXISTS (SELECT 1 FROM invoices i WHERE i.lease_id=l.id AND i.status IN ('open','partially_paid') AND i.balance_minor>=10000) LIMIT 1`,[ORG_ID])).rows[0]; assert.ok(lease);
    const manager:Session={userId:USERS.manager,orgId:ORG_ID,liveOrgId:ORG_ID,sessionId:sid,kind:'staff',role:'manager',environment:'live',locale:'en',calendar:'gregorian',leaseId:null,email:'synthetic@example.test',name:'Synthetic'};
    const input={leaseId:lease.id,amountMajor:10,paidOn:'2026-10-30',last5:'12345',reference:'synthetic',requestId:randomUUID()};
    const prior=(await c.query<{n:string}>(`SELECT count(*)::text AS n FROM notifications WHERE lease_id=$1 AND event_type='payment_confirmed'`,[lease.id])).rows[0].n;
    const [first,replay,third]=await Promise.all([recordPayment(manager,input),recordPayment(manager,input),recordPayment(manager,input)]);
    assert.equal(first.paymentId,replay.paymentId); assert.equal(first.paymentId,third.paymentId);
    await assert.rejects(recordPayment(manager,{...input,amountMajor:11}));
    await assert.rejects(recordPayment(manager,{...input,requestId:undefined}));
    assert.equal((await c.query(`SELECT 1 FROM app.b010_source_events WHERE payment_id=$1 AND kind='payment_confirmed' AND actor_id=$2`,[first.paymentId,USERS.manager])).rowCount,1);
    await c.query("BEGIN"); await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.manager]); await c.query("SET LOCAL ROLE authenticated");
    assert.equal((await c.query<{status:string}>(`SELECT app.b010_payment_command_status($1,$1,'live',$2,$3,'manager',$4) AS status`,[ORG_ID,sid,lease.id,input.requestId])).rows[0].status,'recorded');
    assert.equal((await c.query<{status:string}>(`SELECT app.b010_payment_command_status($1,$1,'live',$2,$3,'manager',$4) AS status`,[ORG_ID,sid,lease.id,randomUUID()])).rows[0].status,'unknown');
    await c.query("ROLLBACK");
    assert.equal((await c.query<{n:string}>(`SELECT count(*)::text AS n FROM notifications WHERE lease_id=$1 AND event_type='payment_confirmed'`,[lease.id])).rows[0].n,prior);
    const snapshot=async()=> (await c.query(`SELECT (SELECT count(*) FROM payments WHERE lease_id=$1)::text AS payments,
      (SELECT count(*) FROM ledger_transactions WHERE lease_id=$1)::text AS ledger,
      (SELECT coalesce(sum(balance_minor),0)::text FROM invoices WHERE lease_id=$1) AS balance,
      (SELECT count(*) FROM app.b010_source_events WHERE lease_id=$1)::text AS events`,[lease.id])).rows[0];
    const before=await snapshot();
    await c.query(`CREATE FUNCTION app.b010_synthetic_event_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic event fault'; END $$`);
    await c.query(`CREATE TRIGGER b010_synthetic_event_fault BEFORE INSERT ON app.b010_source_events FOR EACH ROW EXECUTE FUNCTION app.b010_synthetic_event_fault()`);
    try { await assert.rejects(recordPayment(manager,{...input,requestId:randomUUID()})); }
    finally { await c.query(`DROP TRIGGER b010_synthetic_event_fault ON app.b010_source_events`); await c.query(`DROP FUNCTION app.b010_synthetic_event_fault()`); }
    assert.deepEqual(await snapshot(),before);
    const makeSubmitted=async()=> (await c.query<{id:string}>(`INSERT INTO payments(org_id,property_id,lease_id,payer_contact_id,currency,amount_minor,paid_on,method,status,source,submitted_by) VALUES ($1,$2,$3,$4,$5,1000,'2026-10-30','bank_transfer','submitted','tenant_portal',$6) RETURNING id::text`,[ORG_ID,lease.property_id,lease.id,lease.contact_id,lease.currency,USERS.tenant])).rows[0].id;
    const confirmed=await makeSubmitted();
    await confirmPayment(manager,confirmed); await confirmPayment(manager,confirmed);
    assert.equal((await c.query(`SELECT 1 FROM app.b010_source_events WHERE payment_id=$1 AND kind='payment_confirmed'`,[confirmed])).rowCount,1);
    const rejected=await makeSubmitted(); await rejectPayment(manager,rejected,'Synthetic reason');
    assert.equal((await c.query(`SELECT 1 FROM app.b010_source_events WHERE payment_id=$1 AND kind='payment_rejected'`,[rejected])).rowCount,1);
    const adminSid=randomUUID(); await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,clock_timestamp()+interval '1 hour')`,[adminSid,USERS.admin,randomUUID()]);
    const admin:Session={...manager,userId:USERS.admin,role:'admin',sessionId:adminSid};
    await reversePayment(admin,confirmed,'Synthetic correction');
    assert.equal((await c.query(`SELECT 1 FROM app.b010_source_events WHERE payment_id=$1 AND kind='payment_reversed'`,[confirmed])).rowCount,1);
    assert.equal((await c.query(`SELECT 1 FROM payments WHERE id=$1 AND status='reversed'`,[confirmed])).rowCount,1);
  } finally { await c.end(); }
});


test("both bank paths emit only on a submitted-to-confirmed transition",async()=>{
  const c=new Client({connectionString:process.env.DATABASE_URL}); await c.connect();
  try {
    const sid=randomUUID();
    await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
    await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"payment_results_v2":true,"bank_matching":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key IN ('payment_results_v2','bank_matching')`,[ORG_ID]);
    const lease=(await c.query<{id:string;property_id:string;currency:string;contact_id:string}>(`SELECT l.id::text,l.property_id::text,l.currency,lp.contact_id::text FROM leases l JOIN lease_parties lp ON lp.lease_id=l.id AND lp.role='primary' WHERE l.org_id=$1 AND EXISTS (SELECT 1 FROM invoices i WHERE i.lease_id=l.id AND i.status IN ('open','partially_paid') AND i.balance_minor>=10000) LIMIT 1`,[ORG_ID])).rows[0]; assert.ok(lease);
    const admin:Session={userId:USERS.admin,orgId:ORG_ID,liveOrgId:ORG_ID,sessionId:sid,kind:'staff',role:'admin',environment:'live',locale:'en',calendar:'gregorian',leaseId:null,email:'synthetic@example.test',name:'Synthetic'};
    const account=(await c.query<{id:string}>(`INSERT INTO bank_accounts(org_id,property_id,nickname,bank_name,currency) VALUES ($1,$2,'Synthetic','Synthetic',$3) RETURNING id::text`,[ORG_ID,lease.property_id,lease.currency])).rows[0].id;
    const makePair=async(existing?:string)=>{
      const payment=existing ?? (await c.query<{id:string}>(`INSERT INTO payments(org_id,property_id,lease_id,payer_contact_id,currency,amount_minor,paid_on,method,status,source,submitted_by) VALUES ($1,$2,$3,$4,$5,1000,'2026-10-30','bank_transfer','submitted','tenant_portal',$6) RETURNING id::text`,[ORG_ID,lease.property_id,lease.id,lease.contact_id,lease.currency,USERS.tenant])).rows[0].id;
      const file=(await c.query<{id:string}>(`INSERT INTO files(org_id,storage_bucket,storage_path,file_name,mime_type,size_bytes,uploaded_by) VALUES ($1,'bank-imports',$2,'synthetic.csv','text/csv',1,$3) RETURNING id::text`,[ORG_ID,randomUUID(),USERS.admin])).rows[0].id;
      const imported=(await c.query<{id:string}>(`INSERT INTO bank_statement_imports(org_id,bank_account_id,file_id,status,uploaded_by) VALUES ($1,$2,$3,'completed',$4) RETURNING id::text`,[ORG_ID,account,file,USERS.admin])).rows[0].id;
      const bank=(await c.query<{id:string}>(`INSERT INTO bank_transactions(org_id,bank_account_id,import_id,row_number,posted_on,amount_minor,currency,raw,dedupe_hash,status) VALUES ($1,$2,$3,1,'2026-10-30',1000,$4,'{}'::jsonb,$5,'suggested') RETURNING id::text`,[ORG_ID,account,imported,lease.currency,randomUUID()])).rows[0].id;
      const suggestion=(await c.query<{id:string}>(`INSERT INTO bank_match_suggestions(org_id,bank_transaction_id,payment_id,score,reasons,status) VALUES ($1,$2,$3,1,'{}'::jsonb,'suggested') RETURNING id::text`,[ORG_ID,bank,payment])).rows[0].id;
      return {payment,bank,suggestion};
    };
    const first=await makePair();
    assert.equal(await decideBankMatch(admin,{bankId:first.bank,suggestionId:first.suggestion,decision:'match',reason:'Synthetic'}),true);
    assert.equal((await c.query(`SELECT 1 FROM app.b010_source_events WHERE payment_id=$1 AND kind='payment_confirmed' AND actor_id=$2`,[first.payment,USERS.admin])).rowCount,1);
    const already=await recordPayment(admin,{leaseId:lease.id,amountMajor:10,paidOn:'2026-10-30',last5:'12345',reference:'Synthetic',requestId:randomUUID()});
    const link=await makePair(already.paymentId);
    assert.equal(await decideBankMatch(admin,{bankId:link.bank,suggestionId:link.suggestion,decision:'match',reason:'Synthetic'}),true);
    assert.equal((await c.query(`SELECT 1 FROM app.b010_source_events WHERE payment_id=$1 AND kind='payment_confirmed'`,[already.paymentId])).rowCount,1);
    const racedMatch=await makePair();
    const raceResults=await Promise.allSettled([confirmPayment(admin,racedMatch.payment),decideBankMatch(admin,{bankId:racedMatch.bank,suggestionId:racedMatch.suggestion,decision:'match',reason:'Synthetic'})]);
    assert.ok(raceResults.some(item=>item.status==='fulfilled'));
    assert.equal((await c.query(`SELECT 1 FROM app.b010_source_events WHERE payment_id=$1 AND kind='payment_confirmed'`,[racedMatch.payment])).rowCount,1);
    assert.equal((await c.query(`SELECT 1 FROM ledger_transactions WHERE source_table='payments' AND source_id=$1 AND kind='payment'`,[racedMatch.payment])).rowCount,1);
    const rejected=await makePair();
    assert.equal(await decideBankMatch(admin,{bankId:rejected.bank,suggestionId:rejected.suggestion,decision:'reject',reason:'Synthetic'}),true);
    assert.equal((await c.query(`SELECT 1 FROM app.b010_source_events WHERE payment_id=$1`,[rejected.payment])).rowCount,0);
    await c.query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}' WHERE key='bank_matching'`);
    const legacy=await makePair();
    await approveMatch(admin,legacy.suggestion);
    assert.equal((await c.query(`SELECT 1 FROM app.b010_source_events WHERE payment_id=$1 AND kind='payment_confirmed'`,[legacy.payment])).rowCount,1);
    const raced=await makePair(), replacement=await makePair();
    const holder=new Client({connectionString:process.env.DATABASE_URL}); await holder.connect();
    try {
      await holder.query("BEGIN"); await holder.query(`SELECT 1 FROM bank_transactions WHERE id=$1 FOR UPDATE`,[raced.bank]);
      const holderPid=(await holder.query<{pid:number}>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
      const pending=approveMatch(admin,raced.suggestion);
      const outcome=pending.then(()=>"resolved",()=>"rejected");
      const deadline=Date.now()+5000; let blocked=false;
      while (Date.now()<deadline) {
        blocked=(await c.query<{ok:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS ok`,[holderPid])).rows[0].ok;
        if (blocked) break;
        await new Promise(r=>setTimeout(r,10));
      }
      assert.equal(blocked,true);
      await c.query(`UPDATE bank_match_suggestions SET payment_id=$2 WHERE id=$1`,[raced.suggestion,replacement.payment]);
      await holder.query("COMMIT");
      assert.equal(await outcome,"rejected");
      assert.equal((await c.query(`SELECT 1 FROM app.b010_source_events WHERE payment_id IN ($1,$2)`,[raced.payment,replacement.payment])).rowCount,0);
      assert.equal((await c.query(`SELECT 1 FROM payment_allocations WHERE payment_id IN ($1,$2)`,[raced.payment,replacement.payment])).rowCount,0);
    } finally { await holder.end(); }
  } finally { await c.end(); }
});


test("expired manager session while waiting for invoice cannot record a payment",async()=>{
  const c=new Client({connectionString:process.env.DATABASE_URL}),holder=new Client({connectionString:process.env.DATABASE_URL});
  await c.connect(); await holder.connect();
  try {
    const sid=randomUUID(),requestId=randomUUID();
    await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,clock_timestamp()+interval '2 seconds')`,[sid,USERS.manager,randomUUID()]);
    await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"payment_results_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='payment_results_v2'`,[ORG_ID]);
    const invoice=(await c.query<{id:string;lease_id:string}>(`SELECT id::text,lease_id::text FROM invoices WHERE org_id=$1 AND status IN ('open','partially_paid') AND balance_minor>1000 ORDER BY id LIMIT 1`,[ORG_ID])).rows[0]; assert.ok(invoice);
    const session:Session={userId:USERS.manager,orgId:ORG_ID,liveOrgId:ORG_ID,sessionId:sid,kind:'staff',role:'manager',environment:'live',locale:'en',calendar:'gregorian',leaseId:null,email:'synthetic@example.test',name:'Synthetic'};
    await holder.query("BEGIN"); await holder.query(`SELECT id FROM invoices WHERE id=$1 FOR UPDATE`,[invoice.id]);
    const pid=(await holder.query<{pid:number}>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
    const pending=recordPayment(session,{leaseId:invoice.lease_id,amountMajor:10,paidOn:'2026-10-30',last5:'12345',reference:'synthetic',requestId});
    const outcome=pending.then(()=>"resolved",()=>"rejected");
    const deadline=Date.now()+3000; let blocked=false;
    while (Date.now()<deadline) {
      blocked=(await c.query<{ok:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS ok`,[pid])).rows[0].ok;
      if (blocked) break; await new Promise(r=>setTimeout(r,10));
    }
    assert.equal(blocked,true);
    await new Promise(r=>setTimeout(r,2200));
    await holder.query("COMMIT"); assert.equal(await outcome,"rejected");
    assert.equal((await c.query(`SELECT 1 FROM app.b010_payment_commands WHERE org_id=$1 AND actor_id=$2 AND request_id=$3`,[ORG_ID,USERS.manager,requestId])).rowCount,0);
  } finally {await holder.end(); await c.end();}
});


test("accountant can record and reverse under ON without configuration write access",async()=>{
  const c=new Client({connectionString:process.env.DATABASE_URL}); await c.connect();
  try {
    const sid=randomUUID();
    await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.accountant,randomUUID()]);
    await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"payment_results_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='payment_results_v2'`,[ORG_ID]);
    const lease=(await c.query<{id:string}>(`SELECT l.id::text FROM leases l JOIN lease_parties lp ON lp.lease_id=l.id AND lp.role='primary' WHERE l.org_id=$1 AND EXISTS (SELECT 1 FROM invoices i WHERE i.lease_id=l.id AND i.status IN ('open','partially_paid') AND i.balance_minor>1000) LIMIT 1`,[ORG_ID])).rows[0]; assert.ok(lease);
    const session:Session={userId:USERS.accountant,orgId:ORG_ID,liveOrgId:ORG_ID,sessionId:sid,kind:'staff',role:'accountant',environment:'live',locale:'en',calendar:'gregorian',leaseId:null,email:'synthetic@example.test',name:'Synthetic'};
    const requestId=randomUUID();
    assert.equal(await paymentRequestEnabled(session),true);
    assert.equal(await paymentRequestStatus(session,lease.id,requestId),'unknown');
    const result=await recordPayment(session,{leaseId:lease.id,amountMajor:10,paidOn:'2026-10-30',last5:'12345',reference:'synthetic',requestId});
    assert.equal(await paymentRequestStatus(session,lease.id,requestId),'recorded');
    await assert.rejects(paymentRequestStatus({...session,role:'maintenance'},lease.id,requestId));
    await assert.rejects(paymentRequestStatus({...session,kind:'tenant'},lease.id,requestId));
    await assert.rejects(paymentRequestStatus({...session,orgId:randomUUID()},lease.id,requestId));
    await reversePayment(session,result.paymentId,'Synthetic correction');
    assert.equal(await paymentRequestStatus(session,lease.id,requestId),'recorded');
    assert.equal((await c.query(`SELECT 1 FROM app.b010_source_events WHERE payment_id=$1 AND kind='payment_confirmed' AND actor_id=$2`,[result.paymentId,USERS.accountant])).rowCount,1);
    assert.equal((await c.query(`SELECT 1 FROM app.b010_source_events WHERE payment_id=$1 AND kind='payment_reversed' AND actor_id=$2`,[result.paymentId,USERS.accountant])).rowCount,1);
  } finally {await c.end();}
});


test("concurrent reversal attempts preserve one original and one reversal event",async()=>{
  const c=new Client({connectionString:process.env.DATABASE_URL}); await c.connect();
  try {
    const sid=randomUUID();
    await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
    await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"payment_results_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='payment_results_v2'`,[ORG_ID]);
    const lease=(await c.query<{id:string}>(`SELECT l.id::text FROM leases l JOIN lease_parties lp ON lp.lease_id=l.id AND lp.role='primary' WHERE l.org_id=$1 AND EXISTS (SELECT 1 FROM invoices i WHERE i.lease_id=l.id AND i.status IN ('open','partially_paid') AND i.balance_minor>1000) LIMIT 1`,[ORG_ID])).rows[0]; assert.ok(lease);
    const session:Session={userId:USERS.admin,orgId:ORG_ID,liveOrgId:ORG_ID,sessionId:sid,kind:'staff',role:'admin',environment:'live',locale:'en',calendar:'gregorian',leaseId:null,email:'synthetic@example.test',name:'Synthetic'};
    const payment=await recordPayment(session,{leaseId:lease.id,amountMajor:10,paidOn:'2026-10-30',last5:'12345',reference:'synthetic',requestId:randomUUID()});
    const outcomes=await Promise.allSettled([reversePayment(session,payment.paymentId,'First synthetic reversal'),reversePayment(session,payment.paymentId,'Second synthetic reversal')]);
    assert.equal(outcomes.filter(item=>item.status==='fulfilled').length,1);
    assert.equal((await c.query(`SELECT 1 FROM app.b010_source_events WHERE payment_id=$1 AND kind='payment_reversed'`,[payment.paymentId])).rowCount,1);
    assert.equal((await c.query(`SELECT 1 FROM ledger_transactions r JOIN payments p ON p.ledger_transaction_id=r.reverses_transaction_id WHERE p.id=$1 AND r.kind='reversal'`,[payment.paymentId])).rowCount,1);
  } finally {await c.end();}
});
