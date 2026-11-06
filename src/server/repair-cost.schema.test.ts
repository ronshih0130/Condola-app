import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL(
  "../../supabase/migrations/20261105160000_prop11_repair_cost_foundation.sql",
  import.meta.url,
), "utf8");
const sql = source.replace(/--[^\n]*/g, "");
const tables = [
  "app.repair_cost_items",
  "app.repair_cost_allocations",
  "app.repair_cost_documents",
  "app.repair_cost_statement_links",
  "app.repair_cost_visibility",
  "app.tenant_period_due_components",
];
const statements = sql.split(";").map(statement => statement.trim()).filter(Boolean);

function tableBody(table: string): string {
  const body = sql.match(new RegExp(
    `CREATE TABLE ${table.replaceAll(".", "\\.")} \\(([\\s\\S]*?)\\n\\);`,
    "i",
  ))?.[1];
  assert.ok(body, `missing ${table}`);
  return body;
}

test("repair cost foundation creates six private tables with service-only grants", () => {
  assert.deepEqual(
    [...sql.matchAll(/CREATE TABLE\s+([\w.]+)/gi)].map(match => match[1]),
    tables,
  );
  for (const table of tables) {
    assert.ok(statements.includes(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
    assert.match(tableBody(table), /UNIQUE \(org_id, id\)/);
  }
  const revokes = statements.filter(statement => /^REVOKE\b/i.test(statement));
  const grants = statements.filter(statement => /^GRANT\b/i.test(statement));
  assert.equal(revokes.length, 1);
  assert.equal(grants.length, 4);
  const revoke = revokes[0].match(/^REVOKE ALL ON TABLE\s+([\s\S]+)\s+FROM PUBLIC,\s*anon,\s*authenticated$/i);
  const selectInsert = grants[0].match(/^GRANT SELECT,\s*INSERT ON TABLE\s+([\s\S]+)\s+TO service_role$/i);
  assert.ok(revoke);
  assert.ok(selectInsert);
  assert.deepEqual(revoke[1].split(",").map(name => name.trim()), tables);
  assert.deepEqual(selectInsert[1].split(",").map(name => name.trim()), tables);
  assert.match(grants[1], /^GRANT UPDATE \(status, amount_minor, work_content, category, incurred_at\)\s+ON app\.repair_cost_items TO service_role$/i);
  assert.match(grants[2], /^GRANT UPDATE \(bearer, tenant_share_bp, owner_share_bp, management_share_bp,\s+default_source, prior_bearer, prior_tenant_share_bp, prior_owner_share_bp,\s+prior_management_share_bp, correction_reason, corrected_at, updated_at\)\s+ON app\.repair_cost_allocations TO service_role$/i);
  assert.match(grants[3], /^GRANT UPDATE \(can_view_financial, can_view_photos, basis\)\s+ON app\.repair_cost_visibility TO service_role$/i);
  assert.doesNotMatch(sql, /\bGRANT\b[\s\S]*?\bDELETE\b/i);
  assert.doesNotMatch(sql, /CREATE POLICY|DISABLE ROW LEVEL SECURITY/i);
  assert.doesNotMatch(sql, /GRANT\b[\s\S]*?\bTO\s+(?:anon|authenticated)\b/i);
});

test("migration is bounded and leaves existing schema, writers and flags alone", () => {
  assert.match(sql, /^\s*BEGIN;/);
  assert.match(sql, /SET LOCAL lock_timeout = '5s';/);
  assert.match(sql, /SET LOCAL statement_timeout = '60s';/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.doesNotMatch(sql, /\b(?:CREATE|ALTER)\s+TYPE\b/i);
  assert.doesNotMatch(sql, /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.|app\.)?\w+/i);
  assert.doesNotMatch(sql, /\bplatform_settings\b|\bCREATE\s+(?:OR REPLACE\s+)?(?:FUNCTION|TRIGGER)\b/i);
  assert.doesNotMatch(sql, /\bALTER TABLE\s+(?:ONLY\s+)?(?:public\.|app\.)?(?:tickets|maintenance_tickets|repair_vendor_jobs|owner_statement_lines|leases)\b/i);
  assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE)\b|\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i);
  assert.doesNotMatch(sql, /\b(?:account_number|bank_account_number|paid_at|payment_id)\b/i);
});

test("allocations reuse cost_bearer, require complete splits and retain corrections", () => {
  const body = tableBody("app.repair_cost_allocations");
  assert.match(body, /bearer public\.cost_bearer NOT NULL DEFAULT 'undecided'/);
  assert.match(body, /prior_bearer public\.cost_bearer/);
  for (const party of ["tenant", "owner", "management"]) {
    assert.ok(body.includes(`${party}_share_bp integer CHECK (${party}_share_bp BETWEEN 0 AND 10000)`));
    assert.ok(body.includes(`prior_${party}_share_bp integer`));
  }
  assert.match(body, /bearer = 'split'\s+AND tenant_share_bp IS NOT NULL AND owner_share_bp IS NOT NULL AND management_share_bp IS NOT NULL\s+AND tenant_share_bp \+ owner_share_bp \+ management_share_bp = 10000/);
  assert.match(body, /OR \(bearer <> 'split'\s+AND tenant_share_bp IS NULL AND owner_share_bp IS NULL AND management_share_bp IS NULL\)/);
  assert.match(body, /CHECK \(corrected_at IS NULL OR correction_reason IS NOT NULL\)/);
  assert.match(body, /UNIQUE \(cost_item_id\)/);
});

test("documents distinguish ticket photos and require exactly one evidence source", () => {
  const body = tableBody("app.repair_cost_documents");
  assert.match(body, /kind IN \('quote','receipt','invoice','work_photo','other'\)/);
  assert.match(body, /is_ticket_photo boolean GENERATED ALWAYS AS \(kind = 'work_photo'\) STORED/);
  assert.match(body, /\(ticket_attachment_id IS NOT NULL AND storage_path IS NULL\)\s+OR \(storage_path IS NOT NULL AND ticket_attachment_id IS NULL\)/);
  assert.match(body, /storage_path text UNIQUE/);
  const visibility = tableBody("app.repair_cost_visibility");
  assert.match(visibility, /party_kind IN \('owner','tenant','vendor','accountant','manager'\)/);
  assert.match(visibility, /can_view_photos boolean NOT NULL DEFAULT false/);
  assert.match(visibility, /can_view_financial boolean NOT NULL DEFAULT false/);
  assert.match(visibility, /UNIQUE \(cost_item_id, party_kind\)/);
});

test("references reuse real org keys and document the soft statement-line scope check", () => {
  assert.doesNotMatch(sql, /REFERENCES public\.(?:tickets|owner_statement_lines)\b/i);
  for (const name of ["items", "allocations", "documents"]) {
    assert.match(tableBody(`app.repair_cost_${name}`),
      /FOREIGN KEY \(org_id, ticket_id\) REFERENCES public\.maintenance_tickets\(org_id, id\)/);
  }
  for (const name of ["items", "documents", "statement_links"]) {
    assert.match(tableBody(`app.repair_cost_${name}`),
      /FOREIGN KEY \(org_id, repair_vendor_job_id\)\s+REFERENCES public\.repair_vendor_jobs\(org_id, id\)/);
  }
  for (const name of ["allocations", "documents", "statement_links", "visibility"]) {
    assert.match(tableBody(`app.repair_cost_${name}`),
      /FOREIGN KEY \(org_id, cost_item_id\)\s+REFERENCES app\.repair_cost_items\(org_id, id\)/);
  }
  const links = tableBody("app.repair_cost_statement_links");
  assert.match(links, /owner_statement_line_id uuid NOT NULL/);
  assert.match(links, /UNIQUE \(owner_statement_line_id, cost_item_id\)/);
  assert.match(source, /owner_statement_lines\.id = owner_statement_line_id AND org_id = scoped org_id/);
});

test("FR-Q6-01 reserves per-period components and source references without payments", () => {
  assert.match(source, /FR-Q6-01/);
  const body = tableBody("app.tenant_period_due_components");
  assert.ok(body.includes("period_ym ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'"));
  assert.match(body, /amount_minor bigint NOT NULL CHECK \(amount_minor >= 0\)/);
  assert.match(body, /currency text NOT NULL/);
  assert.match(body, /source_ref_kind IN \('lease_charge','repair_cost_item','deposit_settlement','manual','other'\)/);
  assert.match(body, /source_ref_id uuid,/);
  assert.match(body, /UNIQUE \(org_id, lease_id, period_ym, component_key, source_ref_kind, source_ref_id\)/);
  assert.match(body, /FOREIGN KEY \(org_id, lease_id\) REFERENCES public\.leases\(org_id, id\)/);
});
