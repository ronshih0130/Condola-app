import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(path: string) {
  return readFileSync(path, "utf8");
}

function parseJsonc(raw: string) {
  const json = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(json) as {
    env?: {
      staging?: {
        compatibility_flags?: string[];
        vars?: Record<string, string>;
        secrets?: { required?: string[] };
        services?: { service?: string }[];
        placement?: { mode?: string; region?: string };
      };
      production?: unknown;
    };
  };
}

test("the staging wrangler env names secrets and keeps demo mode off", () => {
  const raw = read("wrangler.jsonc");
  const staging = parseJsonc(raw).env?.staging;
  assert.ok(staging);
  assert.ok(staging.compatibility_flags?.includes("nodejs_compat"));
  assert.equal(staging.vars?.CONDOLA_ENV, "staging");
  assert.equal(staging.vars?.DEMO_MODE, "false");
  assert.equal(staging.vars?.LINE_LOGIN_ENABLED, "false");
  assert.deepEqual(staging.secrets?.required, [
    "DATABASE_URL",
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]);
  assert.equal(staging.services?.[0]?.service, "condola-staging");
  assert.equal(staging.placement?.mode, "targeted");
  assert.equal(staging.placement?.region, "aws:ap-northeast-1");
  assert.equal(parseJsonc(raw).env?.production, undefined);
  assert.doesNotMatch(raw, /postgres:\/\//i);
  assert.doesNotMatch(raw, /eyJ/);
  assert.doesNotMatch(raw, /sb_secret_/);
  assert.doesNotMatch(raw, /supabase\.co/);
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
});
