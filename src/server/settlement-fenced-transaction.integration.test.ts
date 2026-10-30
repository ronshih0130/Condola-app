import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { disposableDbUrl,withDatabase } from "./test-disposable-db";
import { withSettlementFencePrototype } from "./settlement-fenced-transaction";
const source=disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let admin:Client,db:Client,name:string,owned=false,previous:string|undefined;
test.before(async()=>{const template=decodeURIComponent(source.pathname.slice(1));if(!/^[a-z][a-z0-9_]{0,62}$/.test(template))throw new Error("Invalid template");name=`condola_b011_${randomUUID().replaceAll("-","")}`;admin=new Client({connectionString:withDatabase(source,"postgres")});await admin.connect();await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);owned=true;db=new Client({connectionString:withDatabase(source,name)});await db.connect();previous=process.env.DATABASE_URL;process.env.DATABASE_URL=withDatabase(source,name);
  await db.query(`CREATE TABLE app.b011_fence_test_parent(id integer PRIMARY KEY); INSERT INTO app.b011_fence_test_parent VALUES(1); CREATE TABLE app.b011_fence_test_child(id uuid PRIMARY KEY); GRANT SELECT,UPDATE ON app.b011_fence_test_parent TO service_role; GRANT INSERT,SELECT ON app.b011_fence_test_child TO service_role; CREATE FUNCTION app.b011_fence_test_deferred() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM id FROM app.b011_fence_test_parent WHERE id=1 FOR UPDATE; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER b011_fence_test_deferred AFTER INSERT ON app.b011_fence_test_child DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.b011_fence_test_deferred(); CREATE TABLE app.b011_fence_test_sleep(id uuid PRIMARY KEY); GRANT INSERT,SELECT ON app.b011_fence_test_sleep TO service_role; CREATE FUNCTION app.b011_fence_test_slow() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2); RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER b011_fence_test_slow AFTER INSERT ON app.b011_fence_test_sleep DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.b011_fence_test_slow()`);
});
test.after(async()=>{if(previous===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous;await db?.end();if(owned)await admin.query(`DROP DATABASE "${name}"`);await admin?.end();});
test("precommit deferred constraint lock wait rolls back and releases the fence",async t=>{
  const peer=new Client({connectionString:withDatabase(source,name)});await peer.connect();await peer.query("BEGIN");await peer.query(`SELECT id FROM app.b011_fence_test_parent WHERE id=1 FOR UPDATE`);
  try {
    const row=randomUUID(),start=performance.now();let inserted=false;
    await assert.rejects(withSettlementFencePrototype(randomUUID(),async()=>{},async query=>{await query("LOCK TABLE public.invoices,public.invoice_lines IN SHARE MODE NOWAIT");await query(`INSERT INTO app.b011_fence_test_child(id) VALUES($1)`,[row]);inserted=true;}),(error:unknown)=>(error as {cause?:{code?:string}}).cause?.code==="55P03");assert.equal(inserted,true);
    const elapsed=performance.now()-start;assert.ok(elapsed<1500);assert.equal(Number((await db.query(`SELECT count(*) AS n FROM app.b011_fence_test_child WHERE id=$1`,[row])).rows[0].n),0);
    await db.query("BEGIN");await db.query("LOCK TABLE public.invoices,public.invoice_lines IN ROW EXCLUSIVE MODE NOWAIT");await db.query("ROLLBACK");
    t.diagnostic(`Synthetic deferred wait aborted and fence released after ${Math.round(elapsed)} ms`);
  } finally {await peer.query("ROLLBACK");await peer.end();}
  const accepted=randomUUID();await withSettlementFencePrototype(randomUUID(),async()=>{},async query=>{await query("LOCK TABLE public.invoices,public.invoice_lines IN SHARE MODE NOWAIT");await query(`INSERT INTO app.b011_fence_test_child(id) VALUES($1)`,[accepted]);});assert.equal(Number((await db.query(`SELECT count(*) AS n FROM app.b011_fence_test_child WHERE id=$1`,[accepted])).rows[0].n),1);
});
test("an idle callback cannot retain the invoice fence beyond its database deadline",async t=>{
  const peer=new Client({connectionString:withDatabase(source,name)});await peer.connect();
  let ready!:()=>void;const locked=new Promise<void>(resolve=>{ready=resolve;});
  const start=performance.now();let callbackResumed=false;
  const operation=withSettlementFencePrototype(randomUUID(),async()=>{},async query=>{await query("LOCK TABLE public.invoices IN SHARE MODE NOWAIT");ready();await new Promise(resolve=>setTimeout(resolve,3000));callbackResumed=true;}).then(()=>null,error=>error);
  try {
    await locked;await peer.query("BEGIN");const pid=(await peer.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const pending=peer.query("LOCK TABLE public.invoices IN ROW EXCLUSIVE MODE");let blocked=false;
    for(let n=0;n<40&&!blocked;n++){await new Promise(resolve=>setTimeout(resolve,25));blocked=(await db.query<{blocked:boolean}>(`SELECT cardinality(pg_blocking_pids($1))>0 AS blocked`,[pid])).rows[0].blocked;}
    assert.ok(blocked);await pending;const released=performance.now()-start;assert.ok(released<2000);assert.equal(callbackResumed,false);await peer.query("ROLLBACK");
    assert.ok(await operation);t.diagnostic(`Synthetic idle fence released after ${Math.round(released)} ms`);
  } finally {await peer.query("ROLLBACK").catch(()=>{});await peer.end();await operation;}
});

test("precommit deferred constraint execution consumes the remaining statement budget",async t=>{
  const row=randomUUID(),start=performance.now();let inserted=false;
  await assert.rejects(withSettlementFencePrototype(randomUUID(),async()=>{},async query=>{await query("LOCK TABLE public.invoices IN SHARE MODE NOWAIT");await query(`INSERT INTO app.b011_fence_test_sleep(id) VALUES($1)`,[row]);inserted=true;}),(error:unknown)=>(error as {cause?:{code?:string}}).cause?.code==="57014");
  const elapsed=performance.now()-start;assert.equal(inserted,true);assert.ok(elapsed<2500);assert.equal(Number((await db.query(`SELECT count(*) AS n FROM app.b011_fence_test_sleep WHERE id=$1`,[row])).rows[0].n),0);
  await db.query("BEGIN");await db.query("LOCK TABLE public.invoices IN ROW EXCLUSIVE MODE NOWAIT");await db.query("ROLLBACK");t.diagnostic(`Synthetic deferred statement cancelled after ${Math.round(elapsed)} ms`);
});
test("active SQL followed by idle callback shares one fence deadline",async t=>{
  const peer=new Client({connectionString:withDatabase(source,name)});await peer.connect();
  let ready!:()=>void;const activeComplete=new Promise<void>(resolve=>{ready=resolve;});
  const start=performance.now();let callbackResumed=false;
  const operation=withSettlementFencePrototype(randomUUID(),async()=>{},async query=>{await query("LOCK TABLE public.invoices IN SHARE MODE NOWAIT");await query("SELECT pg_sleep(0.9)");ready();await new Promise(resolve=>setTimeout(resolve,3000));callbackResumed=true;}).then(()=>null,error=>error);
  try {
    await activeComplete;await peer.query("BEGIN");const pid=(await peer.query<{pid:number}>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const pending=peer.query("LOCK TABLE public.invoices IN ROW EXCLUSIVE MODE");let blocked=false;
    for(let n=0;n<20&&!blocked;n++){await new Promise(resolve=>setTimeout(resolve,20));blocked=(await db.query<{blocked:boolean}>(`SELECT cardinality(pg_blocking_pids($1))>0 AS blocked`,[pid])).rows[0].blocked;}
    assert.ok(blocked);await pending;const released=performance.now()-start;assert.ok(released<2000);assert.equal(callbackResumed,false);await peer.query("ROLLBACK");assert.ok(await operation);
    t.diagnostic(`Synthetic active-then-idle fence released after ${Math.round(released)} ms`);
  } finally {await peer.query("ROLLBACK").catch(()=>{});await peer.end();await operation;}
});
