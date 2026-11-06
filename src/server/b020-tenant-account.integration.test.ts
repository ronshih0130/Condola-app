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
  await db.query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',$1::boolean,'allowed_org_ids',jsonb_build_array($2::text)) WHERE key='tenant_account_settings'`, [on, ORG_ID]);
  await db.query(`UPDATE organizations SET feature_flags=feature_flags || jsonb_build_object('tenant_account_settings',$1::boolean) WHERE id=$2`, [on, ORG_ID]);
}
async function tenant(org = ORG_ID) {
  const user = randomUUID();
  await db.query(`INSERT INTO auth.users(id,email,role,aud) VALUES($1,$2,'authenticated','authenticated')`, [user, `${user}@example.invalid`]);
  await db.query(`INSERT INTO contacts(org_id,is_tenant,display_name,user_id) VALUES($1,true,'B020',$2)`, [org, user]);
  const session = async () => (await db.query<{ id: string }>(`INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 day') RETURNING id::text`, [user, randomUUID()])).rows[0].id;
  return { user, a: await session(), b: await session() };
}
async function as<T>(user: string, fn: () => Promise<T>, org: string = ORG_ID, env: string | null = "live"): Promise<T> {
  await db.query("BEGIN");
  try {
    await db.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env',$3,true)`, [user, org, env ?? ""]);
    await db.query("SET LOCAL ROLE authenticated");
    const out = await fn(); await db.query("COMMIT"); return out;
  } catch (e) { await db.query("ROLLBACK"); throw e; }
}

test("flag OFF / missing pin / wrong org: every RPC is refused", async () => {
  await flag(false);
  const t = await tenant();
  await assert.rejects(as(t.user, () => db.query(`SELECT * FROM app.b020_my_sessions($1)`, [ORG_ID])), code("42501"));
  await flag(true);
  for (const [org, env] of [[ORG_ID, null], [ORG_ID, "sandbox"], [ORG2_ID, "live"]] as const)
    await assert.rejects(as(t.user, () => db.query(`SELECT * FROM app.b020_my_sessions($1)`, [org]), org, env), code("42501"));
});

test("sessions: own only; revoking another session makes it unusable; current and foreign sessions cannot be revoked", async () => {
  await flag(true);
  const t = await tenant(), other = await tenant();
  const rows = (await as(t.user, () => db.query<{ id: string }>(`SELECT id::text FROM app.b020_my_sessions($1)`, [ORG_ID]))).rows.map((r) => r.id).sort();
  assert.deepEqual(rows, [t.a, t.b].sort());
  assert.equal((await as(t.user, () => db.query(`SELECT app.b020_revoke_session($1,$2,$3) ok`, [ORG_ID, t.b, t.a]))).rows[0].ok, true);
  assert.ok((await db.query(`SELECT revoked_at FROM auth_sessions WHERE id=$1`, [t.b])).rows[0].revoked_at);
  await assert.rejects(as(t.user, () => db.query(`SELECT app.b020_revoke_session($1,$2,$2)`, [ORG_ID, t.a])), code("42501"));
  assert.equal((await as(t.user, () => db.query(`SELECT app.b020_revoke_session($1,$2,$3) ok`, [ORG_ID, other.a, t.a]))).rows[0].ok, false);
  assert.equal((await db.query(`SELECT revoked_at FROM auth_sessions WHERE id=$1`, [other.a])).rows[0].revoked_at, null);
  await assert.rejects(as(t.user, () => db.query(`SELECT app.b020_revoke_session($1,$2,$3)`, [ORG_ID, t.a, t.b])), code("42501"), "a revoked current session cannot act");
});

test("data requests: one trackable request per kind; replay and conflicts", async () => {
  await flag(true);
  const t = await tenant(), r1 = randomUUID();
  const a = (await as(t.user, () => db.query<{ id: string }>(`SELECT app.b020_submit_data_request($1,$2,'export')::text id`, [ORG_ID, r1]))).rows[0].id;
  const b = (await as(t.user, () => db.query<{ id: string }>(`SELECT app.b020_submit_data_request($1,$2,'export')::text id`, [ORG_ID, r1]))).rows[0].id;
  const c = (await as(t.user, () => db.query<{ id: string }>(`SELECT app.b020_submit_data_request($1,$2,'export')::text id`, [ORG_ID, randomUUID()]))).rows[0].id;
  assert.equal(a, b); assert.equal(a, c);
  await assert.rejects(as(t.user, () => db.query(`SELECT app.b020_submit_data_request($1,$2,'deletion')`, [ORG_ID, r1])), code("42501"));
  await assert.rejects(as(t.user, () => db.query(`SELECT app.b020_submit_data_request($1,$2,'other')`, [ORG_ID, randomUUID()])), code("22023"));
  const list = (await as(t.user, () => db.query(`SELECT kind,status FROM app.b020_my_data_requests($1)`, [ORG_ID]))).rows;
  assert.deepEqual(list, [{ kind: "export", status: "submitted" }]);
  for (const role of ["anon", "authenticated", "service_role"])
    assert.equal((await db.query(`SELECT has_table_privilege($1,'app.b020_data_requests','SELECT,INSERT,UPDATE,DELETE') a`, [role])).rows[0].a, false);
});

test("QA r1: every accepted request id stays bound (reuse included); concurrent submits yield one open row", async () => {
  await flag(true);
  const t = await tenant(), A = randomUUID(), B = randomUUID();
  const a = (await as(t.user, () => db.query<{ id: string }>(`SELECT app.b020_submit_data_request($1,$2,'export')::text id`, [ORG_ID, A]))).rows[0].id;
  const b = (await as(t.user, () => db.query<{ id: string }>(`SELECT app.b020_submit_data_request($1,$2,'export')::text id`, [ORG_ID, B]))).rows[0].id;
  assert.equal(a, b);
  await assert.rejects(as(t.user, () => db.query(`SELECT app.b020_submit_data_request($1,$2,'deletion')`, [ORG_ID, B])), code("42501"));
  await db.query(`UPDATE app.b020_data_requests SET status='completed' WHERE id=$1`, [a]);
  assert.equal((await as(t.user, () => db.query<{ id: string }>(`SELECT app.b020_submit_data_request($1,$2,'export')::text id`, [ORG_ID, B]))).rows[0].id, a, "retry of B after completion returns the same row");
  const u = await tenant(), C = randomUUID();
  const c1 = new Client({ connectionString: clone.url }), c2 = new Client({ connectionString: clone.url });
  await c1.connect(); await c2.connect();
  const on = async <T>(c: Client, fn: () => Promise<T>) => { await c.query("BEGIN"); try { await c.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`, [u.user, ORG_ID]); await c.query("SET LOCAL ROLE authenticated"); const r = await fn(); await c.query("COMMIT"); return r; } catch (e) { await c.query("ROLLBACK"); throw e; } };
  try {
    const [x, y] = await Promise.all([
      on(c1, () => c1.query<{ id: string }>(`SELECT app.b020_submit_data_request($1,$2,'correction')::text id`, [ORG_ID, C])),
      on(c2, () => c2.query<{ id: string }>(`SELECT app.b020_submit_data_request($1,$2,'correction')::text id`, [ORG_ID, C])),
    ]);
    assert.equal(x.rows[0].id, y.rows[0].id);
    const [p, q] = await Promise.all([
      on(c1, () => c1.query<{ id: string }>(`SELECT app.b020_submit_data_request($1,$2,'correction')::text id`, [ORG_ID, randomUUID()])),
      on(c2, () => c2.query<{ id: string }>(`SELECT app.b020_submit_data_request($1,$2,'correction')::text id`, [ORG_ID, randomUUID()])),
    ]);
    assert.equal(p.rows[0].id, q.rows[0].id);
    assert.equal((await db.query(`SELECT count(*)::int n FROM app.b020_data_requests WHERE user_id=$1 AND kind='correction'`, [u.user])).rows[0].n, 1);
  } finally { await c1.end(); await c2.end(); }
});

