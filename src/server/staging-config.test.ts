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
};

function parseJsonc(raw: string) {
  const json = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(json) as { env?: { staging?: WorkerEnv; production?: WorkerEnv } };
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
  ]);
  assert.equal(staging.services?.[0]?.service, "condola-staging");
  assert.equal(staging.placement?.mode, "targeted");
  assert.equal(staging.placement?.region, "aws:ap-northeast-1");
  assert.doesNotMatch(raw, /postgres:\/\//i);
  assert.doesNotMatch(raw, /eyJ/);
  assert.doesNotMatch(raw, /sb_secret_/);
  assert.doesNotMatch(raw, /supabase\.co/);
});

test("the production wrangler env serves both public hosts and keeps demo mode off", () => {
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
  ]);
  assert.equal(production.secrets?.required?.some((name) => name.startsWith("ID_DOC_")), false);
  assert.equal(production.services?.[0]?.service, "condola-prod");
  assert.equal(production.placement?.mode, "targeted");
  assert.equal(production.placement?.region, "aws:ap-northeast-1");
  assert.deepEqual(
    production.routes?.map((route) => route.pattern),
    ["app.condola.app", "condola.app"],
  );
  assert.equal(production.routes?.every((route) => route.custom_domain === true), true);
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
});
