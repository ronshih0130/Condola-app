import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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
  const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();try{await c.query(await readFile('supabase/migrations/20261031100219_b010_b028_real_producer.sql','utf8'));}finally{await c.end();}
 } finally {if(demo===undefined)delete process.env.DEMO_MODE;else process.env.DEMO_MODE=demo;if(key===undefined)delete process.env.ID_DOC_ENCRYPTION_KEY;else process.env.ID_DOC_ENCRYPTION_KEY=key;}
});
test.after(async()=>{if(clone)await clone.cleanup();});

// Research predicate only: not a migration, production gateway, or commit guarantee.
const confirmedProof=`SELECT EXISTS(SELECT 1 FROM payments p JOIN ledger_transactions t ON t.id=p.ledger_transaction_id AND t.org_id=p.org_id
 WHERE p.id=$1 AND p.org_id=$2 AND p.status='confirmed' AND p.confirmed_by=$3 AND p.confirmed_at IS NOT NULL AND p.amount_minor>0
 AND t.kind='payment' AND t.source_table='payments' AND t.source_id=p.id AND t.created_by=$3
 AND t.property_id=p.property_id AND t.lease_id=p.lease_id AND t.currency=p.currency
 AND (SELECT coalesce(sum(a.amount_minor),0) FROM payment_allocations a WHERE a.org_id=p.org_id AND a.payment_id=p.id)=p.amount_minor
 AND NOT EXISTS(SELECT 1 FROM payment_allocations a LEFT JOIN invoices i ON i.org_id=a.org_id AND i.id=a.invoice_id
   WHERE a.payment_id=p.id AND (a.org_id<>p.org_id OR a.amount_minor<=0 OR i.id IS NULL OR i.lease_id<>p.lease_id OR i.property_id<>p.property_id OR i.currency<>p.currency
    OR i.total_minor IS DISTINCT FROM (SELECT coalesce(sum(il.amount_minor),0) FROM invoice_lines il WHERE il.invoice_id=i.id)
    OR i.paid_minor IS DISTINCT FROM (SELECT coalesce(sum(pa.amount_minor),0) FROM payment_allocations pa JOIN payments pp ON pp.id=pa.payment_id WHERE pa.invoice_id=i.id AND pp.status='confirmed')
    OR i.status::text IS DISTINCT FROM CASE WHEN i.balance_minor<=0 AND i.total_minor>0 THEN 'paid' WHEN i.paid_minor>0 THEN 'partially_paid' ELSE 'open' END))
 AND NOT EXISTS(SELECT 1 FROM ledger_transactions rev WHERE rev.org_id=p.org_id AND rev.reverses_transaction_id=t.id)
 AND NOT EXISTS(SELECT 1 FROM ledger_entries e WHERE e.org_id=p.org_id AND e.transaction_id=t.id AND
   (e.currency<>p.currency OR e.property_id IS DISTINCT FROM p.property_id OR e.lease_id IS DISTINCT FROM p.lease_id OR e.contact_id IS DISTINCT FROM p.payer_contact_id OR (e.invoice_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM payment_allocations a WHERE a.org_id=p.org_id AND a.payment_id=p.id AND a.invoice_id=e.invoice_id)) OR e.account NOT IN ('cash_clearing','tenant_receivable')))
 AND (SELECT coalesce(sum(e.amount_minor),0) FROM ledger_entries e WHERE e.org_id=p.org_id AND e.transaction_id=t.id AND e.account='cash_clearing')=p.amount_minor
 AND (SELECT coalesce(sum(e.amount_minor),0) FROM ledger_entries e WHERE e.org_id=p.org_id AND e.transaction_id=t.id AND e.account='tenant_receivable')=-p.amount_minor
 ) AS valid`;
async function proof(c:Client,payment:string){return (await c.query<{valid:boolean}>(confirmedProof,[payment,ORG_ID,USERS.admin])).rows[0].valid;}

test('actual partial allocation and ledger pass candidate; balanced wrong amount and wrong scope fail within rollback',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {await c.query('BEGIN');await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`,[USERS.admin,ORG_ID]);
  const base=(await c.query<{lease_id:string;property_id:string;currency:string;payer:string}>(`SELECT l.id::text lease_id,l.property_id::text,l.currency,lp.contact_id::text payer FROM leases l JOIN lease_parties lp ON lp.org_id=l.org_id AND lp.lease_id=l.id AND lp.role='primary' JOIN invoices i ON i.org_id=l.org_id AND i.lease_id=l.id WHERE l.org_id=$1 AND i.status IN ('open','partially_paid') AND i.balance_minor>100 AND EXISTS(SELECT 1 FROM leases other WHERE other.org_id=l.org_id AND other.id<>l.id AND other.currency=l.currency) ORDER BY l.id LIMIT 1`,[ORG_ID])).rows[0];assert.ok(base);
  const invoices=await lockAllocationInvoices(c,ORG_ID,base.lease_id);assert.ok(invoices.length);
  const pay=(await c.query<{id:string;org_id:string;property_id:string;lease_id:string;currency:string;amount_minor:string;payer_contact_id:string|null}>(`INSERT INTO payments(org_id,property_id,lease_id,payer_contact_id,currency,amount_minor,paid_on,method,status,source,submitted_by,confirmed_by,confirmed_at)
   VALUES($1,$2,$3,$4,$5,100,current_date,'bank_transfer','confirmed','manager_entry',$6,$6,clock_timestamp()) RETURNING id::text,org_id::text,property_id::text,lease_id::text,currency,amount_minor::text,payer_contact_id::text`,[ORG_ID,base.property_id,base.lease_id,base.payer,base.currency,USERS.admin])).rows[0];
  await allocateAndLedger(c,pay,USERS.admin,invoices);assert.equal(await proof(c,pay.id),true);
  const invoice=(await c.query<{balance:string;status:string}>(`SELECT balance_minor::text balance,status::text FROM invoices WHERE id=$1`,[invoices[0].id])).rows[0];assert.ok(BigInt(invoice.balance)>BigInt(0));assert.equal(invoice.status,'partially_paid');
  await c.query('SAVEPOINT detached_reversal');await c.query(`SELECT post_reversal(ledger_transaction_id,'local pending reversal') FROM payments WHERE id=$1`,[pay.id]);assert.equal((await c.query<{status:string}>(`SELECT status::text FROM payments WHERE id=$1`,[pay.id])).rows[0].status,'confirmed');assert.equal(await proof(c,pay.id),false);await c.query('ROLLBACK TO SAVEPOINT detached_reversal');
  await c.query('SAVEPOINT wrong_invoice');await c.query(`UPDATE invoices SET paid_minor=0 WHERE id=$1`,[invoices[0].id]);assert.equal(await proof(c,pay.id),false);await c.query('ROLLBACK TO SAVEPOINT wrong_invoice');
  await c.query('SAVEPOINT wrong_amount');
  const fake=(await c.query<{id:string}>(`INSERT INTO ledger_transactions(org_id,property_id,lease_id,kind,currency,effective_date,description,source_table,source_id,created_by)
   SELECT org_id,property_id,lease_id,kind,currency,effective_date,description,source_table,source_id,created_by FROM ledger_transactions WHERE id=(SELECT ledger_transaction_id FROM payments WHERE id=$1) RETURNING id::text`,[pay.id])).rows[0].id;
  await c.query(`INSERT INTO ledger_entries(org_id,transaction_id,account,amount_minor,currency,contact_id,property_id,lease_id,invoice_id)
   SELECT org_id,$2,account,amount_minor*2,currency,contact_id,property_id,lease_id,invoice_id FROM ledger_entries WHERE transaction_id=(SELECT ledger_transaction_id FROM payments WHERE id=$1)`,[pay.id,fake]);
  await c.query(`UPDATE payments SET ledger_transaction_id=$2 WHERE id=$1`,[pay.id,fake]);assert.equal(await proof(c,pay.id),false);await c.query('ROLLBACK TO SAVEPOINT wrong_amount');
  await c.query('SAVEPOINT wrong_scope');const other=(await c.query<{id:string}>(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date) SELECT org_id,property_id,id,gen_random_uuid()::text,currency,current_date FROM leases WHERE org_id=$1 AND id<>$2 AND currency=$3 LIMIT 1 RETURNING id::text`,[ORG_ID,base.lease_id,base.currency])).rows[0];assert.ok(other);
  await c.query(`UPDATE payment_allocations SET invoice_id=$2 WHERE payment_id=$1`,[pay.id,other.id]);assert.equal(await proof(c,pay.id),false);await c.query('ROLLBACK TO SAVEPOINT wrong_scope');
  await c.query('SAVEPOINT split_entries');
  const split=(await c.query<{id:string}>(`INSERT INTO ledger_transactions(org_id,property_id,lease_id,kind,currency,effective_date,description,source_table,source_id,created_by) SELECT org_id,property_id,lease_id,kind,currency,effective_date,description,source_table,source_id,created_by FROM ledger_transactions WHERE id=(SELECT ledger_transaction_id FROM payments WHERE id=$1) RETURNING id::text`,[pay.id])).rows[0].id;
  await c.query(`INSERT INTO ledger_entries(org_id,transaction_id,account,amount_minor,currency,contact_id,property_id,lease_id,invoice_id) SELECT e.org_id,$2,e.account,e.amount_minor/2,e.currency,e.contact_id,e.property_id,e.lease_id,e.invoice_id FROM ledger_entries e CROSS JOIN generate_series(1,2) WHERE e.transaction_id=(SELECT ledger_transaction_id FROM payments WHERE id=$1)`,[pay.id,split]);
  await c.query(`UPDATE payments SET ledger_transaction_id=$2 WHERE id=$1`,[pay.id,split]);assert.equal(await proof(c,pay.id),true);await c.query('ROLLBACK TO SAVEPOINT split_entries');
  await c.query('SAVEPOINT missing_allocation');await c.query(`DELETE FROM payment_allocations WHERE payment_id=$1`,[pay.id]);assert.equal(await proof(c,pay.id),false);await c.query('ROLLBACK TO SAVEPOINT missing_allocation');
  for(const variant of ['lineage','currency','contact','entry_currency','entry_lease','entry_property','extra','actor'] as const) {
   await c.query('SAVEPOINT bad_header');
   const bad=(await c.query<{id:string}>(`INSERT INTO ledger_transactions(org_id,property_id,lease_id,kind,currency,effective_date,description,source_table,source_id,created_by)
    SELECT org_id,property_id,lease_id,kind,CASE WHEN $2='currency' THEN 'USD' ELSE currency END,effective_date,description,source_table,CASE WHEN $2='lineage' THEN gen_random_uuid() ELSE source_id END,CASE WHEN $2='actor' THEN $3 ELSE created_by END
     FROM ledger_transactions WHERE id=(SELECT ledger_transaction_id FROM payments WHERE id=$1) RETURNING id::text`,[pay.id,variant,USERS.manager])).rows[0].id;
   await c.query(`INSERT INTO ledger_entries(org_id,transaction_id,account,amount_minor,currency,contact_id,property_id,lease_id,invoice_id)
    SELECT org_id,$2,account,amount_minor,CASE WHEN $3='entry_currency' THEN 'USD' ELSE currency END,CASE WHEN $3='contact' THEN NULL ELSE contact_id END,CASE WHEN $3='entry_property' THEN NULL ELSE property_id END,CASE WHEN $3='entry_lease' THEN NULL ELSE lease_id END,invoice_id FROM ledger_entries WHERE transaction_id=(SELECT ledger_transaction_id FROM payments WHERE id=$1)`,[pay.id,bad,variant]);
   if(variant==='extra')await c.query(`INSERT INTO ledger_entries(org_id,transaction_id,account,amount_minor,currency,contact_id,property_id,lease_id,invoice_id)
    SELECT org_id,$2,account,amount_minor,currency,contact_id,property_id,lease_id,invoice_id FROM ledger_entries WHERE transaction_id=(SELECT ledger_transaction_id FROM payments WHERE id=$1)`,[pay.id,bad]);
   await c.query(`UPDATE payments SET ledger_transaction_id=$2 WHERE id=$1`,[pay.id,bad]);assert.equal(await proof(c,pay.id),false,variant);await c.query('ROLLBACK TO SAVEPOINT bad_header');
  }
  assert.equal(await proof(c,pay.id),true);await c.query('ROLLBACK');assert.equal((await c.query(`SELECT 1 FROM payments WHERE id=$1`,[pay.id])).rowCount,0);
 } finally {await c.end();}
});

const reverseProof=`SELECT EXISTS(SELECT 1 FROM payments p JOIN ledger_transactions original ON original.org_id=p.org_id AND original.id=p.ledger_transaction_id
 JOIN ledger_transactions reversal ON reversal.org_id=original.org_id AND reversal.reverses_transaction_id=original.id AND reversal.kind='reversal'
 WHERE p.id=$1 AND p.org_id=$2 AND p.status='reversed' AND original.kind='payment' AND original.source_table='payments' AND original.source_id=p.id
 AND original.property_id=p.property_id AND original.lease_id=p.lease_id AND original.currency=p.currency
 AND reversal.created_by=$3 AND btrim(coalesce(reversal.reason,''))<>'' AND reversal.currency=original.currency AND reversal.property_id IS NOT DISTINCT FROM original.property_id AND reversal.lease_id IS NOT DISTINCT FROM original.lease_id
 AND original.created_by=p.confirmed_by AND p.confirmed_by IS NOT NULL AND p.confirmed_at IS NOT NULL
 AND (SELECT coalesce(sum(a.amount_minor),0) FROM payment_allocations a WHERE a.org_id=p.org_id AND a.payment_id=p.id)=p.amount_minor
 AND NOT EXISTS(SELECT 1 FROM payment_allocations a LEFT JOIN invoices i ON i.org_id=a.org_id AND i.id=a.invoice_id WHERE a.payment_id=p.id AND (a.org_id<>p.org_id OR a.amount_minor<=0 OR i.id IS NULL OR i.lease_id<>p.lease_id OR i.property_id<>p.property_id OR i.currency<>p.currency
  OR i.total_minor IS DISTINCT FROM (SELECT coalesce(sum(il.amount_minor),0) FROM invoice_lines il WHERE il.invoice_id=i.id)
  OR i.paid_minor IS DISTINCT FROM (SELECT coalesce(sum(pa.amount_minor),0) FROM payment_allocations pa JOIN payments pp ON pp.id=pa.payment_id WHERE pa.invoice_id=i.id AND pp.status='confirmed')
  OR i.status::text IS DISTINCT FROM CASE WHEN i.balance_minor<=0 AND i.total_minor>0 THEN 'paid' WHEN i.paid_minor>0 THEN 'partially_paid' ELSE 'open' END))
 AND NOT EXISTS(SELECT 1 FROM ledger_entries e WHERE e.org_id=p.org_id AND e.transaction_id=original.id AND
  (e.currency<>p.currency OR e.property_id IS DISTINCT FROM p.property_id OR e.lease_id IS DISTINCT FROM p.lease_id OR e.contact_id IS DISTINCT FROM p.payer_contact_id OR e.account NOT IN ('cash_clearing','tenant_receivable') OR (e.invoice_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM payment_allocations a WHERE a.org_id=p.org_id AND a.payment_id=p.id AND a.invoice_id=e.invoice_id))))
 AND (SELECT coalesce(sum(e.amount_minor),0) FROM ledger_entries e WHERE e.org_id=p.org_id AND e.transaction_id=original.id AND e.account='cash_clearing')=p.amount_minor
 AND (SELECT coalesce(sum(e.amount_minor),0) FROM ledger_entries e WHERE e.org_id=p.org_id AND e.transaction_id=original.id AND e.account='tenant_receivable')=-p.amount_minor
 AND NOT EXISTS((SELECT e.account,e.currency,e.contact_id,e.property_id,e.lease_id,e.invoice_id,sum(e.amount_minor) FROM ledger_entries e WHERE e.org_id=p.org_id AND e.transaction_id=original.id GROUP BY e.account,e.currency,e.contact_id,e.property_id,e.lease_id,e.invoice_id)
   EXCEPT (SELECT e.account,e.currency,e.contact_id,e.property_id,e.lease_id,e.invoice_id,-sum(e.amount_minor) FROM ledger_entries e WHERE e.org_id=p.org_id AND e.transaction_id=reversal.id GROUP BY e.account,e.currency,e.contact_id,e.property_id,e.lease_id,e.invoice_id))
 AND NOT EXISTS((SELECT e.account,e.currency,e.contact_id,e.property_id,e.lease_id,e.invoice_id,-sum(e.amount_minor) FROM ledger_entries e WHERE e.org_id=p.org_id AND e.transaction_id=reversal.id GROUP BY e.account,e.currency,e.contact_id,e.property_id,e.lease_id,e.invoice_id)
   EXCEPT (SELECT e.account,e.currency,e.contact_id,e.property_id,e.lease_id,e.invoice_id,sum(e.amount_minor) FROM ledger_entries e WHERE e.org_id=p.org_id AND e.transaction_id=original.id GROUP BY e.account,e.currency,e.contact_id,e.property_id,e.lease_id,e.invoice_id))
 ) AS valid`;
async function reversalProof(c:Client,payment:string){return (await c.query<{valid:boolean}>(reverseProof,[payment,ORG_ID,USERS.admin])).rows[0].valid;}

test('actual reversal passes exact inverse; header-only and balanced wrong inverse fail',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {await c.query('BEGIN');await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`,[USERS.admin,ORG_ID]);
  const pay=(await c.query<{id:string;ledger:string}>(`SELECT id::text,ledger_transaction_id::text ledger FROM payments WHERE org_id=$1 AND status='confirmed' AND ledger_transaction_id IS NOT NULL LIMIT 1`,[ORG_ID])).rows[0];assert.ok(pay);
  for(const addEntries of [false,true]) {
   await c.query('SAVEPOINT invalid_reversal');
   const fake=(await c.query<{id:string}>(`INSERT INTO ledger_transactions(org_id,property_id,lease_id,kind,currency,effective_date,source_table,source_id,reverses_transaction_id,reason,created_by)
    SELECT org_id,property_id,lease_id,'reversal',currency,current_date,source_table,source_id,id,'local negative',$2 FROM ledger_transactions WHERE id=$1 RETURNING id::text`,[pay.ledger,USERS.admin])).rows[0].id;
   if(addEntries)await c.query(`INSERT INTO ledger_entries(org_id,transaction_id,account,amount_minor,currency,contact_id,property_id,lease_id,invoice_id) SELECT org_id,$2,account,-2*amount_minor,currency,contact_id,property_id,lease_id,invoice_id FROM ledger_entries WHERE transaction_id=$1`,[pay.ledger,fake]);
   await c.query(`UPDATE payments SET status='reversed' WHERE id=$1`,[pay.id]);assert.equal(await reversalProof(c,pay.id),false);await c.query('ROLLBACK TO SAVEPOINT invalid_reversal');
  }
  await c.query('SAVEPOINT bad_original');
  const wrong=(await c.query<{id:string}>(`INSERT INTO ledger_transactions(org_id,property_id,lease_id,kind,currency,effective_date,source_table,source_id,created_by)
   SELECT org_id,property_id,lease_id,kind,currency,effective_date,source_table,source_id,created_by FROM ledger_transactions WHERE id=$1 RETURNING id::text`,[pay.ledger])).rows[0].id;
  await c.query(`INSERT INTO ledger_entries(org_id,transaction_id,account,amount_minor,currency,contact_id,property_id,lease_id,invoice_id) SELECT org_id,$2,account,2*amount_minor,currency,contact_id,property_id,lease_id,invoice_id FROM ledger_entries WHERE transaction_id=$1`,[pay.ledger,wrong]);
  await c.query(`UPDATE payments SET ledger_transaction_id=$2 WHERE id=$1`,[pay.id,wrong]);await c.query(`SELECT post_reversal($1,'local wrong original')`,[wrong]);await c.query(`UPDATE payments SET status='reversed' WHERE id=$1`,[pay.id]);assert.equal(await reversalProof(c,pay.id),false);await c.query('ROLLBACK TO SAVEPOINT bad_original');
  await c.query('SAVEPOINT preserved_invoice_status');await c.query(`UPDATE invoices SET status='written_off' WHERE id IN (SELECT invoice_id FROM payment_allocations WHERE payment_id=$1)`,[pay.id]);
  await c.query(`SELECT post_reversal($1,'local preserved invoice')`,[pay.ledger]);await c.query(`UPDATE payments SET status='reversed' WHERE id=$1`,[pay.id]);
  assert.equal((await c.query<{status:string}>(`SELECT status::text FROM invoices WHERE id IN (SELECT invoice_id FROM payment_allocations WHERE payment_id=$1) LIMIT 1`,[pay.id])).rows[0].status,'written_off');
  assert.equal(await reversalProof(c,pay.id),false);await c.query('ROLLBACK TO SAVEPOINT preserved_invoice_status');
  await c.query(`SELECT post_reversal($1,'local actual reversal')`,[pay.ledger]);await c.query(`UPDATE payments SET status='reversed' WHERE id=$1`,[pay.id]);assert.equal(await reversalProof(c,pay.id),true);
  await c.query('ROLLBACK');assert.equal((await c.query<{status:string}>(`SELECT status::text FROM payments WHERE id=$1`,[pay.id])).rows[0].status,'confirmed');
 } finally {await c.end();}
});

test('submitted confirmation uses real helper; clean rejection shape requires reason (research-only)',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {await c.query('BEGIN');await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`,[USERS.admin,ORG_ID]);
  const base=(await c.query<{lease_id:string;property_id:string;currency:string;payer:string}>(`SELECT l.id::text lease_id,l.property_id::text,l.currency,lp.contact_id::text payer FROM leases l JOIN lease_parties lp ON lp.org_id=l.org_id AND lp.lease_id=l.id AND lp.role='primary' JOIN invoices i ON i.org_id=l.org_id AND i.lease_id=l.id WHERE l.org_id=$1 AND i.status IN ('open','partially_paid') AND i.balance_minor>1 AND EXISTS(SELECT 1 FROM leases other WHERE other.org_id=l.org_id AND other.id<>l.id AND other.currency=l.currency) ORDER BY l.id LIMIT 1`,[ORG_ID])).rows[0];assert.ok(base);
  const pay=(await c.query<{id:string;org_id:string;property_id:string;lease_id:string;currency:string;amount_minor:string;payer_contact_id:string|null}>(`INSERT INTO payments(org_id,property_id,lease_id,payer_contact_id,currency,amount_minor,paid_on,method,status,source,submitted_by)
   VALUES($1,$2,$3,$4,$5,1,current_date,'bank_transfer','submitted','tenant_portal',$6) RETURNING id::text,org_id::text,property_id::text,lease_id::text,currency,amount_minor::text,payer_contact_id::text`,[ORG_ID,base.property_id,base.lease_id,base.payer,base.currency,USERS.tenant])).rows[0];
  await c.query('SAVEPOINT confirm_case');const invoices=await lockAllocationInvoices(c,ORG_ID,base.lease_id);await c.query(`UPDATE payments SET status='confirmed',confirmed_by=$2,confirmed_at=clock_timestamp() WHERE id=$1`,[pay.id,USERS.admin]);await allocateAndLedger(c,pay,USERS.admin,invoices);assert.equal(await proof(c,pay.id),true);await c.query('ROLLBACK TO SAVEPOINT confirm_case');
  const rejection=`SELECT status='rejected' AND btrim(coalesce(rejected_reason,''))<>'' AND ledger_transaction_id IS NULL AND NOT EXISTS(SELECT 1 FROM payment_allocations a WHERE a.payment_id=p.id) AS valid FROM payments p WHERE p.id=$1 AND p.org_id=$2`;
  await c.query(`UPDATE payments SET status='rejected',rejected_reason='local reason' WHERE id=$1`,[pay.id]);assert.equal((await c.query<{valid:boolean}>(rejection,[pay.id,ORG_ID])).rows[0].valid,true);
  await c.query(`UPDATE payments SET rejected_reason=' ' WHERE id=$1`,[pay.id]);assert.equal((await c.query<{valid:boolean}>(rejection,[pay.id,ORG_ID])).rows[0].valid,false);
  await c.query('ROLLBACK');assert.equal((await c.query(`SELECT 1 FROM payments WHERE id=$1`,[pay.id])).rowCount,0);
 } finally {await c.end();}
});

test('candidate permits seeded supported ledger entries with allocated invoice IDs',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {
  const pay=(await c.query<{id:string}>(`SELECT p.id::text FROM payments p JOIN ledger_entries e ON e.org_id=p.org_id AND e.transaction_id=p.ledger_transaction_id WHERE p.org_id=$1 AND p.status='confirmed' AND e.invoice_id IS NOT NULL LIMIT 1`,[ORG_ID])).rows[0];assert.ok(pay);
  assert.equal(await proof(c,pay.id),true);
 } finally {await c.end();}
});

test('legacy submitted payment with preexisting ledger can be rejected by existing state rule',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {await c.query('BEGIN');await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`,[USERS.admin,ORG_ID]);
  const base=(await c.query<{lease_id:string;property_id:string;currency:string;payer:string}>(`SELECT l.id::text lease_id,l.property_id::text,l.currency,lp.contact_id::text payer FROM leases l JOIN lease_parties lp ON lp.org_id=l.org_id AND lp.lease_id=l.id AND lp.role='primary' JOIN invoices i ON i.org_id=l.org_id AND i.lease_id=l.id WHERE l.org_id=$1 AND i.status IN ('open','partially_paid') AND i.balance_minor>1 ORDER BY l.id LIMIT 1`,[ORG_ID])).rows[0];assert.ok(base);
  const pay=(await c.query<{id:string;org_id:string;property_id:string;lease_id:string;currency:string;amount_minor:string;payer_contact_id:string|null}>(`INSERT INTO payments(org_id,property_id,lease_id,payer_contact_id,currency,amount_minor,paid_on,method,status,source,submitted_by) VALUES($1,$2,$3,$4,$5,1,current_date,'bank_transfer','submitted','tenant_portal',$6) RETURNING id::text,org_id::text,property_id::text,lease_id::text,currency,amount_minor::text,payer_contact_id::text`,[ORG_ID,base.property_id,base.lease_id,base.payer,base.currency,USERS.tenant])).rows[0];
  await allocateAndLedger(c,pay,USERS.admin,await lockAllocationInvoices(c,ORG_ID,base.lease_id));await c.query(`UPDATE payments SET status='rejected',rejected_reason='local reason' WHERE id=$1 AND status='submitted'`,[pay.id]);
  const state=(await c.query<{legacy:boolean;strict:boolean}>(`SELECT status='rejected' AND btrim(coalesce(rejected_reason,''))<>'' AS legacy,ledger_transaction_id IS NULL AND NOT EXISTS(SELECT 1 FROM payment_allocations a WHERE a.payment_id=p.id) AS strict FROM payments p WHERE id=$1`,[pay.id])).rows[0];assert.deepEqual(state,{legacy:true,strict:false});
  await c.query('ROLLBACK');
 } finally {await c.end();}
});
