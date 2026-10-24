import assert from "node:assert/strict";
import test from "node:test";
import { withClient } from "./db";
import { ORG_ID, ORG2_ID, USERS } from "./ids";

/** Same normalization as condola_property_address_key: NFKC, lower case, no whitespace. */
function addressKey(display: string) {
  return display.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
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

test("condola_property_address_key is an invoker pure function and authenticated address writes update keys", async () => {
  await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const def = await client.query<{
        prosecdef: boolean;
        provolatile: string;
        prosrc: string;
        proconfig: string[] | null;
        table_refs: string;
        granted: boolean;
      }>(
        `SELECT p.prosecdef,
                p.provolatile,
                p.prosrc,
                p.proconfig,
                (SELECT count(*)::text
                   FROM pg_depend d
                  WHERE d.objid = p.oid
                    AND d.classid = 'pg_proc'::regclass
                    AND d.refclassid = 'pg_class'::regclass) AS table_refs,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') AS granted
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND p.proname = 'condola_property_address_key'`,
      );
      const fn = def.rows[0];
      assert.ok(fn);
      assert.equal(fn.prosecdef, false);
      assert.equal(fn.provolatile, "i");
      assert.equal(fn.table_refs, "0");
      assert.doesNotMatch(fn.prosrc, /\b(from|join|insert|update|delete)\b/i);
      assert.ok(fn.proconfig?.some((item) => item.replace(/\s+/g, "") === "search_path=pg_catalog"));
      assert.equal(fn.granted, true);

      const jurisdiction = await client.query<{ id: string }>(
        `SELECT id::text FROM jurisdictions WHERE code = 'TW'`,
      );
      const jurisdictionId = jurisdiction.rows[0]?.id;
      assert.ok(jurisdictionId);

      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [USERS.admin]);
      await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`);
      await client.query("SET LOCAL ROLE authenticated");

      const stamp = `Key Probe ${Date.now().toString(36)}`;
      const first = `${stamp} Lane 1`;
      const second = `${stamp} Lane 2`;
      const third = `${stamp} Lane 3`;
      const created = await client.query<{ id: string; address_key: string }>(
        `INSERT INTO properties (
           org_id, name, address, address_display, country_code, jurisdiction_id, currency, timezone
         ) VALUES ($1, $2, '{}'::jsonb, $3, 'TW', $4, 'TWD', 'Asia/Taipei')
         RETURNING id::text, address_key`,
        [ORG_ID, `addr ${stamp}`, first, jurisdictionId],
      );
      const propertyId = created.rows[0].id;
      assert.equal(created.rows[0].address_key, addressKey(first));

      const updated = await client.query<{ address_key: string }>(
        `UPDATE properties SET address_display = $2 WHERE id = $1 RETURNING address_key`,
        [propertyId, second],
      );
      assert.equal(updated.rows[0].address_key, addressKey(second));

      const unit = await client.query<{ id: string; import_address_key: string }>(
        `INSERT INTO units (org_id, property_id, label, rental_mode)
         VALUES ($1, $2, $3, 'whole_unit')
         RETURNING id::text, import_address_key`,
        [ORG_ID, propertyId, `U ${stamp}`],
      );
      assert.equal(unit.rows[0].import_address_key, addressKey(second));

      await client.query(`UPDATE properties SET address_display = $2 WHERE id = $1`, [propertyId, third]);
      const unitUpdated = await client.query<{ import_address_key: string }>(
        `UPDATE units SET import_address_key = NULL WHERE id = $1 RETURNING import_address_key`,
        [unit.rows[0].id],
      );
      assert.equal(unitUpdated.rows[0].import_address_key, addressKey(third));
      const propertyKey = await client.query<{ address_key: string }>(
        `SELECT address_key FROM properties WHERE id = $1`,
        [propertyId],
      );
      assert.equal(propertyKey.rows[0].address_key, addressKey(third));
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
