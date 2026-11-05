import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { ORG_ID, USERS } from "./ids";
import { resetAndSeed } from "./seed";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";

const source=disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
const centerTables=["b028_center_mark_contexts","b028_center_cursors","b028_center_reads","b028_center_recipients","b028_center_events"] as const;

async function producerTables(db:Client) {
  return (await db.query<{present:boolean}>(`SELECT to_regclass('app.b017_occurrences') IS NOT NULL AS present`)).rows[0].present;
}

async function sourceFingerprint() {
  const parent=new Client({connectionString:source.href}); await parent.connect();
  try {const base=(await parent.query<{digest:string}>(`SELECT md5(jsonb_build_object(
    'orgs',(SELECT coalesce(jsonb_agg(jsonb_build_array(id,environment,feature_flags) ORDER BY id),'[]'::jsonb) FROM organizations),
    'leases',(SELECT coalesce(jsonb_agg(jsonb_build_array(id,org_id,status) ORDER BY id),'[]'::jsonb) FROM leases),
    'settings',(SELECT coalesce(jsonb_agg(jsonb_build_array(key,value) ORDER BY key),'[]'::jsonb) FROM platform_settings),
    'users',(SELECT count(*) FROM auth.users),'b010',(SELECT count(*) FROM app.b010_source_events),
    'center',(SELECT count(*) FROM app.b028_center_events),'handover_gc',(SELECT count(*) FROM app.handover_gc_tombstones))::text) AS digest`)).rows[0].digest;
    if(!await producerTables(parent)) return base;
    const extra=(await parent.query<{digest:string}>(`SELECT md5(jsonb_build_object(
      'occurrences',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]'::jsonb) FROM app.b017_occurrences x),
      'resolutions',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]'::jsonb) FROM app.b017_center_resolutions x),
      'old_transactions',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY source_id),'[]'::jsonb) FROM app.b017_old_source_transactions x))::text) AS digest`)).rows[0].digest;
    return `${base}:${extra}`;
  }
  finally {await parent.end();}
}

async function withOwned<T>(fn:(db:Client)=>Promise<T>) {
  const before=await sourceFingerprint();
  const clone=await cloneTestDatabase();
  const oldDemo=process.env.DEMO_MODE,oldKey=process.env.ID_DOC_ENCRYPTION_KEY;
  process.env.DEMO_MODE="true"; process.env.ID_DOC_ENCRYPTION_KEY=randomBytes(32).toString("hex");
  const db=new Client({connectionString:process.env.DATABASE_URL});
  try {await db.connect(); return await fn(db);}
  finally {
    await db.end().catch(()=>{});
    if(oldDemo===undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE=oldDemo;
    if(oldKey===undefined) delete process.env.ID_DOC_ENCRYPTION_KEY; else process.env.ID_DOC_ENCRYPTION_KEY=oldKey;
    await clone.cleanup();
    assert.equal(await sourceFingerprint(),before,"source database changed");
  }
}

async function fixture(db:Client) {
  await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='notification_center_v2'`,[ORG_ID]);
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"notification_center_v2":true}'::jsonb WHERE id=$1`,[ORG_ID]);
  const lease=(await db.query<{lease_id:string;invoice_id:string}>(`SELECT l.id::text lease_id,i.id::text invoice_id FROM leases l JOIN invoices i ON i.lease_id=l.id AND i.org_id=l.org_id WHERE l.org_id=$1 LIMIT 1`,[ORG_ID])).rows[0]; assert.ok(lease);
  const member=(await db.query<{id:string}>(`SELECT id::text FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='active' AND role='manager'`,[ORG_ID,USERS.manager])).rows[0]; assert.ok(member);
  const session=randomUUID(); await db.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[session,USERS.manager,randomUUID()]);
  const producer=await producerTables(db);
  const sources:{id:string;neutral:boolean}[]=[];
  let first:string|null=null;
  await db.query('BEGIN');
  try {
    for(let n=0;n<100;n++) {
      const neutral=producer && n%2===1;
      const b=(await db.query<{id:string;at:string}>(neutral
        ? `INSERT INTO app.b017_occurrences(org_id,lease_id,invoice_id,kind,occurrence_key,local_date,occurred_at) VALUES($1,$2,$3,'rent_due',$4,current_date,clock_timestamp()) RETURNING id::text,occurred_at::text at`
        : `INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date) VALUES($1,$2,$3,'rent_due',$4,current_date) RETURNING id::text,created_at::text at`,[ORG_ID,lease.lease_id,lease.invoice_id,randomUUID()])).rows[0];
      sources.push({id:b.id,neutral});
      const e=(await db.query<{id:string}>(neutral
        ? `INSERT INTO app.b028_center_events(org_id,kind,neutral_source_id,occurred_at) VALUES($1,'rent_due',$2,$3) RETURNING id::text`
        : `INSERT INTO app.b028_center_events(org_id,kind,b010_event_id,occurred_at) VALUES($1,'rent_due',$2,$3) RETURNING id::text`,[ORG_ID,b.id,b.at])).rows[0];
      const recipient=(await db.query<{id:string}>(`INSERT INTO app.b028_center_recipients(org_id,event_id,persona,principal_user_id,member_id) VALUES($1,$2,'staff',$3,$4) RETURNING id::text`,[ORG_ID,e.id,USERS.manager,member.id])).rows[0];
      first ??= recipient.id;
    }
    await db.query('COMMIT');
  } catch(error) {await db.query('ROLLBACK'); throw error;}
  assert.ok(first);
  if(producer) {
    for(const item of sources) {
      const resolution=await db.query(item.neutral ? `SELECT * FROM app.b017_resolve_neutral($1,$2)` : `SELECT * FROM app.b017_resolve_history($1,$2)`,[ORG_ID,item.id]);
      assert.equal(resolution.rows[0].outcome,'existing_center');
    }
    for(const neutral of [false,true]) {
      const orphan=(await db.query<{id:string}>(neutral
        ? `INSERT INTO app.b017_occurrences(org_id,lease_id,invoice_id,kind,occurrence_key,local_date,occurred_at) VALUES($1,$2,$3,'rent_overdue',$4,current_date,clock_timestamp()) RETURNING id::text`
        : `INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date) VALUES($1,$2,$3,'rent_overdue',$4,current_date) RETURNING id::text`,[ORG_ID,lease.lease_id,lease.invoice_id,randomUUID()])).rows[0];
      const resolution=await db.query(neutral ? `SELECT * FROM app.b017_resolve_neutral($1,$2)` : `SELECT * FROM app.b017_resolve_history($1,$2)`,[ORG_ID,orphan.id]);
      assert.deepEqual(resolution.rows,[{outcome:'no_backfill',center_event_id:null}]);
    }
    for(const [table,count] of [['b017_center_resolutions',102],['b017_occurrences',51],['b017_old_source_transactions',51]] as const) {
      assert.equal(Number((await db.query(`SELECT count(*) AS n FROM app.${table}`)).rows[0].n),count,table);
    }
  }
  await db.query('BEGIN'); await db.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.manager]); await db.query('SET LOCAL ROLE service_role');
  const page=await db.query<{continuation:string|null}>(`SELECT continuation::text FROM app.b028_center_session($1,$1,'live',$2,'staff','manager',NULL,NULL)`,[ORG_ID,session]);
  assert.ok(page.rows.some(row=>row.continuation));
  await db.query(`SELECT * FROM app.b028_center_session($1,$1,'live',$2,'staff','manager',$3,NULL)`,[ORG_ID,session,first]);
  await db.query('RESET ROLE');
  assert.equal(Number((await db.query(`SELECT count(*) AS n FROM app.b028_center_mark_contexts`)).rows[0].n),1);
  await db.query('SET CONSTRAINTS app.b028_center_mark_commit IMMEDIATE');
  assert.equal(Number((await db.query(`SELECT count(*) AS n FROM app.b028_center_mark_contexts`)).rows[0].n),0);
  await db.query('COMMIT');
  for(const [table,expected] of [["b028_center_events",100],["b028_center_recipients",100],["b028_center_reads",1],["b028_center_cursors",1],["b028_center_mark_contexts",0]] as const) {
    assert.equal(Number((await db.query(`SELECT count(*) AS n FROM app.${table}`)).rows[0].n),expected,table);
  }
  return {session,first};
}

async function blockedBy(db:Client,pid:number,requireAdmission:boolean) {
  const until=Date.now()+4000;
  while(Date.now()<until) {
    const found=(await db.query<{ok:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE a.datname=current_database() AND $1::int=ANY(pg_blocking_pids(a.pid))
      AND EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.relation='public.platform_settings'::regclass AND l.mode='ShareRowExclusiveLock' AND l.granted=$2::boolean)) AS ok`,[pid,requireAdmission])).rows[0].ok;
    if(found) return true; await new Promise(resolve=>setTimeout(resolve,20));
  }
  return false;
}

test("guarded demo reset clears real center rows twice and preserves unrelated app and handover tombstones",async()=>withOwned(async db=>{
  assert.equal((await db.query(`SELECT to_regclass('app.b028_center_events') IS NOT NULL AND to_regclass('app.handover_gc_tombstones') IS NOT NULL AS ok`)).rows[0].ok,true);
  await resetAndSeed();
  await db.query(`CREATE TABLE app.b028_reset_unrelated_probe(value integer NOT NULL)`);
  await db.query(`INSERT INTO app.b028_reset_unrelated_probe VALUES(7)`);
  const tombstone=`org/${ORG_ID}/handover/${randomUUID()}/${randomUUID()}`;
  await db.query(`INSERT INTO app.handover_gc_tombstones(storage_path,reason) VALUES($1,'demo_reset')`,[tombstone]);
  for(let n=0;n<2;n++) {
    await fixture(db); await resetAndSeed();
    for(const table of centerTables) assert.equal(Number((await db.query(`SELECT count(*) AS n FROM app.${table}`)).rows[0].n),0,table);
    if(await producerTables(db)) {
      for(const table of ['b017_center_resolutions','b017_occurrences','b017_old_source_transactions']) assert.equal(Number((await db.query(`SELECT count(*) AS n FROM app.${table}`)).rows[0].n),0,table);
    }
    assert.equal(Number((await db.query(`SELECT count(*) AS n FROM app.b010_source_events`)).rows[0].n),0);
    assert.equal((await db.query(`SELECT 1 FROM app.b028_reset_unrelated_probe WHERE value=7`)).rowCount,1);
    assert.equal((await db.query(`SELECT 1 FROM app.handover_gc_tombstones WHERE storage_path=$1`,[tombstone])).rowCount,1);
    assert.equal((await db.query(`SELECT 1 FROM organizations WHERE id=$1`,[ORG_ID])).rowCount,1);
  }
}));

test("actual center admission and actual reset serialize in both orders",async()=>withOwned(async db=>{
  await resetAndSeed();
  let source=await fixture(db);
  const held=new Client({connectionString:process.env.DATABASE_URL}); await held.connect();
  const pending:Promise<unknown>[]=[];
  try {
    await held.query('BEGIN'); await held.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.manager]); await held.query('SET LOCAL ROLE service_role');
    await held.query(`SELECT * FROM app.b028_center_session($1,$1,'live',$2,'staff','manager',$3,NULL)`,[ORG_ID,source.session,source.first]);
    const heldPid=(await held.query<{id:number}>(`SELECT pg_backend_pid() AS id`)).rows[0].id;
    const reset=resetAndSeed(); pending.push(reset); assert.equal(await blockedBy(db,heldPid,false),true);
    await held.query('COMMIT'); await reset;
    assert.equal(Number((await db.query(`SELECT count(*) AS n FROM app.b028_center_events`)).rows[0].n),0);
    source=await fixture(db);
    await held.query('BEGIN'); await held.query(`SELECT 1 FROM organizations WHERE id=$1 FOR UPDATE`,[ORG_ID]);
    const resetFirst=resetAndSeed(); pending.push(resetFirst); assert.equal(await blockedBy(db,heldPid,true),true);
    await db.query('BEGIN'); await db.query(`SELECT set_config('request.jwt.claim.sub',$1,true)`,[USERS.manager]); await db.query('SET LOCAL ROLE service_role');
    await assert.rejects(db.query(`SELECT * FROM app.b028_center_session($1,$1,'live',$2,'staff','manager',$3,NULL)`,[ORG_ID,source.session,source.first]),(e:unknown)=>(e as {code?:string}).code==='55P03');
    await db.query('ROLLBACK'); await held.query('COMMIT'); await resetFirst;
    assert.equal(Number((await db.query(`SELECT count(*) AS n FROM app.b028_center_events`)).rows[0].n),0);
  } finally {await held.query('ROLLBACK').catch(()=>{}); await held.end(); await Promise.allSettled(pending);}
}));

test("synthetic absence of 100214, 100215 and optional 100217 tables remains reset-compatible",async(t)=>withOwned(async db=>{
  // This deliberately removes selected tables only in this owned clone. It is
  // capability-absence evidence, not a historical migration or upgrade fixture.
  const producer=await producerTables(db);
  if(producer) await db.query(`DROP TABLE app.b017_center_resolutions`);
  await db.query(`DROP TABLE app.b028_center_mark_contexts,app.b028_center_cursors,app.b028_center_reads,app.b028_center_recipients,app.b028_center_events`);
  if(producer) await db.query(`DROP TABLE app.b017_old_source_transactions,app.b017_occurrences`);
  await db.query(`DROP TABLE IF EXISTS app.deposit_settlement_payments`);
  await db.query(`DROP TABLE IF EXISTS app.deposit_settlement_confirmations`);
  await db.query(`DROP TABLE IF EXISTS app.deposit_settlement_evidence`);
  await db.query(`DROP TABLE IF EXISTS app.deposit_settlement_lines`);
  await db.query(`DROP TABLE IF EXISTS app.deposit_settlement_records`);
  await db.query(`DROP TABLE app.handover_gc_attempts,app.handover_gc_tombstones,app.handover_version_attachments,app.handover_replies,app.handover_attachments,app.handover_upload_intents,app.handover_versions,app.handover_records`);
  assert.equal((await db.query(`SELECT to_regclass('app.handover_records') IS NULL AND to_regclass('app.b028_center_events') IS NULL AS ok`)).rows[0].ok,true);
  await resetAndSeed();
  assert.equal((await db.query(`SELECT 1 FROM organizations WHERE id=$1`,[ORG_ID])).rowCount,1);
  t.diagnostic('Synthetic table-absence probe only; not a historical-schema upgrade result.');
}));

test("standalone typed-source resolvers and guarded reset share admission in both orders",async()=>withOwned(async db=>{
  assert.equal(await producerTables(db),true,"this regression requires the unpublished 100217 source");
  const held=new Client({connectionString:process.env.DATABASE_URL}); await held.connect();
  const pending:Promise<unknown>[]=[];
  async function source(neutral:boolean) {
    const lease=(await db.query<{lease:string;invoice:string}>(`SELECT l.id::text lease,i.id::text invoice FROM leases l JOIN invoices i ON i.lease_id=l.id AND i.org_id=l.org_id WHERE l.org_id=$1 LIMIT 1`,[ORG_ID])).rows[0];
    const key=randomUUID();
    const row=(await db.query<{id:string}>(neutral
      ? `INSERT INTO app.b017_occurrences(org_id,lease_id,invoice_id,kind,occurrence_key,local_date,occurred_at) VALUES($1,$2,$3,'rent_due',$4,current_date,clock_timestamp()) RETURNING id::text`
      : `INSERT INTO app.b010_source_events(org_id,lease_id,invoice_id,kind,occurrence_key,local_date) VALUES($1,$2,$3,'rent_due',$4,current_date) RETURNING id::text`,[ORG_ID,lease.lease,lease.invoice,key])).rows[0];
    return {...lease,key,id:row.id,neutral};
  }
  async function resolve(c:Client,item:Awaited<ReturnType<typeof source>>) {
    return c.query(item.neutral ? `SELECT * FROM app.b017_resolve_neutral($1,$2)` : `SELECT * FROM app.b017_resolve_history($1,$2)`,[ORG_ID,item.id]);
  }
  try {
    for(const neutral of [false,true]) {
      await resetAndSeed();
      let item=await source(neutral);
      await held.query('BEGIN');
      assert.deepEqual((await resolve(held,item)).rows,[{outcome:'no_backfill',center_event_id:null}]);
      const pid=(await held.query<{id:number}>(`SELECT pg_backend_pid() AS id`)).rows[0].id;
      const first=resetAndSeed(); pending.push(first);
      assert.equal(await blockedBy(db,pid,false),true,'resolver admission must hold reset before mutation');
      await held.query('COMMIT'); await first;
      assert.equal(Number((await db.query(`SELECT count(*) AS n FROM app.b017_center_resolutions`)).rows[0].n),0);
      item=await source(neutral);
      await held.query('BEGIN'); await held.query('LOCK TABLE app.b028_center_events IN SHARE MODE');
      const second=resetAndSeed(); pending.push(second);
      assert.equal(await blockedBy(db,pid,true),true,'reset must hold platform admission while blocked before deleting center parents');
      const busy=(e:unknown)=>(e as {code?:string}).code==='55P03';
      await assert.rejects(resolve(db,item),busy,'standalone resolver must not append after reset removed resolutions');
      await assert.rejects(db.query(`SELECT * FROM app.b017_resolve_key($1,$2,'rent_due',$3,NULL,NULL,$4)`,[ORG_ID,item.lease,item.invoice,item.key]),busy);
      await assert.rejects(db.query(neutral
        ? `INSERT INTO app.b017_center_resolutions(org_id,kind,lease_id,invoice_id,occurrence_key,local_date,occurred_at,neutral_source_id,outcome) SELECT org_id,kind,lease_id,invoice_id,occurrence_key,local_date,occurred_at,id,'no_backfill' FROM app.b017_occurrences WHERE id=$1`
        : `INSERT INTO app.b017_center_resolutions(org_id,kind,lease_id,invoice_id,occurrence_key,local_date,occurred_at,old_source_id,outcome) SELECT org_id,kind,lease_id,invoice_id,occurrence_key,local_date,created_at,id,'no_backfill' FROM app.b010_source_events WHERE id=$1`,[item.id]),busy);
      await held.query('COMMIT'); await second;
      for(const table of ['b017_center_resolutions','b017_occurrences','b017_old_source_transactions','b010_source_events']) assert.equal(Number((await db.query(`SELECT count(*) AS n FROM app.${table}`)).rows[0].n),0,table);
    }
  } finally {await held.query('ROLLBACK').catch(()=>{});await held.end();await Promise.allSettled(pending);}
}));
