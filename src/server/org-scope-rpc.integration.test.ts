import assert from "node:assert/strict";
import test from "node:test";
import { query, withClient } from "./db";
import { ORG2_ID, ORG_ID, USERS } from "./ids";

function sqlState(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
}

async function asUser(
  userId: string,
  orgId: string | null,
  role: "authenticated" | "service_role",
  sql: string,
  params: unknown[] = [],
) {
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId]);
      await client.query(`SELECT set_config('request.jwt.claim.role', $1, true)`, [role]);
      await client.query(`SELECT set_config('app.active_org_id', $1, true)`, [orgId ?? ""]);
      await client.query(`SELECT set_config('app.env', 'live', true)`);
      await client.query(`SET LOCAL ROLE ${role}`);
      const result = await client.query(sql, params);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The statement already aborted the transaction.
      }
      throw error;
    }
  });
}

async function balancedTxn(orgId: string) {
  const txn = await query<{ id: string }>(
    `INSERT INTO ledger_transactions (org_id, kind, currency, effective_date, description, source_table)
     VALUES ($1, 'expense', 'TWD', current_date, 'org scope check', 'org_scope_test')
     RETURNING id::text`,
    [orgId],
  );
  const id = txn.rows[0].id;
  await query(
    `INSERT INTO ledger_entries (org_id, transaction_id, account, amount_minor, currency)
     VALUES ($1, $2, 'expense', 100, 'TWD'), ($1, $2, 'cash_clearing', -100, 'TWD')`,
    [orgId, id],
  );
  return id;
}

test("cross-org post_reversal and audit_event return 42501", async () => {
  const grants = await query<{
    anon2: boolean;
    auth2: boolean;
    svc2: boolean;
    anon3: boolean;
    auth3: boolean;
    svc3: boolean;
    public_audit: boolean;
    anon_audit: boolean;
    auth_audit: boolean;
    svc_audit: boolean;
  }>(
    `SELECT has_function_privilege('anon', 'public.post_reversal(uuid, text)', 'EXECUTE') AS anon2,
            has_function_privilege('authenticated', 'public.post_reversal(uuid, text)', 'EXECUTE') AS auth2,
            has_function_privilege('service_role', 'public.post_reversal(uuid, text)', 'EXECUTE') AS svc2,
            has_function_privilege('anon', 'public.post_reversal(uuid, text, uuid)', 'EXECUTE') AS anon3,
            has_function_privilege('authenticated', 'public.post_reversal(uuid, text, uuid)', 'EXECUTE') AS auth3,
            has_function_privilege('service_role', 'public.post_reversal(uuid, text, uuid)', 'EXECUTE') AS svc3,
            has_function_privilege('public', 'app.audit_event(uuid, text, jsonb)', 'EXECUTE') AS public_audit,
            has_function_privilege('anon', 'app.audit_event(uuid, text, jsonb)', 'EXECUTE') AS anon_audit,
            has_function_privilege('authenticated', 'app.audit_event(uuid, text, jsonb)', 'EXECUTE') AS auth_audit,
            has_function_privilege('service_role', 'app.audit_event(uuid, text, jsonb)', 'EXECUTE') AS svc_audit`,
  );
  const grant = grants.rows[0];
  assert.equal(grant.anon2, false);
  assert.equal(grant.auth2, true);
  assert.equal(grant.svc2, true);
  assert.equal(grant.anon3, false);
  assert.equal(grant.auth3, true);
  assert.equal(grant.svc3, true);
  assert.equal(grant.public_audit, false);
  assert.equal(grant.anon_audit, false);
  assert.equal(grant.auth_audit, true);
  assert.equal(grant.svc_audit, false);

  const place = await query<{ unit_id: string; property_id: string; meter_id: string | null }>(
    `SELECT u.id::text AS unit_id, p.id::text AS property_id,
            (SELECT m.id::text FROM meters m
              WHERE m.unit_id = u.id AND m.utility = 'electricity' AND m.room_id IS NULL AND m.archived_at IS NULL
              LIMIT 1) AS meter_id
       FROM units u
       JOIN properties p ON p.id = u.property_id
      WHERE p.org_id = $1 AND u.archived_at IS NULL
      ORDER BY u.created_at
      LIMIT 1`,
    [ORG_ID],
  );
  assert.ok(place.rows[0], "the demo firm has a unit");
  const unitId = place.rows[0].unit_id;
  const propertyId = place.rows[0].property_id;
  let meterId = place.rows[0].meter_id;
  let createdMeter = false;
  if (!meterId) {
    const meter = await query<{ id: string }>(
      `INSERT INTO meters (org_id, property_id, unit_id, utility, payer, split_method, rate_source, rate_minor_per_unit)
       VALUES ($1, $2, $3, 'electricity', 'tenant', 'none', 'fixed_rate', 500)
       RETURNING id::text`,
      [ORG_ID, propertyId, unitId],
    );
    meterId = meter.rows[0].id;
    createdMeter = true;
  }
  const offset = Date.now() % 15000;
  const day = (n: number) => new Date(Date.UTC(2080, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);
  const periodStart = day(offset);
  const periodEnd = day(offset + 20);
  let billId = "";
  let runId = "";
  const bill = await query<{ id: string }>(
    `INSERT INTO utility_bills (org_id, meter_id, period_start, period_end, currency, total_amount_minor, total_usage)
     VALUES ($1, $2, $3::date, $4::date, 'TWD', 500, 1)
     RETURNING id::text`,
    [ORG_ID, meterId, periodStart, periodEnd],
  );
  billId = bill.rows[0].id;
  try {
  const run = await query<{ id: string }>(
    `INSERT INTO utility_allocation_runs (
       org_id, meter_id, utility_bill_id, unit_id, period_start, period_end, split_method, rate_source, currency,
       total_usage, rate_minor_per_unit, total_amount_minor, status, approved_by, approved_at, computed_by
     ) VALUES (
       $1, $2, $3, $4, $5::date, $6::date, 'none', 'fixed_rate', 'TWD',
       1, 500, 500, 'posted', $7, now(), $7
     ) RETURNING id::text`,
    [ORG_ID, meterId, billId, unitId, periodStart, periodEnd, USERS.admin],
  );
  runId = run.rows[0].id;
  const detail = JSON.stringify({ runId, lines: 1 });
  const [sameOrg, sameOrgInvoice, serviceTxn, foreignTarget] = await Promise.all([
    balancedTxn(ORG_ID),
    balancedTxn(ORG_ID),
    balancedTxn(ORG_ID),
    balancedTxn(ORG_ID),
  ]);

    await assert.rejects(
      () => asUser(USERS.coastAdmin, ORG2_ID, "authenticated", `SELECT post_reversal($1::uuid, $2)`, [foreignTarget, "cross"]),
      (error: unknown) => sqlState(error) === "42501",
    );
    await assert.rejects(
      () =>
        asUser(USERS.coastAdmin, ORG2_ID, "authenticated", `SELECT post_reversal($1::uuid, $2, NULL::uuid)`, [
          foreignTarget,
          "cross",
        ]),
      (error: unknown) => sqlState(error) === "42501",
    );
    await assert.rejects(
      () => asUser(USERS.admin, ORG2_ID, "authenticated", `SELECT post_reversal($1::uuid, $2)`, [foreignTarget, "wrong pin"]),
      (error: unknown) => sqlState(error) === "42501",
    );
    await assert.rejects(
      () =>
        asUser(USERS.coastAdmin, ORG2_ID, "authenticated", `SELECT app.audit_event($1::uuid, 'utility_charge_posted', $2::jsonb)`, [
          ORG_ID,
          detail,
        ]),
      (error: unknown) => sqlState(error) === "42501",
    );
    await assert.rejects(
      () =>
        asUser(USERS.admin, ORG_ID, "authenticated", `SELECT app.audit_event($1::uuid, 'utility_charge_posted', $2::jsonb)`, [
          ORG2_ID,
          detail,
        ]),
      (error: unknown) => sqlState(error) === "42501",
    );

    const reversed = await asUser(USERS.admin, ORG_ID, "authenticated", `SELECT post_reversal($1::uuid, $2) AS id`, [
      sameOrg,
      "same org",
    ]);
    assert.match(String(reversed.rows[0].id), /^[0-9a-f-]{36}$/);
    const reversedInvoice = await asUser(
      USERS.admin,
      ORG_ID,
      "authenticated",
      `SELECT post_reversal($1::uuid, $2, NULL::uuid) AS id`,
      [sameOrgInvoice, "same org invoice"],
    );
    assert.match(String(reversedInvoice.rows[0].id), /^[0-9a-f-]{36}$/);
    const reversedService = await asUser(USERS.admin, null, "service_role", `SELECT post_reversal($1::uuid, $2) AS id`, [
      serviceTxn,
      "service role",
    ]);
    assert.match(String(reversedService.rows[0].id), /^[0-9a-f-]{36}$/);

    await asUser(USERS.admin, ORG_ID, "authenticated", `SELECT app.audit_event($1::uuid, 'utility_charge_posted', $2::jsonb)`, [
      ORG_ID,
      detail,
    ]);
    const recorded = await query<{ actor: string; org_id: string }>(
      `SELECT actor_user_id::text AS actor, org_id::text
         FROM audit_log
        WHERE event_type = 'utility_charge_posted' AND new_row->>'runId' = $1`,
      [runId],
    );
    assert.equal(recorded.rows.length, 1);
    assert.equal(recorded.rows[0].actor, USERS.admin);
    assert.equal(recorded.rows[0].org_id, ORG_ID);
  } finally {
    if (runId) await query(`DELETE FROM utility_allocation_runs WHERE id = $1`, [runId]);
    if (billId) await query(`DELETE FROM utility_bills WHERE id = $1`, [billId]);
    if (createdMeter) await query(`DELETE FROM meters WHERE id = $1`, [meterId]);
  }
});
