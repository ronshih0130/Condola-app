import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("monthly rent operation migration defines tables, restricted access and immutable receipts", () => {
  const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261106000000_b008_monthly_rent_operation.sql"), "utf8");
  const tables = sql.match(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"?\w+"?)\.)?"?\w+"?/gi) ?? [];
  assert.ok(tables.length >= 2, "migration must create both tables");
  assert.match(sql, /\bENABLE\s+ROW\s+LEVEL\s+SECURITY\b/i);
  assert.match(sql, /\bREVOKE\s+ALL(?:\s+PRIVILEGES)?\s+ON\b[^;]*\bFROM\b[^;]*\bservice_role\b/i);
  assert.match(sql, /\bGRANT\s+SELECT\s*,\s*INSERT\b[^;]*\bTO\s+"?service_role"?\b/i);
  assert.match(sql, /\bON\s+CONFLICT\s*\(\s*"?key"?\s*\)\s+DO\s+NOTHING\b/i);
  assert.match(sql, /\bb008_monthly_receipt_immutable\b/i);
  assert.doesNotMatch(sql, /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:"?public"?\.)?"?expenses"?(?=\s|;)/i);
  assert.doesNotMatch(sql, /\bexpenses\b[^;]*\bCHECK\s*\(/i);
});
