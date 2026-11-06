import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const filename = "20261106010000_b009_bank_match_decisions.sql";
const sql = readFileSync(new URL("../../supabase/migrations/" + filename, import.meta.url), "utf8");

test("bank decision migration is atomic, bounded and makes no data or flag changes", () => {
  assert.match(sql, /^BEGIN;[\s\S]*COMMIT;\s*$/);
  assert.match(sql, /SET LOCAL lock_timeout = '5s';/);
  assert.match(sql, /SET LOCAL statement_timeout = '60s';/);
  assert.doesNotMatch(sql, /\bGRANT\b/i);
  assert.doesNotMatch(sql, /\bUPDATE\s+public\.platform_settings\b/i);
  assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/i);
});

test("row identities are private and immutable", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS app\.b009_row_identities\s*\(/);
  assert.match(sql, /PRIMARY KEY\s*\(org_id,bank_account_id,row_key\)/);
  assert.match(sql, /REVOKE ALL ON app\.b009_row_identities FROM PUBLIC,anon,authenticated,service_role;/);
  assert.match(sql, /DROP TRIGGER IF EXISTS b009_row_identities_no_change ON app\.b009_row_identities;/);
  assert.match(sql, /CREATE TRIGGER b009_row_identities_no_change BEFORE UPDATE OR DELETE ON app\.b009_row_identities\s+FOR EACH ROW EXECUTE FUNCTION app\.b009_decisions_immutable\(\);/);
  assert.match(sql, /DROP TRIGGER IF EXISTS b009_row_identities_no_truncate ON app\.b009_row_identities;/);
  assert.match(sql, /CREATE TRIGGER b009_row_identities_no_truncate BEFORE TRUNCATE ON app\.b009_row_identities\s+FOR EACH STATEMENT EXECUTE FUNCTION app\.b009_decisions_immutable\(\);/);
});

test("decisions support request replay and one effective match per bank transaction and payment", () => {
  assert.match(sql, /ALTER TABLE app\.b009_decisions\s+ADD COLUMN IF NOT EXISTS request_id uuid,\s+ADD COLUMN IF NOT EXISTS request_digest text;/);
  assert.match(sql, /IF NOT EXISTS[\s\S]*conname = 'b009_decisions_request_pair'/);
  assert.match(sql, /ADD CONSTRAINT b009_decisions_request_pair\s+CHECK/);
  assert.match(sql, /request_digest ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS b009_decisions_request_uq\s+ON app\.b009_decisions\(org_id,request_id\) WHERE request_id IS NOT NULL;/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS b009_decisions_one_match_bank\s+ON app\.b009_decisions\(org_id,bank_transaction_id\) WHERE decision='match';/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS b009_decisions_one_match_payment\s+ON app\.b009_decisions\(org_id,payment_id\) WHERE decision='match';/);
});
