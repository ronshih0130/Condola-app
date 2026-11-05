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

// Two independent contention budgets, plus scheduling/query overhead.
const S4_TRANSACTION_BOUND_MS=14000;

type ParentFixture = {schema:string;table:string;id:string};
const sandboxParents:ParentFixture[]=[];
const sandboxParentIds=new Map<string,string>();

function identifier(value:string) {
  return `"${value.replaceAll('"','""')}"`;
}

// Clone organization-scoped FK parents without assuming their business
// columns or copying generated columns. Global FK parents remain shared.
async function sandboxReferences(
  c:Client,table:string,source:Record<string,unknown>,
):Promise<Record<string,unknown>> {
  const overrides:Record<string,unknown>={org_id:sandbox};
  const references=await c.query<{
    schema:string;table:string;source_column:string;target_column:string;
  }>(`
    SELECT ns.nspname AS schema,parent.relname AS table,
      child_column.attname AS source_column,
      parent_column.attname AS target_column
    FROM pg_constraint fk
    JOIN pg_class parent ON parent.oid=fk.confrelid
    JOIN pg_namespace ns ON ns.oid=parent.relnamespace
    JOIN LATERAL unnest(fk.conkey,fk.confkey)
      AS keys(child_attnum,parent_attnum) ON true
    JOIN pg_attribute child_column
      ON child_column.attrelid=fk.conrelid
      AND child_column.attnum=keys.child_attnum
    JOIN pg_attribute parent_column
      ON parent_column.attrelid=fk.confrelid
      AND parent_column.attnum=keys.parent_attnum
    WHERE fk.contype='f'
      AND fk.conrelid=$1::regclass
      AND child_column.attname<>'org_id'
      AND EXISTS (
        SELECT 1
        FROM unnest(fk.conkey,fk.confkey) AS org_keys(child_attnum,parent_attnum)
        JOIN pg_attribute ca ON ca.attrelid=fk.conrelid
          AND ca.attnum=org_keys.child_attnum
        JOIN pg_attribute pa ON pa.attrelid=fk.confrelid
          AND pa.attnum=org_keys.parent_attnum
        WHERE ca.attname='org_id' AND pa.attname='org_id'
      )
    ORDER BY fk.oid,keys.child_attnum
  `,[table]);
  for(const reference of references.rows) {
    const value=source[reference.source_column];
    if(value===null || value===undefined) continue;
    if(reference.target_column!=="id") {
      throw new Error(`Unsupported sandbox FK: ${table}.${reference.source_column}`);
    }
    const qualified=`${identifier(reference.schema)}.${identifier(reference.table)}`;
    const key=JSON.stringify([qualified,source.org_id,value]);
    let id=sandboxParentIds.get(key);
    if(!id) {
      const parent=(await c.query<{row:Record<string,unknown>}>(
        `SELECT to_jsonb(p) AS row FROM ${qualified} p WHERE org_id=$1 AND id=$2`,
        [source.org_id,value])).rows[0]?.row;
      assert.ok(parent,`Missing fixture parent: ${qualified}`);
      const parentOverrides=await sandboxReferences(c,qualified,parent);
      id=randomUUID();
      const columns=(await c.query<{name:string}>(`
        SELECT attname AS name FROM pg_attribute
        WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped
          AND attgenerated='' AND attidentity=''
        ORDER BY attnum
      `,[qualified])).rows.map(({name})=>identifier(name));
      await c.query(`
        INSERT INTO ${qualified} (${columns.join(",")})
        SELECT ${columns.map(name=>`r.${name}`).join(",")}
        FROM jsonb_populate_record(NULL::${qualified},$1::jsonb) r
      `,[JSON.stringify({...parent,...parentOverrides,id,org_id:sandbox})]);
      sandboxParentIds.set(key,id);
      sandboxParents.push({schema:reference.schema,table:reference.table,id});
    }
    overrides[reference.source_column]=id;
  }
  return overrides;
}

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
    const lease=(await c.query<{row:Record<string,unknown>}>(
      "SELECT to_jsonb(l) AS row FROM public.leases l WHERE id=$1",
      [payment.lease_id])).rows[0].row;
    const leaseOverrides=await sandboxReferences(c,"public.leases",lease);
    await c.query(`INSERT INTO public.leases (
      id,org_id,property_id,unit_id,target_unit_id,target_room_id,status,
      esign_status,start_date,end_date,currency,rent_amount_minor,
      rent_frequency,due_day,prorate_first_period,deposit_amount_minor,
      deposit_months,late_fee_rule_id,template_version_id,template_variables,
      document_file_id,document_sha256,date_calendar,document_locales,
      signed_at,previous_lease_id,renewal_status,renewal_reminder_days,
      terminated_on,termination_reason,deposit_settled_at,notes,created_by,
      created_at,updated_at,deposit_override_reason,deposit_overridden_by,
      deposit_overridden_at,idempotency_key,moved_out_on,payee_bank_account_id,
      id_retention_auto_end,first_period_basis
    )
    SELECT
      $2::uuid,$3::uuid,r.property_id,r.unit_id,r.target_unit_id,
      r.target_room_id,r.status,r.esign_status,r.start_date,r.end_date,
      r.currency,r.rent_amount_minor,r.rent_frequency,r.due_day,
      r.prorate_first_period,r.deposit_amount_minor,r.deposit_months,
      r.late_fee_rule_id,r.template_version_id,r.template_variables,
      r.document_file_id,r.document_sha256,r.date_calendar,r.document_locales,
      r.signed_at,r.previous_lease_id,r.renewal_status,r.renewal_reminder_days,
      r.terminated_on,r.termination_reason,r.deposit_settled_at,r.notes,
      r.created_by,r.created_at,r.updated_at,r.deposit_override_reason,
      r.deposit_overridden_by,r.deposit_overridden_at,r.idempotency_key,
      r.moved_out_on,r.payee_bank_account_id,r.id_retention_auto_end,
      r.first_period_basis
    FROM public.leases l
    CROSS JOIN LATERAL jsonb_populate_record(
      NULL::public.leases,to_jsonb(l) || $4::jsonb
    ) r
    WHERE l.id=$1`,
    [payment.lease_id,sandboxLease,sandbox,JSON.stringify(leaseOverrides)]);
    sandboxParentIds.set(
      JSON.stringify(['"public"."leases"',lease.org_id,payment.lease_id]),
      sandboxLease);
    const original=(await c.query<{row:Record<string,unknown>}>(
      "SELECT to_jsonb(p) AS row FROM public.payments p WHERE id=$1",
      [payment.id])).rows[0].row;
    const paymentOverrides=await sandboxReferences(c,"public.payments",{
      ...original,ledger_transaction_id:null,
    });
    await c.query(`INSERT INTO payments
      SELECT (jsonb_populate_record(NULL::payments,to_jsonb(p) ||
        $5::jsonb ||
        jsonb_build_object('id',$2::uuid,'org_id',$3::uuid,'lease_id',$4::uuid,
          'status','submitted','ledger_transaction_id',NULL))).*
      FROM payments p WHERE p.id=$1`,
      [payment.id,sandboxPayment,sandbox,sandboxLease,JSON.stringify(paymentOverrides)]);
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
      await a.query(`UPDATE payments SET status=$2::public.payment_status, rejected_reason=CASE WHEN $2::public.payment_status='rejected' THEN 'b010 inversion test' ELSE rejected_reason END WHERE id=$1`,
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
      assert.ok(ao.elapsed>=1800 && ao.elapsed<=S4_TRANSACTION_BOUND_MS,`${ao.elapsed}ms`);
    } else {
      assert.equal(code(ao),"55P03");
      assert.ok(ao.elapsed>=5900 && ao.elapsed<=S4_TRANSACTION_BOUND_MS,`${ao.elapsed}ms`);
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
      for(const parent of sandboxParents.toReversed()) {
        await a.query(
          `DELETE FROM ${identifier(parent.schema)}.${identifier(parent.table)} WHERE id=$1 AND org_id=$2`,
          [parent.id,sandbox]);
      }
      sandboxParents.length=0;
      sandboxParentIds.clear();
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
