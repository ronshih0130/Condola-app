import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

function read(path: string) {
  return readFileSync(path, "utf8");
}

test("B-104 adds only three stable definer helpers owned by the migration role", () => {
  const sql = read("supabase/migrations/20261115160000_b104_vendor_b013_read_helpers.sql");
  assert.deepEqual([...sql.matchAll(/CREATE FUNCTION app\.(\w+)/g)].map(match => match[1]), [
    "b104_current_repair_version", "b104_vendor_command_exists", "b104_vendor_latest_event",
  ]);
  assert.equal((sql.match(/LANGUAGE sql STABLE SECURITY DEFINER\nSET search_path = pg_catalog, pg_temp/g) ?? []).length, 3);
  assert.match(sql, /RETURNS uuid/);
  assert.match(sql, /RETURNS boolean/);
  assert.match(sql, /RETURNS text/);
  assert.match(sql, /SET LOCAL lock_timeout = '5s'/);
  assert.match(sql, /SET LOCAL statement_timeout = '60s'/);
  assert.doesNotMatch(sql, /\b(?:ALTER|DROP|INSERT|UPDATE|DELETE|CREATE OR REPLACE)\b/i);
  assert.doesNotMatch(sql, /\bGRANT\b[^;]*\bTABLE\b/i);
  const probe = read("scripts/check-function-privileges.sh");
  assert.match(probe, /B-104 service-only helper ACL\/config probe/);
  assert.match(probe, /fn\.provolatile <> 's'/);
  assert.match(probe, /fn\.proowner <> 'postgres'::regrole/);
  assert.match(probe, /B-104 private table privilege leaked/);
});

test("PR-015 replaces only two owner readers, preserving bodies and security except org-local authority", () => {
  const sql = read("supabase/migrations/20261115130000_b013_current_owner_authority.sql");
  const readers = read("supabase/migrations/20261105180000_b021_repair_approval_reads.sql");
  function definition(source: string, name: string) {
    const match = source.match(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION app\\.${name}\\([\\s\\S]*?END \\$\\$;`));
    assert.ok(match, name);
    return match[0];
  }
  const authority = /\n {2,3}SELECT 1 FROM public\.property_owners po\n {2,3}JOIN public\.contacts c ON c\.id=po\.owner_contact_id AND c\.org_id=po\.org_id\n {2,3}JOIN public\.organizations o ON o\.id=po\.org_id\n {2,3}WHERE po\.org_id=v\.org_id AND po\.property_id=v\.property_id\n {3,4}AND c\.user_id=a\.actor AND c\.is_owner AND c\.archived_at IS NULL\n {3,4}AND po\.effective_from <= \(clock_timestamp\(\) AT TIME ZONE o\.timezone\)::date\n {3,4}AND \(po\.effective_to IS NULL OR po\.effective_to > \(clock_timestamp\(\) AT TIME ZONE o\.timezone\)::date\)\n/;
  assert.equal((sql.match(new RegExp(authority.source, "g")) ?? []).length, 2);
  const names = ["b013_owner_pending", "b013_owner_history"];
  assert.deepEqual([...sql.matchAll(/CREATE OR REPLACE FUNCTION app\.(\w+)/g)].map(match => match[1]), names);
  for (const name of names) {
    const actual = definition(sql, name).replace("CREATE OR REPLACE FUNCTION", "CREATE FUNCTION")
      .replace(new RegExp("  AND EXISTS \\(" + authority.source + "  \\)\\n"), "");
    assert.equal(actual, definition(readers, name), name);
    const grants = (source: string) => source.match(new RegExp(`(?:REVOKE|GRANT)[^;]*FUNCTION app\\.${name}\\([^;]*;`, "g"));
    assert.deepEqual(grants(sql), grants(readers), name + " ACLs");
  }
  assert.match(sql, /SET LOCAL lock_timeout = '5s'/);
  assert.match(sql, /SET LOCAL statement_timeout = '60s'/);
  assert.doesNotMatch(sql, /CURRENT_DATE/i);
  assert.doesNotMatch(sql, /app\.b013_decide_estimate/);
  assert.doesNotMatch(sql, /\b(?:DROP|ALTER TABLE|CREATE TABLE)\b/);
  assert.match(read("scripts/check-function-privileges.sh"), /PR-015 owner gateway ACL\/config probe/);
});

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

test("B3b new gateways preserve migration ownership and lock-compatible volatile service-only ACLs", () => {
  for (const [file, signature] of [
    ["20261115170100_b3_staff_repair_turns.sql", "b3_staff_repair_turns(uuid,uuid,text,uuid,uuid,uuid,text,jsonb,integer)"],
    ["20261115170200_b3_vendor_repair_turn.sql", "b3_vendor_repair_turn(text)"],
  ]) {
    const sql = read(`supabase/migrations/${file}`), compact = sql.replace(/\s+/g, "");
    assert.match(sql, /VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp/);
    assert.doesNotMatch(sql.replace(/--[^\n]*/g, ""), /ALTER.*OWNER|CREATE OR REPLACE|GRANT.*TABLE|READ ONLY/i);
    assert.ok(compact.includes(`REVOKEALLONFUNCTIONapp.${signature}FROMPUBLIC,anon,authenticated;`));
    assert.ok(compact.includes(`GRANTEXECUTEONFUNCTIONapp.${signature}TOservice_role;`));
    assert.ok(read("scripts/check-function-privileges.sh").includes(`app.${signature}`));
  }
});

test("B-093 adds two owner gateways reusing the PR-015 admission verbatim, service-only and migration-owned", () => {
  const sql = read("supabase/migrations/20261115200000_b093_owner_decided.sql");
  const pr015 = read("supabase/migrations/20261115130000_b013_current_owner_authority.sql");
  const history = pr015.slice(pr015.indexOf("CREATE OR REPLACE FUNCTION app.b013_owner_history"));
  // The exact PR-015 current-owner predicate and env/live tuple check, copied byte for byte.
  const predicate = history.slice(history.indexOf("  AND EXISTS (\n   SELECT 1 FROM public.property_owners po"), history.indexOf("\n ORDER BY v.version_no DESC"));
  const tuple = history.slice(history.indexOf("  SELECT 1 FROM public.organizations o\n"), history.indexOf(" ) THEN RAISE EXCEPTION 'errors.forbidden'"));
  assert.ok(predicate.length > 300 && tuple.length > 200);
  assert.deepEqual([...sql.matchAll(/CREATE FUNCTION app\.(\w+)/g)].map(match => match[1]), ["b093_owner_decided", "b093_owner_decided_ticket"]);
  const bodies = sql.split("CREATE FUNCTION").slice(1);
  for (const body of bodies) {
    assert.ok(body.includes(predicate.trimStart()), "PR-015 predicate");
    assert.ok(body.includes(tuple), "env/live tuple");
    assert.match(body, /SELECT \* INTO a FROM app\.b013_actor\(p_org,p_session\);/);
    assert.match(body, /IF NOT app\.b013_approvals_enabled\(p_org\) THEN RETURN/);
    assert.match(body, /v\.designated_principal_id=a\.actor AND d\.decided_by=a\.actor/);
    assert.match(body, /JOIN app\.b013_estimate_decisions d ON d\.org_id=v\.org_id AND d\.ticket_id=v\.ticket_id AND d\.version_id=v\.id/);
    assert.match(body, /current_setting\('app\.active_org_id',true\) IS DISTINCT FROM p_org::text/);
    assert.match(body, /VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS/);
    // Every relation is schema-qualified under the fixed search_path.
    const code = body.slice(body.indexOf("AS $$"), body.indexOf("END $$;")).replace(/DISTINCT FROM/g, "");
    for (const ref of code.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][\w.]*)/g)) assert.match(ref[1], /^(?:public\.|app\.|decided$)/, ref[0]);
  }
  assert.doesNotMatch(sql.replace(/--[^\n]*/g, ""), /CREATE OR REPLACE|ALTER|DROP|INSERT|UPDATE|DELETE|GRANT[^;]*TABLE|READ ONLY|CURRENT_DATE|evidence_snapshot|designated_contact_id|captured_threshold/i);
  const compact = sql.replace(/\s+/g, "");
  for (const signature of ["b093_owner_decided(uuid,uuid,text,uuid,jsonb,integer)", "b093_owner_decided_ticket(uuid,uuid,text,uuid,uuid)"]) {
    assert.ok(compact.includes(`REVOKEALLONFUNCTIONapp.${signature}FROMPUBLIC,anon,authenticated;`));
    assert.ok(compact.includes(`GRANTEXECUTEONFUNCTIONapp.${signature}TOservice_role;`));
    assert.equal((compact.match(new RegExp(`GRANT[A-Z]*ONFUNCTIONapp\\.${signature.replace(/[()]/g, "\\$&")}`, "g")) ?? []).length, 1);
    assert.ok(read("scripts/check-function-privileges.sh").includes(`app.${signature}`));
  }
  assert.match(sql, /SET LOCAL lock_timeout='5s'/);
  assert.match(sql, /SET LOCAL statement_timeout='60s'/);
  assert.match(read("scripts/check-function-privileges.sh"), /B-093 gateway ACL\/config mismatch/);
});

test("B-105 adds a revoked private table, four service-only gateways and three internal helpers, migration-owned", () => {
  const sql = read("supabase/migrations/20261116160000_b105_vendor_case.sql");
  assert.deepEqual([...sql.matchAll(/CREATE FUNCTION app\.(\w+)/g)].map(match => match[1]),
    ["b105_enabled", "b105_read_job", "b105_vendor_case_admitted", "b105_vendor_case", "b105_vendor_write_job", "b105_vendor_decide", "b105_vendor_attach_photo"]);
  assert.equal((sql.match(/VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS/g) ?? []).length, 7);
  assert.doesNotMatch(sql.replace(/--[^\n]*/g, ""), /CREATE OR REPLACE|DROP|ALTER FUNCTION|GRANT[^;]*\bON (?:TABLE )?(?:app|public)\.|READ ONLY/i);
  assert.match(sql, /ALTER TABLE app\.b105_vendor_job_decisions ENABLE ROW LEVEL SECURITY;/);
  assert.match(sql, /REVOKE ALL ON app\.b105_vendor_job_decisions FROM PUBLIC,anon,authenticated,service_role;/);
  assert.match(sql, /\('vendor_job_v3','\{"enabled":false,"allowed_org_ids":\[\]\}'::jsonb\) ON CONFLICT DO NOTHING/);
  const compact = sql.replace(/\s+/g, "");
  for (const signature of ["b105_vendor_case(text,boolean)", "b105_vendor_case_admitted(text,boolean)", "b105_vendor_decide(text,boolean,uuid,text,date,text)", "b105_vendor_attach_photo(text,boolean,uuid,text,text,text,bigint,text)"]) {
    assert.ok(compact.includes(`REVOKEALLONFUNCTIONapp.${signature}FROMPUBLIC,anon,authenticated;`), signature);
    assert.ok(compact.includes(`GRANTEXECUTEONFUNCTIONapp.${signature}TOservice_role;`), signature);
    assert.ok(read("scripts/check-function-privileges.sh").includes(`app.${signature}`), signature);
    assert.ok(read("supabase/rpc-allowlist.txt").includes(`# service-only: app.${signature}`), signature);
  }
  for (const signature of ["b105_enabled(uuid,boolean)", "b105_read_job(text,boolean)", "b105_vendor_write_job(text,boolean)"]) {
    assert.ok(compact.includes(`REVOKEALLONFUNCTIONapp.${signature}FROMPUBLIC,anon,authenticated,service_role;`), signature);
    assert.ok(!compact.includes(`GRANTEXECUTEONFUNCTIONapp.${signature}`), signature);
  }
  assert.equal((compact.match(/GRANT/g) ?? []).length, 4);
  assert.match(sql, /SET LOCAL lock_timeout='5s'/);
  assert.match(sql, /SET LOCAL statement_timeout='60s'/);
  assert.match(read("scripts/check-function-privileges.sh"), /B-105 gateway ACL\/config mismatch/);
  assert.match(read("scripts/check-function-privileges.sh"), /B-105 table privilege leaked/);
});

test("MF-3 / MGT-151 adds one RLS table with no application grants and two service-only migration-owned gateways", () => {
  const sql = read("supabase/migrations/20261116140000_mf3_deposit_topup.sql");
  const b093 = read("supabase/migrations/20261115200000_b093_owner_decided.sql");
  // The env/live tuple check is copied byte for byte from the B-093 gateways.
  const tuple = b093.slice(b093.indexOf("  SELECT 1 FROM public.organizations o\n"), b093.indexOf(" ) THEN RAISE EXCEPTION 'errors.forbidden'"));
  // The deposit_settlement flag predicate is B-011's isDepositSettlementEnabled (TypeScript reader).
  const flag = read("src/server/deposit-settlement.ts");
  assert.ok(tuple.length > 200);
  for (const part of ["o.feature_flags->'deposit_settlement'='true'::jsonb", "p.key='deposit_settlement' AND p.value->'enabled'='true'::jsonb",
    "jsonb_typeof(p.value->'allowed_org_ids')='array'", "p.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)",
    "coalesce(o.live_org_id,o.id)"]) assert.ok(flag.includes(part), part);
  assert.deepEqual([...sql.matchAll(/CREATE FUNCTION app\.(\w+)/g)].map(match => match[1]), ["mf3_topup_record", "mf3_topup_view"]);
  assert.deepEqual([...sql.matchAll(/CREATE TABLE ([\w.]+)/g)].map(match => match[1]), ["app.deposit_settlement_topups"]);
  for (const body of sql.split("CREATE FUNCTION").slice(1)) {
    assert.ok(body.includes(tuple), "env/live tuple");
    assert.match(body, /current_setting\('app\.active_org_id',true\) IS DISTINCT FROM p_org::text/);
    assert.match(body, /VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS/);
    assert.match(body, /x\.revoked_at IS NULL AND x\.expires_at>clock_timestamp\(\) FOR SHARE/);
    assert.match(body, /o\.feature_flags->'deposit_settlement'='true'::jsonb/);
    assert.match(body, /p\.value->'allowed_org_ids' @> jsonb_build_array\(o\.id::text\)/);
    assert.match(body, /member_role NOT IN \('admin','manager','accountant'\)/);
    const code = body.slice(body.indexOf("AS $$"), body.indexOf("END $$;")).replace(/DISTINCT FROM/g, "");
    for (const ref of code.matchAll(/\b(?:FROM|JOIN|INTO)\s+([a-z_][\w.]*)/g))
      assert.match(ref[1], /^(?:public\.\w+|app\.\w+|actor|member_role|s|unit|prior|paid|tenant|topup_id|today)$/, ref[0]);
  }
  assert.match(sql, /ALTER TABLE app\.deposit_settlement_topups ENABLE ROW LEVEL SECURITY;/);
  assert.match(sql, /REVOKE ALL ON app\.deposit_settlement_topups FROM PUBLIC, anon, authenticated, service_role;/);
  assert.doesNotMatch(sql.replace(/--[^\n]*/g, ""), /GRANT[^;]*ON (?:TABLE )?app\.deposit_settlement_topups|CREATE OR REPLACE|DROP |ALTER TABLE (?!app\.deposit_settlement_topups ENABLE)|CREATE POLICY|\bmethod\b|platform_settings \(|INSERT INTO public\.platform_settings/i);
  const compact = sql.replace(/\s+/g, "");
  for (const signature of ["mf3_topup_record(uuid,uuid,text,uuid,uuid,uuid,uuid,bigint,date,text)", "mf3_topup_view(uuid,uuid,text,uuid,text,uuid)"]) {
    assert.ok(compact.includes(`REVOKEALLONFUNCTIONapp.${signature}FROMPUBLIC,anon,authenticated;`));
    assert.ok(compact.includes(`GRANTEXECUTEONFUNCTIONapp.${signature}TOservice_role;`));
    assert.equal((compact.match(new RegExp(`GRANT[A-Z]*ONFUNCTIONapp\\.${signature.replace(/[()]/g, "\\$&")}`, "g")) ?? []).length, 1);
    assert.ok(read("scripts/check-function-privileges.sh").includes(`app.${signature}`));
  }
  assert.match(sql, /INSERT INTO public\.audit_log/);
  assert.match(sql, /UNIQUE \(org_id, request_id\)/);
  assert.match(sql, /SET LOCAL lock_timeout='5s'/);
  assert.match(sql, /SET LOCAL statement_timeout='60s'/);
  assert.match(read("scripts/check-function-privileges.sh"), /MF-3 top-up gateway ACL\/config mismatch/);
  assert.match(read("scripts/check-function-privileges.sh"), /MF-3 top-up table grant to/);
});

test("B-063 adds one vendor workbench gateway reusing the B-026 history job read verbatim, service-only and migration-owned", () => {
  const sql = read("supabase/migrations/20261116100000_b063_vendor_workbench.sql");
  const b026 = read("supabase/migrations/20261106220000_b026_vendor_accounts.sql");
  const history = b026.slice(b026.indexOf("CREATE FUNCTION app.b026_vendor_account_history"), b026.indexOf("CREATE FUNCTION app.b026_correct_vendor_job"));
  // The exact B-026 job joins and predicate (actor, account, contact, gate, live link), copied byte for byte.
  const joins = history.slice(history.indexOf(" FROM app.b026_vendor_job_accounts l\n"), history.indexOf("\n WHERE l.user_id=actor"));
  const where = history.slice(history.indexOf(" WHERE l.user_id=actor"), history.indexOf(";\n RETURN jsonb_build_object('settings'"));
  assert.ok(joins.length > 300 && where.length > 250);
  assert.deepEqual([...sql.matchAll(/CREATE FUNCTION app\.(\w+)/g)].map(match => match[1]), ["b063_vendor_workbench"]);
  assert.ok(sql.includes(joins), "B-026 joins");
  assert.ok(sql.includes(`${where}\n AND l.org_id=p_org;`), "B-026 predicate plus the one organization");
  assert.match(sql, /actor:=app\.b026_account_actor\(p_session_hash\);/);
  assert.match(sql, /o\.feature_flags->'vendor_workbench'='true'::jsonb/);
  assert.match(sql, /THEN RETURN '\[\]'::jsonb; END IF;/);
  assert.match(sql, /VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS/);
  const body = sql.slice(sql.indexOf("AS $$"), sql.indexOf("END $$;"));
  for (const ref of body.matchAll(/\b(?:FROM|JOIN)\s+(?:LATERAL\s+\()?([a-z_][\w.]*)/gi)) assert.match(ref[1], /^(?:public\.|app\.|SELECT$)/, ref[0]);
  // A list gateway never hands out a job token, and it never writes.
  assert.doesNotMatch(body, /\btoken\b|s\.token/);
  assert.doesNotMatch(sql.replace(/--[^\n]*/g, ""), /CREATE OR REPLACE|ALTER|DROP|INSERT|UPDATE|DELETE|GRANT[^;]*TABLE|READ ONLY|platform_settings/i);
  const compact = sql.replace(/\s+/g, "");
  const signature = "b063_vendor_workbench(text,uuid)";
  assert.ok(compact.includes(`REVOKEALLONFUNCTIONapp.${signature}FROMPUBLIC,anon,authenticated;`));
  assert.ok(compact.includes(`GRANTEXECUTEONFUNCTIONapp.${signature}TOservice_role;`));
  assert.equal((compact.match(/GRANT[A-Z]*ONFUNCTIONapp\.b063_vendor_workbench\(text,uuid\)/g) ?? []).length, 1);
  assert.ok(read("scripts/check-function-privileges.sh").includes(`app.${signature}`));
  assert.match(read("scripts/check-function-privileges.sh"), /B-063 gateway ACL\/config mismatch/);
  assert.match(sql, /SET LOCAL lock_timeout='5s'/);
  assert.match(sql, /SET LOCAL statement_timeout='60s'/);
});

test("B-112 adds a revoked private ledger, two service-only gateways and two internal helpers, migration-owned", () => {
  const sql = read("supabase/migrations/20261116190000_b112_vendor_address.sql");
  assert.deepEqual([...sql.matchAll(/CREATE FUNCTION app\.(\w+)/g)].map(match => match[1]),
    ["b112_enabled", "b112_account_profile", "b112_vendor_address", "b112_save_vendor_address"]);
  assert.equal((sql.match(/VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS/g) ?? []).length, 4);
  assert.doesNotMatch(sql.replace(/--[^\n]*/g, ""), /CREATE OR REPLACE|DROP|ALTER FUNCTION|ALTER TABLE public|GRANT[^;]*\bON (?:TABLE )?(?:app|public)\.|READ ONLY/i);
  assert.match(sql, /ALTER TABLE app\.b112_address_saves ENABLE ROW LEVEL SECURITY;/);
  assert.match(sql, /REVOKE ALL ON app\.b112_address_saves FROM PUBLIC,anon,authenticated,service_role;/);
  assert.match(sql, /app\.b026_account_actor\(p_session_hash\)/);
  const compact = sql.replace(/\s+/g, "");
  for (const signature of ["b112_vendor_address(text,uuid,boolean)", "b112_save_vendor_address(text,uuid,boolean,uuid,integer,text)"]) {
    assert.ok(compact.includes(`REVOKEALLONFUNCTIONapp.${signature}FROMPUBLIC,anon,authenticated;`), signature);
    assert.ok(compact.includes(`GRANTEXECUTEONFUNCTIONapp.${signature}TOservice_role;`), signature);
    assert.ok(read("scripts/check-function-privileges.sh").includes(`app.${signature}`), signature);
    assert.ok(read("supabase/rpc-allowlist.txt").includes(`# service-only: app.${signature}`), signature);
  }
  for (const signature of ["b112_enabled(uuid,boolean)", "b112_account_profile(text,uuid,boolean,boolean)"]) {
    assert.ok(compact.includes(`REVOKEALLONFUNCTIONapp.${signature}FROMPUBLIC,anon,authenticated,service_role;`), signature);
    assert.ok(!compact.includes(`GRANTEXECUTEONFUNCTIONapp.${signature}`), signature);
  }
  assert.equal((compact.match(/GRANT/g) ?? []).length, 2);
  assert.match(sql, /SET LOCAL lock_timeout='5s'/);
  assert.match(read("scripts/check-function-privileges.sh"), /B-112 gateway ACL\/config mismatch/);
});

test("B-065 adds a revoked append-only table, two service-only gateways and two internal helpers, migration-owned", () => {
  const sql = read("supabase/migrations/20261116220000_b065_vendor_activation.sql");
  assert.deepEqual([...sql.matchAll(/CREATE FUNCTION app\.(\w+)/g)].map(match => match[1]),
    ["b065_enabled", "b065_account_contact", "b065_issuer_view", "b065_save_issuer_type"]);
  assert.equal((sql.match(/VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS/g) ?? []).length, 4);
  assert.doesNotMatch(sql.replace(/--[^\n]*/g, ""), /CREATE OR REPLACE|DROP|ALTER FUNCTION|ALTER TABLE public|GRANT[^;]*\bON (?:TABLE )?(?:app|public)\.|READ ONLY/i);
  assert.match(sql, /ALTER TABLE app\.b065_issuer_types ENABLE ROW LEVEL SECURITY;/);
  assert.match(sql, /REVOKE ALL ON app\.b065_issuer_types FROM PUBLIC,anon,authenticated,service_role;/);
  assert.match(sql, /ALTER TABLE app\.b065_issuer_requests ENABLE ROW LEVEL SECURITY;/);
  assert.match(sql, /REVOKE ALL ON app\.b065_issuer_requests FROM PUBLIC,anon,authenticated,service_role;/);
  assert.equal((sql.match(/CREATE TABLE app\./g) ?? []).length, 2);
  assert.match(read("scripts/check-function-privileges.sh"), /'app\.b065_issuer_types','app\.b065_issuer_requests'/);
  assert.match(sql, /app\.b026_account_actor\(p_session_hash\)/);
  assert.match(sql, /\('vendor_activation','\{"enabled":false,"allowed_org_ids":\[\]\}'::jsonb\) ON CONFLICT DO NOTHING/);
  const compact = sql.replace(/\s+/g, "");
  for (const signature of ["b065_issuer_view(text,uuid,boolean)", "b065_save_issuer_type(text,uuid,boolean,uuid,text)"]) {
    assert.ok(compact.includes(`REVOKEALLONFUNCTIONapp.${signature}FROMPUBLIC,anon,authenticated;`), signature);
    assert.ok(compact.includes(`GRANTEXECUTEONFUNCTIONapp.${signature}TOservice_role;`), signature);
    assert.ok(read("scripts/check-function-privileges.sh").includes(`app.${signature}`), signature);
    assert.ok(read("supabase/rpc-allowlist.txt").includes(`# service-only: app.${signature}`), signature);
  }
  for (const signature of ["b065_enabled(uuid,boolean)", "b065_account_contact(text,uuid,boolean,boolean)"]) {
    assert.ok(compact.includes(`REVOKEALLONFUNCTIONapp.${signature}FROMPUBLIC,anon,authenticated,service_role;`), signature);
    assert.ok(!compact.includes(`GRANTEXECUTEONFUNCTIONapp.${signature}`), signature);
    assert.ok(read("scripts/check-function-privileges.sh").includes(`app.${signature}`), signature);
  }
  assert.equal((compact.match(/GRANT/g) ?? []).length, 2);
  assert.match(sql, /SET LOCAL lock_timeout='5s'/);
  assert.match(read("scripts/check-function-privileges.sh"), /B-065 gateway ACL\/config mismatch/);
  assert.match(read("ops/flags.yaml"), /\n  vendor_activation:\n(?:    .*\n)*?    default: false\n/);
});

test("B-109 adds one RLS config table with no application grants, the shared_meter flag OFF and three service-only gateways", () => {
  const sql = read("supabase/migrations/20261116180000_b109_shared_meter.sql");
  const b093 = read("supabase/migrations/20261115200000_b093_owner_decided.sql");
  const tuple = b093.slice(b093.indexOf("  SELECT 1 FROM public.organizations o\n"), b093.indexOf(" ) THEN RAISE EXCEPTION 'errors.forbidden'"));
  assert.ok(tuple.length > 200);
  assert.deepEqual([...sql.matchAll(/CREATE FUNCTION app\.(\w+)/g)].map(m => m[1]), ["b109_shared_meter_save", "b109_shared_meter_view", "b109_shared_meter_split"]);
  assert.deepEqual([...sql.matchAll(/CREATE TABLE ([\w.]+)/g)].map(m => m[1]), ["app.b109_shared_meter_configs"]);
  for (const body of sql.split("CREATE FUNCTION").slice(1)) {
    assert.ok(body.includes(tuple), "env/live tuple");
    assert.match(body, /current_setting\('app\.active_org_id',true\) IS DISTINCT FROM p_org::text/);
    assert.match(body, /VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS/);
    assert.match(body, /x\.revoked_at IS NULL AND x\.expires_at>clock_timestamp\(\) FOR SHARE/);
    assert.match(body, /o\.feature_flags->'shared_meter'='true'::jsonb/);
    assert.match(body, /member_role NOT IN \('admin','manager'\)/);
    assert.match(body, /p\.org_id=p_org AND p\.id=p_property AND p\.archived_at IS NULL/);
    assert.doesNotMatch(body, /CREATE TEMP|INSERT INTO public\.(?!audit_log)|UPDATE public\.|DELETE FROM/);
  }
  assert.match(sql, /ALTER TABLE app\.b109_shared_meter_configs ENABLE ROW LEVEL SECURITY;/);
  assert.match(sql, /REVOKE ALL ON app\.b109_shared_meter_configs FROM PUBLIC, anon, authenticated, service_role;/);
  assert.match(sql, /VALUES \('shared_meter', '\{"enabled":false,"allowed_org_ids":\[\]\}'::jsonb\)\nON CONFLICT \(key\) DO NOTHING;/);
  assert.doesNotMatch(sql.replace(/--[^\n]*/g, ""), /GRANT[^;]*\bON (?:TABLE )?app\.b109_shared_meter_configs|CREATE OR REPLACE|DROP |CREATE POLICY|rate_minor|price/i);
  assert.match(sql, /INSERT INTO public\.audit_log/);
  assert.match(sql, /UNIQUE \(org_id, request_id\)/);
  const compact = sql.replace(/\s+/g, "");
  for (const signature of ["b109_shared_meter_save(uuid,uuid,text,uuid,uuid,uuid,uuid[],text,numeric)", "b109_shared_meter_view(uuid,uuid,text,uuid,uuid)",
    "b109_shared_meter_split(uuid,uuid,text,uuid,uuid,date,numeric,bigint)"]) {
    assert.ok(compact.includes(`REVOKEALLONFUNCTIONapp.${signature}FROMPUBLIC,anon,authenticated;`), signature);
    assert.ok(compact.includes(`GRANTEXECUTEONFUNCTIONapp.${signature}TOservice_role;`), signature);
    assert.ok(read("scripts/check-function-privileges.sh").includes(`app.${signature}`));
  }
  assert.equal((compact.match(/GRANT[A-Z]*ONFUNCTION/g) ?? []).length, 3);
  assert.match(read("scripts/check-function-privileges.sh"), /B-109 gateway ACL\/config mismatch/);
  assert.match(read("ops/flags.yaml"), /\n  shared_meter:\n    owner: Ron\n[\s\S]*?default: false/);
});

test("B-076a adds one service-only, migration-owned phone-history reader and no table, grant or policy", () => {
  const sql = read("supabase/migrations/20261116170000_b076a_phone_history.sql");
  const b093 = read("supabase/migrations/20261115200000_b093_owner_decided.sql");
  const tuple = b093.slice(b093.indexOf("  SELECT 1 FROM public.organizations o\n"), b093.indexOf(" ) THEN RAISE EXCEPTION 'errors.forbidden'"));
  assert.ok(tuple.length > 200);
  assert.deepEqual([...sql.matchAll(/CREATE FUNCTION app\.(\w+)/g)].map(match => match[1]), ["b076a_phone_history"]);
  assert.ok(sql.includes(tuple), "env/live tuple");
  assert.match(sql, /current_setting\('app\.active_org_id',true\) IS DISTINCT FROM p_org::text/);
  assert.match(sql, /VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS/);
  assert.match(sql, /x\.revoked_at IS NULL AND x\.expires_at>clock_timestamp\(\) FOR SHARE/);
  assert.match(sql, /WHERE m\.org_id=p_live AND m\.user_id=actor AND m\.status::text='active' FOR SHARE;/);
  assert.match(sql, /member_role NOT IN \('admin','manager'\)/);
  assert.match(sql, /o\.feature_flags->'tenant_directory_edit'='true'::jsonb/);
  assert.match(sql, /c\.org_id=p_org AND c\.id=p_contact AND c\.is_tenant/);
  assert.match(sql, /a\.reason='tenant_directory_contact_edit' AND 'phone_e164'=ANY\(a\.changed_cols\)/);
  assert.match(sql, /JOIN app\.b015_edit_commands cmd ON cmd\.org_id=a\.org_id AND cmd\.actor_id=a\.actor_user_id/);
  assert.match(sql, /OPEN: only B-015 staff edits are listed/);
  const code = sql.slice(sql.indexOf("AS $$"), sql.indexOf("END $$;")).replace(/DISTINCT FROM/g, "");
  for (const ref of code.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][\w.]*)/g))
    assert.match(ref[1], /^(?:public\.\w+|app\.\w+|h|masked)$/, ref[0]);
  // The raw numbers are only read inside the CTE; the returned object carries masked values only.
  const returned = sql.slice(sql.indexOf("SELECT jsonb_build_object('tenant'"), sql.indexOf("INTO result;"));
  assert.doesNotMatch(returned, /old_phone|new_phone|phone_e164/);
  assert.doesNotMatch(sql.replace(/--[^\n]*/g, ""), /CREATE OR REPLACE|CREATE TABLE|ALTER |DROP |INSERT |UPDATE |DELETE |GRANT[^;]*TABLE|CREATE POLICY|platform_settings \(/i);
  const compact = sql.replace(/\s+/g, ""), signature = "b076a_phone_history(uuid,uuid,text,uuid,uuid,bigint,integer)";
  assert.ok(compact.includes(`REVOKEALLONFUNCTIONapp.${signature}FROMPUBLIC,anon,authenticated;`));
  assert.ok(compact.includes(`GRANTEXECUTEONFUNCTIONapp.${signature}TOservice_role;`));
  assert.equal((compact.match(/GRANT[A-Z]*ONFUNCTION/g) ?? []).length, 1);
  assert.ok(read("scripts/check-function-privileges.sh").includes(`app.${signature}`));
  assert.match(read("scripts/check-function-privileges.sh"), /B-076a gateway ACL\/config mismatch/);
  assert.match(sql, /SET LOCAL lock_timeout='5s'/);
  assert.match(sql, /SET LOCAL statement_timeout='60s'/);
});

test("B-110 adds a revoked private table, five service-only gateways and four internal helpers, migration-owned", () => {
  const sql = read("supabase/migrations/20261116210000_b110_case_share.sql");
  assert.deepEqual([...sql.matchAll(/CREATE FUNCTION app\.(\w+)/g)].map(match => match[1]),
    ["b110_enabled", "b110_expires_at", "b110_live", "b110_share_for", "b110_vendor_share", "b110_staff_share", "b110_staff_revoke", "b110_share_view", "b110_share_photo"]);
  assert.equal((sql.match(/VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS/g) ?? []).length, 9);
  assert.doesNotMatch(sql.replace(/--[^\n]*/g, ""), /CREATE OR REPLACE|DROP|ALTER FUNCTION|ALTER TABLE public|GRANT[^;]*\bON (?:TABLE )?(?:app|public)\.|READ ONLY|INSERT INTO public\.platform_settings/i);
  assert.match(sql, /ALTER TABLE app\.case_shares ENABLE ROW LEVEL SECURITY;/);
  assert.match(sql, /REVOKE ALL ON app\.case_shares FROM PUBLIC,anon,authenticated,service_role;/);
  const compact = sql.replace(/\s+/g, "");
  for (const signature of ["b110_vendor_share(text,boolean,text,text)", "b110_staff_share(uuid,uuid,text,uuid,boolean,uuid,text,boolean)", "b110_staff_revoke(uuid,uuid,text,uuid,boolean,uuid)", "b110_share_view(text,boolean)", "b110_share_photo(text,boolean,uuid)"]) {
    assert.ok(compact.includes(`REVOKEALLONFUNCTIONapp.${signature}FROMPUBLIC,anon,authenticated;`), signature);
    assert.ok(compact.includes(`GRANTEXECUTEONFUNCTIONapp.${signature}TOservice_role;`), signature);
    assert.ok(read("scripts/check-function-privileges.sh").includes(`app.${signature}`), signature);
    assert.ok(read("supabase/rpc-allowlist.txt").includes(`# service-only: app.${signature}`), signature);
  }
  for (const signature of ["b110_enabled(uuid,boolean)", "b110_expires_at(app.case_shares)", "b110_live(app.case_shares,timestamptz)", "b110_share_for(uuid,uuid,text,uuid,uuid,text,boolean)"]) {
    assert.ok(compact.includes(`REVOKEALLONFUNCTIONapp.${signature}FROMPUBLIC,anon,authenticated,service_role;`), signature);
    assert.ok(!compact.includes(`GRANTEXECUTEONFUNCTIONapp.${signature}`), signature);
  }
  assert.equal((compact.match(/GRANT/g) ?? []).length, 5);
  assert.match(read("scripts/check-function-privileges.sh"), /B-110 gateway ACL\/config mismatch/);
});

test("B-091 adds two RLS tables with no application grants, the owner_rules flag OFF and three service-only gateways; locks before admission", () => {
  const sql = read("supabase/migrations/20261116240000_b091_owner_rules.sql");
  const b093 = read("supabase/migrations/20261115200000_b093_owner_decided.sql");
  const tuple = b093.slice(b093.indexOf("  SELECT 1 FROM public.organizations o\n"), b093.indexOf(" ) THEN RAISE EXCEPTION 'errors.forbidden'"));
  assert.deepEqual([...sql.matchAll(/CREATE FUNCTION app\.(\w+)/g)].map(m => m[1]), ["b091_owner_rule_set", "b091_owner_rule_view", "b091_staff_rule_changes"]);
  assert.deepEqual([...sql.matchAll(/CREATE TABLE ([\w.]+)/g)].map(m => m[1]), ["app.b091_owner_rule_revisions", "app.b091_owner_rule_commands"]);
  for (const body of sql.split("CREATE FUNCTION").slice(1)) {
    assert.ok(body.includes(tuple), "env/live tuple");
    assert.match(body, /current_setting\('app\.active_org_id',true\) IS DISTINCT FROM p_org::text/);
    assert.match(body, /VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS/);
    assert.match(body, /o\.feature_flags->'owner_rules'='true'::jsonb/);
    assert.doesNotMatch(body, /CREATE TEMP|UPDATE public\.|DELETE FROM|notification|outbox/i);
  }
  const set = sql.slice(sql.indexOf("CREATE FUNCTION app.b091_owner_rule_set"), sql.indexOf("CREATE FUNCTION app.b091_owner_rule_view"));
  // Lock order: the request id, then every row lock, then admission; no lock taken after the first admission check.
  const advisory = set.indexOf("pg_advisory_xact_lock"), firstAdmission = set.indexOf("IF current_setting('app.active_org_id'");
  assert.ok(advisory > 0 && advisory < set.indexOf("FOR SHARE") && set.lastIndexOf("FOR UPDATE") < firstAdmission && set.lastIndexOf("FOR SHARE") < firstAdmission);
  for (const lock of [/FROM public\.auth_sessions x WHERE x\.id=p_session FOR SHARE;/, /c\.user_id=target AND c\.is_owner ORDER BY c\.id FOR UPDATE\) z;/,
    /po\.owner_contact_id=ANY\(locked_contacts\) ORDER BY po\.id FOR SHARE\) z;/, /pr\.id=ANY\(locked_props\) ORDER BY pr\.id FOR SHARE\) z;/,
    /o\.id IN \(p_org,p_live\) ORDER BY o\.id FOR SHARE\) z;/, /f\.key='owner_rules' FOR SHARE\) z;/])
    assert.match(set, lock);
  // B-065 pattern: admission only on the locked rows, and the locked sets must equal what the predicates select now.
  assert.match(set, /IS DISTINCT FROM locked_contacts/);
  assert.match(set, /IS DISTINCT FROM locked_po THEN/);
  assert.match(set, /c\.id=ANY\(locked_contacts\)/);
  assert.match(set, /po\.id=ANY\(locked_po\) AND pr\.id=ANY\(locked_props\)/);
  assert.match(set, /IF owners<>1 OR NOT \(owner_id=ANY\(locked_contacts\)\)/);
  // Locked sets are aggregated in id order (array comparison), never in subquery or planner order.
  assert.equal((set.match(/array_agg\(z\.id ORDER BY z\.id\)/g) ?? []).length, 3);
  assert.doesNotMatch(set, /array_agg\(z\.id\)/);
  // Every reserved id is bound to the raw payload, not only to its lossy normalisation.
  assert.match(sql, /payload_fingerprint text NOT NULL CHECK \(payload_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(set, /fingerprint:=encode\(sha256\(convert_to\(jsonb_build_array\(p_payload_fingerprint,p_rule,p_expected_revision\)::text,'UTF8'\)\),'hex'\);/);
  assert.match(set, /OR prior\.payload_fingerprint IS DISTINCT FROM fingerprint THEN/);
  assert.match(set, /po\.effective_from <= \(clock_timestamp\(\) AT TIME ZONE o\.timezone\)::date/);
  assert.match(sql, /REVOKE ALL ON app\.b091_owner_rule_revisions, app\.b091_owner_rule_commands FROM PUBLIC, anon, authenticated, service_role;/);
  assert.match(sql, /VALUES \('owner_rules', '\{"enabled":false,"allowed_org_ids":\[\]\}'::jsonb\)\nON CONFLICT \(key\) DO NOTHING;/);
  assert.doesNotMatch(sql.replace(/--[^\n]*/g, ""), /GRANT[^;]*\bON (?:TABLE )?app\.b091_owner_rule_(?:revisions|commands)|CREATE OR REPLACE|DROP |CREATE POLICY/i);
  const compact = sql.replace(/\s+/g, "");
  for (const signature of ["b091_owner_rule_set(uuid,uuid,text,uuid,uuid,text,integer,text)", "b091_owner_rule_view(uuid,uuid,text,uuid)", "b091_staff_rule_changes(uuid,uuid,text,uuid,uuid,bigint,integer)"]) {
    assert.ok(compact.includes(`REVOKEALLONFUNCTIONapp.${signature}FROMPUBLIC,anon,authenticated;`), signature);
    assert.ok(compact.includes(`GRANTEXECUTEONFUNCTIONapp.${signature}TOservice_role;`), signature);
    assert.ok(read("scripts/check-function-privileges.sh").includes(`app.${signature}`));
  }
  assert.equal((compact.match(/GRANT[A-Z]*ONFUNCTION/g) ?? []).length, 3);
  assert.match(read("ops/flags.yaml"), /\n  owner_rules:\n    owner: Ron\n[\s\S]*?default: false/);
});

test("B-109b: a pure split helper and a run-config gateway, service-only; the preview is replaced in place, ACL kept; locks before admission", () => {
  const sql = read("supabase/migrations/20261116230000_b109b_shared_meter_bills.sql");
  assert.deepEqual([...sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION app\.(\w+)/g)].map(m => m[1]), ["b109_split_shares", "b109_shared_meter_split", "b109b_run_config"]);
  assert.match(sql, /CREATE FUNCTION app\.b109_split_shares\(p_weights jsonb,p_total bigint,p_amount bigint DEFAULT NULL\)\nRETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION app\.b109_shared_meter_split\(/);
  assert.match(sql, /VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS/);
  const helper = sql.slice(sql.indexOf("CREATE FUNCTION app.b109_split_shares"), sql.indexOf("REVOKE ALL ON FUNCTION app.b109_split_shares"));
  assert.doesNotMatch(helper, /\b(?:FROM|JOIN)\s+(?:public|app)\./, "pure: no table access");
  assert.match(helper, /div\(p_total\*b\.w,b\.tw\)/);
  const preview = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION app.b109_shared_meter_split"), sql.indexOf("CREATE FUNCTION app.b109b_run_config"));
  assert.match(preview, /app\.b109_split_shares\(/);
  assert.doesNotMatch(preview, /REVOKE|GRANT/, "OR REPLACE keeps the B-109 ACL");
  const cfg = sql.slice(sql.indexOf("CREATE FUNCTION app.b109b_run_config"));
  const firstAdmission = cfg.indexOf("IF current_setting('app.active_org_id'");
  assert.ok(cfg.lastIndexOf("FOR SHARE") < firstAdmission, "every lock before admission");
  for (const lock of [/auth_sessions x WHERE x\.id=p_session FOR SHARE;/, /m\.user_id=target AND m\.status::text='active' FOR SHARE;/,
    /o\.id IN \(p_org,p_live\) ORDER BY o\.id FOR SHARE\) z;/, /f\.key='shared_meter' FOR SHARE\) z;/, /un\.org_id=p_org AND un\.id=p_unit FOR SHARE;/,
    /pr\.id=u\.property_id FOR SHARE\) z;/, /c\.property_id=u\.property_id ORDER BY c\.id FOR SHARE\) z;/, /r\.unit_id=p_unit ORDER BY r\.id FOR SHARE\) z;/,
    /mt\.archived_at IS NULL\n  ORDER BY mt\.id FOR SHARE\) z;/, /r\.id=ANY\(named\) ORDER BY r\.id FOR SHARE\) z;/, /un\.id=ANY\(named\) ORDER BY un\.id FOR SHARE\) z;/,
    /r\.unit_id=p_unit AND r\.status::text<>'void' ORDER BY r\.id FOR SHARE\) z;/]) assert.match(cfg, lock);
  // B-091 r2 pattern: id-ordered locked sets; the decision reads locked rows only; each set must equal the current one.
  assert.equal((cfg.match(/array_agg\(z\.id ORDER BY z\.id\)/g) ?? []).length, 6);
  assert.doesNotMatch(cfg, /array_agg\(z\.id\)/);
  for (const set of ["locked_cfgs", "locked_rooms", "locked_named_rooms", "locked_named_units", "locked_meters", "locked_runs"]) assert.match(cfg, new RegExp(`IS DISTINCT FROM ${set}`));
  // Archived or missing selected rooms block (never dropped); the first period ignores no later run.
  assert.match(cfg, /IF archived>0 THEN RETURN jsonb_build_object\('status','unavailable_rooms'/);
  assert.match(cfg, /IF missing>0 THEN RETURN jsonb_build_object\('status','unavailable_rooms'/);
  assert.match(cfg, /r\.id=ANY\(locked_runs\) AND r\.period_start>=cfg\.effective_from\n   AND NOT \(r\.period_start=p_period_start AND r\.period_end=p_period_end\)\);/);
  assert.match(helper, /jsonb_typeof\(e->'weight'\) IS DISTINCT FROM 'number'/);
  // A changed locked set is its own SQLSTATE (retry), not a denial; the unit and property are re-checked live on the locked rows.
  assert.match(cfg, /IS DISTINCT FROM locked_runs THEN\n[^\n]*\n  RAISE EXCEPTION 'shared meter inputs changed while waiting' USING ERRCODE='40001';/);
  assert.match(cfg, /u\.archived_at IS NOT NULL OR property_archived IS NOT NULL/);
  // The preview uses only the run for exactly this period; anything else overlapping the month is ambiguous.
  assert.match(preview, /n_exact/);
  assert.match(preview, /WHEN t\.n_over>0 AND NOT \(t\.n_over=1 AND t\.n_exact=1\) THEN 'ambiguous_run'/);
  assert.match(cfg, /c\.id=ANY\(locked_cfgs\) AND c\.effective_from<=p_period_start/);
  assert.match(cfg, /r\.id=ANY\(locked_rooms\) AND r\.id=ANY\(cfg\.space_ids\)/);
  assert.match(cfg, /mr\.meter_id=ANY\(locked_meters\)/);
  assert.match(cfg, /member_role IS DISTINCT FROM locked_role/);
  assert.match(cfg, /member_role NOT IN \('admin','manager'\)/);
  assert.match(cfg, /o\.feature_flags->'shared_meter'='true'::jsonb/);
  assert.match(cfg, /c\.effective_from<=p_period_start/);
  assert.doesNotMatch(sql.replace(/--[^\n]*/g, ""), /CREATE TABLE|ALTER TABLE|DROP |CREATE POLICY|INSERT INTO|UPDATE public\.|DELETE FROM|GRANT[^;]*\bON (?:TABLE )?app\./i);
  const compact = sql.replace(/\s+/g, "");
  for (const signature of ["b109_split_shares(jsonb,bigint,bigint)", "b109b_run_config(uuid,uuid,text,uuid,uuid,date,date)"]) {
    assert.ok(compact.includes(`REVOKEALLONFUNCTIONapp.${signature}FROMPUBLIC,anon,authenticated;`), signature);
    assert.ok(compact.includes(`GRANTEXECUTEONFUNCTIONapp.${signature}TOservice_role;`), signature);
    assert.ok(read("scripts/check-function-privileges.sh").includes(`app.${signature}`));
  }
  assert.equal((compact.match(/GRANT[A-Z]*ONFUNCTION/g) ?? []).length, 2);
});

test("B-097 adds two revoked private tables and four service-only gateways, migration-owned, behind the existing vendor_job_v3 gate", () => {
  const sql = read("supabase/migrations/20261116250000_b097_vendor_close.sql");
  assert.deepEqual([...sql.matchAll(/CREATE FUNCTION app\.(\w+)/g)].map(match => match[1]),
    ["b097_reopen_open", "b097_supersede_completion", "b097_vendor_done_view", "b097_vendor_complete", "b097_staff_reopen", "b098_vendor_tenant_phone"]);
  assert.equal((sql.match(/VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS/g) ?? []).length, 6);
  assert.doesNotMatch(sql.replace(/--[^\n]*/g, ""), /CREATE OR REPLACE|DROP|ALTER FUNCTION|ALTER TABLE public|GRANT[^;]*\bON (?:TABLE )?(?:app|public)\.|READ ONLY|platform_settings\(key/i);
  for (const table of ["b097_completions", "b097_requests"]) {
    assert.match(sql, new RegExp(`ALTER TABLE app\\.${table} ENABLE ROW LEVEL SECURITY;`));
    assert.match(sql, new RegExp(`REVOKE ALL ON app\\.${table} FROM PUBLIC,anon,authenticated,service_role;`));
  }
  assert.equal((sql.match(/CREATE TABLE app\./g) ?? []).length, 2);
  const compact = sql.replace(/\s+/g, "");
  for (const signature of ["b097_vendor_done_view(text,boolean)", "b097_vendor_complete(text,boolean,uuid,text)",
    "b097_staff_reopen(uuid,uuid,text,uuid,boolean,uuid,uuid,text)", "b098_vendor_tenant_phone(text,boolean)"]) {
    assert.ok(compact.includes(`REVOKEALLONFUNCTIONapp.${signature}FROMPUBLIC,anon,authenticated;`), signature);
    assert.ok(compact.includes(`GRANTEXECUTEONFUNCTIONapp.${signature}TOservice_role;`), signature);
    assert.ok(read("scripts/check-function-privileges.sh").includes(`app.${signature}`), signature);
    assert.ok(read("supabase/rpc-allowlist.txt").includes(`# service-only: app.${signature}`), signature);
  }
  for (const signature of ["b097_reopen_open(app.b097_completions,timestamptz)", "b097_supersede_completion()"]) {
    assert.ok(compact.includes(`REVOKEALLONFUNCTIONapp.${signature}FROMPUBLIC,anon,authenticated,service_role;`), signature);
    assert.ok(!compact.includes(`GRANTEXECUTEONFUNCTIONapp.${signature}`), signature);
  }
  assert.match(sql, /CREATE TRIGGER b097_supersede_completion AFTER UPDATE OF status, closed_at ON public\.maintenance_tickets/);
  assert.equal((sql.match(/CREATE TRIGGER/g) ?? []).length, 1);
  assert.equal((compact.match(/GRANT/g) ?? []).length, 4);
  assert.match(sql, /SET LOCAL lock_timeout='5s'/);
  assert.match(sql, /app\.b105_enabled\(j\.org_id,p_env_v2\)/);
  assert.match(sql, /PERFORM public\.b017_authorize\(p_org,actor,p_session,'tickets\.update',false\);/);
  assert.match(read("scripts/check-function-privileges.sh"), /B-097 gateway ACL\/config mismatch/);
  assert.match(read("scripts/check-function-privileges.sh"), /'app\.b097_completions','app\.b097_requests'/);
});

test("B-102 adds one service-only room-issue gateway; replaces the B2 invite functions in place (ACLs kept); room-scoped seat cap and secrets", () => {
  const sql = read("supabase/migrations/20261117100000_b102_room_invites.sql");
  const compact = sql.replace(/\s+/g, "");
  assert.deepEqual([...sql.matchAll(/CREATE (OR REPLACE )?FUNCTION app\.(\w+)/g)].map(m => `${m[1] ? "replace " : "create "}${m[2]}`), [
    "replace unit_line_issue", "replace unit_line_rotate", "create unit_line_issue_room", "create unit_line_ensure_room", "replace unit_line_accept",
    "replace unit_line_include_on_lease", "replace unit_bindings_seat_cap_guard"]);
  for (const fn of ["unit_line_issue_room", "unit_line_ensure_room"]) {
    assert.ok(compact.includes(`REVOKEALLONFUNCTIONapp.${fn}(uuid,uuid,uuid,text,uuid)FROMPUBLIC,anon,authenticated;`), fn);
    assert.ok(compact.includes(`GRANTEXECUTEONFUNCTIONapp.${fn}(uuid,uuid,uuid,text,uuid)TOservice_role;`), fn);
    assert.ok(read("supabase/rpc-allowlist.txt").includes(`# service-only: app.${fn}(uuid,uuid,uuid,text,uuid)`), fn);
  }
  assert.equal((compact.match(/GRANT/g) ?? []).length, 2, "replaced functions keep their ACL; no other grant");
  assert.equal((sql.match(/SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS/g) ?? []).length, 7);
  const ensure = sql.slice(sql.indexOf("CREATE FUNCTION app.unit_line_ensure_room"), sql.indexOf("REVOKE ALL ON FUNCTION app.unit_line_ensure_room"));
  const unitLock = ensure.indexOf("u.rental_mode = 'by_room' AND u.archived_at IS NULL FOR UPDATE;"), roomLock = ensure.indexOf("r.unit_id = p_unit AND r.archived_at IS NULL FOR UPDATE;");
  const keep = ensure.indexOf("s.revoked_at IS NULL AND s.expires_at > now()) THEN\n    RETURN NULL;");
  assert.ok(unitLock > 0 && roomLock > unitLock && keep > roomLock, "unit lock, then room lock, then the keep-live check");
  assert.match(sql, /WHERE l\.id = p_lease AND l\.org_id = p_org AND l\.unit_id = p_unit FOR SHARE;/);
  // Unit issue/rotate revoke only the unit's own invite; the room gateway checks the flag, a by_room live unit and a live room.
  assert.equal((sql.match(/WHERE org_id = p_org AND unit_id = p_unit AND room_id IS NULL AND revoked_at IS NULL;/g) ?? []).length, 2);
  const room = sql.slice(sql.indexOf("CREATE FUNCTION app.unit_line_issue_room"), sql.indexOf("REVOKE ALL ON FUNCTION app.unit_line_issue_room"));
  assert.match(room, /IF NOT app\.unit_line_invite_on\(p_org\) THEN\s+RAISE EXCEPTION 'flag_off';/);
  assert.match(room, /u\.rental_mode = 'by_room' AND u\.archived_at IS NULL FOR UPDATE;/);
  assert.match(room, /r\.unit_id = p_unit AND r\.archived_at IS NULL FOR UPDATE;/);
  // Seat cap per room for room bindings (accept and the trigger); room bindings only join a lease of their room.
  assert.equal((sql.match(/AND room_id IS NOT DISTINCT FROM (v_secret|NEW)\.room_id/g) ?? []).length, 2);
  assert.match(sql, /GROUP BY b\.room_id HAVING count\(\*\) > 4\) THEN\s+RAISE EXCEPTION 'seat_cap';/);
  assert.match(sql, /b\.room_id IS NOT NULL AND b\.room_id IS DISTINCT FROM v_target_room\) THEN\s+RAISE EXCEPTION 'room_mismatch';/);
  assert.match(sql, /BEFORE INSERT OR UPDATE OF status, org_id, unit_id, room_id ON app\.unit_bindings/);
  assert.match(sql, /CREATE UNIQUE INDEX unit_invite_secrets_one_live_per_room\s+ON app\.unit_invite_secrets \(org_id, room_id\) WHERE revoked_at IS NULL AND room_id IS NOT NULL;/);
  assert.match(read("scripts/check-function-privileges.sh"), /B-102 invite function ACL\/config mismatch/);
});

test("B-092 adds one service-only owner units reader with B-093 admission and the PR-015 predicate; nothing else", () => {
  const sql = read("supabase/migrations/20261117110000_b092_owner_units.sql");
  const compact = sql.replace(/\s+/g, "");
  assert.deepEqual([...sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION app\.(\w+)/g)].map(m => m[1]), ["b092_owner_units"]);
  assert.ok(compact.includes("REVOKEALLONFUNCTIONapp.b092_owner_units(uuid,uuid,text,uuid)FROMPUBLIC,anon,authenticated;"));
  assert.ok(compact.includes("GRANTEXECUTEONFUNCTIONapp.b092_owner_units(uuid,uuid,text,uuid)TOservice_role;"));
  assert.equal((compact.match(/GRANT/g) ?? []).length, 1);
  assert.match(sql, /RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS/);
  assert.match(sql, /SELECT \* INTO a FROM app\.b013_actor\(p_org,p_session\);/);
  assert.match(sql, /c\.user_id=a\.actor AND c\.is_owner AND c\.archived_at IS NULL\s+AND po\.effective_from <= org\.org_today AND \(po\.effective_to IS NULL OR po\.effective_to > org\.org_today\)/);
  assert.doesNotMatch(sql.replace(/--[^\n]*/g, ""), /phone|CREATE TABLE|ALTER |INSERT |UPDATE |DELETE |CREATE POLICY/i);
  assert.match(read("scripts/check-function-privileges.sh"), /B-092 owner units ACL\/config mismatch/);
  assert.ok(read("supabase/rpc-allowlist.txt").includes("# service-only: app.b092_owner_units(uuid,uuid,text,uuid)"));
});

test("B-092 RO-UNIT adds one service-only single-unit reader with B-093 admission and the PR-015 predicate; nothing else", () => {
  const sql = read("supabase/migrations/20261117120000_b092_owner_unit.sql");
  const compact = sql.replace(/\s+/g, "");
  const code = sql.replace(/--[^\n]*/g, "");
  assert.deepEqual([...sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION app\.(\w+)/g)].map(m => m[1]), ["b092_owner_unit"]);
  assert.ok(compact.includes("REVOKEALLONFUNCTIONapp.b092_owner_unit(uuid,uuid,text,uuid,uuid,uuid)FROMPUBLIC,anon,authenticated;"));
  assert.ok(compact.includes("GRANTEXECUTEONFUNCTIONapp.b092_owner_unit(uuid,uuid,text,uuid,uuid,uuid)TOservice_role;"));
  assert.equal((compact.match(/GRANT/g) ?? []).length, 1);
  assert.match(sql, /RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS/);
  assert.match(sql, /SELECT \* INTO a FROM app\.b013_actor\(p_org,p_session\);/);
  assert.match(sql, /c\.user_id=a\.actor AND c\.is_owner AND c\.archived_at IS NULL\s+AND po\.effective_from <= org\.org_today AND \(po\.effective_to IS NULL OR po\.effective_to > org\.org_today\)/);
  // The phone needs both the company switch and the owner's own row; never an email.
  assert.match(code, /'phone',CASE WHEN show_phone AND s\.can_phone THEN tenant\.phone END/);
  assert.match(code, /o\.settings->'show_tenant_phone' = 'true'::jsonb/);
  assert.doesNotMatch(code, /email|CREATE TABLE|ALTER |INSERT |UPDATE |DELETE |CREATE POLICY/i);
  assert.match(read("scripts/check-function-privileges.sh"), /B-092 owner unit ACL\/config mismatch/);
  assert.ok(read("supabase/rpc-allowlist.txt").includes("# service-only: app.b092_owner_unit(uuid,uuid,text,uuid,uuid,uuid)"));
});

test("B-065 phase B P1 adds three revoked append-only tables, eight service-only gateways and internal helpers, migration-owned (VEN-18)", () => {
  const sql = read("supabase/migrations/20261118110000_b065_stamp.sql");
  const code = sql.replace(/--[^\n]*/g, "");
  const compact = sql.replace(/\s+/g, "");
  const gateways = ["b065_stamp_view(text,uuid,boolean)", "b065_stamp_preview_by_grant(text,uuid,uuid)", "b065_receipt_stamp(text,uuid,boolean)",
    "b065_receipt_stamp_by_grant(text,uuid,uuid)", "b065_save_stamp(text,uuid,boolean,uuid,text,text,text,text,integer[])",
    "b065_save_stamp_by_grant(text,uuid,uuid,uuid,text,text,text,text,integer[])", "b065_consent_stamp(text,uuid,boolean,uuid,text,text,text,text,text,integer[])",
    "b065_consent_stamp_by_grant(text,uuid,uuid,uuid,text,text,text,text,text,integer[])"];
  const helpers = ["b065_svg_canonical(text)", "b065_stamp_version_guard()", "b065_stamp_consent_guard()", "b065_stamp_inputs(public.vendor_profiles)",
    "b065_inputs_sha256(jsonb)", "b065_inputs_fit(jsonb)", "b065_art_meta_ok(text,text,text,integer[])", "b065_grant_enabled(uuid)",
    "b065_stamp_account(text,uuid,boolean,boolean)", "b065_stamp_grant(text,uuid,uuid,boolean)", "b065_stamp_locks(uuid,uuid)",
    "b065_stamp_state(uuid,uuid,public.vendor_profiles,text)",
    "b065_stamp_write(text,text,uuid,uuid,uuid,uuid,public.vendor_profiles,uuid,text,text,text,text,text,integer[])"];
  assert.deepEqual([...sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION app\.(\w+)/g)].map(m => m[1]).sort(),
    [...gateways, ...helpers].map(s => s.split("(")[0]).sort());
  // Every function but the IMMUTABLE art check is a VOLATILE definer with the fixed search path; writers add lock_timeout.
  assert.equal((sql.match(/VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp (?:SET lock_timeout='3s' )?AS/g) ?? []).length, gateways.length + helpers.length - 1);
  assert.equal((sql.match(/SET lock_timeout='3s' AS/g) ?? []).length, 4);
  assert.match(sql, /CREATE FUNCTION app\.b065_svg_canonical\(p_svg text\) RETURNS boolean\nLANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS/);
  assert.doesNotMatch(code, /CREATE OR REPLACE|DROP|ALTER FUNCTION|ALTER TABLE public|ALTER TABLE app\.b0(?!65_stamp)|GRANT[^;]*\bON (?:TABLE )?(?:app|public)\.|READ ONLY|UPDATE public\.|DELETE FROM|INSERT INTO public\.platform_settings/i);
  assert.equal((sql.match(/CREATE TABLE app\./g) ?? []).length, 3);
  for (const table of ["app.b065_stamp_versions", "app.b065_stamp_consents", "app.b065_stamp_requests"]) {
    assert.ok(sql.includes(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`), table);
    assert.ok(sql.includes(`REVOKE ALL ON ${table} FROM PUBLIC,anon,authenticated,service_role;`), table);
    assert.ok(sql.includes(`BEFORE UPDATE OR DELETE ON ${table}\nFOR EACH ROW EXECUTE FUNCTION app.b025_history_immutable();`), table);
    assert.ok(sql.includes(`BEFORE TRUNCATE ON ${table}\nFOR EACH STATEMENT EXECUTE FUNCTION app.b025_history_immutable();`), table);
  }
  assert.match(read("scripts/check-function-privileges.sh"), /'app\.b065_stamp_versions','app\.b065_stamp_consents','app\.b065_stamp_requests'/);
  for (const signature of gateways) {
    assert.ok(compact.includes(`REVOKEALLONFUNCTIONapp.${signature}FROMPUBLIC,anon,authenticated;`), signature);
    assert.ok(compact.includes(`GRANTEXECUTEONFUNCTIONapp.${signature}TOservice_role;`), signature);
    assert.ok(read("scripts/check-function-privileges.sh").includes(`app.${signature}`), signature);
    assert.ok(read("supabase/rpc-allowlist.txt").includes(`# service-only: app.${signature}`), signature);
  }
  for (const signature of helpers) {
    assert.ok(compact.includes(`REVOKEALLONFUNCTIONapp.${signature}FROMPUBLIC,anon,authenticated,service_role;`), signature);
    assert.ok(!compact.includes(`GRANTEXECUTEONFUNCTIONapp.${signature}`), signature);
    assert.ok(read("scripts/check-function-privileges.sh").includes(`app.${signature}`), signature);
    assert.ok(!read("supabase/rpc-allowlist.txt").includes(`app.${signature.split("(")[0]}(`), signature);
  }
  assert.equal((compact.match(/GRANT/g) ?? []).length, gateways.length);
  // Admission: the B-026 session or the B-025 document token hash; the per-org mutex and lock order are written down once.
  assert.match(code, /app\.b026_account_actor\(p_session_hash\)/);
  assert.match(code, /x\.token_hash=p_token_hash/);
  assert.match(code, /pg_advisory_xact_lock\(hashtextextended\('b065\/stamp-req\/'\|\|p_org::text\|\|'\/'\|\|p_request::text,0\)\);\n END IF;\n PERFORM pg_advisory_xact_lock\(hashtextextended\('b065\/stamp-org\/'\|\|p_org::text,0\)\);\n PERFORM pg_advisory_xact_lock_shared\(hashtextextended\('b065\/issuer-org\/'\|\|p_org::text,0\)\);/);
  assert.match(sql, /SET LOCAL lock_timeout='5s'/);
  assert.match(read("scripts/check-function-privileges.sh"), /B-065 stamp gateway ACL\/config mismatch/);
});
