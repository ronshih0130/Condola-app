import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { ORG_ID, ORG2_ID } from "./ids";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>, db: Client;
test.before(async () => { clone = await cloneTestDatabase(); db = new Client({ connectionString: clone.url }); await db.connect(); });
test.after(async () => { await db?.end(); await clone?.cleanup(); });

const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;
async function flag(on: boolean) {
  await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',$1::boolean,'allowed_org_ids',jsonb_build_array($2::text)) WHERE key='tenant_thread_create'`, [on, ORG_ID]);
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object('tenant_thread_create',$1::boolean) WHERE id=$2`, [on, ORG_ID]);
}
async function tenantLease(org = ORG_ID) {
  const user = randomUUID();
  await db.query(`INSERT INTO auth.users(id,email,role,aud) VALUES($1,$2,'authenticated','authenticated')`, [user, `${user}@example.invalid`]);
  const property = (await db.query<{ id: string }>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,$2,'TW','TWD','Asia/Taipei') RETURNING id::text`, [org, `B019 ${randomUUID()}`])).rows[0].id;
  const unit = (await db.query<{ id: string }>(`INSERT INTO units(org_id,property_id,label) VALUES($1,$2,'1F') RETURNING id::text`, [org, property])).rows[0].id;
  const lease = (await db.query<{ id: string }>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor) VALUES($1,$2,$3,$3,'active','2096-01-01','TWD',100) RETURNING id::text`, [org, property, unit])).rows[0].id;
  const contact = (await db.query<{ id: string }>(`INSERT INTO contacts(org_id,is_tenant,display_name,user_id) VALUES($1,true,'B019 tenant',$2) RETURNING id::text`, [org, user])).rows[0].id;
  await db.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'primary')`, [org, lease, contact]);
  return { user, lease, contact };
}
async function asTenant<T>(user: string, org: string, fn: (c: Client) => Promise<T>, conn = db, env: string | null = "live"): Promise<T> {
  await conn.query("BEGIN");
  try {
    await conn.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env',$3,true)`, [user, org, env ?? ""]);
    await conn.query("SET LOCAL ROLE authenticated");
    const out = await fn(conn); await conn.query("COMMIT"); return out;
  } catch (e) { await conn.query("ROLLBACK"); throw e; }
}
const start = (c: Client, lease: string, request: string, body = "Hello") => c.query<{ id: string }>(`SELECT app.b019_start_tenant_thread($1,$2,$3)::text AS id`, [lease, request, body]);
const counts = async (lease: string) => (await db.query<{ threads: number; messages: number; participants: number }>(`SELECT
  (SELECT count(*)::int FROM message_threads WHERE lease_id=$1) threads,
  (SELECT count(*)::int FROM messages m JOIN message_threads t ON t.id=m.thread_id WHERE t.lease_id=$1) messages,
  (SELECT count(*)::int FROM thread_participants p JOIN message_threads t ON t.id=p.thread_id WHERE t.lease_id=$1) participants`, [lease])).rows[0];

test("flag OFF: denied and nothing written", async () => {
  await flag(false);
  const t = await tenantLease();
  await assert.rejects(asTenant(t.user, ORG_ID, (c) => start(c, t.lease, randomUUID())), code("42501"));
  assert.deepEqual(await counts(t.lease), { threads: 0, messages: 0, participants: 0 });
});

test("start creates one lease thread with participants and the first message; replay is idempotent", async () => {
  await flag(true);
  const t = await tenantLease(), request = randomUUID();
  const a = (await asTenant(t.user, ORG_ID, (c) => start(c, t.lease, request))).rows[0].id;
  const b = (await asTenant(t.user, ORG_ID, (c) => start(c, t.lease, request))).rows[0].id;
  assert.equal(a, b);
  assert.deepEqual(await counts(t.lease), { threads: 1, messages: 1, participants: 1 });
  await assert.rejects(asTenant(t.user, ORG_ID, (c) => start(c, t.lease, request, "Different")), code("42501"));
  await assert.rejects(asTenant(t.user, ORG_ID, (c) => start(c, t.lease, randomUUID(), "   ")), code("22023"));
});

test("concurrent starts: one thread; same request id yields one message", async () => {
  await flag(true);
  const t = await tenantLease(), request = randomUUID();
  const c1 = new Client({ connectionString: clone.url }), c2 = new Client({ connectionString: clone.url });
  await c1.connect(); await c2.connect();
  try {
    const [r1, r2] = await Promise.all([asTenant(t.user, ORG_ID, (c) => start(c, t.lease, request), c1), asTenant(t.user, ORG_ID, (c) => start(c, t.lease, request), c2)]);
    assert.equal(r1.rows[0].id, r2.rows[0].id);
    const [r3, r4] = await Promise.all([asTenant(t.user, ORG_ID, (c) => start(c, t.lease, randomUUID(), "A"), c1), asTenant(t.user, ORG_ID, (c) => start(c, t.lease, randomUUID(), "B"), c2)]);
    assert.equal(r3.rows[0].id, r4.rows[0].id);
    assert.deepEqual(await counts(t.lease), { threads: 1, messages: 3, participants: 1 });
  } finally { await c1.end(); await c2.end(); }
});

test("another tenant's lease, a pin mismatch or another org is denied without writes", async () => {
  await flag(true);
  const t = await tenantLease(), other = await tenantLease();
  await assert.rejects(asTenant(other.user, ORG_ID, (c) => start(c, t.lease, randomUUID())), code("42501"));
  await assert.rejects(asTenant(t.user, ORG2_ID, (c) => start(c, t.lease, randomUUID())), code("42501"));
  assert.deepEqual(await counts(t.lease), { threads: 0, messages: 0, participants: 0 });
  for (const role of ["anon", "service_role"])
    assert.equal((await db.query(`SELECT has_function_privilege($1,'app.b019_start_tenant_thread(uuid,uuid,text)','EXECUTE') a`, [role])).rows[0].a, false);
});

test("QA r1: missing/malformed flag config fails closed; env pin required; archived co-party never joins", async () => {
  const t = await tenantLease();
  for (const setup of [
    async () => { await flag(true); await db.query(`UPDATE organizations SET feature_flags=feature_flags - 'tenant_thread_create' WHERE id=$1`, [ORG_ID]); },
    async () => { await flag(true); await db.query(`DELETE FROM platform_settings WHERE key='tenant_thread_create'`); },
    async () => { await db.query(`INSERT INTO platform_settings(key,value) VALUES('tenant_thread_create','{"enabled":true,"allowed_org_ids":"all"}') ON CONFLICT(key) DO UPDATE SET value=excluded.value`); await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"tenant_thread_create":true}' WHERE id=$1`, [ORG_ID]); },
  ]) {
    await setup();
    await assert.rejects(asTenant(t.user, ORG_ID, (c) => start(c, t.lease, randomUUID())), code("42501"));
  }
  await db.query(`INSERT INTO platform_settings(key,value) VALUES('tenant_thread_create','{"enabled":false,"allowed_org_ids":[]}') ON CONFLICT(key) DO NOTHING`);
  await flag(true);
  for (const env of [null, "sandbox"]) await assert.rejects(asTenant(t.user, ORG_ID, (c) => start(c, t.lease, randomUUID()), db, env), code("42501"));
  assert.deepEqual(await counts(t.lease), { threads: 0, messages: 0, participants: 0 });
  const archivedUser = randomUUID();
  await db.query(`INSERT INTO auth.users(id,email,role,aud) VALUES($1,$2,'authenticated','authenticated')`, [archivedUser, `${archivedUser}@example.invalid`]);
  const archived = (await db.query<{ id: string }>(`INSERT INTO contacts(org_id,is_tenant,display_name,user_id,archived_at) VALUES($1,true,'B019 archived',$2,now()) RETURNING id::text`, [ORG_ID, archivedUser])).rows[0].id;
  await db.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES($1,$2,$3,'co_tenant')`, [ORG_ID, t.lease, archived]);
  await asTenant(t.user, ORG_ID, (c) => start(c, t.lease, randomUUID(), "First"));
  assert.equal((await db.query(`SELECT count(*)::int n FROM thread_participants p JOIN message_threads th ON th.id=p.thread_id WHERE th.lease_id=$1 AND p.contact_id=$2`, [t.lease, archived])).rows[0].n, 0);
  const seen = await asTenant(archivedUser, ORG_ID, (c) => c.query(`SELECT m.body FROM messages m JOIN message_threads th ON th.id=m.thread_id WHERE th.lease_id=$1`, [t.lease]));
  assert.equal(seen.rows.length, 0, "archived co-party cannot read the first message");
});

