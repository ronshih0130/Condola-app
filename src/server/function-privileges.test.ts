import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

function read(path: string) {
  return readFileSync(path, "utf8");
}

test("default privileges revoke future execute and do not touch existing functions", () => {
  const sql = read("supabase/migrations/20261029120000_default_function_privileges.sql");
  assert.match(sql, /FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC/);
  assert.match(sql, /FOR ROLE supabase_admin IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /FOR ROLE supabase_admin REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.example\(uuid\) TO authenticated/);
  assert.doesNotMatch(sql, /REVOKE EXECUTE ON FUNCTION /);
  assert.doesNotMatch(sql, /REVOKE EXECUTE ON ALL FUNCTIONS/);
  assert.doesNotMatch(sql, /DROP FUNCTION/i);
});

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) found.push(full);
  }
  return found;
}

test("src does not call PostgREST RPC", () => {
  const sources = walk("src");
  assert.ok(sources.length > 10);
  for (const file of sources) {
    const source = read(file);
    assert.doesNotMatch(source, /supabase\.rpc\s*\(/, file);
    assert.doesNotMatch(source, /@supabase\//, file);
  }
  assert.doesNotMatch(read("package.json"), /@supabase\//);
  const allow = read("supabase/rpc-allowlist.txt");
  assert.match(allow, /no supabase\.rpc/);
  assert.match(allow, /GRANT EXECUTE ON FUNCTION/);
});

test("CI runs the local function privilege check", () => {
  for (const file of [".github/workflows/ci.yml", ".depot/workflows/ci.yml"]) {
    const workflow = read(file);
    assert.match(workflow, /scripts\/check-function-privileges\.sh/);
  }
  const script = read("scripts/check-function-privileges.sh");
  assert.match(script, /has_function_privilege/);
  assert.match(script, /condola_fn_priv/);
  assert.match(script, /non-local/);
  assert.match(script, /20261029150000_lock_public_function_execute\.sql/);
  assert.match(script, /anon executable public functions/);
  assert.match(script, /@mode any is rejected/);
  assert.match(script, /default-privilege probe: skipped/);
});

test("the allowlist is authenticated-only and anon is not granted", () => {
  const allow = read("supabase/rpc-allowlist.txt");
  assert.doesNotMatch(allow, /^# @mode any\b/m);
  assert.match(allow, /# @mode authenticated/);
  assert.match(allow, /public\.post_reversal\(p_txn uuid, p_reason text\)/);
  assert.match(allow, /public\.fn_invoice_recalc\(p_invoice uuid\)/);
  assert.match(allow, /public\.condola_property_address_key\(display text\)/);
  assert.match(allow, /public\.effective_rule\(p_jurisdiction uuid, p_org uuid, p_key text, p_on date\)/);
  assert.match(allow, /public\.platform_max_id_retention_days\(\)/);
  assert.doesNotMatch(allow, /line_lease_picker/);
  assert.doesNotMatch(allow, /purge_due_identity_documents/);
  assert.doesNotMatch(allow, /fn_org_country_setting/);
});
