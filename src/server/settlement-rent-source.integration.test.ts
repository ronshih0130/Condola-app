import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { disposableDbUrl,withDatabase } from "./test-disposable-db";
import { resetAndSeed } from "./seed";
import { scanRentSourcesUnderFence } from "./settlement-rent-source";
const source=disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let admin:Client,db:Client,name:string,owned=false,previous:string|undefined;
test.before(async()=>{const template=decodeURIComponent(source.pathname.slice(1));if(!/^[a-z][a-z0-9_]{0,62}$/.test(template))throw new Error("Invalid template");name=`condola_b011_${randomUUID().replaceAll("-","")}`;admin=new Client({connectionString:withDatabase(source,"postgres")});await admin.connect();await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);owned=true;db=new Client({connectionString:withDatabase(source,name)});await db.connect();previous=process.env.DATABASE_URL;process.env.DATABASE_URL=withDatabase(source,name);await resetAndSeed();});
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
