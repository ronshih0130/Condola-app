import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql = readFileSync(new URL(
  "../../supabase/migrations/20261105120500_prop09_deposit_settlement.sql",
  import.meta.url,
), "utf8").replace(/--[^\n]*/g, "");
const tables = ["records", "lines", "evidence", "confirmations", "payments"]
  .map(name => `app.deposit_settlement_${name}`);
const statements = sql.split(";").map(statement => statement.trim()).filter(Boolean);
const grants = statements.filter(statement => /^GRANT\b/i.test(statement));

function tableBody(name: string): string {
  const body = sql.match(new RegExp(
    `CREATE TABLE app\\.deposit_settlement_${name} \\(([\\s\\S]*?)\\n\\);`,
    "i",
  ))?.[1];
  assert.ok(body, `missing ${name} table`);
  return body;
}

test("deposit settlement creates five private tables with service-only grants", () => {
  assert.deepEqual(
    [...sql.matchAll(/CREATE TABLE\s+(app\.deposit_settlement_\w+)/gi)].map(match => match[1]),
    tables,
  );
  for (const table of tables) {
    const escaped = table.replace(".", "\\.");
    assert.match(sql, new RegExp(`ALTER TABLE ${escaped}\\s+ENABLE ROW LEVEL SECURITY;`, "i"));
    assert.ok(statements.some(statement =>
      /^REVOKE ALL ON\b/i.test(statement) &&
      statement.includes(table) &&
      /FROM PUBLIC,\s*anon,\s*authenticated$/i.test(statement)));
    assert.ok(grants.some(statement =>
      /^GRANT SELECT,\s*INSERT ON\b/i.test(statement) &&
      statement.includes(table) &&
      /TO service_role$/i.test(statement)));
  }
  assert.equal(grants.length, 3);
  for (const grant of grants) {
    assert.match(grant, /\bTO service_role$/i);
    assert.doesNotMatch(grant, /\bTO\b[\s\S]*\b(?:PUBLIC|anon|authenticated)\b/i);
    assert.doesNotMatch(grant, /\b(?:DELETE|ALL)\b/i);
  }
  assert.match(sql, /GRANT UPDATE \(status, confirmed_total_deduction_minor, confirmed_at\)\s+ON app\.deposit_settlement_records TO service_role;/);
  assert.match(sql, /GRANT UPDATE \(amount_minor, prior_amount_minor, corrected_at, reason\)\s+ON app\.deposit_settlement_lines TO service_role;/);
  assert.doesNotMatch(sql, /CREATE POLICY|DISABLE ROW LEVEL SECURITY/i);
});

test("settlement documents, party confirmations and actual payments stay separate", () => {
  const records = tableBody("records");
  const confirmations = tableBody("confirmations");
  const payments = tableBody("payments");
  assert.match(records, /confirmed_total_deduction_minor bigint/);
  assert.doesNotMatch(records, /\b(?:reported_at|account_last5|paid_at)\b/);
  assert.match(confirmations, /UNIQUE \(settlement_id, party_kind, request_id\)/);
  assert.match(confirmations, /confirmed_amount_minor bigint/);
  assert.doesNotMatch(confirmations, /\b(?:reported_at|account_last5|paid_at)\b/);
  assert.match(payments, /direction IN \('refund','top_up'\)/);
  assert.match(payments, /reported_at timestamptz/);
  assert.match(payments, /REFERENCES app\.deposit_settlement_records/);
  assert.doesNotMatch(payments, /REFERENCES app\.deposit_settlement_confirmations/);
  assert.match(payments, /account_last5 text CHECK \(account_last5 ~ '\^\[0-9\]\{4,5\}\$'\)/);
  assert.doesNotMatch(sql, /\b(?:account_number|account_numbers|bank_account|bank_account_number)\b/i);
});

test("migration is additive, bounded and does not seed flags or rewrite history", () => {
  assert.match(sql, /^\s*BEGIN;/);
  assert.match(sql, /SET LOCAL lock_timeout = '5s';/);
  assert.match(sql, /SET LOCAL statement_timeout = '60s';/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.doesNotMatch(sql, /\bINSERT\s+INTO\b/i);
  assert.doesNotMatch(sql, /\bplatform_settings\b/i);
  assert.doesNotMatch(sql, /ALTER TABLE\s+(?:public\.|app\.)?(?:handover_records|lease_charges|leases)\b/i);
  assert.doesNotMatch(sql, /\bdeposit_settled_at\b/i);
  assert.doesNotMatch(sql, /\b(?:UPDATE|DELETE FROM)\s+(?:public\.|app\.)?(?:handover_records|lease_charges|leases)\b/i);
  assert.equal([...sql.matchAll(/CREATE INDEX\s+\w+\s+ON\b/gi)].length, 6);
  assert.doesNotMatch(sql, /CREATE INDEX\s+ON\b/i);
  assert.doesNotMatch(sql, /MATCH FULL/i);
  assert.match(tableBody("records"), /source_handover_record_id uuid\s*,/);
  assert.match(tableBody("lines"), /source_lease_charge_id uuid\s*,/);
  assert.match(tableBody("evidence"), /line_id uuid\s*,/);
  assert.match(tableBody("evidence"), /handover_attachment_id uuid\s*,/);
  assert.match(tableBody("lines"), /FOREIGN KEY \(org_id, source_lease_charge_id\)\s+REFERENCES public\.lease_charges\(org_id, id\)/);
});
