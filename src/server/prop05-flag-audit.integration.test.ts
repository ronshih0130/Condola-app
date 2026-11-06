import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>, db: Client;
test.before(async () => { clone = await cloneTestDatabase(); db = new Client({ connectionString: clone.url }); await db.connect(); });
test.after(async () => { await db?.end(); await clone?.cleanup(); });

const rows = async (key: string) => (await db.query<{ action: string; old_row: unknown; new_row: unknown; changed_cols: string[] | null; reason: string | null; org_id: string | null }>(
  `SELECT action::text,old_row,new_row,changed_cols,reason,org_id::text FROM audit_log WHERE table_name='platform_settings' AND row_id=$1 ORDER BY id`, [key])).rows;

test("platform_settings insert/update/delete are audited with reason; no-op updates are not", async () => {
  const key = "prop05_audit_probe";
  await db.query(`INSERT INTO platform_settings(key,value) VALUES($1,'{"enabled":false,"allowed_org_ids":[]}'::jsonb)`, [key]);
  await db.query("BEGIN");
  await db.query(`SELECT set_config('app.change_reason','enable for pilot org',true)`);
  await db.query(`UPDATE platform_settings SET value='{"enabled":true,"allowed_org_ids":["11111111-1111-4111-8111-111111111111"]}'::jsonb WHERE key=$1`, [key]);
  await db.query("COMMIT");
  await db.query(`UPDATE platform_settings SET value=value WHERE key=$1`, [key]);
  await db.query(`DELETE FROM platform_settings WHERE key=$1`, [key]);
  const log = await rows(key);
  assert.deepEqual(log.map((r) => r.action), ["insert", "update", "delete"]);
  assert.equal(log[1].reason, "enable for pilot org");
  assert.deepEqual(log[1].changed_cols, ["value"]);
  assert.deepEqual((log[1].old_row as { value: unknown }).value, { enabled: false, allowed_org_ids: [] });
  assert.equal(log.every((r) => r.org_id === null), true);
});

test("the audit trigger function is SECURITY DEFINER with pinned search_path and no API execute", async () => {
  const f = (await db.query<{ oid: string; prosecdef: boolean; proconfig: string[] }>(
    `SELECT p.oid::text,p.prosecdef,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname='prop05_audit_platform_settings'`)).rows[0];
  assert.ok(f); assert.equal(f.prosecdef, true); assert.ok(f.proconfig.includes("search_path=pg_catalog, public, app"));
  for (const role of ["anon", "authenticated", "service_role"])
    assert.equal((await db.query(`SELECT has_function_privilege($1,$2::oid,'EXECUTE') a`, [role, f.oid])).rows[0].a, false);
});

test("actor_role records the invoking role, not the trigger function owner", async () => {
  const key = "prop05_role_probe";
  await db.query("BEGIN");
  await db.query("SET LOCAL ROLE service_role");
  await db.query(`INSERT INTO platform_settings(key,value) VALUES($1,'{"enabled":false,"allowed_org_ids":[]}'::jsonb)`, [key]).catch(async (e) => { await db.query("ROLLBACK"); throw e; });
  await db.query("COMMIT");
  const row = (await db.query<{ actor_role: string }>(`SELECT actor_role FROM audit_log WHERE table_name='platform_settings' AND row_id=$1`, [key])).rows[0];
  assert.equal(row.actor_role, "service_role");
});

