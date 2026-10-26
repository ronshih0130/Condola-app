import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { query, tx, withClient } from "./db";
import { USERS } from "./ids";
import { SANDBOX_NOT_SENT } from "./outbound";
import { loadSampleRows, sampleCounts } from "./sandbox-data";
import { runSandboxSeed } from "./sandbox-seed";
import { ensureSampleLoaded, ensureSandbox, loadSampleData, openSandboxFirm } from "./sandbox";
import { recordLeaseNotice } from "./domain";
import type { Session } from "./types";

const LIVE_ID = "90000000-0000-4000-8000-000000000001";
const BLOCK_ID = "90000000-0000-4000-8000-000000000002";
const USER_ID = "90000000-0000-4000-8000-0000000000aa";
const PORTAL_ID = "90000000-0000-4000-8000-0000000000bb";
const LIVE_IDS = [LIVE_ID, BLOCK_ID];
const USER_IDS = [USER_ID, PORTAL_ID];

function session(orgId: string, liveOrgId: string, environment: "live" | "sandbox", role: Session["role"] = "admin"): Session {
  return {
    userId: USER_ID,
    sessionId: "sandbox-rls",
    email: "sandbox-rls@example.com",
    name: "Sandbox RLS",
    kind: "staff",
    role,
    orgId,
    liveOrgId,
    environment,
    locale: "zh-TW",
    calendar: "gregorian",
    leaseId: null,
  };
}

async function orgIds() {
  const rows = await query<{ id: string }>(
    `SELECT id::text FROM organizations WHERE id = ANY($1::uuid[]) OR live_org_id = ANY($1::uuid[])`,
    [LIVE_IDS],
  );
  return rows.rows.map((row) => row.id);
}

async function cleanup() {
  const ids = await orgIds();
  await withClient(async (client) => {
  try {
    await client.query("BEGIN");
    await client.query("SET session_replication_role = replica");
    if (ids.length) {
      const tables = await client.query<{ table_name: string }>(
        `SELECT c.table_name
           FROM information_schema.columns c
           JOIN information_schema.tables t
             ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'public' AND c.column_name = 'org_id' AND t.table_type = 'BASE TABLE'`,
      );
      for (const { table_name } of tables.rows) {
        if (!/^[a-z0-9_]+$/i.test(table_name)) continue;
        await client.query(`DELETE FROM public."${table_name}" WHERE org_id = ANY($1::uuid[])`, [ids]);
      }
      await client.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[]) OR live_org_id = ANY($1::uuid[])`, [ids]);
    }
    await client.query(`DELETE FROM profiles WHERE id = ANY($1::uuid[])`, [USER_IDS]);
    await client.query(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [USER_IDS]);
    await client.query("SET session_replication_role = DEFAULT");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  });
}

async function count(orgId: string, table: string) {
  const row = await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE org_id = $1`, [orgId]);
  return row.rows[0].n;
}

test("sandbox rows stay hidden from other firms and sample data loads once", async () => {
  await cleanup();
  try {
    const tw = await query<{ id: string }>(`SELECT id::text FROM jurisdictions WHERE code = 'TW'`);
    const jurisdictionId = tw.rows[0]?.id;
    assert.ok(jurisdictionId);

    await query(
      `INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data, email_confirmed_at, role, aud)
       VALUES ($1, 'sandbox-rls@example.com', crypt('Demo1234', gen_salt('bf')), '{}'::jsonb, now(), 'authenticated', 'authenticated'),
              ($2, 'sandbox-owner-portal@example.com', crypt('Demo1234', gen_salt('bf')), '{}'::jsonb, now(), 'authenticated', 'authenticated')`,
      [USER_ID, PORTAL_ID],
    );
    await query(
      `INSERT INTO profiles (id, display_name, email) VALUES ($1, 'Sandbox RLS', 'sandbox-rls@example.com'), ($2, 'Portal', 'sandbox-owner-portal@example.com')`,
      [USER_ID, PORTAL_ID],
    );
    await query(
      `INSERT INTO organizations (
         id, name, country_code, jurisdiction_id, default_currency, timezone, plan_tier, created_by, settings, live_enabled
       ) VALUES
         ($1, '沙盒測試公司', 'TW', $3, 'TWD', 'Asia/Taipei', 'beta', $4, '{}'::jsonb, true),
         ($2, '超額測試公司', 'TW', $3, 'TWD', 'Asia/Taipei', 'free', $4, '{}'::jsonb, true)`,
      [LIVE_ID, BLOCK_ID, jurisdictionId, USER_ID],
    );
    await query(
      `INSERT INTO org_members (org_id, user_id, role, is_billing_owner, status)
       VALUES ($1, $3, 'admin', true, 'active'), ($2, $3, 'admin', true, 'active')`,
      [LIVE_ID, BLOCK_ID, USER_ID],
    );
    await query(
      `INSERT INTO properties (org_id, name, address_display, country_code, jurisdiction_id, currency, timezone)
       VALUES ($1, '正式標記', '台北市', 'TW', $2, 'TWD', 'Asia/Taipei')`,
      [LIVE_ID, jurisdictionId],
    );

    const sandboxId = await ensureSandbox(session(LIVE_ID, LIVE_ID, "live"));
    assert.notEqual(sandboxId, LIVE_ID);

    const hidden = await tx(USER_ID, async (client) => {
      const sandbox = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM properties WHERE org_id = $1`, [sandboxId]);
      const live = await client.query<{ name: string }>(`SELECT name FROM properties WHERE org_id = $1`, [LIVE_ID]);
      return { sandbox: sandbox.rows[0].n, live: live.rows.map((row) => row.name) };
    }, { pin: false });
    assert.equal(hidden.sandbox, 0);
    assert.deepEqual(hidden.live, ["正式標記"]);

    const pinnedSandbox = await tx(
      USER_ID,
      (client) => client.query<{ org_id: string }>(`SELECT org_id::text FROM properties`),
      { orgId: sandboxId, environment: "sandbox" },
    );
    assert.deepEqual(pinnedSandbox.rows, []);

    const pinnedLive = await tx(
      USER_ID,
      (client) => client.query<{ name: string }>(`SELECT name FROM properties`),
      { orgId: LIVE_ID, environment: "live" },
    );
    assert.deepEqual(
      pinnedLive.rows.map((row) => row.name),
      ["正式標記"],
    );

    for (const outsider of [USERS.admin, USERS.coastAdmin]) {
      const leaked = await tx(
        outsider,
        (client) => client.query<{ n: number }>(`SELECT count(*)::int AS n FROM properties WHERE org_id = $1`, [sandboxId]),
        { orgId: sandboxId, environment: "sandbox" },
      );
      assert.equal(leaked.rows[0].n, 0);
    }

    await withClient(async (client) => {
      try {
        await client.query("BEGIN");
        const noop = await runSandboxSeed(client, {
          orgId: sandboxId,
          actorUserId: USER_ID,
          plugins: [{ id: "noop", seed: async () => {} }],
        });
        assert.deepEqual(noop.properties, []);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
    assert.equal(await count(sandboxId, "properties"), 0);

    await loadSampleData(session(sandboxId, LIVE_ID, "sandbox"));
    await loadSampleData(session(sandboxId, LIVE_ID, "sandbox"));
    const expected = sampleCounts(loadSampleRows());
    assert.equal(await count(sandboxId, "properties"), expected.properties);
    assert.equal(await count(sandboxId, "leases"), expected.leases);
    const occupancy = await query<{ spaces: number; occupied: number }>(
      `SELECT
         (
           (SELECT count(*) FROM rooms r
              JOIN units u ON u.id = r.unit_id
             WHERE r.org_id = $1 AND r.archived_at IS NULL AND u.rental_mode = 'by_room')
           + (SELECT count(*) FROM units u
               WHERE u.org_id = $1 AND u.archived_at IS NULL AND u.rental_mode = 'whole_unit')
         )::int AS spaces,
         (
           (SELECT count(DISTINCT l.target_room_id) FROM leases l
              JOIN rooms r ON r.id = l.target_room_id
              JOIN units u ON u.id = r.unit_id
             WHERE l.org_id = $1 AND l.status IN ('pending_signature','active') AND u.rental_mode = 'by_room')
           + (SELECT count(DISTINCT l.target_unit_id) FROM leases l
               JOIN units u ON u.id = l.target_unit_id
              WHERE l.org_id = $1 AND l.status IN ('pending_signature','active') AND u.rental_mode = 'whole_unit')
         )::int AS occupied`,
      [sandboxId],
    );
    assert.equal(occupancy.rows[0].spaces, 38);
    assert.equal(occupancy.rows[0].occupied, 31);
    const owners = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM contacts WHERE org_id = $1 AND is_owner`,
      [sandboxId],
    );
    const tenants = await query<{ n: number; portals: number }>(
      `SELECT count(*)::int AS n, count(user_id)::int AS portals
         FROM contacts WHERE org_id = $1 AND is_tenant`,
      [sandboxId],
    );
    assert.equal(owners.rows[0].n, expected.owners);
    assert.equal(tenants.rows[0].n, expected.tenants);
    assert.equal(tenants.rows[0].portals, 0);

    const untagged = await query<{ n: number }>(
      `SELECT (
         (SELECT count(*) FROM properties WHERE org_id = $1 AND name NOT LIKE '%範例資料%')
         + (SELECT count(*) FROM contacts WHERE org_id = $1 AND display_name NOT LIKE '%範例資料%')
         + (SELECT count(*) FROM units WHERE org_id = $1 AND label NOT LIKE '%範例資料%')
         + (SELECT count(*) FROM rooms WHERE org_id = $1 AND label NOT LIKE '%範例資料%')
       )::int AS n`,
      [sandboxId],
    );
    assert.equal(untagged.rows[0].n, 0);
    const marks = await query<{ n: number; other: number }>(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE label <> '範例資料')::int AS other
         FROM sample_marks WHERE org_id = $1`,
      [sandboxId],
    );
    assert.ok(marks.rows[0].n >= expected.properties + expected.owners + expected.tenants + expected.leases);
    assert.equal(marks.rows[0].other, 0);
    const masked = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM contacts WHERE org_id = $1 AND is_tenant AND notes LIKE '%A******%'`,
      [sandboxId],
    );
    assert.equal(masked.rows[0].n, expected.tenants);

    const owner = await query<{ id: string }>(
      `SELECT id::text FROM contacts WHERE org_id = $1 AND is_owner ORDER BY created_at LIMIT 1`,
      [sandboxId],
    );
    await query(`UPDATE contacts SET user_id = $2 WHERE id = $1`, [owner.rows[0].id, PORTAL_ID]);
    await query(
      `INSERT INTO invitations (org_id, kind, contact_id, email, code_hash, invited_by)
       VALUES ($1, 'owner', $2, 'owner-portal@example.com', $3, $4)`,
      [sandboxId, owner.rows[0].id, createHash("sha256").update(randomUUID()).digest("hex"), USER_ID],
    );

    const lease = await query<{ id: string; property_id: string }>(
      `SELECT id::text, property_id::text FROM leases WHERE org_id = $1 LIMIT 1`,
      [sandboxId],
    );
    await query(
      `INSERT INTO invoices (org_id, property_id, lease_id, invoice_number, currency, due_date, total_minor)
       VALUES ($1, $2, $3, 'SB-1', 'TWD', current_date, 0)`,
      [sandboxId, lease.rows[0].property_id, lease.rows[0].id],
    );
    await query(
      `INSERT INTO payments (org_id, property_id, lease_id, currency, amount_minor, paid_on, method, source)
       VALUES ($1, $2, $3, 'TWD', 100, current_date, 'cash', 'manager_entry')`,
      [sandboxId, lease.rows[0].property_id, lease.rows[0].id],
    );
    await query(
      `WITH txn AS (
         INSERT INTO ledger_transactions (org_id, property_id, lease_id, kind, currency, effective_date, description)
         VALUES ($1, $2, $3, 'payment', 'TWD', current_date, 'practice')
         RETURNING id
       )
       INSERT INTO ledger_entries (org_id, transaction_id, account, amount_minor, currency, property_id, lease_id)
       SELECT $1, txn.id, v.account, v.amount, 'TWD', $2, $3
         FROM txn
         CROSS JOIN (VALUES ('cash_clearing'::ledger_account, 100), ('tenant_receivable'::ledger_account, -100)) AS v(account, amount)`,
      [sandboxId, lease.rows[0].property_id, lease.rows[0].id],
    );
    await query(
      `INSERT INTO owner_statements (
         org_id, owner_contact_id, currency, period_start, period_end, closing_balance_minor
       ) VALUES ($1, $2, 'TWD', current_date, current_date, 0)`,
      [sandboxId, owner.rows[0].id],
    );

    await recordLeaseNotice(lease.rows[0].id, "rent_due");
    const delivery = await query<{ status: string; provider: string; error: string | null }>(
      `SELECT status::text, provider, error FROM deliveries WHERE org_id = $1 ORDER BY queued_at DESC LIMIT 1`,
      [sandboxId],
    );
    assert.equal(delivery.rows[0].status, "skipped");
    assert.equal(delivery.rows[0].provider, "sandbox_log");
    assert.equal(delivery.rows[0].error?.includes(SANDBOX_NOT_SENT), true);
    const noticeAudit = await query<{ new_row: { note?: string } }>(
      `SELECT new_row FROM audit_log WHERE org_id = $1 AND event_type = 'notice_not_sent' ORDER BY occurred_at DESC LIMIT 1`,
      [sandboxId],
    );
    assert.equal(noticeAudit.rows[0].new_row.note?.includes(SANDBOX_NOT_SENT), true);

    const seenSandbox = await tx(
      USER_ID,
      (client) => client.query<{ n: number }>(`SELECT count(*)::int AS n FROM properties`),
      { orgId: sandboxId, environment: "sandbox" },
    );
    assert.equal(seenSandbox.rows[0].n, expected.properties);
    const stillHidden = await tx(
      USERS.admin,
      (client) => client.query<{ n: number }>(`SELECT count(*)::int AS n FROM properties WHERE name LIKE '%範例資料%'`),
      { pin: false },
    );
    assert.equal(stillHidden.rows[0].n, 0);
  } finally {
    await cleanup();
  }
});

test("opening a missing sandbox creates the firm and seeds the sample once", async () => {
  const orgId = "90000000-0000-4000-8000-000000000003";
  const userId = "90000000-0000-4000-8000-0000000000cc";
  const wipe = async () => {
    const rows = await query<{ id: string }>(
      `SELECT id::text FROM organizations WHERE id = $1 OR live_org_id = $1`,
      [orgId],
    );
    const ids = rows.rows.map((row) => row.id);
    await withClient(async (client) => {
      await client.query("BEGIN");
      await client.query("SET session_replication_role = replica");
      if (ids.length) {
        const tables = await client.query<{ table_name: string }>(
          `SELECT c.table_name
             FROM information_schema.columns c
             JOIN information_schema.tables t
               ON t.table_schema = c.table_schema AND t.table_name = c.table_name
            WHERE c.table_schema = 'public' AND c.column_name = 'org_id' AND t.table_type = 'BASE TABLE'`,
        );
        for (const { table_name } of tables.rows) {
          if (!/^[a-z0-9_]+$/i.test(table_name)) continue;
          await client.query(`DELETE FROM public."${table_name}" WHERE org_id = ANY($1::uuid[])`, [ids]);
        }
        await client.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [ids]);
      }
      await client.query(`DELETE FROM profiles WHERE id = $1`, [userId]);
      await client.query(`DELETE FROM auth.users WHERE id = $1`, [userId]);
      await client.query("SET session_replication_role = DEFAULT");
      await client.query("COMMIT");
    });
  };

  await wipe();
  try {
    const tw = await query<{ id: string }>(`SELECT id::text FROM jurisdictions WHERE code = 'TW'`);
    await query(
      `INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data, email_confirmed_at, role, aud)
       VALUES ($1, 'sandbox-first@example.com', crypt('Demo1234', gen_salt('bf')), '{}'::jsonb, now(), 'authenticated', 'authenticated')`,
      [userId],
    );
    await query(`INSERT INTO profiles (id, display_name, email) VALUES ($1, 'First Login', 'sandbox-first@example.com')`, [userId]);
    await query(
      `INSERT INTO organizations (
         id, name, country_code, jurisdiction_id, default_currency, timezone, plan_tier, created_by, settings, live_enabled
       ) VALUES ($1, '首次登入公司', 'TW', $2, 'TWD', 'Asia/Taipei', 'beta', $3, '{}'::jsonb, true)`,
      [orgId, tw.rows[0].id, userId],
    );
    await query(
      `INSERT INTO org_members (org_id, user_id, role, is_billing_owner, status)
       VALUES ($1, $2, 'admin', true, 'active')`,
      [orgId, userId],
    );
    const staff = session(orgId, orgId, "live");
    staff.userId = userId;
    const sandboxId = await openSandboxFirm(staff);
    assert.notEqual(sandboxId, orgId);
    const expected = sampleCounts(loadSampleRows());
    assert.equal(await count(sandboxId, "properties"), expected.properties);
    assert.equal(await count(sandboxId, "leases"), expected.leases);
    await openSandboxFirm(staff);
    assert.equal(await count(sandboxId, "properties"), expected.properties);
    const marked = await query<{ loaded: boolean; prompt: string }>(
      `SELECT sample_loaded_at IS NOT NULL AS loaded, settings->>'sandboxPrompt' AS prompt
         FROM organizations WHERE id = $1`,
      [sandboxId],
    );
    assert.equal(marked.rows[0].loaded, true);
    assert.equal(marked.rows[0].prompt, "loaded");
  } finally {
    await wipe();
  }
});

test("an existing empty sandbox is seeded once, and a sandbox that already has rows is left alone", async () => {
  const orgId = "90000000-0000-4000-8000-000000000004";
  const busyId = "90000000-0000-4000-8000-000000000005";
  const userId = "90000000-0000-4000-8000-0000000000dd";
  const orgIds = [orgId, busyId];
  const wipe = async () => {
    const rows = await query<{ id: string }>(
      `SELECT id::text FROM organizations WHERE id = ANY($1::uuid[]) OR live_org_id = ANY($1::uuid[])`,
      [orgIds],
    );
    const ids = rows.rows.map((row) => row.id);
    await withClient(async (client) => {
      await client.query("BEGIN");
      await client.query("SET session_replication_role = replica");
      if (ids.length) {
        const tables = await client.query<{ table_name: string }>(
          `SELECT c.table_name
             FROM information_schema.columns c
             JOIN information_schema.tables t
               ON t.table_schema = c.table_schema AND t.table_name = c.table_name
            WHERE c.table_schema = 'public' AND c.column_name = 'org_id' AND t.table_type = 'BASE TABLE'`,
          );
        for (const { table_name } of tables.rows) {
          if (!/^[a-z0-9_]+$/i.test(table_name)) continue;
          await client.query(`DELETE FROM public."${table_name}" WHERE org_id = ANY($1::uuid[])`, [ids]);
        }
        await client.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [ids]);
      }
      await client.query(`DELETE FROM profiles WHERE id = $1`, [userId]);
      await client.query(`DELETE FROM auth.users WHERE id = $1`, [userId]);
      await client.query("SET session_replication_role = DEFAULT");
      await client.query("COMMIT");
    });
  };

  await wipe();
  try {
    const tw = await query<{ id: string }>(`SELECT id::text FROM jurisdictions WHERE code = 'TW'`);
    await query(
      `INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data, email_confirmed_at, role, aud)
       VALUES ($1, 'sandbox-empty@example.com', crypt('Demo1234', gen_salt('bf')), '{}'::jsonb, now(), 'authenticated', 'authenticated')`,
      [userId],
    );
    await query(`INSERT INTO profiles (id, display_name, email) VALUES ($1, 'Empty Sandbox', 'sandbox-empty@example.com')`, [userId]);
    await query(
      `INSERT INTO organizations (
         id, name, country_code, jurisdiction_id, default_currency, timezone, plan_tier, created_by, settings, live_enabled
       ) VALUES
         ($1, '空沙盒公司', 'TW', $3, 'TWD', 'Asia/Taipei', 'beta', $4, '{}'::jsonb, true),
         ($2, '已有資料公司', 'TW', $3, 'TWD', 'Asia/Taipei', 'beta', $4, '{}'::jsonb, true)`,
      [orgId, busyId, tw.rows[0].id, userId],
    );
    await query(
      `INSERT INTO org_members (org_id, user_id, role, is_billing_owner, status)
       VALUES ($1, $3, 'admin', true, 'active'), ($2, $3, 'admin', true, 'active')`,
      [orgId, busyId, userId],
    );
    const emptyStaff = session(orgId, orgId, "live");
    emptyStaff.userId = userId;
    const sandboxId = await ensureSandbox(emptyStaff);
    const sandboxStaff = session(sandboxId, orgId, "sandbox");
    sandboxStaff.userId = userId;
    const before = await query<{ loaded: Date | null }>(
      `SELECT sample_loaded_at AS loaded FROM organizations WHERE id = $1`,
      [sandboxId],
    );
    assert.equal(before.rows[0].loaded, null);
    await Promise.all([ensureSampleLoaded(sandboxStaff), ensureSampleLoaded(sandboxStaff)]);
    const expected = sampleCounts(loadSampleRows());
    assert.equal(await count(sandboxId, "properties"), expected.properties);
    await ensureSampleLoaded(sandboxStaff);
    assert.equal(await count(sandboxId, "properties"), expected.properties);

    const busyStaff = session(busyId, busyId, "live");
    busyStaff.userId = userId;
    const busySandbox = await ensureSandbox(busyStaff);
    await query(
      `INSERT INTO properties (org_id, name, address_display, country_code, jurisdiction_id, currency, timezone)
       VALUES ($1, '自建物件', '台北市', 'TW', $2, 'TWD', 'Asia/Taipei')`,
      [busySandbox, tw.rows[0].id],
    );
    const busySession = session(busySandbox, busyId, "sandbox");
    busySession.userId = userId;
    await ensureSampleLoaded(busySession);
    assert.equal(await count(busySandbox, "properties"), 1);
    const untouched = await query<{ loaded: Date | null; name: string }>(
      `SELECT o.sample_loaded_at AS loaded, p.name
         FROM organizations o
         JOIN properties p ON p.org_id = o.id
        WHERE o.id = $1`,
      [busySandbox],
    );
    assert.equal(untouched.rows[0].loaded, null);
    assert.equal(untouched.rows[0].name, "自建物件");
  } finally {
    await wipe();
  }
});

test("sample portfolio seed is a few statements, not one round trip per row", async () => {
  const orgId = randomUUID();
  const userId = randomUUID();
  const tw = await query<{ id: string }>(`SELECT id::text FROM jurisdictions WHERE code = 'TW'`);
  await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data, email_confirmed_at, role, aud)
         VALUES ($1, $2, crypt('Demo1234', gen_salt('bf')), '{}'::jsonb, now(), 'authenticated', 'authenticated')`,
        [userId, `seed-batch-${userId}@example.com`],
      );
      await client.query(`INSERT INTO profiles (id, display_name, email) VALUES ($1, 'Batch', $2)`, [
        userId,
        `seed-batch-${userId}@example.com`,
      ]);
      await client.query(
        `INSERT INTO organizations (
           id, name, country_code, jurisdiction_id, default_currency, timezone, plan_tier, created_by, environment
         ) VALUES ($1, '批次沙盒', 'TW', $2, 'TWD', 'Asia/Taipei', 'free', $3, 'live')`,
        [orgId, tw.rows[0].id, userId],
      );
      await client.query(
        `INSERT INTO org_members (org_id, user_id, role, is_billing_owner, status)
         VALUES ($1, $2, 'admin', true, 'active')`,
        [orgId, userId],
      );
      const sandboxId = randomUUID();
      await client.query(
        `INSERT INTO organizations (
           id, name, country_code, jurisdiction_id, default_currency, timezone, plan_tier, created_by,
           environment, live_org_id
         ) VALUES ($1, '批次沙盒', 'TW', $2, 'TWD', 'Asia/Taipei', 'free', $3, 'sandbox', $4)`,
        [sandboxId, tw.rows[0].id, userId, orgId],
      );
      await client.query(
        `INSERT INTO org_members (org_id, user_id, role, is_billing_owner, status)
         VALUES ($1, $2, 'admin', true, 'active')`,
        [sandboxId, userId],
      );
      let statements = 0;
      const counting = new Proxy(client, {
        get(target, prop, receiver) {
          if (prop === "query") {
            return (sql: string, params?: unknown[]) => {
              statements += 1;
              return target.query(sql, params);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      const started = Date.now();
      const seeded = await runSandboxSeed(counting as typeof client, { orgId: sandboxId, actorUserId: userId });
      const elapsed = Date.now() - started;
      const expected = sampleCounts(loadSampleRows());
      assert.equal(seeded.properties.length, expected.properties);
      assert.equal(seeded.leases.length, expected.leases);
      assert.equal(seeded.owners.length, expected.owners);
      assert.ok(statements <= 24, `seed used ${statements} statements`);
      assert.ok(elapsed < 3000, `seed took ${elapsed}ms`);
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
});
