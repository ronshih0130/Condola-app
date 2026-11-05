import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { Client } from "pg";
import { ORG_ID, USERS } from "./ids";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { resetAndSeed } from "./seed";

disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>;
let payment: {id:string;lease_id:string};
const sid=randomUUID();
const sandbox=randomUUID();

test.before(async()=>{
  clone=await cloneTestDatabase();
  const demo=process.env.DEMO_MODE,key=process.env.ID_DOC_ENCRYPTION_KEY;
  try {
    process.env.DEMO_MODE="true";
    process.env.ID_DOC_ENCRYPTION_KEY=randomBytes(32).toString("hex");
    await resetAndSeed();
  } finally {
    if(demo===undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE=demo;
    if(key===undefined) delete process.env.ID_DOC_ENCRYPTION_KEY; else process.env.ID_DOC_ENCRYPTION_KEY=key;
  }
  const c=new Client({connectionString:process.env.DATABASE_URL});
  await c.connect();
  try {
    payment=(await c.query<{id:string;lease_id:string}>(
      `SELECT id::text,lease_id::text FROM payments WHERE org_id=$1 AND status='confirmed' LIMIT 1`,[ORG_ID])).rows[0];
    assert.ok(payment);
    await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at)
      VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
    // Preserve required organization columns from the seeded live organization.
    await c.query(`INSERT INTO organizations
      SELECT (jsonb_populate_record(NULL::organizations,to_jsonb(o) ||
        jsonb_build_object('id',$2::uuid,'environment','sandbox','live_org_id',o.id))).*
      FROM organizations o WHERE o.id=$1`,[ORG_ID,sandbox]);
    await c.query(`UPDATE organizations SET feature_flags=feature_flags ||
      '{"payment_results_v2":true,"rent_reminders_v2":true}'::jsonb
      WHERE id IN ($1,$2)`,[ORG_ID,sandbox]);
    await c.query(`UPDATE platform_settings SET value=jsonb_build_object(
      'enabled',true,'allowed_org_ids',jsonb_build_array($1::text,$2::text))
      WHERE key IN ('payment_results_v2','rent_reminders_v2')`,[ORG_ID,sandbox]);
  } finally {await c.end();}
});
test.after(async()=>{if(clone) await clone.cleanup();});

type Scope = "live" | "sandbox";
type Holder = "platform" | "org" | "live twin" | "member" | "session" | "lease";
type Outcome = {error:unknown;elapsed:number};

async function begin(c:Client) {
  await c.query("BEGIN");
  await c.query("SET LOCAL statement_timeout='11s'");
  await c.query("SET LOCAL lock_timeout='9s'");
  await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);
}

async function scope(c:Client,environment:Scope) {
  if(environment==="sandbox") {
    // Keep the seeded financial graph intact; copy the required business fields
    // into a fresh sandbox lease/payment pair without moving existing children.
    await c.query(`INSERT INTO leases
      SELECT (jsonb_populate_record(NULL::leases,to_jsonb(l) ||
        jsonb_build_object('id',$2::uuid,'org_id',$3::uuid))).*
      FROM leases l WHERE l.id=$1`,[payment.lease_id,sandboxLease,sandbox]);
    await c.query(`INSERT INTO payments
      SELECT (jsonb_populate_record(NULL::payments,to_jsonb(p) ||
        jsonb_build_object('id',$2::uuid,'org_id',$3::uuid,'lease_id',$4::uuid,
          'status','submitted','ledger_transaction_id',NULL))).*
      FROM payments p WHERE p.id=$1`,[payment.id,sandboxPayment,sandbox,sandboxLease]);
  }
}

async function context(c:Client,environment:Scope) {
  const org=environment==="live"?ORG_ID:sandbox;
  const result=await c.query<{enabled:boolean}>(
    `SELECT app.b010_lock_payment_context($1,$2,$3,$4,$5,'admin') AS enabled`,
    [org,ORG_ID,environment,sid,payment.lease_id]);
  assert.equal(result.rows[0].enabled,true);
}

async function hold(c:Client,holder:Holder,environment:Scope) {
  const org=environment==="live"?ORG_ID:sandbox;
  if(holder==="platform") {
    await c.query("LOCK TABLE public.platform_settings IN SHARE ROW EXCLUSIVE MODE");
  } else if(holder==="org" || holder==="live twin") {
    await c.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE",
      [holder==="live twin"?ORG_ID:org]);
  } else if(holder==="member") {
    assert.equal((await c.query(`SELECT id FROM org_members
      WHERE org_id=$1 AND user_id=$2 AND status='active' AND role='admin' FOR UPDATE`,
      [ORG_ID,USERS.admin])).rowCount,1);
  } else if(holder==="session") {
    await c.query("SELECT id FROM auth_sessions WHERE id=$1 FOR UPDATE",[sid]);
  } else {
    await c.query("SELECT id FROM leases WHERE id=$1 FOR UPDATE",[payment.lease_id]);
  }
}

async function measured(action:()=>Promise<unknown>):Promise<Outcome> {
  const started=performance.now();
  try {await action();return {error:undefined,elapsed:performance.now()-started};}
  catch(error) {return {error,elapsed:performance.now()-started};}
}

function code(outcome:Outcome) {
  return (outcome.error as {code?:string}|undefined)?.code;
}

async function inversion(holder:Holder,environment:Scope,release:boolean) {
  const a=new Client({connectionString:process.env.DATABASE_URL});
  const b=new Client({connectionString:process.env.DATABASE_URL});
  await a.connect(); await b.connect();
  let ap:Promise<Outcome>|undefined,bp:Promise<Outcome>|undefined;
  try {
    // Sandbox fixture rows must be visible to both sessions. They are created
    // only in the disposable clone, then deleted after both transactions.
    await scope(a,environment);
    const fixture=environment==="sandbox"
      ? {id:sandboxPayment,lease_id:sandboxLease}:payment;
    await begin(a); await begin(b);

    // A owns the child before requesting context. B owns the opposite-order
    // control/authorization lock and then requests that child. Polling must
    // release partial locks, allowing the six-second loser to unwind.
    await a.query("SELECT id FROM payments WHERE id=$1 FOR UPDATE",[fixture.id]);
    await holdFixture(b,holder,environment,fixture.lease_id);
    ap=measured(async()=>{
      const org=environment==="live"?ORG_ID:sandbox;
      const r=await a.query<{enabled:boolean}>(
        `SELECT app.b010_lock_payment_context($1,$2,$3,$4,$5,'admin') AS enabled`,
        [org,ORG_ID,environment,sid,fixture.lease_id]);
      assert.equal(r.rows[0].enabled,true);
      await a.query(`UPDATE payments SET status=$2 WHERE id=$1`,
        [fixture.id,environment==="sandbox"?"rejected":"reversed"]);
    });
    if(release) {
      await new Promise(resolve=>setTimeout(resolve,2000));
      await b.query("ROLLBACK");
    } else {
      bp=measured(async()=>{
        await b.query("SELECT id FROM payments WHERE id=$1 FOR UPDATE",[fixture.id]);
      });
    }
    const ao=await ap;
    assert.notEqual(code(ao),"40P01");
    if(release) {
      if(ao.error) throw ao.error;
      assert.ok(ao.elapsed>=1800 && ao.elapsed<7000,`${ao.elapsed}ms`);
    } else {
      assert.equal(code(ao),"55P03");
      assert.ok(ao.elapsed>=5900 && ao.elapsed<7200,`${ao.elapsed}ms`);
    }
    await a.query("ROLLBACK");
    if(bp) {
      const bo=await bp;
      assert.notEqual(code(bo),"40P01");
      if(bo.error) throw bo.error;
    }
  } finally {
    // End A first so an outstanding B child-row request can settle.
    await a.query("ROLLBACK");
    if(ap) await ap;
    if(bp) await bp;
    await b.query("ROLLBACK");
    if(environment==="sandbox") {
      await a.query("DELETE FROM payments WHERE id=$1",[sandboxPayment]);
      await a.query("DELETE FROM leases WHERE id=$1",[sandboxLease]);
    }
    await a.end(); await b.end();
  }
}

const sandboxLease=randomUUID(),sandboxPayment=randomUUID();

async function holdFixture(c:Client,holder:Holder,environment:Scope,lease:string) {
  if(holder==="lease") {
    await c.query("SELECT id FROM leases WHERE id=$1 FOR UPDATE",[lease]);
  } else {
    await hold(c,holder,environment);
  }
}

for(const environment of ["live","sandbox"] as const) {
  for(const holder of ["platform","org","live twin","member","session","lease"] as const) {
    if(environment==="live" && holder==="live twin") continue;
    for(const release of [false,true]) {
      test(`C1 r3 ${environment} ${holder}: ${release?"release":"bounded loser"}`,
        {timeout:20000},async()=>{await inversion(holder,environment,release);});
    }
  }
}

test("C2 runbook evidence: implicit payments relation lock waits until DDL-like holder releases",
  {timeout:15000},async()=>{
    const a=new Client({connectionString:process.env.DATABASE_URL});
    const b=new Client({connectionString:process.env.DATABASE_URL});
    await a.connect(); await b.connect();
    let pending:Promise<Outcome>|undefined;
    try {
      await begin(a); await begin(b);
      await context(a,"live");
      await b.query("LOCK TABLE public.payments IN ACCESS EXCLUSIVE MODE");
      pending=measured(async()=>{
        await a.query("UPDATE payments SET status='reversed' WHERE id=$1",[payment.id]);
      });
      await new Promise(resolve=>setTimeout(resolve,2000));
      await b.query("ROLLBACK");
      const outcome=await pending;
      assert.notEqual(code(outcome),"40P01");
      if(outcome.error) assert.equal(code(outcome),"55P03");
      else assert.ok(outcome.elapsed>=1800,`implicit wait absent: ${outcome.elapsed}ms`);
      assert.ok(outcome.elapsed<7000,`implicit wait exceeded release bound: ${outcome.elapsed}ms`);
      // Explicit NOWAIT polling cannot bound the UPDATE's implicit relation
      // lock. Release and statement_timeout provide this test's outer bound.
    } finally {
      await b.query("ROLLBACK");
      if(pending) await pending;
      await a.query("ROLLBACK");
      await a.end(); await b.end();
    }
  });
