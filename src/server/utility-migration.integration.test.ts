import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const database = "condola_utility_mig";

function databaseUrl(name: string) {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required");
  const url = new URL(raw);
  url.pathname = `/${name}`;
  return url.toString();
}

async function psql(name: string, args: string[]) {
  await exec("psql", [databaseUrl(name), "-v", "ON_ERROR_STOP=1", ...args], {
    cwd: root,
    maxBuffer: 20 * 1024 * 1024,
  });
}

test("the electricity migration applies twice, including inside one transaction", { timeout: 120_000 }, async () => {
  assert.equal(Boolean(process.env.DATABASE_URL), true);
  await psql("postgres", ["-c", `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`]);
  await psql("postgres", ["-c", `CREATE DATABASE ${database} OWNER condola`]);
  try {
    await psql(database, ["-f", "supabase/stub/supabase_stub.sql"]);
    const files = (await readdir(path.join(root, "supabase/migrations"))).filter((name) => name.endsWith(".sql")).sort();
    assert.equal(files.includes("20261023130000_utility_charge_posting.sql"), true);
    for (const file of files) {
      await psql(database, ["-f", path.join("supabase/migrations", file)]);
    }
    const utility = "supabase/migrations/20261023130000_utility_charge_posting.sql";
    const fill = "supabase/migrations/20261023130500_utility_runs_unit_id_default.sql";
    assert.equal(files[files.indexOf("20261023130000_utility_charge_posting.sql") + 1], "20261023130500_utility_runs_unit_id_default.sql");
    await psql(database, ["-f", utility]);
    await psql(database, ["--single-transaction", "-f", utility]);
    // Staging already has the shim trigger. Re-applying this file must replace it
    // with the name that sorts before trg_allocation_rate_cap.
    await psql(database, [
      "-c",
      `DROP TRIGGER trg_a_fill_unit_id ON utility_allocation_runs;
       CREATE TRIGGER trg_utility_runs_fill_unit_id
         BEFORE INSERT ON utility_allocation_runs
         FOR EACH ROW EXECUTE FUNCTION public.utility_runs_fill_unit_id();`,
    ]);
    await psql(database, ["-f", fill]);
    await psql(database, ["--single-transaction", "-f", fill]);
    const check = await exec(
      "psql",
      [
        databaseUrl(database),
        "-v",
        "ON_ERROR_STOP=1",
        "-tA",
        "-c",
        `SELECT count(*) FROM pg_constraint WHERE conname = 'utility_allocation_runs_unit_period_excl'`,
      ],
      { cwd: root },
    );
    assert.equal(check.stdout.trim(), "1");
    const reversals = await exec(
      "psql",
      [
        databaseUrl(database),
        "-v",
        "ON_ERROR_STOP=1",
        "-tA",
        "-c",
        `SELECT pronargs::text || ':' || pronargdefaults::text
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'post_reversal'
          ORDER BY 1`,
      ],
      { cwd: root },
    );
    assert.equal(reversals.stdout.trim(), "2:0\n3:0");
    const triggers = await exec(
      "psql",
      [
        databaseUrl(database),
        "-v",
        "ON_ERROR_STOP=1",
        "-tA",
        "-c",
        `SELECT tgname
           FROM pg_trigger
          WHERE tgrelid = 'public.utility_allocation_runs'::regclass
            AND NOT tgisinternal
            AND (tgtype::int & 2) = 2
            AND (tgtype::int & 4) = 4
          ORDER BY tgname`,
      ],
      { cwd: root },
    );
    assert.equal(triggers.stdout.trim(), "trg_a_fill_unit_id\ntrg_allocation_rate_cap");
    await psql(database, [
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `
      BEGIN;
      INSERT INTO auth.users (id, email, role, aud)
      VALUES ('11111111-1111-4111-8111-111111111111', 'unit-fill@example.com', 'authenticated', 'authenticated');
      INSERT INTO organizations (id, name, country_code, default_currency)
      VALUES ('22222222-2222-4222-8222-222222222222', 'Fill', 'TW', 'TWD');
      INSERT INTO org_members (org_id, user_id, role, is_billing_owner, status)
      VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'admin', true, 'active');
      INSERT INTO properties (id, org_id, name, country_code, jurisdiction_id, currency, timezone)
      SELECT '33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222', '中壢', 'TW', id, 'TWD', 'Asia/Taipei'
        FROM jurisdictions WHERE code = 'TW';
      INSERT INTO units (id, org_id, property_id, label) VALUES
        ('44444444-4444-4444-8444-444444444444', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', 'A'),
        ('55555555-5555-4555-8555-555555555555', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', 'B');
      INSERT INTO meters (id, org_id, property_id, unit_id, utility, payer, split_method, rate_source, rate_minor_per_unit)
      VALUES ('66666666-6666-4666-8666-666666666666', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333',
              '44444444-4444-4444-8444-444444444444', 'electricity', 'tenant', 'even', 'fixed_rate', 500);
      INSERT INTO utility_bills (id, org_id, meter_id, provider, period_start, period_end, currency, total_amount_minor, total_usage)
      VALUES
        ('77777777-7777-4777-8777-777777777771', '22222222-2222-4222-8222-222222222222', '66666666-6666-4666-8666-666666666666', 'Taipower', '2026-11-01', '2026-11-30', 'TWD', 200000, 400),
        ('77777777-7777-4777-8777-777777777772', '22222222-2222-4222-8222-222222222222', '66666666-6666-4666-8666-666666666666', 'Taipower', '2026-12-01', '2026-12-31', 'TWD', 200000, 400),
        ('77777777-7777-4777-8777-777777777773', '22222222-2222-4222-8222-222222222222', '66666666-6666-4666-8666-666666666666', 'Taipower', '2027-01-01', '2027-01-31', 'TWD', 200000, 400);
      DO $$
      DECLARE got uuid; capped uuid;
      BEGIN
        INSERT INTO utility_allocation_runs (
          org_id, meter_id, utility_bill_id, period_start, period_end, split_method, rate_source, currency,
          total_usage, common_area_usage, common_area_policy, rate_minor_per_unit,
          cap_override_reason, cap_overridden_by, total_amount_minor, inputs, status, computed_by
        ) VALUES (
          '22222222-2222-4222-8222-222222222222', '66666666-6666-4666-8666-666666666666', '77777777-7777-4777-8777-777777777771',
          '2026-11-01', '2026-11-30', 'even', 'fixed_rate', 'TWD',
          400, 0, 'split_evenly', 500,
          NULL, NULL, 200000, '{}'::jsonb, 'draft', NULL
        ) RETURNING unit_id, cap_rule_id INTO got, capped;
        IF got IS DISTINCT FROM '44444444-4444-4444-8444-444444444444'::uuid THEN
          RAISE EXCEPTION 'omitted unit_id filled %, expected the meter unit', got;
        END IF;
        IF capped IS NULL THEN
          RAISE EXCEPTION 'rate-cap trigger did not run after the unit fill';
        END IF;
        INSERT INTO utility_allocation_runs (
          org_id, meter_id, utility_bill_id, period_start, period_end, split_method, rate_source, currency,
          total_usage, common_area_usage, common_area_policy, rate_minor_per_unit,
          cap_override_reason, cap_overridden_by, total_amount_minor, inputs, status, computed_by, unit_id
        ) VALUES (
          '22222222-2222-4222-8222-222222222222', '66666666-6666-4666-8666-666666666666', '77777777-7777-4777-8777-777777777772',
          '2026-12-01', '2026-12-31', 'even', 'fixed_rate', 'TWD',
          400, 0, 'split_evenly', 500,
          NULL, NULL, 200000, '{}'::jsonb, 'draft', NULL, '55555555-5555-4555-8555-555555555555'
        ) RETURNING unit_id INTO got;
        IF got IS DISTINCT FROM '55555555-5555-4555-8555-555555555555'::uuid THEN
          RAISE EXCEPTION 'explicit unit_id was replaced with %', got;
        END IF;
      END $$;
      SELECT set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
      SELECT set_config('request.jwt.claim.role', 'authenticated', true);
      SET LOCAL ROLE authenticated;
      DO $$
      DECLARE got uuid;
      BEGIN
        INSERT INTO utility_allocation_runs (
          org_id, meter_id, utility_bill_id, period_start, period_end, split_method, rate_source, currency,
          total_usage, common_area_usage, common_area_policy, rate_minor_per_unit,
          cap_override_reason, cap_overridden_by, total_amount_minor, inputs, status, computed_by
        ) VALUES (
          '22222222-2222-4222-8222-222222222222', '66666666-6666-4666-8666-666666666666', '77777777-7777-4777-8777-777777777773',
          '2027-01-01', '2027-01-31', 'even', 'fixed_rate', 'TWD',
          400, 0, 'split_evenly', 500,
          NULL, NULL, 200000, '{}'::jsonb, 'draft', NULL
        ) RETURNING unit_id INTO got;
        IF got IS DISTINCT FROM '44444444-4444-4444-8444-444444444444'::uuid THEN
          RAISE EXCEPTION 'member insert omitted unit_id filled %', got;
        END IF;
      END $$;
      COMMIT;
      `,
    ]);
  } finally {
    await psql("postgres", ["-c", `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`]);
  }
});
