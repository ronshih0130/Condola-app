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
let invoice: string;
const sid=randomUUID();

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
    invoice=(await c.query<{id:string}>(
      `SELECT id::text FROM invoices WHERE org_id=$1 AND lease_id=$2 LIMIT 1`,[ORG_ID,payment.lease_id])).rows[0].id;
    await c.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at)
      VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[sid,USERS.admin,randomUUID()]);
  } finally {await c.end();}
});
test.after(async()=>{if(clone) await clone.cleanup();});

type Holder = "platform" | "org";
type Operation = "payment insert" | "payment transition" | "context" | "admin claim" | "tenant claim";

async function switches(c:Client,enabled:boolean) {
  await c.query(`UPDATE organizations SET feature_flags=feature_flags ||
    jsonb_build_object('payment_results_v2',$2::boolean,'rent_reminders_v2',$2::boolean) WHERE id=$1`,[ORG_ID,enabled]);
  await c.query(`UPDATE platform_settings SET value=jsonb_build_object(
    'enabled',$2::boolean,'allowed_org_ids',jsonb_build_array($1::text))
    WHERE key IN ('payment_results_v2','rent_reminders_v2')`,[ORG_ID,enabled]);
}

async function write(c:Client,operation:Operation) {
  if(operation==="context") {
    return c.query<{enabled:boolean}>(`SELECT app.b010_lock_payment_context($1,$1,'live',$2,$3,'admin') AS enabled`,
      [ORG_ID,sid,payment.lease_id]);
  }
  if(operation==="payment transition") {
    return c.query(`UPDATE payments SET status='reversed' WHERE id=$1`,[payment.id]);
  }
  if(operation==="payment insert") {
    // Copy the seeded row's required business fields without sharing its identity
    // or ledger transaction. Every attempt is rolled back.
    return c.query(`INSERT INTO payments
      SELECT (jsonb_populate_record(NULL::payments,to_jsonb(p) ||
        jsonb_build_object('id',$2::uuid,'status','confirmed','ledger_transaction_id',NULL))).*
      FROM payments p WHERE p.id=$1`,[payment.id,randomUUID()]);
  }
  return c.query(`INSERT INTO email_log(org_id,kind,target_id,threshold)
    VALUES($1,$2,$3,1)`,[ORG_ID,operation==="admin claim"?"rent_overdue_admin":"rent_overdue_tenant",invoice]);
}

async function scenario(holder:Holder,operation:Operation,mode:"off"|"release"|"timeout"|"disable") {
  const owner=new Client({connectionString:process.env.DATABASE_URL});
  const writer=new Client({connectionString:process.env.DATABASE_URL});
  await owner.connect();
  await writer.connect();
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await switches(owner,mode!=="off");
    await owner.query("BEGIN");
    if(holder==="platform") await owner.query("LOCK TABLE public.platform_settings IN EXCLUSIVE MODE");
    // A non-key control update conflicts with the rollout's FOR SHARE lock
    // while allowing the legacy email_log foreign key's FOR KEY SHARE lock.
    else await owner.query("SELECT id FROM organizations WHERE id=$1 FOR NO KEY UPDATE",[ORG_ID]);
    if(mode==="disable") {
      if(holder==="platform") {
        await owner.query(`UPDATE platform_settings SET value=jsonb_set(value,'{enabled}','false'::jsonb)
          WHERE key IN ('payment_results_v2','rent_reminders_v2')`);
      } else {
        await owner.query(`UPDATE organizations SET feature_flags=feature_flags ||
          '{"payment_results_v2":false,"rent_reminders_v2":false}'::jsonb WHERE id=$1`,[ORG_ID]);
      }
    }

    await writer.query("BEGIN");
    await writer.query("SET LOCAL statement_timeout='12s'");
    await writer.query("SET LOCAL lock_timeout='9s'");
    await writer.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.admin]);
    await writer.query("SET LOCAL ROLE service_role");

    const started=performance.now();
    // Attach both settlement handlers immediately, including for expected errors.
    const pending=write(writer,operation).then(
      result=>({result,error:undefined}),
      (error:unknown)=>({result:undefined,error}),
    );
    let released:Promise<unknown> | undefined;
    if(mode==="release" || mode==="disable") {
      released=new Promise<void>((resolve,reject)=>{
        releaseTimer=setTimeout(()=>{
          owner.query(mode==="disable"?"COMMIT":"ROLLBACK").then(()=>resolve(),reject);
        },300);
      });
    }
    const outcome=await pending;
    const elapsed=performance.now()-started;
    if(released) await released;

    if(mode==="timeout") {
      assert.equal((outcome.error as {code?:string}|undefined)?.code,"55P03");
      assert.ok(elapsed>=5900,`retry budget ended early: ${elapsed}ms`);
      assert.ok(elapsed<11000,`lock wait exceeded budget: ${elapsed}ms`);
    } else {
      if(outcome.error) throw outcome.error;
      if(mode==="off") assert.ok(elapsed<1000,`OFF write waited ${elapsed}ms`);
      else {
        assert.ok(elapsed>=200,`enabled write did not wait: ${elapsed}ms`);
        assert.ok(elapsed<2000,`released write waited ${elapsed}ms`);
      }
      if(operation==="context") {
        assert.equal(outcome.result?.rows[0].enabled,mode==="release");
      }
      assert.equal((await writer.query<{value:string}>(
        `SELECT current_setting('lock_timeout') AS value`)).rows[0].value,"9s");
    }
  } finally {
    if(releaseTimer) clearTimeout(releaseTimer);
    await writer.query("ROLLBACK");
    await owner.query("ROLLBACK");
    await writer.end();
    await owner.end();
  }
}

for(const holder of ["platform","org"] as const) {
  for(const operation of ["payment insert","payment transition","context","admin claim","tenant claim"] as const) {
    test(`OFF ${operation} bypasses held ${holder} lock`,async()=>{
      await scenario(holder,operation,"off");
    });
    test(`ON ${operation} exhausts bounded ${holder} lock retries`,async()=>{
      await scenario(holder,operation,"timeout");
    });
    test(`${operation} rechecks OFF after waiting for ${holder}`,async()=>{
      await scenario(holder,operation,"disable");
    });
    if(operation==="context" || operation==="payment insert" || operation==="payment transition") {
      // Payment statements succeed; rollback avoids committing an incomplete
      // financial transition without its required event and ledger evidence.
      test(`ON ${operation} succeeds after ${holder} lock release`,async()=>{
        await scenario(holder,operation,"release");
      });
    } else {
      test(`ON ${operation} waits then preserves the legacy fence after ${holder} release`,async()=>{
        const owner=new Client({connectionString:process.env.DATABASE_URL});
        const writer=new Client({connectionString:process.env.DATABASE_URL});
        await owner.connect(); await writer.connect();
        try {
          await switches(owner,true);
          await owner.query("BEGIN");
          if(holder==="platform") await owner.query("LOCK TABLE public.platform_settings IN EXCLUSIVE MODE");
          else await owner.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE",[ORG_ID]);
          await writer.query("BEGIN");
          await writer.query("SET LOCAL statement_timeout='12s'");
          const started=performance.now();
          const pending=write(writer,operation).then(
            ()=>undefined,(e:unknown)=>e,
          );
          await new Promise(resolve=>setTimeout(resolve,300));
          await owner.query("ROLLBACK");
          assert.equal(((await pending) as {code?:string})?.code,"42501");
          assert.ok(performance.now()-started>=200);
          assert.ok(performance.now()-started<2000);
        } finally {
          await writer.query("ROLLBACK"); await owner.query("ROLLBACK");
          await writer.end(); await owner.end();
        }
      });
    }
  }
}
