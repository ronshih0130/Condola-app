import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { ORG_ID, USERS } from "./ids";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { resetAndSeed } from "./seed";

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone:Awaited<ReturnType<typeof cloneTestDatabase>>;
test.before(async()=>{clone=await cloneTestDatabase();const demo=process.env.DEMO_MODE,key=process.env.ID_DOC_ENCRYPTION_KEY;try{process.env.DEMO_MODE='true';process.env.ID_DOC_ENCRYPTION_KEY=randomBytes(32).toString('hex');await resetAndSeed();}finally{if(demo===undefined)delete process.env.DEMO_MODE;else process.env.DEMO_MODE=demo;if(key===undefined)delete process.env.ID_DOC_ENCRYPTION_KEY;else process.env.ID_DOC_ENCRYPTION_KEY=key;}});
test.after(async()=>{if(clone)await clone.cleanup();});

test('clone-only synthetic seal blocks selected same-XID financial and recipient mutations',async()=>{
 const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try {
  await c.query(`CREATE TABLE app.b019_guard_probe(tx_id xid8 NOT NULL,kind text NOT NULL,id uuid NOT NULL,PRIMARY KEY(tx_id,kind,id));
   REVOKE ALL ON app.b019_guard_probe FROM PUBLIC,anon,authenticated,service_role;
   CREATE FUNCTION app.b019_guard_probe_match(k text,v uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,app AS $$ SELECT EXISTS(SELECT 1 FROM app.b019_guard_probe WHERE tx_id=pg_current_xact_id() AND kind=k AND id=v) $$;
   REVOKE ALL ON FUNCTION app.b019_guard_probe_match(text,uuid) FROM PUBLIC,anon,authenticated,service_role;
   CREATE FUNCTION app.b019_guard_probe_row() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
   DECLARE blocked boolean:=false;
   BEGIN
    IF TG_TABLE_NAME='payments' THEN
     blocked:=(TG_OP<>'INSERT' AND app.b019_guard_probe_match('payment',OLD.id)) OR (TG_OP<>'DELETE' AND app.b019_guard_probe_match('payment',NEW.id));
    ELSIF TG_TABLE_NAME='payment_allocations' THEN
     blocked:=(TG_OP<>'INSERT' AND (app.b019_guard_probe_match('payment',OLD.payment_id) OR app.b019_guard_probe_match('invoice',OLD.invoice_id))) OR (TG_OP<>'DELETE' AND (app.b019_guard_probe_match('payment',NEW.payment_id) OR app.b019_guard_probe_match('invoice',NEW.invoice_id)));
    ELSIF TG_TABLE_NAME='invoice_lines' THEN
     blocked:=(TG_OP<>'INSERT' AND app.b019_guard_probe_match('invoice',OLD.invoice_id)) OR (TG_OP<>'DELETE' AND app.b019_guard_probe_match('invoice',NEW.invoice_id));
    ELSIF TG_TABLE_NAME='ledger_transactions' THEN
     blocked:=(TG_OP<>'INSERT' AND (app.b019_guard_probe_match('ledger',OLD.id) OR (OLD.source_table='payments' AND app.b019_guard_probe_match('payment',OLD.source_id)) OR app.b019_guard_probe_match('ledger',OLD.reverses_transaction_id))) OR (TG_OP<>'DELETE' AND (app.b019_guard_probe_match('ledger',NEW.id) OR (NEW.source_table='payments' AND app.b019_guard_probe_match('payment',NEW.source_id)) OR app.b019_guard_probe_match('ledger',NEW.reverses_transaction_id)));
    ELSIF TG_TABLE_NAME='ledger_entries' THEN
     blocked:=(TG_OP<>'INSERT' AND app.b019_guard_probe_match('ledger',OLD.transaction_id)) OR (TG_OP<>'DELETE' AND app.b019_guard_probe_match('ledger',NEW.transaction_id));
    ELSIF TG_TABLE_NAME='contacts' THEN
     blocked:=(TG_OP<>'INSERT' AND app.b019_guard_probe_match('contact',OLD.id)) OR (TG_OP<>'DELETE' AND app.b019_guard_probe_match('contact',NEW.id));
    ELSIF TG_TABLE_NAME='lease_parties' THEN
     blocked:=(TG_OP<>'INSERT' AND app.b019_guard_probe_match('lease',OLD.lease_id)) OR (TG_OP<>'DELETE' AND app.b019_guard_probe_match('lease',NEW.lease_id));
    ELSIF TG_TABLE_NAME='auth_sessions' THEN
     blocked:=(TG_OP<>'INSERT' AND app.b019_guard_probe_match('session',OLD.id)) OR (TG_OP<>'DELETE' AND app.b019_guard_probe_match('session',NEW.id));
    END IF;
    IF blocked THEN RAISE EXCEPTION 'synthetic resource sealed' USING ERRCODE='23514'; END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
   END $$;
   REVOKE ALL ON FUNCTION app.b019_guard_probe_row() FROM PUBLIC,anon,authenticated,service_role;
   CREATE TRIGGER a_b019_guard_probe BEFORE INSERT OR UPDATE OR DELETE ON public.payments FOR EACH ROW EXECUTE FUNCTION app.b019_guard_probe_row();
   CREATE TRIGGER a_b019_guard_probe BEFORE INSERT OR UPDATE OR DELETE ON public.payment_allocations FOR EACH ROW EXECUTE FUNCTION app.b019_guard_probe_row();
   CREATE TRIGGER a_b019_guard_probe BEFORE INSERT OR UPDATE OR DELETE ON public.invoice_lines FOR EACH ROW EXECUTE FUNCTION app.b019_guard_probe_row();
   CREATE TRIGGER a_b019_guard_probe BEFORE INSERT OR UPDATE OR DELETE ON public.ledger_transactions FOR EACH ROW EXECUTE FUNCTION app.b019_guard_probe_row();
   CREATE TRIGGER a_b019_guard_probe BEFORE INSERT OR UPDATE OR DELETE ON public.ledger_entries FOR EACH ROW EXECUTE FUNCTION app.b019_guard_probe_row();
   CREATE TRIGGER a_b019_guard_probe BEFORE INSERT OR UPDATE OR DELETE ON public.contacts FOR EACH ROW EXECUTE FUNCTION app.b019_guard_probe_row();
   CREATE TRIGGER a_b019_guard_probe BEFORE INSERT OR UPDATE OR DELETE ON public.lease_parties FOR EACH ROW EXECUTE FUNCTION app.b019_guard_probe_row();
   CREATE TRIGGER a_b019_guard_probe BEFORE INSERT OR UPDATE OR DELETE ON public.auth_sessions FOR EACH ROW EXECUTE FUNCTION app.b019_guard_probe_row();`);
  await c.query('BEGIN');const p=(await c.query<{id:string;lease:string;contact:string;ledger:string;invoice:string;alloc:string;line:string}>(`SELECT p.id::text,p.lease_id::text lease,p.payer_contact_id::text contact,p.ledger_transaction_id::text ledger,a.invoice_id::text invoice,a.id::text alloc,(SELECT id::text FROM invoice_lines WHERE invoice_id=a.invoice_id LIMIT 1) line FROM payments p JOIN payment_allocations a ON a.org_id=p.org_id AND a.payment_id=p.id WHERE p.org_id=$1 AND p.status='confirmed' AND p.payer_contact_id IS NOT NULL LIMIT 1`,[ORG_ID])).rows[0];assert.ok(p?.line);
  const otherLease=(await c.query<{id:string;property:string;currency:string}>(`SELECT l.id::text,l.property_id::text property,l.currency FROM leases l JOIN payments p ON p.currency=l.currency WHERE l.org_id=$1 AND l.id<>p.lease_id AND p.id=$2 LIMIT 1`,[ORG_ID,p.id])).rows[0];assert.ok(otherLease);
  const otherInvoice=(await c.query<{id:string}>(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date) VALUES($1,$2,$3,$4,$5,current_date) RETURNING id::text`,[ORG_ID,otherLease.property,otherLease.id,randomUUID(),otherLease.currency])).rows[0].id;
  const otherLine=(await c.query<{id:string}>(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,unit_amount_minor,amount_minor) VALUES($1,$2,1,'rent','fixture',1,1) RETURNING id::text`,[ORG_ID,otherInvoice])).rows[0].id;
  const otherPayment=(await c.query<{id:string}>(`INSERT INTO payments(org_id,property_id,lease_id,currency,amount_minor,paid_on,method,status,source) VALUES($1,$2,$3,$4,1,current_date,'bank_transfer','submitted','tenant_portal') RETURNING id::text`,[ORG_ID,otherLease.property,otherLease.id,otherLease.currency])).rows[0].id;
  const otherAlloc=(await c.query<{id:string}>(`INSERT INTO payment_allocations(org_id,payment_id,invoice_id,amount_minor) VALUES($1,$2,$3,1) RETURNING id::text`,[ORG_ID,otherPayment,otherInvoice])).rows[0].id;
  const sid=randomUUID();await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
  for(const [kind,id] of [['payment',p.id],['invoice',p.invoice],['ledger',p.ledger],['contact',p.contact],['lease',p.lease],['session',sid]] as const)await c.query(`INSERT INTO app.b019_guard_probe VALUES(pg_current_xact_id(),$1,$2)`,[kind,id]);
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');
  const attempts:[string,unknown[]][]=[
   [`UPDATE payments SET reference='blocked' WHERE id=$1`,[p.id]],
   [`DELETE FROM payment_allocations WHERE id=$1`,[p.alloc]],
   [`UPDATE payment_allocations SET invoice_id=$2 WHERE id=$1`,[otherAlloc,p.invoice]],
   [`UPDATE invoice_lines SET amount_minor=amount_minor+1 WHERE id=$1`,[p.line]],
   [`UPDATE invoice_lines SET invoice_id=$2 WHERE id=$1`,[otherLine,p.invoice]],
   [`INSERT INTO ledger_transactions(org_id,property_id,lease_id,kind,currency,effective_date,source_table,source_id,created_by) SELECT org_id,property_id,lease_id,kind,currency,effective_date,source_table,source_id,created_by FROM ledger_transactions WHERE id=$1`,[p.ledger]],
   [`INSERT INTO ledger_transactions(org_id,property_id,lease_id,kind,currency,effective_date,reverses_transaction_id,reason,created_by) SELECT org_id,property_id,lease_id,'reversal',currency,current_date,id,'fixture',created_by FROM ledger_transactions WHERE id=$1`,[p.ledger]],
   [`INSERT INTO ledger_entries(org_id,transaction_id,account,amount_minor,currency,contact_id,property_id,lease_id,invoice_id) SELECT org_id,transaction_id,account,amount_minor,currency,contact_id,property_id,lease_id,invoice_id FROM ledger_entries WHERE transaction_id=$1 LIMIT 1`,[p.ledger]],
   [`UPDATE contacts SET user_id=$2 WHERE id=$1`,[p.contact,USERS.admin]],
   [`DELETE FROM lease_parties WHERE org_id=$1 AND lease_id=$2 AND contact_id=$3`,[ORG_ID,p.lease,p.contact]],
   [`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1`,[sid]],
  ];
  for(const [sql,params] of attempts){await c.query('SAVEPOINT blocked');await assert.rejects(c.query(sql,params),(e:unknown)=>(e as {code?:string;message?:string}).code==='23514' && (e as {message?:string}).message==='synthetic resource sealed');await c.query('ROLLBACK TO SAVEPOINT blocked');}
  await c.query('ROLLBACK');
 } finally {await c.end();}
});
