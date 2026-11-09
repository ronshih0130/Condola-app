import assert from "node:assert/strict";
import test from "node:test";
import { buildSeedSql } from "./line-channel-seed.mjs";

const env = {
  LINE_LOGIN_CHANNEL_ID: "1234567890",
  LINE_MESSAGING_CHANNEL_ID: "9876543210",
  LINE_OA_BASIC_ID: "@condola",
  LINE_LOGIN_SECRET_REF: "line-login",
  LINE_MESSAGING_SECRET_REF: "line-messaging",
  LINE_MESSAGING_TOKEN_REF: "line-messaging-token",
  // Present in the environment but must never be read or emitted:
  LINE_CHANNEL_SECRETS: JSON.stringify({ "line-login": { secret: "SHOULD-NOT-APPEAR", identityPepper: "p", destination: "d" } }),
};
const orgs = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"];

test("emits an idempotent transaction with upsert and post-upsert verification", () => {
  const sql = buildSeedSql(env, { orgs, enable: false });
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /COMMIT;\n$/);
  assert.ok(sql.includes("ON CONFLICT (messaging_channel_id) DO UPDATE"), "upsert present");
  const upsertAt = sql.indexOf("INSERT INTO public.line_channels");
  const verifyAt = sql.indexOf("app.b033_channel_verify");
  assert.ok(upsertAt >= 0 && verifyAt > upsertAt, "verify must follow the upsert");
  assert.ok(sql.includes("'租多啦Condola'"), "display name present");
});

test("enable-only sections appear only with the flag", () => {
  const base = buildSeedSql(env, { orgs, enable: false });
  assert.ok(!base.includes("platform_settings"));
  assert.ok(!base.includes("audit_log"));
  assert.ok(!base.includes("feature_flags"));
  const enabled = buildSeedSql(env, { orgs, enable: true });
  assert.ok(enabled.includes("INSERT INTO public.platform_settings"));
  assert.ok(enabled.includes("line_tenant_portal"));
  assert.ok(enabled.includes("line_owner_portal"));
  assert.ok(enabled.includes("line_vendor_portal"));
  assert.ok(enabled.includes("vendor_link"));
  assert.ok(enabled.includes("INSERT INTO public.audit_log"));
  assert.ok(enabled.includes("line_enable_internal"));
  assert.ok(enabled.includes("feature_flags"));
});

test("parenthesizes the EXCLUDED jsonb path and guards unknown orgs per org", () => {
  const sql = buildSeedSql(env, { orgs, enable: true });
  assert.ok(sql.includes("|| (EXCLUDED.value->'allowed_org_ids')"), "EXCLUDED path parenthesized");
  for (const org of orgs) {
    assert.ok(sql.includes(`RAISE EXCEPTION 'unknown org %', '${org}'`), "unknown-org guard emitted per org");
  }
});

test("rejects invalid org UUIDs", () => {
  assert.throws(() => buildSeedSql(env, { orgs: ["not-a-uuid"], enable: true }), /invalid org/i);
});

test("safely escapes single quotes and rejects control characters", () => {
  const sql = buildSeedSql({ ...env, LINE_PROVIDER_ID: "prov'ider" }, { orgs, enable: false });
  assert.ok(sql.includes("'prov''ider'"), "single quotes doubled");
  assert.throws(() => buildSeedSql({ ...env, LINE_PROVIDER_ID: "bad\u0007value" }, { orgs, enable: false }), /control/i);
});

test("emits only public identifier env values, never secret values", () => {
  const sql = buildSeedSql(env, { orgs, enable: true });
  assert.ok(!sql.includes("SHOULD-NOT-APPEAR"), "secret value absent");
  assert.ok(!sql.includes("LINE_CHANNEL_SECRETS"), "secret env name absent");
  assert.ok(sql.includes("1234567890"), "login channel id present");
  assert.ok(sql.includes("9876543210"), "messaging channel id present");
});
