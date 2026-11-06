import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL(
  "../../supabase/migrations/20261105170000_b013_repair_approval_state.sql",
  import.meta.url,
), "utf8");
const sql = source.replace(/--[^\n]*/g, "");
const tables = [
  "app.b013_estimate_heads",
  "app.b013_estimate_versions",
  "app.b013_estimate_decisions",
  "app.b013_repair_emergencies",
  "app.b013_repair_appointments",
  "app.b013_repair_event_outbox",
  "app.b013_repair_commands",
];
const history = tables.filter(table => table !== "app.b013_estimate_heads");
const gateways = [
  "b013_submit_estimate", "b013_decide_estimate", "b013_authorize_emergency",
  "b013_record_appointment", "b013_emit_reminder", "b013_dispatch_allowed",
];

function tableBody(table: string): string {
  const body = sql.match(new RegExp(
    String.raw`CREATE TABLE ${table.replaceAll(".", "\\.")} \(([\s\S]*?)\n\);`, "i",
  ))?.[1];
  assert.ok(body, `missing ${table}`);
  return body;
}

test("seven private tables enable RLS and revoke every application role", () => {
  assert.deepEqual([...sql.matchAll(/CREATE TABLE\s+([\w.]+)/gi)].map(m => m[1]), tables);
  for (const table of tables) {
    assert.ok(sql.includes(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`));
    tableBody(table);
  }
  const revoke = sql.match(/REVOKE ALL ON TABLE\s+([\s\S]+?)\s+FROM PUBLIC,\s*anon,\s*authenticated,\s*service_role;/i);
  assert.ok(revoke);
  assert.deepEqual(revoke[1].split(",").map(s => s.trim()).sort(), [...tables].sort());
  assert.doesNotMatch(sql, /CREATE POLICY|DISABLE ROW LEVEL SECURITY/i);
  assert.doesNotMatch(sql, /\bGRANT\s+(?!EXECUTE\b)/i);
  assert.doesNotMatch(sql, /\bGRANT\b[^;]*\bTO\b[^;]*\b(?:PUBLIC|anon|authenticated)\b/i);
});

test("six immutable history tables reject row edits and truncation", () => {
  const loop = sql.match(/FOREACH relation_name IN ARRAY ARRAY\[([\s\S]+?)\] LOOP([\s\S]+?)END LOOP;/);
  assert.ok(loop);
  assert.deepEqual(
    [...loop[1].matchAll(/'([^']+)'/g)].map(m => `app.${m[1]}`).sort(),
    [...history].sort(),
  );
  assert.match(loop[2], /BEFORE UPDATE OR DELETE ON app\.%I\s+FOR EACH ROW/);
  assert.match(loop[2], /BEFORE TRUNCATE ON app\.%I\s+FOR EACH STATEMENT/);
  assert.equal([...loop[2].matchAll(/EXECUTE FUNCTION app\.b013_approval_immutable_row\(\)/g)].length, 2);
  assert.match(sql, /RAISE EXCEPTION 'Immutable repair approval history' USING ERRCODE = '23514'/);
  assert.match(sql, /REVOKE ALL ON FUNCTION app\.b013_approval_immutable_row\(\) FROM PUBLIC, anon, authenticated, service_role;/);
});

test("threshold, ticket binding, cyclic heads and outbox dedupe are structural", () => {
  const versions = tableBody("app.b013_estimate_versions");
  assert.match(versions, /GENERATED ALWAYS AS \(amount_minor > captured_threshold_minor\) STORED/);
  assert.match(versions, /currency char\(3\) NOT NULL CHECK \(currency ~ '\^\[A-Z\]\{3\}\$'\)/);
  assert.match(versions, /REFERENCES app\.b013_estimate_heads\(org_id, ticket_id\)\s+ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql, /FOREIGN KEY \(org_id, ticket_id, current_version_id\)\s+REFERENCES app\.b013_estimate_versions\(org_id, ticket_id, id\)\s+DEFERRABLE INITIALLY DEFERRED/);
  assert.match(versions, /threshold_source = 'regional_default' AND threshold_revision_id IS NULL/);
  assert.match(versions, /threshold_source <> 'regional_default' AND threshold_revision_id IS NOT NULL/);
  assert.match(tableBody("app.b013_estimate_decisions"), /UNIQUE \(org_id, version_id\)/);
  assert.match(tableBody("app.b013_estimate_decisions"), /version_id, decided_by\)\s+REFERENCES app\.b013_estimate_versions\(org_id, ticket_id, id, designated_principal_id\)/);
  const outbox = tableBody("app.b013_repair_event_outbox");
  assert.match(outbox, /kind text NOT NULL/);
  assert.match(outbox, /UNIQUE \(org_id, version_id, kind\)/);
  assert.match(tableBody("app.b013_repair_commands"), /PRIMARY KEY \(actor_id, request_id\)/);
  assert.match(tableBody("app.b013_repair_commands"), /result_json jsonb NOT NULL/);
  assert.match(tableBody("app.b013_repair_appointments"), /FOREIGN KEY \(repair_vendor_job_id\) REFERENCES public\.repair_vendor_jobs\(id\) ON DELETE RESTRICT/);
  assert.doesNotMatch(sql, /public\.currencies|\bdigest\s*\(/i);
});

test("only the six SECURITY DEFINER gateways are granted to service_role", () => {
  const grants = [...sql.matchAll(/\bGRANT\s+([^;]+);/gi)].map(m => m[1]);
  assert.equal(grants.length, gateways.length);
  for (const name of gateways) {
    assert.equal(grants.filter(grant => grant.startsWith(`EXECUTE ON FUNCTION app.${name}(`)).length, 1);
    assert.match(sql, new RegExp(
      String.raw`CREATE FUNCTION app\.${name}\([\s\S]+?RETURNS (?:jsonb|boolean)[\s\S]+?SECURITY DEFINER SET search_path=pg_catalog,public,app,pg_temp AS \$\$`,
    ));
    assert.match(sql, new RegExp(
      String.raw`REVOKE ALL ON FUNCTION app\.${name}\([^;]+?\)\s+FROM PUBLIC, anon, authenticated, service_role;`,
    ));
  }
  for (const grant of grants) assert.match(grant, /\)\s+TO service_role$/);
});

test("migration is atomic, bounded, additive and does not enable rollout flags", () => {
  assert.match(sql, /^\s*BEGIN;/);
  assert.match(sql, /SET LOCAL lock_timeout = '5s';/);
  assert.match(sql, /SET LOCAL statement_timeout = '60s';/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.doesNotMatch(sql, /\bDROP\b|CREATE TYPE|CREATE TABLE IF NOT EXISTS|ALTER TABLE public\./i);
  assert.doesNotMatch(sql, /(?:INSERT INTO|UPDATE)\s+public\.(?:platform_settings|organizations)\b/i);
  const reminder = sql.match(/CREATE FUNCTION app\.b013_emit_reminder\b([\s\S]*?)END \$\$;/)?.[1];
  assert.ok(reminder);
  assert.match(reminder, /ON CONFLICT \(org_id, version_id, kind\) DO NOTHING/);
  assert.doesNotMatch(reminder, /(?:INSERT INTO|UPDATE)\s+app\.b013_estimate_(?:decisions|heads)/);
});
