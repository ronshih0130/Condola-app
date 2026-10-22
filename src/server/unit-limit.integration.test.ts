import assert from "node:assert/strict";
import test from "node:test";
import { query, tx, withClient } from "./db";
import { FlowError } from "./errors";
import { ORG_ID, USERS } from "./ids";
import { applyUnitCount, trialEnd } from "./unit-limit";

type Stamp = { table: "rooms" | "units" | "leases"; id: string; updatedAt: Date };

type OrgSnap = {
  settings: unknown;
  kept_unit_ids: string[] | null;
  billing_period_end: string | null;
  billed_unit_count: number | null;
  pending_unit_count: number | null;
  billing_cycle: string | null;
  updated_at: Date;
};

async function spaces() {
  const rows = await query<{ id: string; kind: string }>(
    `SELECT id::text, kind FROM app.portfolio_spaces($1::uuid) ORDER BY created_at, id`,
    [ORG_ID],
  );
  return rows.rows;
}

async function phase() {
  const row = await query<{ phase: string }>(`SELECT app.unit_limit_phase($1::uuid) AS phase`, [ORG_ID]);
  return row.rows[0].phase;
}

async function kept() {
  const rows = await query<{ id: string }>(
    `SELECT k.kept_space_ids::text AS id
       FROM app.kept_space_ids($1::uuid) WITH ORDINALITY AS k(kept_space_ids, ord)
      ORDER BY k.ord`,
    [ORG_ID],
  );
  return rows.rows.map((row) => row.id);
}

async function setPlan(trialSql: string | null) {
  await query(
    `UPDATE organizations
        SET settings = jsonb_set(
              coalesce(settings, '{}'::jsonb),
              '{plan}',
              CASE
                WHEN $2::text IS NULL THEN (coalesce(settings->'plan', '{}'::jsonb) || jsonb_build_object('tier', 'free')) - 'trialUntil'
                ELSE coalesce(settings->'plan', '{}'::jsonb) || jsonb_build_object('tier', 'free', 'trialUntil', $2::text)
              END,
              true)
      WHERE id = $1`,
    [ORG_ID, trialSql],
  );
}

async function touch(table: "rooms" | "units", id: string) {
  const before = await query<{ updated_at: Date }>(`SELECT updated_at FROM ${table} WHERE id = $1`, [id]);
  const updated = await tx(USERS.admin, (client) =>
    client.query(`UPDATE ${table} SET label = label WHERE id = $1 AND org_id = $2`, [id, ORG_ID]),
  );
  return { rowCount: updated.rowCount ?? 0, stamp: { table, id, updatedAt: before.rows[0].updated_at } satisfies Stamp };
}

async function restoreStamp(stamp: Stamp) {
  await query(`ALTER TABLE ${stamp.table} DISABLE TRIGGER trg_${stamp.table}_updated_at`);
  await query(`UPDATE ${stamp.table} SET updated_at = $2 WHERE id = $1`, [stamp.id, stamp.updatedAt]);
  await query(`ALTER TABLE ${stamp.table} ENABLE TRIGGER trg_${stamp.table}_updated_at`);
}

test("grace, the default pick, re-picking, payments, and the next period are enforced in the database", async () => {
  const snap = await query<OrgSnap>(
    `SELECT settings, kept_unit_ids, billing_period_end::text, billed_unit_count, pending_unit_count,
            billing_cycle, updated_at
       FROM organizations WHERE id = $1`,
    [ORG_ID],
  );
  const before = snap.rows[0];
  assert.ok(before);
  const stamps: Stamp[] = [];
  let paymentId: string | null = null;
  try {
    await setPlan(null);
    assert.equal(await phase(), "open");

    const trialAgo = await query<{ at: string }>(
      `SELECT (now() - interval '40 days')::text AS at`,
    );
    await setPlan(trialAgo.rows[0].at);
    await query(
      `UPDATE organizations
          SET kept_unit_ids = NULL,
              billed_unit_count = NULL,
              pending_unit_count = NULL,
              billing_period_end = NULL
        WHERE id = $1`,
      [ORG_ID],
    );
    assert.equal(await phase(), "locked");

    const list = await spaces();
    assert.ok(list.length > 4, "the demo firm needs more than 4 spaces");
    const earliest = list.slice(0, 4).map((space) => space.id);
    const locked = list[4];
    assert.deepEqual(await kept(), earliest);

    const blocked = await touch(locked.kind === "room" ? "rooms" : "units", locked.id);
    assert.equal(blocked.rowCount, 0);

    const openSpace = list[0];
    const opened = await touch(openSpace.kind === "room" ? "rooms" : "units", openSpace.id);
    assert.equal(opened.rowCount, 1);
    stamps.push(opened.stamp);

    const swapped = [locked.id, list[0].id, list[1].id, list[2].id];
    await tx(USERS.admin, (client) =>
      client.query(`SELECT app.set_kept_units($1::uuid, $2::uuid[])`, [ORG_ID, swapped]),
    );
    assert.deepEqual(await kept(), swapped);
    const nowOpen = await touch(locked.kind === "room" ? "rooms" : "units", locked.id);
    assert.equal(nowOpen.rowCount, 1);
    stamps.push(nowOpen.stamp);
    const dropped = list[3];
    const nowLocked = await touch(dropped.kind === "room" ? "rooms" : "units", dropped.id);
    assert.equal(nowLocked.rowCount, 0);

    await assert.rejects(
      () => tx(USERS.manager, (client) => client.query(`SELECT app.set_kept_units($1::uuid, $2::uuid[])`, [ORG_ID, swapped])),
      (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden",
    );

    await tx(USERS.admin, (client) => client.query(`SELECT app.set_kept_units($1::uuid, '{}'::uuid[])`, [ORG_ID]));
    assert.deepEqual(await kept(), earliest);

    const graceAgo = await query<{ at: string }>(`SELECT (now() - interval '10 days')::text AS at`);
    await setPlan(graceAgo.rows[0].at);
    assert.equal(await phase(), "grace");
    const duringGrace = await touch(locked.kind === "room" ? "rooms" : "units", locked.id);
    assert.equal(duringGrace.rowCount, 1);
    stamps.push(duringGrace.stamp);

    const ahead = await query<{ at: string }>(`SELECT (now() + interval '10 days')::text AS at`);
    await setPlan(ahead.rows[0].at);
    assert.equal(await phase(), "trial");
    const duringTrial = await touch(locked.kind === "room" ? "rooms" : "units", locked.id);
    assert.equal(duringTrial.rowCount, 1);
    stamps.push(duringTrial.stamp);

    await setPlan(trialAgo.rows[0].at);
    assert.equal(await phase(), "locked");
    const lease = await query<{ id: string; property_id: string; space_id: string; updated_at: Date }>(
      `SELECT l.id::text, l.property_id::text, coalesce(l.target_room_id, l.target_unit_id)::text AS space_id, l.updated_at
         FROM leases l
        WHERE l.org_id = $1
          AND coalesce(l.target_room_id, l.target_unit_id) IS NOT NULL
        ORDER BY l.created_at
        LIMIT 1`,
      [ORG_ID],
    );
    const row = lease.rows[0];
    assert.ok(row);
    const others = list.filter((space) => space.id !== row.space_id).slice(0, 4).map((space) => space.id);
    assert.equal(others.length, 4);
    await tx(USERS.admin, (client) => client.query(`SELECT app.set_kept_units($1::uuid, $2::uuid[])`, [ORG_ID, others]));
    assert.equal((await kept()).includes(row.space_id), false);

    const paid = await tx(USERS.admin, (client) =>
      client.query<{ id: string }>(
        `INSERT INTO payments (
           org_id, property_id, lease_id, currency, amount_minor, paid_on, method,
           payer_account_last5, reference, status, source, submitted_by
         ) VALUES ($1,$2,$3,'TWD',100, current_date, 'bank_transfer', '90817', 'readonly-unit', 'submitted', 'manager_entry', $4)
         RETURNING id::text`,
        [ORG_ID, row.property_id, row.id, USERS.admin],
      ),
    );
    paymentId = paid.rows[0].id;
    const revised = await tx(USERS.admin, (client) =>
      client.query(`UPDATE payments SET reference = 'readonly-reversed' WHERE id = $1 AND org_id = $2`, [paymentId, ORG_ID]),
    );
    assert.equal(revised.rowCount, 1);
    const leaseBlocked = await tx(USERS.admin, (client) =>
      client.query(`UPDATE leases SET due_day = due_day WHERE id = $1 AND org_id = $2`, [row.id, ORG_ID]),
    );
    assert.equal(leaseBlocked.rowCount, 0);

    const keptLease = await query<{ id: string; updated_at: Date }>(
      `SELECT l.id::text, l.updated_at
         FROM leases l
        WHERE l.org_id = $1
          AND coalesce(l.target_room_id, l.target_unit_id) = ANY($2::uuid[])
        LIMIT 1`,
      [ORG_ID, others],
    );
    if (keptLease.rows[0]) {
      const edited = await tx(USERS.admin, (client) =>
        client.query(`UPDATE leases SET due_day = due_day WHERE id = $1 AND org_id = $2`, [keptLease.rows[0].id, ORG_ID]),
      );
      assert.equal(edited.rowCount, 1);
      stamps.push({ table: "leases", id: keptLease.rows[0].id, updatedAt: keptLease.rows[0].updated_at });
    }

    await query(
      `UPDATE organizations
          SET billed_unit_count = NULL, pending_unit_count = NULL, billing_period_end = NULL, billing_cycle = 'month'
        WHERE id = $1`,
      [ORG_ID],
    );
    const first = await query<{ billed: number; pending: number | null; period_end: string }>(
      `SELECT billed, pending, period_end::text AS period_end FROM app.sync_billed_units($1::uuid, 6, '2026-10-22'::date)`,
      [ORG_ID],
    );
    assert.deepEqual(
      { billed: first.rows[0].billed, pending: first.rows[0].pending, periodEnd: first.rows[0].period_end },
      applyUnitCount({ active: 6, billed: null, pending: null, periodEnd: null, today: "2026-10-22", cycle: "month" }),
    );
    const raised = await query<{ billed: number; pending: number | null; period_end: string }>(
      `SELECT billed, pending, period_end::text AS period_end FROM app.sync_billed_units($1::uuid, 10, '2026-10-22'::date)`,
      [ORG_ID],
    );
    assert.equal(raised.rows[0].billed, 6);
    assert.equal(raised.rows[0].pending, 10);
    assert.equal(raised.rows[0].period_end, "2026-10-31");
    const rolled = await query<{ billed: number; pending: number | null; period_end: string }>(
      `SELECT billed, pending, period_end::text AS period_end FROM app.sync_billed_units($1::uuid, 10, '2026-11-01'::date)`,
      [ORG_ID],
    );
    assert.deepEqual(
      { billed: rolled.rows[0].billed, pending: rolled.rows[0].pending, periodEnd: rolled.rows[0].period_end },
      applyUnitCount({ active: 10, billed: 6, pending: 10, periodEnd: "2026-10-31", today: "2026-11-01", cycle: "month" }),
    );

    const ends = await withClient(async (client) => {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('app.trial_mode', 'days90', true)`);
      const days = await client.query<{ end: Date }>(`SELECT app.trial_end($1::timestamptz, 3) AS end`, ["2026-01-31T00:00:00.000Z"]);
      await client.query(`SELECT set_config('app.trial_mode', 'calendar_months', true)`);
      const months = await client.query<{ end: Date }>(`SELECT app.trial_end($1::timestamptz, 3) AS end`, ["2026-01-31T00:00:00.000Z"]);
      await client.query("ROLLBACK");
      return { days: days.rows[0].end, months: months.rows[0].end };
    });
    const start = new Date("2026-01-31T00:00:00.000Z");
    assert.equal(new Date(ends.days).toISOString(), trialEnd(start, 3, "days90").toISOString());
    assert.equal(new Date(ends.months).toISOString(), trialEnd(start, 3, "calendar_months").toISOString());
  } finally {
    if (paymentId) await query(`DELETE FROM payments WHERE id = $1`, [paymentId]);
    for (const stamp of stamps) await restoreStamp(stamp);
    await query(`ALTER TABLE organizations DISABLE TRIGGER trg_organizations_updated_at`);
    await query(
      `UPDATE organizations
          SET settings = $2::jsonb,
              kept_unit_ids = $3::uuid[],
              billing_period_end = $4::date,
              billed_unit_count = $5,
              pending_unit_count = $6,
              billing_cycle = $7,
              updated_at = $8
        WHERE id = $1`,
      [
        ORG_ID,
        JSON.stringify(before.settings ?? {}),
        before.kept_unit_ids,
        before.billing_period_end,
        before.billed_unit_count,
        before.pending_unit_count,
        before.billing_cycle,
        before.updated_at,
      ],
    );
    await query(`ALTER TABLE organizations ENABLE TRIGGER trg_organizations_updated_at`);
  }
});
