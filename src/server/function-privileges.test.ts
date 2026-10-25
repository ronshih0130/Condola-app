import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

function read(path: string) {
  return readFileSync(path, "utf8");
}

test("default privileges revoke future execute and do not touch existing functions", () => {
  const sql = read("supabase/migrations/20261030130000_default_function_privileges.sql");
  assert.match(sql, /FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC/);
  assert.match(sql, /FOR ROLE supabase_admin IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /FOR ROLE supabase_admin REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.example\(uuid\) TO authenticated/);
  assert.match(sql, /WHEN insufficient_privilege THEN/);
  assert.match(sql, /insufficient_privilege changing default privileges for role supabase_admin/);
  const adminAt = sql.indexOf("DO $supabase_admin$");
  const postgresAt = sql.indexOf("FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE");
  assert.ok(postgresAt > 0 && adminAt > postgresAt);
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
  const pkg = JSON.parse(read("package.json")) as { dependencies?: Record<string, string> };
  const scope = "@" + "supabase";
  assert.equal(Object.keys(pkg.dependencies ?? {}).some((name) => name.split("/")[0] === scope), false);
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
  assert.match(script, /20261030100000_lock_public_function_execute\.sql/);
  assert.match(script, /anon executable public functions/);
  assert.match(script, /@mode any is rejected/);
  assert.match(script, /default-privilege probe: skipped/);
  assert.match(script, /gotrue_confirm_uses/);
  assert.match(script, /utility function revoke probe/);
  assert.match(script, /app\.audit_event\(uuid, text, jsonb\)/);
  assert.match(script, /app\.is_member\(uuid\)/);
  assert.match(script, /permission table before\/after/);
  assert.match(script, /is_member_check=/);
  const member = read("supabase/migrations/20261030140500_revoke_app_is_member_execute.sql");
  assert.match(member, /REVOKE EXECUTE ON FUNCTION app\.is_member\(uuid\) FROM PUBLIC/);
  assert.match(member, /REVOKE EXECUTE ON FUNCTION app\.is_member\(uuid\) FROM anon/);
  assert.match(member, /GRANT EXECUTE ON FUNCTION app\.is_member\(uuid\) TO authenticated, service_role/);
  assert.doesNotMatch(member, /FROM authenticated/);
  assert.doesNotMatch(member, /FROM service_role/);
  assert.match(script, /merged trigger revoke probe/);
  assert.match(script, /public\.fn_id_photo_drop_wm\(\)/);
  assert.match(script, /public\.fn_lease_close_end_date\(\)/);
  assert.match(script, /20261030150000_revoke_id_photo_lease_close_execute\.sql/);
});

test("merged trigger functions lose EXECUTE only when they exist", () => {
  const names = readdirSync("supabase/migrations").filter((name) => name.endsWith(".sql")).sort();
  const file = "20261030150000_revoke_id_photo_lease_close_execute.sql";
  assert.ok(names.includes(file));
  assert.ok(file > "20261030140500_revoke_app_is_member_execute.sql");
  const sql = read(`supabase/migrations/${file}`);
  assert.match(sql, /Version 20261030150000/);
  assert.match(sql, /IF EXISTS \(\s*SELECT 1 FROM pg_proc WHERE oid = to_regprocedure\('public\.fn_id_photo_drop_wm\(\)'\)/);
  assert.match(sql, /IF EXISTS \(\s*SELECT 1 FROM pg_proc WHERE oid = to_regprocedure\('public\.fn_lease_close_end_date\(\)'\)/);
  assert.match(sql, /REVOKE EXECUTE ON FUNCTION public\.fn_id_photo_drop_wm\(\) FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /REVOKE EXECUTE ON FUNCTION public\.fn_lease_close_end_date\(\) FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /skip missing function public\.fn_id_photo_drop_wm\(\)/);
  assert.match(sql, /skip missing function public\.fn_lease_close_end_date\(\)/);
  assert.doesNotMatch(sql, /GRANT EXECUTE/);
  assert.doesNotMatch(sql, /CREATE (TABLE|FUNCTION|OR REPLACE)/i);
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|ALTER TABLE|DROP)\b/i);
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
  assert.match(allow, /public\.post_reversal\(p_txn uuid, p_reason text, p_invoice uuid\)/);
  assert.match(allow, /app\.audit_event\(p_org uuid, p_event text, p_detail jsonb\)/);
  assert.doesNotMatch(allow, /line_lease_picker/);
  assert.doesNotMatch(allow, /utility_runs_fill_unit_id/);
  assert.doesNotMatch(allow, /utility_runs_reuse_open_period/);
  assert.doesNotMatch(allow, /purge_due_identity_documents/);
  assert.doesNotMatch(allow, /fn_org_country_setting/);
});
