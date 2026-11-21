// QA B010 L3: the legacy cron's SQL (loadLegacyOverdueRows / loadLegacyLeaseRows)
// excludes leases that are not active or have a terminated_on date, counts
// "today" in organizations.timezone, and skips an organization whose time zone
// PostgreSQL does not know. One transaction, rolled back; nothing is sent.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { ORG_ID } from "./ids";
import { disposableDbUrl } from "./test-disposable-db";
import { loadLegacyLeaseRows, loadLegacyOverdueRows } from "./reminders";
import type { query } from "./db";

// 2026-10-31T20:00Z: 2026-11-01 in Asia/Taipei, 2026-10-31 in America/Los_Angeles.
const NOW = new Date("2026-10-31T20:00:00Z");

test("L3: legacy loaders use the organization's time zone and skip ended leases", async () => {
  const c = new Client({ connectionString: disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE).href });
  await c.connect();
  const execute = ((sql: string, params?: unknown[]) => c.query(sql, params)) as unknown as typeof query;
  try {
    await c.query("BEGIN");
    // Only this test's rows matter: every other live lease/invoice is filtered out below by id.
    await c.query(`UPDATE organizations SET environment='live', timezone='America/Los_Angeles' WHERE id=$1`, [ORG_ID]);
    const property = (await c.query<{ id: string }>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES($1,'L3 legacy','TW','TWD','Asia/Taipei') RETURNING id::text`, [ORG_ID])).rows[0].id;
    const makeLease = async (status: string, end: string, terminatedOn: string | null = null) => {
      const unit = (await c.query<{ id: string }>(`INSERT INTO units(org_id,property_id,label) VALUES($1,$2,$3) RETURNING id::text`, [ORG_ID, property, `L3-${randomUUID().slice(0, 8)}`])).rows[0].id;
      return (await c.query<{ id: string }>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,end_date,terminated_on,currency,rent_amount_minor)
        VALUES($1,$2,$3,$3,$4,'2026-01-01',$5,$6,'TWD',1800000) RETURNING id::text`, [ORG_ID, property, unit, status, end, terminatedOn])).rows[0].id;
    };
    const makeInvoice = async (lease: string, due: string) => {
      const id = (await c.query<{ id: string }>(`INSERT INTO invoices(org_id,property_id,lease_id,invoice_number,currency,due_date,status,total_minor)
        VALUES($1,$2,$3,$4,'TWD',$5,'open',1800000) RETURNING id::text`, [ORG_ID, property, lease, `L3-${randomUUID()}`, due])).rows[0].id;
      await c.query(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,unit_amount_minor,amount_minor) VALUES($1,$2,1,'rent','L3 rent',1800000,1800000)`, [ORG_ID, id]);
      return id;
    };
    const active = await makeLease("active", "2026-11-30");                      // 30 days on the LA date (29 on Taipei's)
    const ended = await makeLease("ended", "2026-10-29");
    const terminated = await makeLease("terminated", "2026-12-31", "2026-10-20");
    const activeButTerminated = await makeLease("active", "2026-12-31", "2026-10-20");
    const dueYesterdayLA = await makeInvoice(active, "2026-10-30");               // day 1 on LA date (day 2 on Taipei's)
    const onEnded = await makeInvoice(ended, "2026-10-30");
    const onTerminated = await makeInvoice(terminated, "2026-10-30");
    const onActiveTerminated = await makeInvoice(activeButTerminated, "2026-10-30");
    const mine = new Set([dueYesterdayLA, onEnded, onTerminated, onActiveTerminated]);

    const overdue = (await loadLegacyOverdueRows(NOW, execute)).filter((r) => mine.has(r.invoice_id));
    assert.deepEqual(overdue.map((r) => r.invoice_id), [dueYesterdayLA], "only the active lease's invoice, counted as day 1 on the LA date");
    assert.equal(overdue[0].org_today, "2026-10-31");
    assert.equal(overdue[0].lease_status, "active");
    assert.equal(overdue[0].lease_terminated_on, null);

    const leases = (await loadLegacyLeaseRows(NOW, execute)).filter((r) => r.lease_id === active);
    assert.deepEqual(leases.map((r) => [r.lease_id, r.org_today]), [[active, "2026-10-31"]], "lease 30 days out on the LA date");

    // Back on Asia/Taipei the same instant is 2026-11-01: day 2 and 29 days, so neither is selected.
    await c.query(`UPDATE organizations SET timezone='Asia/Taipei' WHERE id=$1`, [ORG_ID]);
    assert.deepEqual((await loadLegacyOverdueRows(NOW, execute)).filter((r) => mine.has(r.invoice_id)), []);
    assert.deepEqual((await loadLegacyLeaseRows(NOW, execute)).filter((r) => r.lease_id === active), []);

    // An unknown time zone skips the organization instead of failing the run.
    await c.query("SAVEPOINT tz");
    const bad = await c.query(`UPDATE organizations SET timezone='Not/AZone' WHERE id=$1`, [ORG_ID]).then(() => true, () => false);
    if (bad) {
      // (Skipped when a constraint already rejects an unknown time zone.)
      assert.deepEqual((await loadLegacyOverdueRows(NOW, execute)).filter((r) => mine.has(r.invoice_id)), []);
      assert.deepEqual((await loadLegacyLeaseRows(NOW, execute)).filter((r) => r.lease_id === active), []);
    } else {
      await c.query("ROLLBACK TO SAVEPOINT tz");
    }
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await c.end();
  }
});
