// Copy the migration files this branch adds or changes versus main into the
// staging artifact, and say whether each change is add-only.
// Add-only: new columns, defaults, triggers, or functions. A NOT NULL, a new
// constraint, a rewrite of existing behavior, or a privilege change is not.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(process.argv[2] ?? path.join(root, "pr-migrations"));
const base = "2bedb895306726310252aac26f742baeaa6f3ea9";

/** Added files. Modified files are classified from their diff. */
const added = {
  "supabase/migrations/20261021150000_revoke_purge_execute.sql": {
    addOnly: false,
    reason: "REVOKE EXECUTE on purge_due_identity_documents. No column or constraint. service_role keeps EXECUTE.",
  },
  "supabase/migrations/20261022180000_tenant_id_check.sql": {
    addOnly: false,
    reason: "New ID tables, NOT NULL columns, CHECK constraints, a dropped column, triggers, and REVOKE EXECUTE on the six ID helpers. An old insert that omits the new columns or writes verified_by would fail.",
  },
  "supabase/migrations/20261022200000_tenant_id_check_upgrade.sql": {
    addOnly: false,
    reason: "Same ID shape for a database that already ran an earlier copy: NOT NULL, CHECK, dropped functions, a unique index, and the same EXECUTE revokes.",
  },
  "supabase/migrations/20261024100000_revoke_truncate.sql": {
    addOnly: false,
    reason: "REVOKE TRUNCATE from anon and authenticated. No column or constraint. Row DML grants stay.",
  },
  "supabase/migrations/20261025120000_id_consent_notice.sql": {
    addOnly: true,
    reason: "Adds nullable consent_notice_sha256. No default, NOT NULL, or constraint.",
  },
  "supabase/migrations/20261025140000_id_upload_slots.sql": {
    addOnly: false,
    reason: "New id_upload_slots table with NOT NULL columns and CHECK constraints. Old code does not write this table.",
  },
  "supabase/migrations/20261026150000_id_upload_slots_revoke_anon.sql": {
    addOnly: false,
    reason: "REVOKE ALL on id_upload_slots from anon. No column or constraint.",
  },
  "supabase/migrations/20261026160000_id_consent_display_sha.sql": {
    addOnly: true,
    reason: "Adds nullable consent_full_text_sha256 and consent_upload_text_sha256. No default or constraint.",
  },
  "supabase/migrations/20261027120000_id_consent_shown_sha.sql": {
    addOnly: true,
    reason: "Adds the same two nullable sha256 columns when the earlier filename was skipped. No default or constraint.",
  },
  "supabase/migrations/20261027140000_id_anon_revoke.sql": {
    addOnly: false,
    reason: "REVOKE table grants and EXECUTE on the mask and dedupe helpers from anon and authenticated. No column or constraint.",
  },
  "supabase/migrations/20261028120000_id_delete_after_consent.sql": {
    addOnly: false,
    reason: "Replaces id_document_delete_after and rewrites delete_after on live rows. No new NOT NULL or table constraint.",
  },
  "supabase/migrations/20261029130000_id_no_direct_mutate.sql": {
    addOnly: false,
    reason: "REVOKE UPDATE and DELETE on the id tables from PUBLIC, anon, and authenticated. Replaces iddoc_team with a SELECT-only policy. Adds SECURITY DEFINER photo functions and REVOKEs them from anon and authenticated. No new NOT NULL or constraint.",
  },
  "supabase/migrations/20261029140000_id_consent_shown_version.sql": {
    addOnly: true,
    reason: "Adds nullable consent_notice_sha and consented_at. No default, NOT NULL, or constraint. An old insert that omits them still works.",
  },
  "supabase/migrations/20261029150000_id_watermark_copy.sql": {
    addOnly: false,
    reason: "New id_document_wm_objects table uses NOT NULL columns. Replaces id_photo_open so a signed read returns the watermarked copy, and replaces purge_due_identity_documents so both ciphertext objects are deleted. No new constraint on existing tables. An old photo insert that omits the watermarked object still succeeds.",
  },
  "supabase/migrations/20261029160000_lease_close_end_date.sql": {
    addOnly: true,
    reason: "BEFORE trigger fills a null end_date when a lease becomes terminated or cancelled. An end date that is already set stays. No NOT NULL and no new constraint.",
  },
  "supabase/migrations/20261030100000_lock_public_function_execute.sql": {
    addOnly: false,
    reason: "Replaces post_reversal and fn_invoice_recalc with a caller-org check and REVOKEs EXECUTE on trigger and utility functions. Privilege change and a rewrite of existing function bodies.",
  },
  "supabase/migrations/20261030110000_gotrue_confirm_single_use.sql": {
    addOnly: false,
    reason: "New gotrue_confirm_uses table with a NOT NULL primary key, plus REVOKE ALL from PUBLIC, anon, and authenticated.",
  },
  "supabase/migrations/20261030120000_org_scoped_reversal_audit.sql": {
    addOnly: false,
    reason: "Replaces both post_reversal overloads so a cross-org call raises 42501, and replaces app.audit_event to record the session org. Rewrite of existing function bodies.",
  },
  "supabase/migrations/20261030130000_default_function_privileges.sql": {
    addOnly: false,
    reason: "ALTER DEFAULT PRIVILEGES revokes EXECUTE on future public functions from PUBLIC, anon, and authenticated. Privilege change. No existing function body changes.",
  },
  "supabase/migrations/20261030140500_revoke_app_is_member_execute.sql": {
    addOnly: false,
    reason: "REVOKE EXECUTE on app.is_member from PUBLIC and anon. authenticated and service_role keep EXECUTE. Privilege change.",
  },
  "supabase/migrations/20261030150000_revoke_id_photo_lease_close_execute.sql": {
    addOnly: false,
    reason: "REVOKE EXECUTE on fn_id_photo_drop_wm and fn_lease_close_end_date from PUBLIC, anon, and authenticated when those trigger functions exist. Privilege change. Trigger firing is unchanged.",
  },
};

const functions = [
  ["dedupe_live_identity_documents", "()", "no", "migrations and service_role only", ""],
  ["fn_id_access_log_guard", "()", "no", "trigger; ID deletes run as service_role", "pg_catalog, public"],
  ["fn_id_document_allow_log_delete", "()", "no", "trigger on identity_documents delete", ""],
  ["fn_id_number_masked", "()", "no", "trigger; inserts run as service_role", ""],
  ["id_document_keep_days", "()", "no", "called by security-definer id_document_delete_after", ""],
  ["id_number_stored_mask", "(text)", "no", "masking in the request path is application code", ""],
];

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function hasCommit(sha) {
  try {
    git(["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function commentOnly(diff) {
  const lines = diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  return lines.length > 0 && lines.every((line) => {
    const body = line.slice(1).trim();
    return body === "" || body.startsWith("--");
  });
}

function livePrivileges() {
  const sql = `SELECT p.proname || '|' || pg_get_function_identity_arguments(p.oid) || '|' ||
       has_function_privilege('public', p.oid, 'execute') || '|' ||
       has_function_privilege('anon', p.oid, 'execute') || '|' ||
       has_function_privilege('authenticated', p.oid, 'execute') || '|' ||
       has_function_privilege('service_role', p.oid, 'execute') || '|' ||
       coalesce((SELECT split_part(cfg, '=', 2) FROM unnest(p.proconfig) cfg WHERE cfg LIKE 'search_path=%'), '')
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname = ANY (ARRAY['dedupe_live_identity_documents','fn_id_access_log_guard','fn_id_document_allow_log_delete','fn_id_number_masked','id_document_keep_days','id_number_stored_mask'])
 ORDER BY 1`;
  try {
    const url = process.env.DATABASE_URL || "postgres://condola:condola@127.0.0.1:5432/condola";
    return execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-At", "-c", sql], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

mkdirSync(outDir, { recursive: true });

const intended = [
  "# ID function EXECUTE",
  "",
  "Staging reported anon can execute all six. The revoke is in `20261022180000_tenant_id_check.sql` and `20261022200000_tenant_id_check_upgrade.sql`, the migration that creates the functions.",
  "`fn_id_access_log_guard` is SECURITY DEFINER with `SET search_path = pg_catalog, public`.",
  "authenticated is not needed: no request path calls these as `authenticated`.",
  "",
  "| function | signature | PUBLIC | anon | authenticated | service_role | authenticated needed | proconfig search_path |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ...functions.map(([name, signature, needed, why, searchPath]) => `| ${name} | ${signature} | no | no | no | yes | ${needed} — ${why} | ${searchPath || "(none)"} |`),
  "",
].join("\n");

let liveNote = "Live database check was not run (no local functions, or no database).";
const live = livePrivileges();
if (live) {
  const rows = live.split("\n").filter(Boolean).map((line) => line.split("|"));
  const granted = (value) => value === "t" || value === "true";
  if (rows.length === 6) {
    const open = rows.filter((row) => granted(row[2]) || granted(row[3]) || granted(row[4]) || !granted(row[5]));
    if (open.length > 0) {
      console.error("id function execute grants are still open:");
      console.error(open.map((row) => row.join("|")).join("\n"));
      process.exit(1);
    }
    liveNote = [
      "Live `has_function_privilege` at pack time:",
      "",
      "| function | signature | PUBLIC | anon | authenticated | service_role | proconfig search_path |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...rows.map((row) => `| ${row[0]} | (${row[1]}) | ${granted(row[2]) ? "yes" : "no"} | ${granted(row[3]) ? "yes" : "no"} | ${granted(row[4]) ? "yes" : "no"} | ${granted(row[5]) ? "yes" : "no"} | ${row[6] || "(none)"} |`),
      "",
    ].join("\n");
  }
}
writeFileSync(path.join(outDir, "PERMISSIONS.md"), `${intended}\n${liveNote}\n`);

if (!hasCommit(base)) {
  writeFileSync(
    path.join(outDir, "MANIFEST.md"),
    `# PR migrations\n\nBase commit \`${base}\` is not in this clone, so the file list was not computed.\n\nadd-only: not computed.\n`,
  );
  process.exit(0);
}

const nameStatus = git(["diff", "--name-status", base, "HEAD", "--", "supabase/migrations"]);
const untracked = git(["ls-files", "--others", "--exclude-standard", "--", "supabase/migrations"])
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.endsWith(".sql"));

const entries = [];
for (const line of nameStatus.split("\n")) {
  if (!line.trim()) continue;
  const parts = line.split("\t");
  const status = parts[0];
  const file = status.startsWith("R") ? parts[2] : parts[1];
  if (!file?.endsWith(".sql")) continue;
  entries.push({ status: status.startsWith("R") ? "R" : status, file });
}
for (const file of untracked) {
  if (!entries.some((entry) => entry.file === file)) entries.push({ status: "A", file });
}
entries.sort((a, b) => a.file.localeCompare(b.file));

const rows = [];
for (const entry of entries) {
  const baseName = path.basename(entry.file);
  if (entry.status !== "D") copyFileSync(path.join(root, entry.file), path.join(outDir, baseName));
  if (entry.status === "M" || entry.status === "R") {
    const diff = git(["diff", "--unified=0", base, "HEAD", "--", entry.file]);
    if (commentOnly(diff)) {
      rows.push({ file: baseName, change: entry.status, addOnly: "yes", reason: "Version comment only. No column, default, trigger, function, NOT NULL, or constraint. An already applied filename is not run again." });
      continue;
    }
  }
  const known = added[entry.file];
  if (!known) {
    console.error(`no add-only classification for ${entry.file}`);
    process.exit(1);
  }
  rows.push({
    file: baseName,
    change: entry.status,
    addOnly: known.addOnly ? "yes" : "no",
    reason: known.reason,
  });
}

const head = git(["rev-parse", "HEAD"]).trim();
const manifest = [
  "# PR migrations vs main 2bedb895",
  "",
  `Head \`${head}\`. Base \`${base}\`.`,
  "",
  "Add-only means the change only adds columns, defaults, triggers, or functions. A NOT NULL, a new constraint old code would reject, a rewrite of existing rows or functions, or a privilege change is not add-only.",
  "",
  "| file | change | add-only | why |",
  "| --- | --- | --- | --- |",
  ...rows.map((row) => `| ${row.file} | ${row.change} | ${row.addOnly} | ${row.reason} |`),
  "",
  `${rows.length} files. ${rows.filter((row) => row.addOnly === "yes").length} add-only.`,
  "",
].join("\n");
writeFileSync(path.join(outDir, "MANIFEST.md"), manifest);
