import assert from "node:assert/strict";
import test from "node:test";
import { cronAuthorized, secretsMatch } from "./cron-auth";

test("cron secrets match without a length leak, and demo-cron is local only", () => {
  assert.equal(secretsMatch("same", "same"), true);
  assert.equal(secretsMatch("same", "other"), false);
  assert.equal(secretsMatch("short", "much-longer-value"), false);

  const saved = {
    DEMO_MODE: process.env.DEMO_MODE,
    CONDOLA_ENV: process.env.CONDOLA_ENV,
    NODE_ENV: process.env.NODE_ENV,
    CRON_SECRET: process.env.CRON_SECRET,
  };
  const env = process.env as Record<string, string | undefined>;
  env.DEMO_MODE = "true";
  delete env.CONDOLA_ENV;
  env.NODE_ENV = "test";
  delete env.CRON_SECRET;
  assert.equal(cronAuthorized("demo-cron"), true);
  assert.equal(cronAuthorized("nope"), false);
  assert.equal(cronAuthorized(null), false);

  process.env.CRON_SECRET = "staging-secret";
  assert.equal(cronAuthorized("staging-secret"), true);
  process.env.DEMO_MODE = "false";
  process.env.CONDOLA_ENV = "staging";
  assert.equal(cronAuthorized("demo-cron"), false);
  assert.equal(cronAuthorized("staging-secret"), true);
  assert.equal(cronAuthorized("staging-secret-extra"), false);

  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete env[name];
    else env[name] = value;
  };
  restore("DEMO_MODE", saved.DEMO_MODE);
  restore("CONDOLA_ENV", saved.CONDOLA_ENV);
  restore("NODE_ENV", saved.NODE_ENV);
  restore("CRON_SECRET", saved.CRON_SECRET);
});
