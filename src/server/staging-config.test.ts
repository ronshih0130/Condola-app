import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sessionCookie } from "./auth";
import { PRODUCTION_HOSTS, sameAppPath } from "./public-origin";

function read(path: string) {
  return readFileSync(path, "utf8");
}

type WorkerEnv = {
  name?: string;
  compatibility_flags?: string[];
  workers_dev?: boolean;
  vars?: Record<string, string>;
  secrets?: { required?: string[] };
  services?: { service?: string }[];
  placement?: { mode?: string; region?: string };
  routes?: { pattern?: string; custom_domain?: boolean }[];
  observability?: { enabled?: boolean };
  send_email?: { name?: string; remote?: boolean }[];
  triggers?: { crons?: string[] };
};

function parseJsonc(raw: string) {
  const json = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(json) as { main?: string; env?: { staging?: WorkerEnv; production?: WorkerEnv } };
}

/** Replacing the purge function must not leave anon or authenticated able to run it. */
function assertPurgeExecuteStaysClosed(sql: string) {
  const created = sql.lastIndexOf("CREATE OR REPLACE FUNCTION purge_due_identity_documents");
  const revoked = sql.lastIndexOf(
    "REVOKE ALL ON FUNCTION purge_due_identity_documents(integer) FROM PUBLIC, anon, authenticated",
  );
  assert.ok(created >= 0 && revoked > created);
  const grantAt = sql.indexOf("GRANT EXECUTE ON FUNCTION purge_due_identity_documents(integer)", revoked);
  assert.ok(grantAt > revoked);
  const grant = sql.slice(grantAt, sql.indexOf(";", grantAt));
  assert.match(grant, /TO service_role/);
  assert.doesNotMatch(grant, /\banon\b|\bauthenticated\b|\bPUBLIC\b/);
}

test("the staging wrangler env names secrets and keeps demo mode off", () => {
  const raw = read("wrangler.jsonc");
  const staging = parseJsonc(raw).env?.staging;
  assert.ok(staging);
  assert.ok(staging.compatibility_flags?.includes("nodejs_compat"));
  assert.equal(staging.vars?.CONDOLA_ENV, "staging");
  assert.equal(staging.vars?.CONDOLA_SITE_URL, "https://staging.condola.app");
  assert.equal(staging.vars?.DEMO_MODE, "false");
  assert.equal(staging.vars?.LINE_LOGIN_ENABLED, "false");
  assert.deepEqual(staging.secrets?.required, [
    "DATABASE_URL",
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "ID_DOC_ENCRYPTION_KEY",
    "ID_DOC_HMAC_KEY",
    "ID_DOC_SIGNING_SECRET",
    "CRON_SECRET",
  ]);
  assert.deepEqual(staging.triggers?.crons, ["0 1 * * *", "0 19 * * *"]);
  assert.equal(staging.services?.[0]?.service, "condola-staging");
  assert.equal(staging.placement?.mode, "targeted");
  assert.equal(staging.placement?.region, "aws:ap-northeast-1");
  assert.equal(staging.observability?.enabled, true);
  assert.equal(staging.vars?.MAIL_PROVIDER, "cloudflare");
  assert.deepEqual(staging.send_email, [{ name: "EMAIL", remote: true }]);
  assert.equal(staging.secrets?.required?.includes("RESEND_API_KEY"), false);
  assert.equal(staging.secrets?.required?.includes("BREVO_API_KEY"), false);
  assert.doesNotMatch(raw, /postgres:\/\//i);
  assert.doesNotMatch(raw, /eyJ/);
  assert.doesNotMatch(raw, /sb_secret_/);
  assert.doesNotMatch(raw, /supabase\.co/);
});

test("the production wrangler env serves app.condola.app and keeps demo mode off", () => {
  const production = parseJsonc(read("wrangler.jsonc")).env?.production;
  assert.ok(production);
  assert.equal(production.name, "condola-prod");
  assert.ok(production.compatibility_flags?.includes("nodejs_compat"));
  assert.equal(production.workers_dev, false);
  assert.equal(production.vars?.CONDOLA_ENV, "production");
  assert.equal(production.vars?.CONDOLA_SITE_URL, "https://app.condola.app");
  assert.equal(production.vars?.DEMO_MODE, "false");
  assert.equal(production.vars?.LINE_LOGIN_ENABLED, "false");
  assert.equal(production.vars?.STAGING_AUTODEPLOY, "false");
  assert.deepEqual(production.secrets?.required, [
    "DATABASE_URL",
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "ID_DOC_ENCRYPTION_KEY",
    "ID_DOC_HMAC_KEY",
    "ID_DOC_SIGNING_SECRET",
    "CRON_SECRET",
  ]);
  assert.deepEqual(production.triggers?.crons, ["0 1 * * *", "0 19 * * *"]);
  assert.equal(production.services?.[0]?.service, "condola-prod");
  assert.equal(production.placement?.mode, "targeted");
  assert.equal(production.placement?.region, "aws:ap-northeast-1");
  assert.deepEqual(
    production.routes?.map((route) => route.pattern),
    ["app.condola.app"],
  );
  assert.equal(production.routes?.every((route) => route.custom_domain === true), true);
  assert.equal(production.observability?.enabled, true);
  assert.equal(production.vars?.MAIL_PROVIDER, "cloudflare");
  assert.deepEqual(production.send_email, [{ name: "EMAIL", remote: true }]);
});

test("the worker cron calls the protected reminder route", () => {
  const config = parseJsonc(read("wrangler.jsonc"));
  assert.equal(config.main, "./custom-worker.mjs");
  const worker = read("custom-worker.mjs");
  assert.match(worker, /scheduled/);
  assert.match(worker, /0 1 \* \* \*/);
  assert.match(worker, /0 19 \* \* \*/);
  assert.match(worker, /\/api\/cron\/reminders/);
  assert.match(worker, /\/api\/cron\/purge-id-documents/);
  assert.match(worker, /from "\.\/\.open-next\/worker\.js"/);
  assert.doesNotMatch(worker, /id-purge-cron/);
  assert.doesNotMatch(worker, /from "pg"/);
  assert.match(worker, /CRON_SECRET/);
  assert.match(worker, /x-cron-secret/);
  assert.match(worker, /id-purge failed/);
  assert.doesNotMatch(worker, /SET LOCAL ROLE anon/);
  const purge = read("id-purge-cron.mjs");
  assert.match(purge, /0 19 \* \* \*/);
  assert.match(purge, /purge_due_identity_documents/);
  assert.match(purge, /SET LOCAL ROLE service_role/);
  assert.match(purge, /DELETE FROM id_document_wm_objects/);
  assert.match(purge, /DELETE FROM id_document_objects/);
  assert.doesNotMatch(purge, /SET LOCAL ROLE anon/);
  assert.doesNotMatch(purge, /console\.(log|error|warn)/);
  const route = read("src/app/api/cron/purge-id-documents/route.ts");
  assert.match(route, /purgeDueIdDocumentsUntilDone/);
  assert.match(route, /getCloudflareContext/);
  assert.match(route, /cronAuthorized/);
  assert.match(route, /status: 404/);
  assert.match(route, /x-cron-secret/);
  assert.doesNotMatch(route, /CONDOLA_ENV/);
});

test("production redirects and cookies accept app.condola.app and condola.app", () => {
  assert.deepEqual([...PRODUCTION_HOSTS], ["app.condola.app", "condola.app"]);
  assert.equal(sameAppPath("https://app.condola.app/m/properties?x=1"), "/m/properties?x=1");
  assert.equal(sameAppPath("https://condola.app/login"), "/login");
  assert.equal(sameAppPath("https://evil.example/m"), "");
  assert.equal(sameAppPath("http://condola.app/m"), "");
  const previous = process.env.CONDOLA_ENV;
  try {
    process.env.CONDOLA_ENV = "production";
    const cookie = sessionCookie("token", false);
    assert.equal(cookie.options.domain, ".condola.app");
    assert.equal(cookie.options.secure, true);
    assert.equal(cookie.options.path, "/");
    process.env.CONDOLA_ENV = "staging";
    assert.equal(sessionCookie("token", false).options.domain, undefined);
  } finally {
    if (previous === undefined) delete process.env.CONDOLA_ENV;
    else process.env.CONDOLA_ENV = previous;
  }
  const config = read("next.config.ts");
  assert.match(config, /allowedOrigins/);
  assert.match(config, /PRODUCTION_HOSTS/);
});

test("Depot deploys staging only after tests, behind a default-off variable", () => {
  const workflow = read(".depot/workflows/ci.yml");
  const deploy = read("scripts/cf-deploy-staging.sh");
  const migrate = read("scripts/db-migrate.sh");

  assert.match(workflow, /deploy-staging:/);
  assert.match(workflow, /needs:\s*check/);
  assert.match(workflow, /github\.event_name == 'push'/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /vars\.STAGING_AUTODEPLOY == 'true'/);
  assert.match(workflow, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.match(workflow, /secrets\.DATABASE_URL/);
  assert.match(workflow, /scripts\/db-migrate\.sh/);
  assert.match(workflow, /scripts\/cf-deploy-staging\.sh/);
  assert.doesNotMatch(workflow, /--env(?:=|\s+)production/);
  assert.doesNotMatch(workflow, /wrangler deploy/);

  assert.match(deploy, /--env staging/);
  assert.match(deploy, /CLOUDFLARE_ENV/);
  assert.doesNotMatch(deploy, /--env(?:=|\s+)production/);
  assert.doesNotMatch(deploy, /wrangler deploy/);

  assert.match(migrate, /supabase\/migrations\/\*\.sql/);
  assert.match(migrate, /6543/);
  assert.doesNotMatch(migrate, /-f [^\n]*stub/);
  assert.match(workflow, /CRON_SECRET/);
  assert.match(deploy, /CRON_SECRET/);

  const worker = read("custom-worker.mjs");
  assert.match(worker, /scheduled/);
  assert.match(worker, /\/api\/cron\/purge-id-documents/);
  assert.doesNotMatch(worker, /id-purge-cron/);
  assert.doesNotMatch(worker, /from "pg"/);
  assert.match(worker, /\/api\/cron\/reminders/);
  assert.match(worker, /CRON_SECRET/);
  assert.match(read("wrangler.jsonc"), /"main": "\.\/custom-worker\.mjs"/);

  const sql = read("supabase/migrations/20261022180000_tenant_id_check.sql");
  assert.match(sql, /pg_temp\.id_purge_batch/);
  assert.match(sql, /ON DELETE CASCADE/);
  assert.match(sql, /row_number\(\)/);
  assert.match(sql, /REVOKE ALL ON FUNCTION purge_due_identity_documents\(integer\) FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /SET search_path = pg_catalog, public/);
  for (const fn of [
    "id_number_stored_mask\\(text\\)",
    "dedupe_live_identity_documents\\(\\)",
    "fn_id_access_log_guard\\(\\)",
    "fn_id_document_allow_log_delete\\(\\)",
    "fn_id_number_masked\\(\\)",
    "id_document_keep_days\\(\\)",
  ]) {
    assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC, anon, authenticated`));
  }
  assert.match(sql, /WHEN n < 8 THEN 2 ELSE 3 END/);
  assertPurgeExecuteStaysClosed(sql);
  const upgrade = read("supabase/migrations/20261022200000_tenant_id_check_upgrade.sql");
  assert.match(upgrade, /ADD COLUMN IF NOT EXISTS/);
  assert.match(upgrade, /DROP FUNCTION IF EXISTS id_document_delete_after\(uuid\)/);
  assert.match(upgrade, /DROP FUNCTION IF EXISTS fn_id_document_delete_after\(\)/);
  assert.match(upgrade, /REVOKE ALL ON FUNCTION purge_due_identity_documents\(integer\) FROM PUBLIC, anon, authenticated/);
  assert.match(upgrade, /SET search_path = pg_catalog, public/);
  for (const fn of [
    "id_number_stored_mask\\(text\\)",
    "dedupe_live_identity_documents\\(\\)",
    "fn_id_access_log_guard\\(\\)",
    "fn_id_document_allow_log_delete\\(\\)",
    "fn_id_number_masked\\(\\)",
    "id_document_keep_days\\(\\)",
  ]) {
    assert.match(upgrade, new RegExp(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC, anon, authenticated`));
  }
  assert.match(upgrade, /GRANT EXECUTE ON FUNCTION purge_due_identity_documents\(integer\)/);
  assert.match(upgrade, /TO service_role/);
  assertPurgeExecuteStaysClosed(upgrade);
  const hotfix = read("supabase/migrations/20261021150000_revoke_purge_execute.sql");
  assert.match(
    hotfix,
    /REVOKE EXECUTE ON FUNCTION public\.purge_due_identity_documents\(integer\) FROM PUBLIC, anon, authenticated/,
  );
  assert.match(read("scripts/pack-staging-bundle.sh"), /custom-worker\.mjs/);
  assert.match(read("scripts/pack-staging-bundle.sh"), /\.open-next\/worker\.js/);
  const exportUpdate = sql.indexOf("UPDATE export_jobs");
  const exportCheck = sql.indexOf("export_jobs_no_identity_documents");
  assert.ok(exportUpdate >= 0 && exportUpdate < exportCheck);
  assert.match(sql, /delete_after/);
  assert.match(sql, /819200/);
  assert.match(sql, /819228/);
  assert.match(sql, /FOR UPDATE OF d SKIP LOCKED/);
  assert.match(sql, /deleted_at IS NOT NULL/);
  assert.match(sql, /OLD\.id::text/);
  assert.match(sql, /array_append/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM public\.identity_documents d WHERE d\.id = OLD\.document_id\)/);
  assert.match(upgrade, /array_append/);
  assert.match(upgrade, /NOT EXISTS \(SELECT 1 FROM public\.identity_documents d WHERE d\.id = OLD\.document_id\)/);
  const truncate = read("supabase/migrations/20261024100000_revoke_truncate.sql");
  assert.match(truncate, /-- Version 20261024100000\./);
  assert.match(truncate, /REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon, authenticated;/);
  assert.match(truncate, /ALTER DEFAULT PRIVILEGES IN SCHEMA public/);
  assert.match(truncate, /REVOKE TRUNCATE ON TABLES FROM anon, authenticated;/);
  assert.match(upgrade, /FOR UPDATE OF d SKIP LOCKED/);
  assert.match(upgrade, /size_bytes > 819200/);
  assert.match(upgrade, /confdeltype IS DISTINCT FROM 'c'/);
  assert.match(sql, /l\.status IN \('active', 'ended', 'terminated'\)/);
  assert.match(upgrade, /l\.status IN \('active', 'ended', 'terminated'\)/);
  assert.match(sql, /SELECT 90/);
  assert.match(upgrade, /SELECT 90/);
  assert.doesNotMatch(sql, /365/);
  assert.doesNotMatch(upgrade, /365/);
  assert.doesNotMatch(sql, /fn_id_photo_reject_back/);
  assert.match(upgrade, /DROP TRIGGER IF EXISTS trg_id_photo_reject_back/);
  assert.match(upgrade, /DROP FUNCTION IF EXISTS fn_id_photo_reject_back\(\)/);
  assert.doesNotMatch(upgrade, /CREATE TRIGGER trg_id_photo_reject_back/);
  assert.match(upgrade, /SET delete_after = id_document_delete_after\(lease_id, org_id, created_at\);/);
  assert.match(upgrade, /number_masked !~ '\^\[\^\*\]\{0,1\}/);
});
