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
const busy=(e:unknown)=>(e as {code?:string}).code==='55P03';
const fence=`LOCK TABLE app.b010_payment_commands IN SHARE ROW EXCLUSIVE MODE NOWAIT`;

test('real B010 store and proposed local command fence conflict in both orders',async()=>{
 const a=new Client({connectionString:process.env.DATABASE_URL}),b=new Client({connectionString:process.env.DATABASE_URL});await a.connect();await b.connect();
 try {
  const p=(await b.query<{id:string;lease:string}>(`SELECT id::text,lease_id::text lease FROM payments WHERE org_id=$1 AND status='confirmed' LIMIT 1`,[ORG_ID])).rows[0];assert.ok(p);
  const prepare=async()=>{await b.query('BEGIN');await b.query(`INSERT INTO app.b010_payment_requirements(tx_id,org_id,lease_id,payment_id,kind,actor_id) VALUES(txid_current(),$1,$2,$3,'payment_confirmed',$4)`,[ORG_ID,p.lease,p.id,USERS.admin]);await b.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);await b.query('SET LOCAL ROLE authenticated');};
  await prepare();await b.query(`SELECT app.b010_payment_command_store($1,$2,$3,$4)`,[ORG_ID,randomUUID(),'a'.repeat(64),p.id]);await a.query('BEGIN');await assert.rejects(a.query(fence),busy);await a.query('ROLLBACK');await b.query('ROLLBACK');
  await prepare();await a.query('BEGIN');await a.query(fence);await b.query(`SET LOCAL lock_timeout='50ms'`);await assert.rejects(b.query(`SELECT app.b010_payment_command_store($1,$2,$3,$4)`,[ORG_ID,randomUUID(),'a'.repeat(64),p.id]),busy);await b.query('ROLLBACK');await a.query('ROLLBACK');
  assert.equal((await a.query(`SELECT 1 FROM app.b010_payment_commands WHERE org_id=$1 AND payment_id=$2`,[ORG_ID,p.id])).rowCount,0);
 } finally {await a.end();await b.end();}
});

test('command relation fence is compatible with row lock but tuple NOWAIT fails',async()=>{
 const a=new Client({connectionString:process.env.DATABASE_URL}),b=new Client({connectionString:process.env.DATABASE_URL});await a.connect();await b.connect();
 try {const p=(await a.query<{id:string}>(`SELECT id::text FROM payments WHERE org_id=$1 AND status='confirmed' LIMIT 1`,[ORG_ID])).rows[0];assert.ok(p);const key=randomUUID();await a.query(`INSERT INTO app.b010_payment_commands(org_id,actor_id,request_id,payload_digest,payment_id) VALUES($1,$2,$3,$4,$5)`,[ORG_ID,USERS.admin,key,'b'.repeat(64),p.id]);
  await b.query('BEGIN');await b.query(`SELECT request_id FROM app.b010_payment_commands WHERE org_id=$1 AND actor_id=$2 AND request_id=$3 FOR UPDATE`,[ORG_ID,USERS.admin,key]);await a.query('BEGIN');await a.query(fence);await assert.rejects(a.query(`SELECT request_id FROM app.b010_payment_commands WHERE org_id=$1 AND actor_id=$2 AND request_id=$3 FOR SHARE NOWAIT`,[ORG_ID,USERS.admin,key]),busy);await a.query('ROLLBACK');await b.query('ROLLBACK');
 } finally {await a.end();await b.end();}
});
