import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "pg";
import { USERS } from "./ids";
import { disposableDbUrl, withDatabase } from "./test-disposable-db";

// Uses the guarded local server only. This test owns and removes its scratch database.
const source = disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);

test("pre-migration ambiguous closed lease is held after upgrade", async () => {
  const clone = `condola_b002_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: withDatabase(source, "postgres") });
  await admin.connect();
  let created = false;
  let db: Client | undefined;
  try {
    const roles = await admin.query(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')`);
    assert.equal(roles.rows[0].n, 3, "local Supabase test roles must already exist");
    await admin.query(`CREATE DATABASE "${clone}"`);
    created = true;
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const target = withDatabase(source, clone);
    const psqlEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      NODE_ENV: process.env.NODE_ENV ?? "test",
      PGHOST: source.hostname.replace(/^\[|\]$/g, ""), PGPORT: source.port,
      PGDATABASE: clone,
      ...(source.username ? { PGUSER: decodeURIComponent(source.username) } : {}),
      ...(source.password ? { PGPASSWORD: decodeURIComponent(source.password) } : {}),
    };
    function apply(file: string) {
      const result = spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", file], { cwd: root, env: psqlEnv, stdio: "pipe" });
      if (result.status !== 0) throw new Error(`Synthetic migration replay failed: ${file.split("/").at(-1)}`);
    }
    apply("supabase/stub/supabase_stub.sql");
    const migrations = (await readdir(new URL("../../supabase/migrations/", import.meta.url)))
      .filter((name) => name.endsWith(".sql") && name < "20261031100203_b002_retention_boundary.sql").sort();
    for (const migration of migrations) apply(`supabase/migrations/${migration}`);
    db = new Client({ connectionString: target });
    await db.connect();
    await db.query(`INSERT INTO auth.users(id) VALUES ($1),($2) ON CONFLICT DO NOTHING`, [USERS.admin, USERS.tenant]);
    const prior = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='leases' AND column_name='id_retention_auto_end'`);
    assert.equal(prior.rowCount, 0, "fixture must predate the proposed migration");
    const org = (await db.query<{ id: string }>(`INSERT INTO organizations(name,country_code,default_currency) VALUES ('B002 historical','TW','TWD') RETURNING id::text`)).rows[0].id;
    await db.query(`INSERT INTO org_members(org_id,user_id,role,status) VALUES ($1,$2,'admin','active')`, [org, USERS.admin]);
    const contact = (await db.query<{ id: string }>(`INSERT INTO contacts(org_id,user_id,is_tenant,display_name) VALUES ($1,$2,true,'B002 historical') RETURNING id::text`, [org, USERS.tenant])).rows[0].id;
    const property = (await db.query<{ id: string }>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES ($1,'B002 historical','TW','TWD','Asia/Taipei') RETURNING id::text`, [org])).rows[0].id;
    const unit = (await db.query<{ id: string }>(`INSERT INTO units(org_id,property_id,label) VALUES ($1,$2,'B002 historical') RETURNING id::text`, [org, property])).rows[0].id;
    const lease = (await db.query<{ id: string }>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,end_date,terminated_on,currency,rent_amount_minor) VALUES ($1,$2,$3,$3,'terminated','2025-01-01','2025-12-01','2025-12-01','TWD',0) RETURNING id::text`, [org, property, unit])).rows[0].id;
    const doc = (await db.query<{ id: string }>(`INSERT INTO identity_documents(org_id,contact_id,lease_id,doc_type,number_masked,storage_path,encryption_key_ref) VALUES ($1,$2,$3,'passport','A***CD',$4,'fixture-key-ref') RETURNING id::text`, [org, contact, lease, `${org}/historical`])).rows[0].id;
    apply("supabase/migrations/20261031100203_b002_retention_boundary.sql");
    await db.query(`UPDATE leases SET id_retention_auto_end=true WHERE id=$1`, [lease]);
    const row = (await db.query(`SELECT l.id_retention_auto_end, l.end_date::text, d.delete_after::text AS cached,
      public.id_document_delete_after(l.id,l.org_id,d.created_at)::text AS actual
      FROM leases l JOIN identity_documents d ON d.lease_id=l.id WHERE l.id=$1 AND d.id=$2`, [lease, doc])).rows[0];
    assert.equal(row.id_retention_auto_end, null);
    assert.equal(row.end_date, "2025-12-01");
    assert.ok(row.cached);
    assert.equal(row.actual, "9999-12-31");
    assert.equal((await db.query(`SELECT 1 FROM id_photo_gate(NULL,$1,$2,$3,'live')`, [USERS.admin, doc, org])).rowCount, 0);
    assert.equal((await db.query(`SELECT 1 FROM preview_due_identity_documents(1000) WHERE document_id=$1`, [doc])).rowCount, 0);
  } finally {
    await db?.end();
    if (created) await admin.query(`DROP DATABASE "${clone}"`);
    await admin.end();
  }
});
