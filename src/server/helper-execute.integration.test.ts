import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "pg";
import { withClient } from "./db";
import { ORG_ID, ORG2_ID, USERS } from "./ids";

function asPg(error: unknown): { code?: string; message: string } {
  assert.ok(error instanceof Error);
  return error as Error & { code?: string };
}

async function expectKeyDenied(client: Client, sql: string, params: unknown[]) {
  await client.query("SAVEPOINT expect_key");
  await client.query("REVOKE EXECUTE ON FUNCTION public.condola_property_address_key(text) FROM authenticated");
  await client.query("SET LOCAL ROLE authenticated");
  try {
    await client.query(sql, params);
    assert.fail("expected permission denied for condola_property_address_key");
  } catch (error) {
    const pg = asPg(error);
    assert.equal(pg.code, "42501");
    assert.match(pg.message, /permission denied for function condola_property_address_key/);
    await client.query("ROLLBACK TO SAVEPOINT expect_key");
  }
}

test("org A cannot read org B through effective_rule or platform_max_id_retention_days", async () => {
  await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const defs = await client.query<{ proname: string; prosecdef: boolean }>(
        `SELECT proname, prosecdef
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND proname IN ('effective_rule', 'platform_max_id_retention_days')
          ORDER BY proname`,
      );
      assert.deepEqual(
        defs.rows.map((row) => [row.proname, row.prosecdef]),
        [
          ["effective_rule", false],
          ["platform_max_id_retention_days", false],
        ],
      );

      const jurisdiction = await client.query<{ id: string }>(
        `SELECT id::text FROM jurisdictions WHERE code = 'TW'`,
      );
      const jurisdictionId = jurisdiction.rows[0]?.id;
      assert.ok(jurisdictionId);

      await client.query(
        `INSERT INTO jurisdiction_rules (
           jurisdiction_id, org_id, rule_key, value, enforcement, effective_from, legal_status
         ) VALUES ($1, $2, 'deposit.max_months', '{"max_months": 7, "marker": "org-b-only"}'::jsonb,
                   'warn', '1900-01-01', 'unverified')`,
        [jurisdictionId, ORG2_ID],
      );
      await client.query(
        `UPDATE organizations SET id_doc_retention_days = 30 WHERE id = $1`,
        [ORG2_ID],
      );

      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [USERS.admin]);
      await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`);
      await client.query("SET LOCAL ROLE authenticated");

      const seen = await client.query<{ org_id: string | null; marker: string | null; max_months: string | null }>(
        `SELECT org_id::text, value->>'marker' AS marker, value->>'max_months' AS max_months
           FROM effective_rule($1::uuid, $2::uuid, 'deposit.max_months', current_date)`,
        [jurisdictionId, ORG2_ID],
      );
      assert.equal(seen.rows.length, 1);
      assert.equal(seen.rows[0].org_id, null);
      assert.equal(seen.rows[0].marker, null);
      assert.equal(seen.rows[0].max_months, "2");

      const hidden = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM jurisdiction_rules WHERE org_id = $1`,
        [ORG2_ID],
      );
      assert.equal(hidden.rows[0].n, "0");

      const cap = await client.query<{ days: number }>(`SELECT platform_max_id_retention_days() AS days`);
      assert.equal(cap.rows[0].days, 90);
      const orgB = await client.query(
        `SELECT id_doc_retention_days FROM organizations WHERE id = $1`,
        [ORG2_ID],
      );
      assert.equal(orgB.rowCount, 0);
    } finally {
      await client.query("ROLLBACK");
    }
  });
});

test("authenticated address writes need EXECUTE on condola_property_address_key", async () => {
  await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const place = await client.query<{ property_id: string; unit_id: string }>(
        `SELECT p.id::text AS property_id, u.id::text AS unit_id
           FROM properties p
           JOIN units u ON u.property_id = p.id AND u.org_id = p.org_id
          WHERE p.org_id = $1 AND p.address_display IS NOT NULL
          LIMIT 1`,
        [ORG_ID],
      );
      const row = place.rows[0];
      assert.ok(row, "seeded property and unit");

      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [USERS.admin]);
      await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`);
      await client.query("SET LOCAL ROLE authenticated");

      const property = await client.query<{ address_key: string }>(
        `UPDATE properties
            SET address_display = 'OrgA Key Probe'
          WHERE id = $1
          RETURNING address_key`,
        [row.property_id],
      );
      assert.equal(property.rows[0].address_key, "orgakeyprobe");

      const unit = await client.query<{ import_address_key: string }>(
        `UPDATE units
            SET import_address_key = NULL
          WHERE id = $1
          RETURNING import_address_key`,
        [row.unit_id],
      );
      assert.equal(unit.rows[0].import_address_key, "orgakeyprobe");

      await client.query("RESET ROLE");
      await expectKeyDenied(
        client,
        `UPDATE properties SET address_display = 'OrgA Key Probe 2' WHERE id = $1`,
        [row.property_id],
      );
      await expectKeyDenied(
        client,
        `UPDATE units SET import_address_key = NULL WHERE id = $1`,
        [row.unit_id],
      );

      const still = await client.query<{ granted: boolean }>(
        `SELECT has_function_privilege('authenticated', 'public.condola_property_address_key(text)', 'EXECUTE') AS granted`,
      );
      assert.equal(still.rows[0].granted, true);
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
