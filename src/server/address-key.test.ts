import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const syncMigration = "20261029120000_sync_address_key_errors.sql";

function sqlWithoutComments(name: string) {
  const sql = readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), "utf8");
  return { sql, code: sql.replace(/--.*$/gm, "") };
}

test("address-key sync logs failures and stays add-only", () => {
  const names = readdirSync(new URL("../../supabase/migrations/", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(names.includes(syncMigration));
  assert.ok(names.includes("20261028180000_utility_owner_lines.sql"));
  assert.ok(syncMigration > "20261028180000_utility_owner_lines.sql");
  assert.equal(
    names.filter((name) => name < syncMigration).includes("20261026130000_bulk_import.sql"),
    true,
  );

  const { sql, code } = sqlWithoutComments(syncMigration);
  assert.match(sql, /20261029120000/);
  assert.match(code, /CREATE TABLE IF NOT EXISTS public\.condola_sync_errors/);
  assert.match(
    code,
    /FUNCTION public\.condola_sync_unit_address_keys\(\)\s+RETURNS trigger\s+LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = pg_catalog, public/,
  );
  assert.match(code, /GET STACKED DIAGNOSTICS/);
  assert.match(code, /INSERT INTO public\.condola_sync_errors \(source, org_id, row_id, sqlstate, message, detail\)/);
  assert.match(code, /'condola_sync_unit_address_keys'/);
  assert.match(code, /RAISE WARNING 'condola_sync_unit_address_keys could not log %: %'/);
  assert.match(code, /SET import_address_key = NEW\.address_key/);
  assert.match(code, /WHERE property_id = NEW\.id\s+AND org_id = NEW\.org_id/);
  assert.match(code, /REVOKE ALL ON TABLE public\.condola_sync_errors FROM PUBLIC, anon, authenticated/);
  assert.match(code, /GRANT SELECT, INSERT ON TABLE public\.condola_sync_errors TO service_role/);
  assert.match(code, /REVOKE EXECUTE ON FUNCTION public\.condola_sync_unit_address_keys\(\) FROM PUBLIC, anon, authenticated/);
  assert.equal(code.match(/RETURN NEW/g)?.length, 1);
  assert.doesNotMatch(code, /RETURN NULL/i);
  assert.doesNotMatch(code, /\bDROP\b/i);
  assert.doesNotMatch(code, /SET NOT NULL/i);
  assert.doesNotMatch(code, /ADD CONSTRAINT/i);
  assert.doesNotMatch(code, /ALTER TABLE\s+public\.(properties|units)/i);
  assert.doesNotMatch(code, /DISABLE TRIGGER/i);
  assert.doesNotMatch(code, /REFERENCES/i);
});

const moveMigration = "20261029130000_unit_import_key_on_move.sql";

test("a unit key refreshes on move and the backfill stays out of the migration", () => {
  const names = readdirSync(new URL("../../supabase/migrations/", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(names.includes(moveMigration));
  assert.ok(moveMigration > syncMigration);
  assert.equal(names.includes("backfill-unit-import-address-keys.sql"), false);

  const { sql, code } = sqlWithoutComments(moveMigration);
  assert.match(sql, /20261029130000/);
  assert.match(sql, /scripts\/backfill-unit-import-address-keys\.sql/);
  assert.match(
    code,
    /FUNCTION public\.condola_set_unit_import_address_key\(\)\s+RETURNS trigger\s+LANGUAGE plpgsql\s+SET search_path = pg_catalog, public/,
  );
  assert.match(code, /TG_OP = 'UPDATE' AND NEW\.property_id IS DISTINCT FROM OLD\.property_id/);
  assert.match(code, /ELSIF NEW\.import_address_key IS NULL THEN/);
  assert.match(code, /WHERE p\.id = NEW\.property_id\s+AND p\.org_id = NEW\.org_id/);
  assert.match(code, /REVOKE EXECUTE ON FUNCTION public\.condola_set_unit_import_address_key\(\) FROM PUBLIC, anon, authenticated/);
  assert.equal(code.match(/RETURN NEW/g)?.length, 1);
  assert.doesNotMatch(code, /UPDATE\s+(public\.)?units/i);
  assert.doesNotMatch(code, /\bDROP\b/i);
  assert.doesNotMatch(code, /SET NOT NULL/i);
  assert.doesNotMatch(code, /ADD CONSTRAINT/i);
  assert.doesNotMatch(code, /DISABLE TRIGGER/i);
  assert.doesNotMatch(code, /SECURITY DEFINER/i);

  const script = readFileSync(new URL("../../scripts/backfill-unit-import-address-keys.sql", import.meta.url), "utf8");
  const scriptCode = script.replace(/--.*$/gm, "");
  assert.match(scriptCode, /UPDATE public\.units AS u/);
  assert.match(scriptCode, /SET import_address_key = coalesce\(p\.address_key, public\.condola_property_address_key\(p\.address_display\)\)/);
  assert.match(scriptCode, /u\.import_address_key IS DISTINCT FROM coalesce\(p\.address_key, public\.condola_property_address_key\(p\.address_display\)\)/);
  assert.match(scriptCode, /DISABLE TRIGGER trg_units_updated_at/);
  assert.equal(scriptCode.match(/ENABLE TRIGGER trg_units_updated_at/g)?.length, 2);
  assert.match(scriptCode, /EXCEPTION WHEN OTHERS THEN[\s\S]*ENABLE TRIGGER trg_units_updated_at;\s*RAISE;/);
  assert.match(scriptCode, /backfill-unit-import-address-keys updated/);
  assert.doesNotMatch(scriptCode, /RETURN NULL/i);
});
