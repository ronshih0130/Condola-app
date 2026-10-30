import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { ORG_ID } from "./ids";
import { disposableDbUrl, withDatabase } from "./test-disposable-db";

const source = disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let database: string;
let admin: Client;
let client: Client;
let owned = false;
test.before(async () => {
  database = `condola_id_purge_history_${randomUUID().replaceAll("-", "")}`;
  admin = new Client({ connectionString: withDatabase(source, "postgres") }); await admin.connect();
  await admin.query(`CREATE DATABASE "${database}"`); owned = true;
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV ?? "test", PGHOST: source.hostname.replace(/^\[|\]$/g, ""), PGPORT: source.port, PGDATABASE: database,
    ...(source.username ? { PGUSER: decodeURIComponent(source.username) } : {}), ...(source.password ? { PGPASSWORD: decodeURIComponent(source.password) } : {}) };
  const apply = (file: string) => { const result = spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", file], { cwd: ROOT, env, stdio: "pipe" });
    if (result.status !== 0) throw new Error(`Historical replay failed: ${path.basename(file)}`); };
  apply("supabase/stub/supabase_stub.sql");
  const migrations = (await readdir(path.join(ROOT, "supabase/migrations"))).filter((name) => name.endsWith(".sql") && name <= "20261030151200_id_purge_dry_run_guard.sql").sort();
  for (const name of migrations) apply(`supabase/migrations/${name}`);
  client = new Client({ connectionString: withDatabase(source,database) }); await client.connect();
  await client.query(`INSERT INTO organizations(id,name,country_code,default_currency) VALUES ($1,'historical test','TW','TWD')`,[ORG_ID]);
  const property = (await client.query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES ($1,'historical test','TW','TWD','Asia/Taipei') RETURNING id::text`,[ORG_ID])).rows[0].id;
  const unit = (await client.query<{id:string}>(`INSERT INTO units(org_id,property_id,label) VALUES ($1,$2,'historical test') RETURNING id::text`,[ORG_ID,property])).rows[0].id;
  await client.query(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor) VALUES ($1,$2,$3,$3,'draft','2020-01-01','TWD',0)`,[ORG_ID,property,unit]);
});
test.after(async () => { await client?.end(); if (owned) await admin.query(`DROP DATABASE "${database}"`); await admin?.end(); });
async function withDb<T>(fn: (client: Client) => Promise<T>) { return fn(client); }

test("missing lock, unlocked guard, config replay, and legacy clocks", async () => {
  await withDb(async (client) => {
    await client.query("BEGIN");
    try {
      const { readFileSync } = await import("node:fs");
      const migration = readFileSync(path.join(ROOT,
        "supabase/migrations/20261030151200_id_purge_dry_run_guard.sql"), "utf8");
      await client.query(`UPDATE platform_settings SET value = 'false'
        WHERE key = 'id_documents.org_retention_locked'`);
      await client.query(migration);
      await client.query(migration);
      assert.equal((await client.query(`SELECT value FROM platform_settings
        WHERE key = 'id_documents.org_retention_locked'`)).rows[0].value, false);
      await client.query(`DELETE FROM platform_settings WHERE key = 'id_documents.org_retention_locked'`);
      for (const sql of [
        `INSERT INTO organizations (name, country_code, default_currency, id_doc_retention_days)
         VALUES ('retention rejected', 'TW', 'TWD', 30)`,
        `UPDATE organizations SET id_doc_retention_days = 30 WHERE id = '${ORG_ID}'`,
      ]) {
        await client.query("SAVEPOINT rejected");
        await assert.rejects(client.query(sql), (error: unknown) =>
          (error as { code?: string }).code === "23514");
        await client.query("ROLLBACK TO SAVEPOINT rejected");
      }
      await client.query(`INSERT INTO platform_settings (key, value)
        VALUES ('id_documents.org_retention_locked', 'false')`);
      await client.query(`UPDATE organizations SET id_doc_retention_days = 30 WHERE id = $1`, [ORG_ID]);
      await client.query("SAVEPOINT above_cap");
      await assert.rejects(client.query(
        `UPDATE organizations SET id_doc_retention_days = 91 WHERE id = $1`, [ORG_ID]),
        (error: unknown) => (error as { code?: string }).code === "23514");
      await client.query("ROLLBACK TO SAVEPOINT above_cap");
      await client.query(`UPDATE platform_settings SET value = '20'
        WHERE key = 'id_documents.max_retention_days_after_close'`);
      assert.equal((await client.query(`SELECT id_doc_retention_days AS days
        FROM organizations WHERE id = $1`, [ORG_ID])).rows[0].days, 20);
      await client.query(`UPDATE platform_settings SET value = '90'
        WHERE key = 'id_documents.max_retention_days_after_close'`);
      await client.query(`UPDATE platform_settings SET value = 'true'
        WHERE key = 'id_documents.org_retention_locked'`);
      for (const legacyDays of [30, 120]) {
        // Superuser fixture only: model legacy data without weakening the guard.
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query(`UPDATE organizations SET id_doc_retention_days = $2 WHERE id = $1`, [ORG_ID, legacyDays]);
        await client.query("SET LOCAL session_replication_role = origin");
        const contact = await client.query<{ id: string }>(
          `INSERT INTO contacts (org_id, is_tenant, display_name)
           VALUES ($1, true, 'legacy retention clock') RETURNING id`, [ORG_ID]);
        const lease = await client.query<{ id: string }>(
          `INSERT INTO leases (
             org_id, property_id, unit_id, target_unit_id, target_room_id, status, esign_status,
             start_date, end_date, terminated_on, currency, rent_amount_minor, deposit_amount_minor, created_by
           ) SELECT org_id, property_id, unit_id, target_unit_id, target_room_id, 'terminated', 'fully_signed',
                    current_date - 500, current_date - 150, current_date - 200,
                    currency, rent_amount_minor, 0, created_by
               FROM leases WHERE org_id = $1 LIMIT 1 RETURNING id`, [ORG_ID]);
        assert.ok(lease.rows[0]?.id);
        for (const leaseId of [lease.rows[0].id, null]) {
          const document = await client.query<{ id: string }>(
            `INSERT INTO identity_documents (
               org_id, contact_id, lease_id, doc_type, number_masked, storage_path,
               encryption_key_ref, created_at
             ) VALUES ($1, $2, $3, 'passport', 'A******789', $4,
                       'env:ID_DOC_ENCRYPTION_KEY', '2020-06-01 23:30:00+00') RETURNING id`,
            [ORG_ID, contact.rows[0].id, leaseId, `${ORG_ID}/legacy-${legacyDays}-${leaseId ?? "upload"}`]);
          const due = await client.query(
            `SELECT v.retention_days, d.delete_after::text AS actual,
                    CASE WHEN d.lease_id IS NULL THEN DATE '2020-06-02' + 90
                         ELSE current_date - 200 + 90 END::text AS expected
               FROM identity_documents d JOIN id_documents_due_for_purge v ON v.document_id = d.id
              WHERE d.id = $1`, [document.rows[0].id]);
          assert.equal(due.rowCount, 1);
          assert.equal(due.rows[0].retention_days, 90);
          assert.equal(due.rows[0].actual, due.rows[0].expected);
          for (const cap of [60, 100, 90]) {
            await client.query(`UPDATE platform_settings SET value = to_jsonb($1::int)
              WHERE key = 'id_documents.max_retention_days_after_close'`, [cap]);
            const changed = await client.query(
              `SELECT o.id_doc_retention_days AS stored, id_document_keep_days() AS effective,
                      d.delete_after = CASE WHEN d.lease_id IS NULL THEN DATE '2020-06-02' + $2::int
                        ELSE current_date - 200 + $2::int END AS correct
                 FROM identity_documents d JOIN organizations o ON o.id = d.org_id WHERE d.id = $1`,
              [document.rows[0].id, cap]);
            assert.deepEqual(changed.rows[0], { stored: legacyDays, effective: cap, correct: true });
          }
          await client.query(`DELETE FROM identity_documents WHERE id = $1`, [document.rows[0].id]);
        }
      }
      const defaultOrg = await client.query(`INSERT INTO organizations (name, country_code, default_currency)
        VALUES ('retention default', 'TW', 'TWD') RETURNING id_doc_retention_days`);
      assert.equal(defaultOrg.rows[0].id_doc_retention_days, 90);
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
