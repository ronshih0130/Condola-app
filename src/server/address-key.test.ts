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
