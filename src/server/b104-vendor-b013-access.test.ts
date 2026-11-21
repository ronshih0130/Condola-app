import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const read = (file: string) => readFileSync(file, "utf8");
const migration = "supabase/migrations/20261115160000_b104_vendor_b013_read_helpers.sql";
const revoked = [
  "b013_estimate_heads", "b013_estimate_versions", "b013_estimate_decisions",
  "b013_repair_emergencies", "b013_repair_appointments", "b013_repair_commands", "b013_repair_event_outbox",
];

test("all non-test TypeScript under src must use gateways for revoked B-013 tables", () => {
  const reference = new RegExp(`\\b(?:${revoked.join("|")})\\b`, "i");
  const violations: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      // Only test files are exempt; fixtures and production modules are scanned.
      else if (/\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file)) {
        read(file).split("\n").forEach((line, index) => {
          if (reference.test(line)) violations.push(`${file}:${index + 1}`);
        });
      }
    }
  }
  walk("src");
  assert.deepEqual(violations, [], "revoked table references outside tests");
  const original = read("supabase/migrations/20261105170000_b013_repair_approval_state.sql");
  const block = original.match(/REVOKE ALL ON TABLE([\s\S]*?)FROM PUBLIC, anon, authenticated, service_role;/);
  assert.ok(block);
  assert.deepEqual([...block[1].matchAll(/app\.(\w+)/g)].map(match => match[1]).sort(), [...revoked].sort());
});

test("B-104 reads preserve scopes, actor fallback, latest-event order and null handling", () => {
  const sql = read(migration);
  assert.match(sql, /h\.org_id = p_org AND h\.ticket_id = p_ticket/);
  assert.match(sql, /j\.org_id = c\.org_id AND coalesce\(j\.created_by, j\.id\) = c\.actor_id/);
  assert.match(sql, /j\.org_id = p_org AND j\.id = p_job AND c\.request_id = p_request/);
  assert.match(sql, /a\.org_id = p_org AND a\.ticket_id = p_ticket/);
  assert.match(sql, /a\.repair_vendor_job_id = p_job AND a\.version_id = p_version/);
  assert.match(sql, /ORDER BY a\.occurred_at DESC, a\.id DESC LIMIT 1/);
  for (const name of ["org", "ticket", "job", "request", "version"]) {
    assert.match(sql, new RegExp(`p_${name} IS NOT NULL`));
  }
  assert.doesNotMatch(sql, /\bFOR (UPDATE|SHARE)\b/i);
  const callers = read("src/server/vendor-job.ts");
  assert.match(callers, /prior\?\.found !== true/);
  assert.match(callers, /return row\?\.event_kind \?\? "none"/);
  assert.match(read("src/server/vendor-repair.ts"), /return row\?\.version_id \?\? null/);
  const scripts = JSON.parse(read("package.json")).scripts;
  assert.ok(scripts["test:unit"].includes("src/server/b104-vendor-b013-access.test.ts"));
  assert.ok(scripts["test:rls"].split(" && ").includes(
    "tsx --test --test-concurrency=1 src/server/b104-vendor-b013-access.integration.test.ts"));
});
