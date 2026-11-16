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

test("B-105 adds a revoked private table, three service-only gateways and two internal helpers, migration-owned", () => {
  const sql = read("supabase/migrations/20261116160000_b105_vendor_case.sql");
  assert.deepEqual([...sql.matchAll(/CREATE FUNCTION app\.(\w+)/g)].map(match => match[1]),
    ["b105_enabled", "b105_vendor_case", "b105_vendor_write_job", "b105_vendor_decide", "b105_vendor_photo_phase"]);
  assert.equal((sql.match(/VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS/g) ?? []).length, 5);
  assert.doesNotMatch(sql.replace(/--[^\n]*/g, ""), /CREATE OR REPLACE|DROP|ALTER FUNCTION|GRANT[^;]*\bON (?:TABLE )?(?:app|public)\.|READ ONLY/i);
  assert.match(sql, /ALTER TABLE app\.b105_vendor_job_decisions ENABLE ROW LEVEL SECURITY;/);
  assert.match(sql, /REVOKE ALL ON app\.b105_vendor_job_decisions FROM PUBLIC,anon,authenticated,service_role;/);
  assert.match(sql, /\('vendor_job_v3','\{"enabled":false,"allowed_org_ids":\[\]\}'::jsonb\) ON CONFLICT DO NOTHING/);
  const compact = sql.replace(/\s+/g, "");
  for (const signature of ["b105_vendor_case(text,boolean)", "b105_vendor_decide(text,boolean,uuid,text,date,text)", "b105_vendor_photo_phase(text,boolean,uuid,text)"]) {
    assert.ok(compact.includes(`REVOKEALLONFUNCTIONapp.${signature}FROMPUBLIC,anon,authenticated;`), signature);
    assert.ok(compact.includes(`GRANTEXECUTEONFUNCTIONapp.${signature}TOservice_role;`), signature);
    assert.ok(read("scripts/check-function-privileges.sh").includes(`app.${signature}`), signature);
    assert.ok(read("supabase/rpc-allowlist.txt").includes(`# service-only: app.${signature}`), signature);
  }
  for (const signature of ["b105_enabled(uuid,boolean)", "b105_vendor_write_job(text,boolean)"]) {
    assert.ok(compact.includes(`REVOKEALLONFUNCTIONapp.${signature}FROMPUBLIC,anon,authenticated,service_role;`), signature);
    assert.ok(!compact.includes(`GRANTEXECUTEONFUNCTIONapp.${signature}`), signature);
  }
  assert.equal((compact.match(/GRANT/g) ?? []).length, 3);
  assert.match(sql, /SET LOCAL lock_timeout='5s'/);
  assert.match(sql, /SET LOCAL statement_timeout='60s'/);
  assert.match(read("scripts/check-function-privileges.sh"), /B-105 gateway ACL\/config mismatch/);
  assert.match(read("scripts/check-function-privileges.sh"), /B-105 table privilege leaked/);
});
