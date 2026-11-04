import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { ORG_ID, USERS } from "./ids";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { approveMatch,confirmPayment,recordPayment,rejectPayment,reversePayment } from "./domain";
import { decideBankMatch } from "./bank-matching";
import { centerSessionItems } from "./notification-center";
import { beginPaymentCenter } from "./payment-center-events";
import type { Session } from "./types";

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone:Awaited<ReturnType<typeof cloneTestDatabase>>;
test.before(async()=>{clone=await cloneTestDatabase();});
test.after(async()=>{await clone.cleanup();});
async function setup(c:Client,results:boolean,center=true) {
  await c.query(`UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object('notification_center_v2',$2::boolean,'payment_results_v2',$3::boolean,'bank_matching',true) WHERE id=$1`,[ORG_ID,center,results]);
  for (const [key,on] of [["notification_center_v2",center],["payment_results_v2",results],["bank_matching",true]] as const) await c.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',$2::boolean,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key=$3`,[ORG_ID,on,key]);
  const sid=randomUUID();
  await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
  const session:Session={userId:USERS.admin,sessionId:sid,kind:"staff",role:"admin",orgId:ORG_ID,liveOrgId:ORG_ID,environment:"live",locale:"en",calendar:"gregorian",leaseId:null,email:"synthetic@example.test",name:"Synthetic"};
  const payer=(await c.query<{id:string}>(`SELECT id::text FROM contacts WHERE org_id=$1 AND user_id=$2 AND is_tenant AND archived_at IS NULL`,[ORG_ID,USERS.tenant])).rows[0];assert.ok(payer);
  const property=(await c.query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,'B010 synthetic','TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID])).rows[0].id;
  const unit=(await c.query<{id:string}>(`INSERT INTO units(org_id,property_id,label) VALUES($1,$2,'B010') RETURNING id::text`,[ORG_ID,property])).rows[0].id;
  const lease={id:(await c.query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor) VALUES($1,$2,$3,$3,'active','2026-01-01','TWD',0) RETURNING id::text`,[ORG_ID,property,unit])).rows[0].id,property,currency:"TWD",payer:payer.id,principal:USERS.tenant};
  await c.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')`,[ORG_ID,lease.id,lease.payer]);
  const invoice=(await c.query<{id:string}>(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date,status,total_minor) VALUES($1,$2,$3,$4,'TWD','2026-11-01','open',100000) RETURNING id::text`,[ORG_ID,property,lease.id,`B010-${randomUUID()}`])).rows[0].id;
  await c.query(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,quantity,unit_amount_minor,amount_minor) VALUES($1,$2,1,'rent','Synthetic',1,100000,100000)`,[ORG_ID,invoice]);
  const submitted=async(payer:string|null=lease.payer)=>(await c.query<{id:string}>(`INSERT INTO payments(org_id,property_id,lease_id,payer_contact_id,currency,amount_minor,paid_on,method,status,source,submitted_by) VALUES($1,$2,$3,$4,$5,100,'2026-11-01','bank_transfer','submitted','tenant_portal',$6) RETURNING id::text`,[ORG_ID,lease.property,lease.id,payer,lease.currency,lease.principal])).rows[0].id;
  const pair=async(existing?:string)=>{
    const payment=existing ?? await submitted();
    const account=(await c.query<{id:string}>(`INSERT INTO bank_accounts(org_id,nickname,bank_name,currency) VALUES($1,'Synthetic','Synthetic',$2) RETURNING id::text`,[ORG_ID,lease.currency])).rows[0].id;
    const file=(await c.query<{id:string}>(`INSERT INTO files(org_id,storage_bucket,storage_path,file_name,mime_type,size_bytes,uploaded_by) VALUES($1,'bank-imports',$2,'synthetic.csv','text/csv',1,$3) RETURNING id::text`,[ORG_ID,randomUUID(),session.userId])).rows[0].id;
    const imported=(await c.query<{id:string}>(`INSERT INTO bank_statement_imports(org_id,bank_account_id,file_id,status,uploaded_by) VALUES($1,$2,$3,'completed',$4) RETURNING id::text`,[ORG_ID,account,file,session.userId])).rows[0].id;
    const bank=(await c.query<{id:string}>(`INSERT INTO bank_transactions(org_id,bank_account_id,import_id,row_number,posted_on,amount_minor,currency,raw,dedupe_hash,status) VALUES($1,$2,$3,1,'2026-11-01',100,$4,'{}'::jsonb,$5,'suggested') RETURNING id::text`,[ORG_ID,account,imported,lease.currency,randomUUID()])).rows[0].id;
    const suggestion=(await c.query<{id:string}>(`INSERT INTO bank_match_suggestions(org_id,bank_transaction_id,payment_id,score,reasons,status) VALUES($1,$2,$3,1,'{}'::jsonb,'suggested') RETURNING id::text`,[ORG_ID,bank,payment])).rows[0].id;
    return {payment,bank,suggestion};
  };
  const check=async(payment:string,kind:string,recipients=1)=>{
    const rows=(await c.query(`SELECT n.kind,n.occurrence_key,n.actor_id::text,n.payer_contact_id::text,n.payer_principal_user_id::text,e.b010_event_id,e.occurred_at=n.occurred_at AS same_time,count(r.id)::int AS recipients,min(r.contact_id::text) AS recipient,min(r.principal_user_id::text) AS principal FROM app.b017_occurrences n JOIN app.b028_center_events e ON e.org_id=n.org_id AND e.neutral_source_id=n.id LEFT JOIN app.b028_center_recipients r ON r.org_id=e.org_id AND r.event_id=e.id WHERE n.org_id=$1 AND n.payment_id=$2 AND n.kind=$3 GROUP BY n.id,e.id`,[ORG_ID,payment,kind])).rows;
    assert.equal(rows.length,1);assert.equal(rows[0].kind,kind);assert.equal(rows[0].occurrence_key,kind);assert.equal(rows[0].actor_id,session.userId);assert.equal(rows[0].b010_event_id,null);assert.equal(rows[0].same_time,true);assert.equal(rows[0].recipients,recipients);
    if(recipients) {assert.equal(rows[0].recipient,lease.payer);assert.equal(rows[0].principal,lease.principal);}
    const old=(await c.query(`SELECT b.id FROM app.b010_source_events b JOIN app.b017_occurrences n ON n.org_id=b.org_id AND n.payment_id=b.payment_id AND n.kind=b.kind AND n.occurred_at=b.created_at WHERE b.payment_id=$1 AND b.kind=$2`,[payment,kind])).rowCount;
    assert.equal(old,results ? 1 : 0);
  };
  return {session,lease,submitted,pair,check};
}
for(const results of [false,true]) test(`six real payment paths reach only the payer; payment results ${results}`,async()=>{
  const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
  try {
    const {session,lease,submitted,pair,check}=await setup(c,results);
    const confirmed=await submitted();await confirmPayment(session,confirmed);await check(confirmed,"payment_confirmed");await confirmPayment(session,confirmed);await check(confirmed,"payment_confirmed");
    const rejected=await submitted();await rejectPayment(session,rejected,"Synthetic reason");await check(rejected,"payment_rejected");
    await reversePayment(session,confirmed,"Synthetic reversal");await check(confirmed,"payment_reversed");
    assert.equal((await c.query(`SELECT 1 FROM ledger_transactions r JOIN payments p ON p.ledger_transaction_id=r.reverses_transaction_id WHERE p.id=$1 AND r.kind='reversal'`,[confirmed])).rowCount,1);
    const input={leaseId:lease.id,amountMajor:1,paidOn:"2026-11-01",last5:"12345",reference:"Synthetic",requestId:randomUUID()};
    const manager=await recordPayment(session,input);await check(manager.paymentId,"payment_confirmed");
    if(results) {assert.equal((await recordPayment(session,input)).paymentId,manager.paymentId);await check(manager.paymentId,"payment_confirmed");}
    const deniedLegacy=await pair();await assert.rejects(approveMatch(session,deniedLegacy.suggestion));assert.equal((await c.query(`SELECT status::text FROM payments WHERE id=$1`,[deniedLegacy.payment])).rows[0].status,"submitted");assert.equal((await c.query(`SELECT 1 FROM app.b017_occurrences WHERE payment_id=$1`,[deniedLegacy.payment])).rowCount,0);
    await c.query(`UPDATE platform_settings SET value=jsonb_set(value,'{enabled}','false'::jsonb) WHERE key='bank_matching'`);
    const legacy=await pair();await approveMatch(session,legacy.suggestion);await check(legacy.payment,"payment_confirmed");
    await c.query(`UPDATE platform_settings SET value=jsonb_set(value,'{enabled}','true'::jsonb) WHERE key='bank_matching'`);
    const enhanced=await pair();await decideBankMatch(session,{bankId:enhanced.bank,suggestionId:enhanced.suggestion,decision:"match",reason:"other"});await check(enhanced.payment,"payment_confirmed");
    const suggestion=await pair();await decideBankMatch(session,{bankId:suggestion.bank,suggestionId:suggestion.suggestion,decision:"reject",reason:"other"});assert.equal((await c.query(`SELECT 1 FROM app.b017_occurrences WHERE payment_id=$1`,[suggestion.payment])).rowCount,0);
    const linked=await pair(manager.paymentId);await decideBankMatch(session,{bankId:linked.bank,suggestionId:linked.suggestion,decision:"match",reason:"other"});await check(manager.paymentId,"payment_confirmed");
    const none=await submitted(null);await confirmPayment(session,none);await check(none,"payment_confirmed",0);
    for(const payment of [manager.paymentId,legacy.payment,enhanced.payment]) {assert.equal((await c.query(`SELECT 1 FROM ledger_transactions WHERE source_table='payments' AND source_id=$1 AND kind='payment'`,[payment])).rowCount,1);assert.equal((await c.query(`SELECT sum(amount_minor)::int AS n FROM payment_allocations WHERE payment_id=$1`,[payment])).rows[0].n,100);}
    const sid=randomUUID();await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,lease.principal,randomUUID()]);
    const tenant:Session={...session,userId:lease.principal,sessionId:sid,kind:"tenant",role:null};
    const list=await centerSessionItems(tenant);const item=list.items.find(x=>x.kind==="payment_confirmed");assert.ok(item);assert.deepEqual(Object.keys(item).sort(),["continuation","kind","occurred_at","read_at","recipient_id"]);assert.ok((await centerSessionItems(tenant,item.recipient_id)).items.some(x=>x.recipient_id===item.recipient_id && x.read_at));
  } finally {await c.end();}
});

test("center OFF remains compatible; historical confirmation cannot backfill; stale sessions fail closed",async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();try{
   const {session,submitted}=await setup(c,false,false);const old=await submitted();await confirmPayment(session,old);assert.equal((await c.query(`SELECT 1 FROM app.b017_occurrences WHERE payment_id=$1`,[old])).rowCount,0);
   await setup(c,false,true);await confirmPayment(session,old);assert.equal((await c.query(`SELECT 1 FROM app.b017_occurrences WHERE payment_id=$1`,[old])).rowCount,0);
   const payment=await submitted();await c.query(`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1`,[session.sessionId]);await assert.rejects(confirmPayment(session,payment));assert.equal((await c.query(`SELECT status::text FROM payments WHERE id=$1`,[payment])).rows[0].status,"submitted");assert.equal((await c.query(`SELECT 1 FROM payment_allocations WHERE payment_id=$1`,[payment])).rowCount,0);
 }finally{await c.end();}
});

test("center failure rolls back payment, allocation and ledger; fixed bridge restores role and JWT",async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();try{
   const {session,lease,submitted}=await setup(c,false);const payment=await submitted();
   await c.query("BEGIN");await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[session.userId]);await c.query("SET LOCAL ROLE authenticated");
   const center=await beginPaymentCenter(c,session,{leaseId:lease.id,paymentId:payment,action:"confirm"});
   assert.deepEqual((await c.query(`SELECT current_user::text AS role,auth.uid()::text AS actor`)).rows[0],{role:"authenticated",actor:session.userId});await c.query("ROLLBACK");void center;
   await c.query(`CREATE FUNCTION app.b010_center_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic center fault'; END $$`);await c.query(`CREATE TRIGGER b010_center_test_fault BEFORE INSERT ON app.b028_center_events FOR EACH ROW EXECUTE FUNCTION app.b010_center_test_fault()`);
   try{await assert.rejects(confirmPayment(session,payment));}finally{await c.query(`DROP TRIGGER b010_center_test_fault ON app.b028_center_events`);await c.query(`DROP FUNCTION app.b010_center_test_fault()`);}
   assert.equal((await c.query(`SELECT status::text FROM payments WHERE id=$1`,[payment])).rows[0].status,"submitted");assert.equal((await c.query(`SELECT 1 FROM payment_allocations WHERE payment_id=$1`,[payment])).rowCount,0);assert.equal((await c.query(`SELECT 1 FROM ledger_transactions WHERE source_table='payments' AND source_id=$1`,[payment])).rowCount,0);assert.equal((await c.query(`SELECT 1 FROM app.b017_occurrences WHERE payment_id=$1`,[payment])).rowCount,0);
   await c.query("BEGIN");const before=(await c.query(`SELECT current_user::text AS role,current_setting('request.jwt.claim.sub',true) AS jwt`)).rows[0];const ownerCenter=await beginPaymentCenter(c,session,{leaseId:lease.id,paymentId:payment,action:"bank_match"});assert.deepEqual((await c.query(`SELECT current_user::text AS role,current_setting('request.jwt.claim.sub',true) AS jwt`)).rows[0],{...before,jwt:before.jwt ?? ""});await c.query("ROLLBACK");void ownerCenter;
 }finally{await c.end();}
});

test("payer identity is frozen; co-tenants, reassignment, other org and ineligible payer never gain a recipient",async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();try{
  const {session,lease,submitted,check}=await setup(c,false);
  const other=(await c.query<{id:string}>(`SELECT id::text FROM contacts WHERE org_id=$1 AND user_id=$2 AND is_tenant AND archived_at IS NULL LIMIT 1`,[ORG_ID,USERS.tenant2])).rows[0];assert.ok(other);
  await c.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'co_tenant') ON CONFLICT DO NOTHING`,[ORG_ID,lease.id,other.id]);
  const payment=await submitted();await confirmPayment(session,payment);await check(payment,"payment_confirmed");
  assert.equal((await c.query(`SELECT 1 FROM app.b028_center_recipients r JOIN app.b028_center_events e ON e.org_id=r.org_id AND e.id=r.event_id JOIN app.b017_occurrences n ON n.org_id=e.org_id AND n.id=e.neutral_source_id WHERE n.payment_id=$1 AND r.contact_id=$2`,[payment,other.id])).rowCount,0);
  const recipient=(await c.query<{id:string}>(`SELECT r.id::text FROM app.b028_center_recipients r JOIN app.b028_center_events e ON e.org_id=r.org_id AND e.id=r.event_id JOIN app.b017_occurrences n ON n.org_id=e.org_id AND n.id=e.neutral_source_id WHERE n.payment_id=$1`,[payment])).rows[0].id;
  const sid=randomUUID();await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.tenant2,randomUUID()]);
  const tenant:Session={...session,userId:USERS.tenant2,sessionId:sid,kind:"tenant",role:null};assert.ok(!(await centerSessionItems(tenant)).items.some(x=>x.recipient_id===recipient));
  const original=(await c.query(`SELECT user_id::text FROM contacts WHERE id=$1`,[lease.payer])).rows[0].user_id;
  await c.query(`UPDATE contacts SET user_id=NULL WHERE id=$1`,[other.id]);
  await c.query(`UPDATE contacts SET user_id=$2 WHERE id=$1`,[lease.payer,USERS.tenant2]);
  try{await confirmPayment(session,payment);assert.ok(!(await centerSessionItems(tenant)).items.some(x=>x.recipient_id===recipient));assert.deepEqual((await centerSessionItems(tenant,recipient)).items,[]);assert.equal((await c.query(`SELECT 1 FROM app.b028_center_reads WHERE recipient_id=$1`,[recipient])).rowCount,0);}finally{await c.query(`UPDATE contacts SET user_id=$2 WHERE id=$1`,[lease.payer,original]);await c.query(`UPDATE contacts SET user_id=$2 WHERE id=$1`,[other.id,USERS.tenant2]);}
  const foreign=await submitted();await assert.rejects(confirmPayment({...session,orgId:randomUUID()},foreign));await assert.rejects(confirmPayment({...session,environment:"sandbox"},foreign));assert.equal((await c.query(`SELECT status::text FROM payments WHERE id=$1`,[foreign])).rows[0].status,"submitted");
  const unbound=(await c.query<{id:string}>(`INSERT INTO contacts(org_id,is_tenant,display_name) VALUES($1,true,'Synthetic unbound') RETURNING id::text`,[ORG_ID])).rows[0].id;
  const noPrincipal=await submitted(unbound);await confirmPayment(session,noPrincipal);await check(noPrincipal,"payment_confirmed",0);
  const spare=randomUUID();await c.query(`INSERT INTO auth.users(id,email) VALUES($1,$2)`,[spare,`synthetic-${spare}@example.test`]);
  const notParty=(await c.query<{id:string}>(`INSERT INTO contacts(org_id,is_tenant,display_name,user_id) VALUES($1,true,'Synthetic non-party',$2) RETURNING id::text`,[ORG_ID,spare])).rows[0].id;
  const noParty=await submitted(notParty);await confirmPayment(session,noParty);await check(noParty,"payment_confirmed",0);
 }finally{await c.end();}
});

test("concurrent confirmation has one source, center, allocation and ledger",async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();try{
  const {session,submitted,check}=await setup(c,false);const payment=await submitted();const results=await Promise.allSettled([confirmPayment(session,payment),confirmPayment(session,payment),confirmPayment(session,payment)]);assert.ok(results.some(x=>x.status==="fulfilled"));await check(payment,"payment_confirmed");assert.equal((await c.query(`SELECT 1 FROM ledger_transactions WHERE source_table='payments' AND source_id=$1 AND kind='payment'`,[payment])).rowCount,1);assert.equal((await c.query(`SELECT sum(amount_minor)::int AS n FROM payment_allocations WHERE payment_id=$1`,[payment])).rows[0].n,100);
 }finally{await c.end();}
});

test("OFF and malformed controls preserve a real non-owner authenticated connection without private owner operations",async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL}),nonowner=new Client({connectionString:process.env.DATABASE_URL});await c.connect();await nonowner.connect();try{
  const {session,lease,submitted}=await setup(c,false,false);const payment=await submitted();
  await nonowner.query("SET SESSION AUTHORIZATION authenticated");
  for(const value of [{enabled:false,allowed_org_ids:[ORG_ID]},{enabled:"true",allowed_org_ids:[ORG_ID]},{enabled:true,allowed_org_ids:ORG_ID},null]){
   if(value===null) await c.query(`DELETE FROM platform_settings WHERE key='notification_center_v2'`);
   else await c.query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='notification_center_v2'`,[JSON.stringify(value)]);
   await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"notification_center_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
   await nonowner.query("BEGIN");await nonowner.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`,[session.userId,ORG_ID]);
   assert.equal(await beginPaymentCenter(nonowner,session,{leaseId:lease.id,paymentId:payment,action:"confirm"}),null);
   assert.deepEqual((await nonowner.query(`SELECT current_user::text AS role,session_user::text AS original`)).rows[0],{role:"authenticated",original:"authenticated"});
   assert.equal((await nonowner.query(`SELECT 1 FROM payments WHERE org_id=$1 AND id=$2`,[ORG_ID,payment])).rowCount,1);await nonowner.query("ROLLBACK");
  }
  await c.query(`INSERT INTO platform_settings(key,value) VALUES('notification_center_v2',jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)))`,[ORG_ID]);
  await nonowner.query("BEGIN");await nonowner.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[session.userId]);await assert.rejects(beginPaymentCenter(nonowner,session,{leaseId:lease.id,paymentId:payment,action:"confirm"}));await nonowner.query("ROLLBACK");
 }finally{await nonowner.end();await c.end();}
});

test("existing manager/accountant action roles remain exact while the center is ON",async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();try{
  const {session,lease,submitted,pair}=await setup(c,false);
  const staff=async(userId:string,role:"manager"|"accountant")=>{const sid=randomUUID();await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,userId,randomUUID()]);return {...session,userId,role,sessionId:sid};};
  const manager=await staff(USERS.manager,"manager"),accountant=await staff(USERS.accountant,"accountant");
  const confirmed=await submitted();await confirmPayment(manager,confirmed);const rejected=await submitted();await rejectPayment(manager,rejected,"Synthetic");
  const recorded=await recordPayment(manager,{leaseId:lease.id,amountMajor:1,paidOn:"2026-11-01",last5:"12345",reference:"Synthetic"});
  for(const payment of [confirmed,rejected,recorded.paymentId])assert.equal((await c.query(`SELECT 1 FROM app.b017_occurrences WHERE payment_id=$1 AND actor_id=$2`,[payment,manager.userId])).rowCount,1);
  await assert.rejects(reversePayment(manager,confirmed,"Synthetic"));await reversePayment(accountant,confirmed,"Synthetic");
  const bank=await pair();assert.equal(await decideBankMatch(manager,{bankId:bank.bank,paymentId:bank.payment,decision:"match",reason:"other"}),null);assert.equal(await decideBankMatch(accountant,{bankId:bank.bank,paymentId:bank.payment,decision:"match",reason:"other"}),true);
  await c.query(`UPDATE platform_settings SET value=jsonb_set(value,'{enabled}','false'::jsonb) WHERE key='bank_matching'`);const legacy=await pair();await approveMatch(accountant,legacy.suggestion);
  for(const payment of [bank.payment,legacy.payment])assert.equal((await c.query(`SELECT 1 FROM app.b017_occurrences WHERE payment_id=$1 AND actor_id=$2`,[payment,accountant.userId])).rowCount,1);
  const forged=await submitted();await assert.rejects(confirmPayment({...session,role:"manager"},forged));assert.equal((await c.query(`SELECT status::text FROM payments WHERE id=$1`,[forged])).rows[0].status,"submitted");
 }finally{await c.end();}
});

test("manager request replay cannot backfill after enabling the center; concurrent retry stays one command",async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();try{
  const {session,lease}=await setup(c,true,false);const input={leaseId:lease.id,amountMajor:1,paidOn:"2026-11-01",last5:"12345",reference:"Synthetic",requestId:randomUUID()};const before=await recordPayment(session,input);
  await c.query(`UPDATE organizations SET feature_flags=feature_flags || '{"notification_center_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);await c.query(`UPDATE platform_settings SET value=jsonb_set(value,'{enabled}','true'::jsonb) WHERE key='notification_center_v2'`);
  assert.equal((await recordPayment(session,input)).paymentId,before.paymentId);assert.equal((await c.query(`SELECT 1 FROM app.b017_occurrences WHERE payment_id=$1`,[before.paymentId])).rowCount,0);
  const retry={...input,requestId:randomUUID()};const all=await Promise.all([recordPayment(session,retry),recordPayment(session,retry),recordPayment(session,retry)]);assert.equal(new Set(all.map(x=>x.paymentId)).size,1);
  assert.equal((await c.query(`SELECT 1 FROM app.b017_occurrences n JOIN app.b028_center_events e ON e.org_id=n.org_id AND e.neutral_source_id=n.id WHERE n.payment_id=$1`,[all[0].paymentId])).rowCount,1);
 }finally{await c.end();}
});

test("center ON with payment results OFF rechecks session expiry after waiting for invoice locks",async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL}),holder=new Client({connectionString:process.env.DATABASE_URL});await c.connect();await holder.connect();let pending:Promise<unknown>|undefined;try{
  const {session,lease,submitted}=await setup(c,false);const payment=await submitted();await c.query(`UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1`,[session.sessionId]);
  await holder.query("BEGIN");await holder.query(`SELECT id FROM invoices WHERE lease_id=$1 FOR UPDATE`,[lease.id]);const pid=(await holder.query<{pid:number}>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
  pending=confirmPayment(session,payment);const result=pending.then(()=>"fulfilled",()=>"rejected");let blocked=false;const deadline=Date.now()+3000;while(Date.now()<deadline){blocked=(await c.query<{ok:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS ok`,[pid])).rows[0].ok;if(blocked)break;await new Promise(r=>setTimeout(r,10));}assert.equal(blocked,true);
  await new Promise(r=>setTimeout(r,2100));await holder.query("COMMIT");assert.equal(await result,"rejected");assert.equal((await c.query(`SELECT status::text FROM payments WHERE id=$1`,[payment])).rows[0].status,"submitted");assert.equal((await c.query(`SELECT 1 FROM payment_allocations WHERE payment_id=$1`,[payment])).rowCount,0);assert.equal((await c.query(`SELECT 1 FROM ledger_transactions WHERE source_table='payments' AND source_id=$1`,[payment])).rowCount,0);assert.equal((await c.query(`SELECT 1 FROM app.b017_occurrences WHERE payment_id=$1`,[payment])).rowCount,0);
 }finally{await holder.query("ROLLBACK");if(pending)await pending.catch(()=>{});await holder.end();await c.end();}
});
