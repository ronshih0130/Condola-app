import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyMigration, commentOnly } from "./migration-classification.mjs";

// Exercise the real manifest generator without ever connecting to a database.
test("migration manifest includes every changed SQL file and classifies unsafe changes", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "condola-manifest-"));
  try {
    const stub = path.join(tmp, "psql");
    writeFileSync(stub, "#!/bin/sh\nexit 1\n");
    chmodSync(stub, 0o755);
    const env = { ...process.env, PATH: `${tmp}:${process.env.PATH}` };
    delete env.DATABASE_URL;
    const out = path.join(tmp, "artifact");
    execFileSync(process.execPath, ["scripts/write-pr-migrations.mjs", out], { env, stdio: "pipe" });
    const manifest = readFileSync(path.join(out, "MANIFEST.md"), "utf8");
    const changed = execFileSync("git", ["diff", "--name-only", "2bedb895306726310252aac26f742baeaa6f3ea9", "HEAD", "--", "supabase/migrations"], { encoding: "utf8" })
      .split("\n").filter((file) => file.endsWith(".sql")).map((file) => path.basename(file));
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "supabase/migrations"], { encoding: "utf8" })
      .split("\n").filter((file) => file.endsWith(".sql")).map((file) => path.basename(file));
    const expected = [...new Set([...changed, ...untracked])];
    const recorded = [...manifest.matchAll(/^\| ([^|]+\.sql) \|/gm)].map((match) => match[1]);
    assert.deepEqual([...recorded].sort(), [...expected].sort());
    const copied = readdirSync(out).filter((name) => name.endsWith(".sql"));
    assert.deepEqual([...copied].sort(), [...expected].sort());
    for (const file of ["20261030150400_ticket_job_type_reserve.sql", "20261030150500_revoke_public_function_execute.sql", "20261030151200_id_purge_dry_run_guard.sql", "20261030151500_paper_lease_versions.sql", "20261031100201_b001_esign_internal_helpers.sql"]) {
      assert.match(manifest, new RegExp(`\\| ${file.replaceAll(".", "\\.")} \\| A \\| no \\|`));
    }
    assert.match(manifest, /20261025120000_id_consent_notice\.sql \| A \| yes \|/);
    assert.match(readFileSync(path.join(out, "PERMISSIONS.md"), "utf8"), /Live database check was not run/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});


test("historical migration changes examine additions and deletions before classification", () => {
  const header = "diff --git a/m.sql b/m.sql\n--- a/m.sql\n+++ b/m.sql\n@@ -1,2 +1,2 @@\n";
  const comments = `${header}--- old comment\n+-- new comment\n-\n+\n`;
  assert.equal(commentOnly(comments), true);
  assert.equal(classifyMigration("M", comments, undefined).addOnly, true);
  assert.equal(classifyMigration("R", comments, undefined).addOnly, true);
  const removedDdl = `${header}-ALTER TABLE t ADD COLUMN x text;\n+-- removed old DDL\n`;
  assert.equal(commentOnly(removedDdl), false);
  assert.throws(() => classifyMigration("M", removedDdl, { addOnly: true, reason: "old added classification" }), /explicit re-review/);
  assert.throws(() => classifyMigration("R", removedDdl, { addOnly: true }), /explicit re-review/);
  assert.throws(() => classifyMigration("M", "", { addOnly: true }), /explicit re-review/);
  assert.throws(() => classifyMigration("A", "", undefined), /no add-only classification/);
  assert.throws(() => classifyMigration("D", "", { addOnly: true }), /no add-only classification/);
});
