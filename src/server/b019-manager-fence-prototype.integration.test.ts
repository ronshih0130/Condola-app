import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { ORG_ID, ORG2_ID } from "./ids";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { resetAndSeed } from "./seed";

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone:Awaited<ReturnType<typeof cloneTestDatabase>>;
test.before(async()=>{clone=await cloneTestDatabase();const demo=process.env.DEMO_MODE,key=process.env.ID_DOC_ENCRYPTION_KEY;try{process.env.DEMO_MODE='true';process.env.ID_DOC_ENCRYPTION_KEY=randomBytes(32).toString('hex');await resetAndSeed();}finally{if(demo===undefined)delete process.env.DEMO_MODE;else process.env.DEMO_MODE=demo;if(key===undefined)delete process.env.ID_DOC_ENCRYPTION_KEY;else process.env.ID_DOC_ENCRYPTION_KEY=key;}});
test.after(async()=>{if(clone)await clone.cleanup();});
const fence=`LOCK TABLE public.invoice_lines,public.invoices,public.lease_parties,public.ledger_entries,public.ledger_transactions,public.payment_allocations,public.payments IN SHARE ROW EXCLUSIVE MODE NOWAIT`;

test('seven-table local fence and status-only payment writer conflict in both orders',async()=>{
 const a=new Client({connectionString:process.env.DATABASE_URL}),b=new Client({connectionString:process.env.DATABASE_URL});await a.connect();await b.connect();
 try {
  const p=(await a.query<{id:string}>(`SELECT id::text FROM payments WHERE org_id=$1 AND status='confirmed' LIMIT 1`,[ORG_ID])).rows[0];assert.ok(p);
  await b.query('BEGIN');await b.query(`UPDATE payments SET status='submitted' WHERE id=$1`,[p.id]);await a.query('BEGIN');await assert.rejects(a.query(fence),(e:unknown)=>(e as {code?:string}).code==='55P03');await a.query('ROLLBACK');await b.query('ROLLBACK');
  await a.query('BEGIN');await a.query(fence);await b.query('BEGIN');await b.query(`SET LOCAL lock_timeout='50ms'`);await assert.rejects(b.query(`UPDATE payments SET status='submitted' WHERE id=$1`,[p.id]),(e:unknown)=>(e as {code?:string}).code==='55P03');await b.query('ROLLBACK');await a.query('ROLLBACK');
 } finally {await a.end();await b.end();}
});

test('seven-table local fence blocks unrelated-organization invoice insert in both orders',async()=>{
 const a=new Client({connectionString:process.env.DATABASE_URL}),b=new Client({connectionString:process.env.DATABASE_URL});await a.connect();await b.connect();
 try {
  const dest=(await a.query<{lease:string;property:string;currency:string}>(`SELECT id::text lease,property_id::text property,currency FROM leases WHERE org_id=$1 LIMIT 1`,[ORG2_ID])).rows[0];assert.ok(dest);
  const insert=`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date) VALUES($1,$2,$3,$4,$5,current_date)`;
  await b.query('BEGIN');await b.query(insert,[ORG2_ID,dest.property,dest.lease,randomUUID(),dest.currency]);await a.query('BEGIN');await assert.rejects(a.query(fence),(e:unknown)=>(e as {code?:string}).code==='55P03');await a.query('ROLLBACK');await b.query('ROLLBACK');
  await a.query('BEGIN');await a.query(fence);await b.query('BEGIN');await b.query(`SET LOCAL lock_timeout='50ms'`);await assert.rejects(b.query(insert,[ORG2_ID,dest.property,dest.lease,randomUUID(),dest.currency]),(e:unknown)=>(e as {code?:string}).code==='55P03');await b.query('ROLLBACK');await a.query('ROLLBACK');
 } finally {await a.end();await b.end();}
});

test('table fence does not eliminate existing row locks; tuple NOWAIT fails closed',async()=>{
 const a=new Client({connectionString:process.env.DATABASE_URL}),b=new Client({connectionString:process.env.DATABASE_URL});await a.connect();await b.connect();
 try {
  const row=(await a.query<{payment:string;invoice:string}>(`SELECT p.id::text payment,a.invoice_id::text invoice FROM payments p JOIN payment_allocations a ON a.org_id=p.org_id AND a.payment_id=p.id WHERE p.org_id=$1 LIMIT 1`,[ORG_ID])).rows[0];assert.ok(row);
  for(const [table,id] of [['payments',row.payment],['invoices',row.invoice]] as const){
   await b.query('BEGIN');await b.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`,[id]);await a.query('BEGIN');await a.query(fence);
   await assert.rejects(a.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE NOWAIT`,[id]),(e:unknown)=>(e as {code?:string}).code==='55P03');await a.query('ROLLBACK');await b.query('ROLLBACK');
  }
 } finally {await a.end();await b.end();}
});

test('clone-only lease candidate guard rejects same-transaction OLD/NEW phantoms after early constraints',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {
  await c.query(`CREATE TABLE app.b019_invoice_scope_probe(tx_id xid8 NOT NULL,org_id uuid NOT NULL,lease_id uuid NOT NULL,PRIMARY KEY(tx_id,org_id,lease_id));
   REVOKE ALL ON app.b019_invoice_scope_probe FROM PUBLIC,anon,authenticated,service_role;
   CREATE FUNCTION app.b019_invoice_scope_probe_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
   BEGIN
    IF (TG_OP<>'INSERT' AND EXISTS(SELECT 1 FROM app.b019_invoice_scope_probe s WHERE s.tx_id=pg_current_xact_id() AND s.org_id=OLD.org_id AND s.lease_id=OLD.lease_id))
      OR (TG_OP<>'DELETE' AND EXISTS(SELECT 1 FROM app.b019_invoice_scope_probe s WHERE s.tx_id=pg_current_xact_id() AND s.org_id=NEW.org_id AND s.lease_id=NEW.lease_id)) THEN
     RAISE EXCEPTION 'candidate scope sealed' USING ERRCODE='23514'; END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
   END $$;
   REVOKE ALL ON FUNCTION app.b019_invoice_scope_probe_guard() FROM PUBLIC,anon,authenticated,service_role;
   CREATE TRIGGER z_b019_invoice_scope_probe BEFORE INSERT OR UPDATE OR DELETE ON public.invoices FOR EACH ROW EXECUTE FUNCTION app.b019_invoice_scope_probe_guard();`);
  await c.query('BEGIN');const target=(await c.query<{id:string;property:string;currency:string}>(`SELECT l.id::text,l.property_id::text property,l.currency FROM leases l WHERE l.org_id=$1 AND NOT EXISTS(SELECT 1 FROM invoices i WHERE i.org_id=l.org_id AND i.lease_id=l.id AND i.status IN ('open','partially_paid')) ORDER BY l.id LIMIT 1`,[ORG_ID])).rows[0];assert.ok(target);
  const other=(await c.query<{id:string;property:string;currency:string}>(`SELECT id::text,property_id::text property,currency FROM leases WHERE org_id=$1 AND id<>$2 ORDER BY id LIMIT 1`,[ORG_ID,target.id])).rows[0];assert.ok(other);
  const make=async(lease:typeof target,status:'draft'|'void')=>(await c.query<{id:string}>(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date,status,void_reason) VALUES($1,$2,$3,$4,$5,current_date,$6::invoice_status,CASE WHEN $6='void' THEN 'local fixture' ELSE NULL END) RETURNING id::text`,[ORG_ID,lease.property,lease.id,randomUUID(),lease.currency,status])).rows[0].id;
  const draft=await make(target,'draft'),voided=await make(target,'void'),outside=await make(other,'draft');
  assert.equal((await c.query(`SELECT 1 FROM invoices WHERE org_id=$1 AND lease_id=$2 AND status IN ('open','partially_paid')`,[ORG_ID,target.id])).rowCount,0);
  await c.query(fence);await c.query(`INSERT INTO app.b019_invoice_scope_probe VALUES(pg_current_xact_id(),$1,$2)`,[ORG_ID,target.id]);await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  const attempts:[string,unknown[]][]=[
   [`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date) VALUES($1,$2,$3,$4,$5,current_date)`,[ORG_ID,target.property,target.id,randomUUID(),target.currency]],
   [`UPDATE invoices SET status='open' WHERE id=$1`,[draft]],[`UPDATE invoices SET status='open' WHERE id=$1`,[voided]],
   [`UPDATE invoices SET lease_id=$2 WHERE id=$1`,[outside,target.id]],[`UPDATE invoices SET lease_id=$2 WHERE id=$1`,[draft,other.id]],
   [`DELETE FROM invoices WHERE id=$1`,[draft]],
  ];
  for(const [sql,params] of attempts){await c.query('SAVEPOINT sealed');await assert.rejects(c.query(sql,params),(e:unknown)=>(e as {code?:string;message?:string}).code==='23514' && (e as {message?:string}).message==='candidate scope sealed');await c.query('ROLLBACK TO SAVEPOINT sealed');}
  await c.query(`UPDATE invoices SET status='open' WHERE id=$1`,[outside]);await c.query('ROLLBACK');
 } finally {await c.end();}
});
