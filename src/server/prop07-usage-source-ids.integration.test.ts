import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>, db: Client;
test.before(async () => { clone = await cloneTestDatabase(); db = new Client({ connectionString: clone.url }); await db.connect(); });
test.after(async () => { await db?.end(); await clone?.cleanup(); });

const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;
async function as<T>(role: string, user: string | null, fn: () => Promise<T>, org: string | null = ORG_ID, env: string | null = "live"): Promise<T> {
  await db.query("BEGIN");
  try {
    await db.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('app.active_org_id',$2,true),set_config('app.env',$3,true)`, [user ?? "", org ?? "", env ?? ""]);
    await db.query(`SET LOCAL ROLE ${role}`);
    const out = await fn(); await db.query("COMMIT"); return out;
  } catch (error) { await db.query("ROLLBACK"); throw error; }
}
const record = (org: string, dim: string, qty: string, key: string, source = randomUUID()) =>
  db.query<{ id: string }>(`SELECT app.prop07_record_usage($1,$2,$3::bigint,'2026-11-01T00:00:00Z',$4,$5,$6)::text AS id`, [org, dim, qty, "leases", source, key]);

test("record is idempotent by dedupe key, conflicts on a different payload, keeps the source id", async () => {
  const key = `k-${randomUUID()}`, source = randomUUID();
  const a = (await as("service_role", null, () => record(ORG_ID, "signatures", "1", key, source))).rows[0].id;
  const b = (await as("service_role", null, () => record(ORG_ID, "signatures", "1", key, source))).rows[0].id;
  assert.equal(a, b);
  await assert.rejects(as("service_role", null, () => record(ORG_ID, "signatures", "2", key, source)), code("23505"));
  const row = (await db.query(`SELECT source_table, source_id, sandbox FROM app.usage_events WHERE id=$1`, [a])).rows[0];
  assert.deepEqual(row, { source_table: "leases", source_id: source, sandbox: false });
});

test("sandbox usage is marked and excluded from formal summaries; sums are exact bigint", async () => {
  const sandbox = (await db.query<{ id: string }>(`INSERT INTO organizations(name,country_code,default_currency,environment,live_org_id) VALUES($1,'TW','TWD','sandbox',$2) RETURNING id::text`, [randomUUID(), ORG_ID])).rows[0].id;
  await as("service_role", null, () => record(sandbox, "stored_bytes", "5", `s-${randomUUID()}`));
  await as("service_role", null, () => record(ORG_ID, "stored_bytes", "9007199254740993", `l-${randomUUID()}`));
  await as("service_role", null, () => record(ORG_ID, "stored_bytes", "7", `l-${randomUUID()}`));
  assert.equal((await db.query(`SELECT sandbox FROM app.usage_events WHERE org_id=$1`, [sandbox])).rows[0].sandbox, true);
  const summary = (await as("authenticated", USERS.admin, () => db.query(`SELECT * FROM app.prop07_usage_summary($1,'2026-10-01','2026-12-01')`, [ORG_ID]))).rows;
  const bytes = summary.find((r) => r.dimension === "stored_bytes");
  assert.equal(bytes?.quantity, "9007199254741000");
});

test("append-only; API roles cannot write; summary requires an admin of that org", async () => {
  const id = (await as("service_role", null, () => record(ORG_ID, "units", "1", `u-${randomUUID()}`))).rows[0].id;
  await assert.rejects(db.query(`UPDATE app.usage_events SET quantity=2 WHERE id=$1`, [id]), code("55000"));
  await assert.rejects(db.query(`DELETE FROM app.usage_events WHERE id=$1`, [id]), code("55000"));
  for (const role of ["anon", "authenticated"]) await assert.rejects(as(role, USERS.admin, () => record(ORG_ID, "units", "1", `x-${randomUUID()}`)), code("42501"));
  for (const role of ["anon", "authenticated", "service_role"]) await assert.rejects(as(role, null, () => db.query(`SELECT * FROM app.usage_events`)), code("42501"));
  await assert.rejects(as("authenticated", USERS.manager, () => db.query(`SELECT * FROM app.prop07_usage_summary($1,'2026-10-01','2026-12-01')`, [ORG_ID])), code("42501"));
  await assert.rejects(as("authenticated", USERS.coastAdmin, () => db.query(`SELECT * FROM app.prop07_usage_summary($1,'2026-10-01','2026-12-01')`, [ORG_ID]), ORG2_ID), code("42501"));
  await assert.rejects(as("service_role", null, () => record(ORG_ID, "pricing", "1", `p-${randomUUID()}`)), code("23514"));
});

const summary = (org: string) => db.query(`SELECT * FROM app.prop07_usage_summary($1,'2026-10-01','2026-12-01')`, [org]);

test("QA r1: summary requires an exact org/env pin; sandbox org formal summary is empty", async () => {
  for (const [org, env] of [[null, null], ["", ""], [ORG2_ID, "live"], [ORG_ID, "sandbox"], [ORG_ID, null]] as const)
    await assert.rejects(as("authenticated", USERS.admin, () => summary(ORG_ID), org, env), code("42501"));
  await as("authenticated", USERS.admin, () => summary(ORG_ID));
  const sandbox = (await db.query<{ id: string }>(`SELECT id::text FROM organizations WHERE environment='sandbox' AND live_org_id=$1`, [ORG_ID])).rows[0]?.id
    ?? (await db.query<{ id: string }>(`INSERT INTO organizations(name,country_code,default_currency,environment,live_org_id) VALUES($1,'TW','TWD','sandbox',$2) RETURNING id::text`, [randomUUID(), ORG_ID])).rows[0].id;
  await as("service_role", null, () => record(sandbox, "units", "3", `sb-${randomUUID()}`));
  assert.deepEqual((await as("authenticated", USERS.admin, () => summary(sandbox), sandbox, "sandbox")).rows, []);
});

test("QA r1: concurrent recorders with the same dedupe key yield one row; a rolled-back first writer does not block", async () => {
  const key = `race-${randomUUID()}`, source = randomUUID();
  const a = new Client({ connectionString: clone.url }), b = new Client({ connectionString: clone.url });
  await a.connect(); await b.connect();
  try {
    const pidA = (await a.query<{ pid: number }>("SELECT pg_backend_pid() pid")).rows[0].pid, pidB = (await b.query<{ pid: number }>("SELECT pg_backend_pid() pid")).rows[0].pid;
    const blocked = async () => {
      for (let i = 0; i < 200; i++) {
        const r = await db.query<{ blocked: boolean }>("SELECT $2::int = ANY(pg_blocking_pids($1)) blocked", [pidB, pidA]);
        if (r.rows[0].blocked) return;
        await new Promise((res) => setTimeout(res, 25));
      }
      throw new Error("second recorder never waited on the first");
    };
    const call = (c: Client) => c.query<{ id: string }>(`SELECT app.prop07_record_usage($1,'vendor_jobs',1,'2026-11-01T00:00:00Z','repair_vendor_jobs',$2,$3)::text AS id`, [ORG_ID, source, key]);
    await a.query("BEGIN"); await b.query("BEGIN");
    const first = await call(a);
    const second = call(b);                       // blocks on the advisory lock
    await blocked();
    await a.query("COMMIT");
    const r2 = await second; await b.query("COMMIT");
    assert.equal(r2.rows[0].id, first.rows[0].id);
    assert.equal((await db.query(`SELECT count(*)::int n FROM app.usage_events WHERE dedupe_key=$1`, [key])).rows[0].n, 1);
    const key2 = `race-rb-${randomUUID()}`;
    const call2 = (c: Client) => c.query<{ id: string }>(`SELECT app.prop07_record_usage($1,'vendor_jobs',1,'2026-11-01T00:00:00Z','repair_vendor_jobs',$2,$3)::text AS id`, [ORG_ID, source, key2]);
    await a.query("BEGIN"); await b.query("BEGIN");
    await call2(a);
    const pending = call2(b);
    await blocked();
    await a.query("ROLLBACK");
    const won = await pending; await b.query("COMMIT");
    assert.ok(won.rows[0].id);
    assert.equal((await db.query(`SELECT count(*)::int n FROM app.usage_events WHERE dedupe_key=$1`, [key2])).rows[0].n, 1);
  } finally { await a.end(); await b.end(); }
});
