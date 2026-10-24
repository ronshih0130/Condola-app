import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "pg";
import { withClient } from "./db";
import { ORG_ID, ORG2_ID, USERS } from "./ids";

type Place = { leaseId: string; propertyId: string; currency: string };

async function place(client: Client, orgId: string): Promise<Place> {
  const found = await client.query<{ lease_id: string; property_id: string; currency: string }>(
    `SELECT id::text AS lease_id, property_id::text, currency
       FROM leases WHERE org_id = $1 LIMIT 1`,
    [orgId],
  );
  const row = found.rows[0];
  assert.ok(row, `seeded lease in ${orgId}`);
  return { leaseId: row.lease_id, propertyId: row.property_id, currency: row.currency };
}

async function ledger(client: Client, orgId: string, stamp: string) {
  const row = await place(client, orgId);
  const txn = await client.query<{ id: string }>(
    `INSERT INTO ledger_transactions (
       org_id, property_id, lease_id, kind, currency, effective_date, description
     ) VALUES ($1, $2, $3, 'invoice', $4, current_date, $5)
     RETURNING id::text`,
    [orgId, row.propertyId, row.leaseId, row.currency, stamp],
  );
  const id = txn.rows[0].id;
  await client.query(
    `INSERT INTO ledger_entries (org_id, transaction_id, account, amount_minor, currency, property_id, lease_id, memo)
     VALUES ($1, $2, 'tenant_receivable', 100, $3, $4, $5, 'org-check'),
            ($1, $2, 'rental_income', -100, $3, $4, $5, 'org-check')`,
    [orgId, id, row.currency, row.propertyId, row.leaseId],
  );
  return id;
}

async function invoice(client: Client, orgId: string, stamp: string) {
  const row = await place(client, orgId);
  const created = await client.query<{ id: string }>(
    `INSERT INTO invoices (
       org_id, property_id, lease_id, invoice_number, currency, due_date, status, source
     ) VALUES ($1, $2, $3, $4, $5, current_date, 'open', 'one_off')
     RETURNING id::text`,
    [orgId, row.propertyId, row.leaseId, stamp, row.currency],
  );
  const id = created.rows[0].id;
  await client.query(
    `INSERT INTO invoice_lines (
       org_id, invoice_id, line_no, charge_type, description, quantity, unit_amount_minor, amount_minor
     ) VALUES ($1, $2, 1, 'rent', 'rent', 1, 100, 100)`,
    [orgId, id],
  );
  return id;
}

function asPg(error: unknown): { code?: string; message: string } {
  assert.ok(error instanceof Error);
  return error as Error & { code?: string };
}

async function expectOrgMismatch(client: Client, sql: string, params: unknown[]) {
  await client.query("SAVEPOINT expect_org");
  try {
    await client.query(sql, params);
    assert.fail("expected org mismatch");
  } catch (error) {
    const pg = asPg(error);
    assert.equal(pg.code, "42501");
    assert.match(pg.message, /org mismatch/);
    await client.query("ROLLBACK TO SAVEPOINT expect_org");
  }
}

test("post_reversal allows the pinned org, rejects another org, and service_role bypasses", async () => {
  await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const stamp = `org-rev-${Date.now().toString(36)}`;
      const own = await ledger(client, ORG_ID, `${stamp}-a`);
      const other = await ledger(client, ORG2_ID, `${stamp}-b`);
      await client.query(
        `INSERT INTO org_members (org_id, user_id, role, status)
         VALUES ($1, $2, 'admin', 'active')
         ON CONFLICT (org_id, user_id) DO NOTHING`,
        [ORG2_ID, USERS.admin],
      );
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [USERS.admin]);
      await client.query(`SELECT set_config('app.active_org_id', $1, true)`, [ORG_ID]);
      await client.query("SET LOCAL ROLE authenticated");
      const reversed = await client.query<{ id: string }>(`SELECT post_reversal($1::uuid, 'same org') AS id`, [own]);
      assert.match(reversed.rows[0].id, /^[0-9a-f-]{36}$/);
      await client.query("RESET ROLE");

      await client.query(`SELECT set_config('app.active_org_id', $1, true)`, [ORG_ID]);
      await client.query("SET LOCAL ROLE authenticated");
      await expectOrgMismatch(client, `SELECT post_reversal($1::uuid, 'cross org')`, [other]);
      await client.query("RESET ROLE");

      await client.query(`SELECT set_config('app.active_org_id', '', true)`);
      await client.query("SET LOCAL ROLE authenticated");
      await expectOrgMismatch(client, `SELECT post_reversal($1::uuid, 'unpinned')`, [other]);
      await client.query("RESET ROLE");

      await client.query(`SELECT set_config('app.active_org_id', $1, true)`, [ORG_ID]);
      await client.query("SET LOCAL ROLE service_role");
      const bypass = await client.query<{ id: string }>(`SELECT post_reversal($1::uuid, 'service') AS id`, [other]);
      assert.match(bypass.rows[0].id, /^[0-9a-f-]{36}$/);
    } finally {
      await client.query("ROLLBACK");
    }
  });
});

test("the 3-arg post_reversal returns P0001 for another org, and app.audit_event returns 42501", async () => {
  await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const stamp = `org-rev3-${Date.now().toString(36)}`;
      const other = await ledger(client, ORG2_ID, `${stamp}-b`);
      await client.query(
        `INSERT INTO org_members (org_id, user_id, role, status)
         VALUES ($1, $2, 'admin', 'active')
         ON CONFLICT (org_id, user_id) DO NOTHING`,
        [ORG2_ID, USERS.admin],
      );
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [USERS.admin]);
      await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`);
      await client.query(`SELECT set_config('app.active_org_id', $1, true)`, [ORG_ID]);
      await client.query("SET LOCAL ROLE authenticated");

      // Same pin and membership as the 2-arg test. This overload has no
      // 42501 branch. app.is_member hides the other org while the pin is set,
      // so the body raises the default "not found" exception (P0001).
      await client.query("SAVEPOINT expect_p0001");
      try {
        await client.query(`SELECT post_reversal($1::uuid, 'cross org', NULL::uuid)`, [other]);
        assert.fail("expected P0001 not found");
      } catch (error) {
        const pg = asPg(error);
        assert.equal(pg.code, "P0001");
        assert.match(pg.message, /not found/);
        assert.doesNotMatch(pg.message, /org mismatch/);
        await client.query("ROLLBACK TO SAVEPOINT expect_p0001");
      }

      await client.query("SAVEPOINT expect_audit");
      try {
        await client.query(
          `SELECT app.audit_event($1::uuid, 'utility_charge_posted', $2::jsonb)`,
          [ORG2_ID, JSON.stringify({ runId: "00000000-0000-4000-8000-000000000099" })],
        );
        assert.fail("expected 42501 from app.audit_event");
      } catch (error) {
        const pg = asPg(error);
        assert.equal(pg.code, "42501");
        assert.match(pg.message, /not allowed to audit this event/);
        await client.query("ROLLBACK TO SAVEPOINT expect_audit");
      }
    } finally {
      await client.query("ROLLBACK");
    }
  });
});

test("fn_invoice_recalc allows the pinned org, rejects another org, and service_role bypasses", async () => {
  await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const stamp = `org-inv-${Date.now().toString(36)}`;
      const own = await invoice(client, ORG_ID, `${stamp}-a`);
      const other = await invoice(client, ORG2_ID, `${stamp}-b`);
      await client.query(
        `INSERT INTO org_members (org_id, user_id, role, status)
         VALUES ($1, $2, 'admin', 'active')
         ON CONFLICT (org_id, user_id) DO NOTHING`,
        [ORG2_ID, USERS.admin],
      );
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [USERS.admin]);
      await client.query(`SELECT set_config('app.active_org_id', $1, true)`, [ORG_ID]);
      await client.query("SET LOCAL ROLE authenticated");
      await client.query(`SELECT fn_invoice_recalc($1::uuid)`, [own]);
      await client.query("RESET ROLE");
      const total = await client.query<{ total: string }>(
        `SELECT total_minor::text AS total FROM invoices WHERE id = $1`,
        [own],
      );
      assert.equal(total.rows[0].total, "100");

      await client.query(`SELECT set_config('app.active_org_id', $1, true)`, [ORG_ID]);
      await client.query("SET LOCAL ROLE authenticated");
      await expectOrgMismatch(client, `SELECT fn_invoice_recalc($1::uuid)`, [other]);
      await client.query("RESET ROLE");

      await client.query(`SELECT set_config('app.active_org_id', '', true)`);
      await client.query("SET LOCAL ROLE authenticated");
      await expectOrgMismatch(client, `SELECT fn_invoice_recalc($1::uuid)`, [other]);
      await client.query("RESET ROLE");

      await client.query(`SELECT set_config('app.active_org_id', $1, true)`, [ORG_ID]);
      await client.query("SET LOCAL ROLE service_role");
      await client.query(`SELECT fn_invoice_recalc($1::uuid)`, [other]);
      const otherTotal = await client.query<{ total: string }>(
        `SELECT total_minor::text AS total FROM invoices WHERE id = $1`,
        [other],
      );
      assert.equal(otherTotal.rows[0].total, "100");
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
