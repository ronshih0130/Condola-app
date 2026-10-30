import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
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

test("PUBLIC loses EXECUTE on app helper functions; authenticated and service_role keep it", () => {
  const names = readdirSync("supabase/migrations").filter((name) => name.endsWith(".sql")).sort();
  const file = "20261030150500_revoke_public_function_execute.sql";
  assert.ok(names.includes(file));
  assert.ok(names.indexOf(file) > names.indexOf("20261030150400_ticket_job_type_reserve.sql"));
  assert.ok(file > "20261030150400_ticket_job_type_reserve.sql");
  assert.ok(file < "20261030160000");
  const sql = read(`supabase/migrations/${file}`);
  assert.match(sql, /Version 20261030150500/);

  const signatures = [
    "app.can_see_ticket(uuid)",
    "app.has_role(uuid, org_role[])",
    "app.in_thread(uuid)",
    "app.income_expense_report(uuid, uuid, uuid, date, date)",
    "app.is_lease_tenant(uuid)",
    "app.is_my_contact(uuid)",
    "app.is_property_owner(uuid)",
    "app.lease_context_prefix(uuid)",
    "app.my_contact_ids()",
    "app.my_tenant_leases()",
    "app.tenant_of_property(uuid)",
  ];
  for (const signature of signatures) {
    const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s*");
    assert.match(sql, new RegExp(`REVOKE\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+${escaped}\\s+FROM\\s+PUBLIC\\s*;`, "i"), signature);
    assert.match(sql, new RegExp(`GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+${escaped}\\s+TO\\s+authenticated\\s*,\\s*service_role\\s*;`, "i"), signature);
  }

  const revokes = sql.split("\n").filter((line) => /^\s*REVOKE\b/i.test(line));
  assert.equal(revokes.length, signatures.length);
  for (const line of revokes) {
    assert.doesNotMatch(line, /FROM\s+(anon|authenticated|service_role)/i);
    assert.match(line, /FROM\s+PUBLIC\s*;$/i);
  }
  assert.doesNotMatch(sql, /\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/i);
  assert.doesNotMatch(sql, /\bALTER\s+FUNCTION\b/i);
  assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|DROP)\b/i);
  assert.doesNotMatch(sql, /skip missing|IF EXISTS/i);
  assert.doesNotMatch(sql, /\b(skip|missing)\b/i);
  assert.match(sql, /SET LOCAL lock_timeout = '5s';/);
  assert.match(sql, /DO\s+\$assert_function_privileges\$/);

  const helperArray = sql.match(/helper_signatures\s+text\[\]\s*:=\s*ARRAY\[([\s\S]*?)\];/);
  assert.ok(helperArray);
  assert.deepEqual(
    Array.from(helperArray[1].matchAll(/'([^']+)'/g), (match) => match[1]),
    signatures,
  );

  const publicCheck = sql.match(
    /SELECT string_agg\([\s\S]*?RAISE EXCEPTION 'PUBLIC still has EXECUTE on: %', offending;\s*END IF;/,
  );
  assert.ok(publicCheck);
  assert.match(publicCheck[0], /FROM unnest\(helper_signatures\) AS helpers\(signature\)/);
  assert.match(publicCheck[0], /JOIN pg_proc AS p ON p\.oid = helpers\.signature::regprocedure/);
  assert.match(publicCheck[0], /aclexplode\(coalesce\(p\.proacl, acldefault\('f', p\.proowner\)\)\)/);
  assert.match(publicCheck[0], /acl\.grantee = 0/);
  assert.match(publicCheck[0], /acl\.privilege_type = 'EXECUTE'/);
  assert.match(publicCheck[0], /IF offending IS NOT NULL THEN/);

  assert.match(sql, /FROM unnest\(helper_signatures\) AS helpers\(signature\)\s+CROSS JOIN/);
  assert.match(sql, /has_function_privilege\(/);
  assert.match(sql, /roles\.role_name, helpers\.signature::regprocedure, 'EXECUTE'/);
  assert.match(sql, /RAISE EXCEPTION 'Required role lacks EXECUTE on: %', offending/);
  assert.equal((sql.match(/\bRAISE EXCEPTION\b/g) ?? []).length, 2);

  const otherCheck = sql.match(
    /SELECT string_agg\(\s*format\('%I\.%I\(%s\)'[\s\S]*?RAISE NOTICE 'other functions with PUBLIC EXECUTE \(not changed here\): %', offending;\s*END IF;/,
  );
  assert.ok(otherCheck);
  assert.match(otherCheck[0], /n\.nspname IN \('app', 'public'\)/);
  assert.match(otherCheck[0], /AND NOT \(p\.oid = ANY \(helper_signatures::regprocedure\[\]\)\)/);
  assert.match(otherCheck[0], /AND NOT EXISTS \(/);
  assert.match(otherCheck[0], /d\.classid = 'pg_proc'::regclass/);
  assert.match(otherCheck[0], /d\.objid = p\.oid/);
  assert.match(otherCheck[0], /d\.objsubid = 0/);
  assert.match(otherCheck[0], /d\.deptype = 'e'/);
  assert.match(otherCheck[0], /aclexplode\(coalesce\(p\.proacl, acldefault\('f', p\.proowner\)\)\)/);
  assert.match(otherCheck[0], /acl\.grantee = 0/);
  assert.match(otherCheck[0], /acl\.privilege_type = 'EXECUTE'/);
  assert.match(otherCheck[0], /IF offending IS NOT NULL THEN/);
  assert.doesNotMatch(otherCheck[0], /RAISE EXCEPTION/);
  assert.match(sql, /global PUBLIC scan is the ops pre\/post check/);
});


test("privilege checks reject implicit or redirected targets before any database command", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "condola-priv-refusal-"));
  const marker = path.join(folder, "called");
  try {
    writeFileSync(path.join(folder, "psql"), '#!/bin/sh\nprintf called > "$CONDOLA_TEST_PSQL_MARKER"\nexit 99\n', { mode: 0o700 });
    const cases: [string | undefined, string | undefined][] = [
      [undefined, "YES"],
      ["postgres://local@127.0.0.1:55436/disposable", undefined],
      ["postgres://local@127.0.0.1/disposable", "YES"],
      ["postgres://local@example.test:55436/disposable", "YES"],
      ["postgres://local@127.0.0.1:55436/disposable?host=example.test", "YES"],
      ["postgres://local@127.0.0.1:55436/disposable?options=anything", "YES"],
      ["postgres://local@127.0.0.1:55436/", "YES"],
      ["postgres://local@127.0.0.1:55436/nested/database", "YES"],
      ["https://127.0.0.1:55436/disposable", "YES"],
    ];
    for (const [url, consent] of cases) {
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${folder}:${process.env.PATH ?? ""}`, CONDOLA_TEST_PSQL_MARKER: marker };
      if (url === undefined) delete env.DATABASE_URL; else env.DATABASE_URL = url;
      if (consent === undefined) delete env.CONDOLA_RLS_DISPOSABLE; else env.CONDOLA_RLS_DISPOSABLE = consent;
      const result = spawnSync("bash", ["scripts/check-function-privileges.sh"], { env, encoding: "utf8" });
      assert.equal(result.status, 2, "invalid target must fail before any DB call");
      assert.equal(existsSync(marker), false, "database command must not be invoked");
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
