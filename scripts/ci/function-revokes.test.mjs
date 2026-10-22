import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ALLOWLIST_PATH,
  checkAddedFunctions,
  normalizeSignature,
  parseAllowlist,
  permissionRows,
  renderPermissionsTable,
} from "./function-revokes.mjs";

const checker = fileURLToPath(new URL("./function-revokes.mjs", import.meta.url));

function fixture(name) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

test("signatures ignore names, case, and spacing", () => {
  assert.equal(
    normalizeSignature("App.Provision_Portal_User( text, text, text )"),
    "app.provision_portal_user(text, text, text)",
  );
  assert.equal(normalizeSignature("app.box(p_email text, p_name text)"), "app.box(text, text)");
  assert.deepEqual(parseAllowlist("# comment\n\napp.box(text)\n"), ["app.box(text)"]);
});

test("the repo allowlist does not exempt a function", () => {
  assert.deepEqual(parseAllowlist(readFileSync(ALLOWLIST_PATH, "utf8")), []);
});

test("REVOKE ALL FROM PUBLIC, anon, and authenticated passes", () => {
  assert.deepEqual(checkAddedFunctions(fixture("revoke-complete.diff"), ""), []);
  assert.deepEqual(checkAddedFunctions(fixture("revoke-one-statement.diff"), ""), []);
  assert.deepEqual(checkAddedFunctions(fixture("revoke-multiline.diff"), ""), []);
});

test("the permissions table records every new function and its revokes", () => {
  const missing = permissionRows(fixture("revoke-missing.diff"), "");
  assert.equal(missing.length, 1);
  assert.equal(missing[0].allowlisted, false);
  assert.equal(missing[0].ok, false);
  assert.deepEqual(missing[0].roles, { PUBLIC: "revoked", anon: "missing", authenticated: "missing" });
  const table = renderPermissionsTable(missing);
  assert.match(table, /# Function EXECUTE permissions/);
  assert.match(table, /\| supabase\/migrations\/20261029020000_provision.sql \| 1 \| `app\.provision_portal_user\(text, text, text\)` \| no \| revoked \| missing \| missing \| fail \|/);

  const complete = permissionRows(fixture("revoke-complete.diff"), "");
  assert.equal(complete.length, 1);
  assert.equal(complete[0].ok, true);
  assert.deepEqual(complete[0].roles, { PUBLIC: "revoked", anon: "revoked", authenticated: "revoked" });
  assert.match(renderPermissionsTable(complete), /\| pass \|/);

  const allowed = permissionRows(fixture("revoke-missing.diff"), "app.provision_portal_user(text, text, text)\n");
  assert.equal(allowed[0].allowlisted, true);
  assert.equal(allowed[0].ok, true);
  assert.match(renderPermissionsTable(allowed), /\| yes \| revoked \| missing \| missing \| pass \|/);

  assert.match(renderPermissionsTable([]), /No new SQL functions in this diff\./);
  assert.match(renderPermissionsTable([]), /\| file \| line \| signature \| allowlisted \| PUBLIC \| anon \| authenticated \| result \|/);
});

test("a removed function is not a new function", () => {
  assert.deepEqual(checkAddedFunctions(fixture("revoke-removed.diff"), ""), []);
});

test("REVOKE ALL FROM PUBLIC alone fails with file and line", () => {
  const problems = checkAddedFunctions(fixture("revoke-missing.diff"), "");
  assert.equal(problems.length, 1);
  assert.equal(problems[0].line, 1);
  assert.equal(problems[0].signature, "app.provision_portal_user(text, text, text)");
  assert.deepEqual(problems[0].missing, ["anon", "authenticated"]);
  assert.equal(
    problems[0].message,
    "supabase/migrations/20261029020000_provision.sql:1: app.provision_portal_user(text, text, text) missing REVOKE EXECUTE FROM anon, authenticated",
  );
});

test("an allowlisted signature may omit the revokes", () => {
  const allow = "app.provision_portal_user(text, text, text)\n";
  assert.deepEqual(checkAddedFunctions(fixture("revoke-missing.diff"), allow), []);
  assert.equal(checkAddedFunctions(fixture("revoke-missing.diff"), "app.provision_portal_user(uuid)\n").length, 1);
});

test("function text inside a diff fixture is not a new SQL function", () => {
  const wrapped = [
    "diff --git a/scripts/ci/fixtures/revoke-missing.diff b/scripts/ci/fixtures/revoke-missing.diff",
    "--- /dev/null",
    "+++ b/scripts/ci/fixtures/revoke-missing.diff",
    "@@ -0,0 +1,1 @@",
    "+CREATE OR REPLACE FUNCTION app.secret() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;",
  ].join("\n");
  assert.deepEqual(checkAddedFunctions(wrapped, ""), []);
});

test("the checker CLI fails with file and line and writes the permissions table", () => {
  const diff = fileURLToPath(new URL("./fixtures/revoke-missing.diff", import.meta.url));
  let stderr = "";
  let stdout = "";
  try {
    execFileSync(process.execPath, [checker, "--diff", diff], { encoding: "utf8" });
    assert.fail("expected exit 1");
  } catch (error) {
    assert.equal(error.status, 1);
    stderr = error.stderr;
    stdout = error.stdout;
  }
  assert.equal(stderr.includes("supabase/migrations/20261029020000_provision.sql:1:"), true);
  assert.equal(stderr.includes("anon, authenticated"), true);
  assert.match(stdout, /# Function EXECUTE permissions/);
  assert.match(stdout, /\| fail \|/);

  const dir = mkdtempSync(join(tmpdir(), "condola-allow-"));
  const allowlist = join(dir, "allow.txt");
  const table = join(dir, "permissions-table.md");
  writeFileSync(allowlist, "app.provision_portal_user(text, text, text)\n");
  const clean = execFileSync(
    process.execPath,
    [checker, "--diff", diff, "--allowlist", allowlist, "--table", table],
    { encoding: "utf8" },
  );
  assert.equal(clean.includes("function revokes: clean"), true);
  assert.match(readFileSync(table, "utf8"), /\| yes \| revoked \| missing \| missing \| pass \|/);

  const complete = fileURLToPath(new URL("./fixtures/revoke-complete.diff", import.meta.url));
  const passed = execFileSync(process.execPath, [checker, "--diff", complete], { encoding: "utf8" });
  assert.equal(passed.includes("function revokes: clean"), true);
  assert.match(passed, /\| pass \|/);
});
