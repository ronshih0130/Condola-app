import assert from "node:assert/strict";
import test from "node:test";
import { tx, withClient } from "./db";
import { FlowError } from "./errors";
import { loadIncomeExpense, type ReportRow } from "./income-expense";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import type { OrgRole, Session } from "./types";

function staff(userId: string, role: OrgRole, orgId = ORG_ID): Session {
  return {
    userId,
    sessionId: "reports",
    email: `${role}@songxin.demo`,
    name: role,
    kind: "staff",
    role,
    orgId,
    liveOrgId: orgId,
    environment: "live",
    locale: "zh-TW",
    calendar: "gregorian",
    leaseId: null,
  };
}

const admin = staff(USERS.admin, "admin");
const maintenance = staff(USERS.maintenance, "maintenance");
const coast = staff(USERS.coastAdmin, "admin", ORG2_ID);

function propertyRow(rows: ReportRow[], name: string) {
  return rows.find((row) => row.property_id && row.property_name === name);
}

function totalRow(rows: ReportRow[], currency: string) {
  return rows.find((row) => row.property_id === null && row.currency === currency);
}

test("income and expense stay in SQL, per property, owner, and currency", async () => {
  const seed = await tx(USERS.admin, async (client) => {
    const found = await client.query<{
      paid_on: string;
      incurred_on: string;
      chen: string;
      daan: string;
      xinyi: string;
    }>(
      `SELECT
         (SELECT paid_on::text FROM payments WHERE org_id = $1 AND status = 'confirmed' ORDER BY paid_on DESC LIMIT 1) AS paid_on,
         (SELECT incurred_on::text FROM expenses WHERE org_id = $1 AND description = '冷氣維修' AND status = 'approved' LIMIT 1) AS incurred_on,
         (SELECT id::text FROM contacts WHERE org_id = $1 AND display_name = '陳建宏' AND is_owner LIMIT 1) AS chen,
         (SELECT id::text FROM properties WHERE org_id = $1 AND name = '大安和平' LIMIT 1) AS daan,
         (SELECT id::text FROM properties WHERE org_id = $1 AND name = '信義松仁' LIMIT 1) AS xinyi`,
      [ORG_ID],
    );
    return found.rows[0];
  });
  assert.ok(seed?.paid_on && seed.incurred_on && seed.chen && seed.daan && seed.xinyi);

  const paidStart = `${seed.paid_on.slice(0, 7)}-01`;
  const paidEnd = await tx(USERS.admin, async (client) => {
    const row = await client.query<{ end: string }>(
      `SELECT (date_trunc('month', $1::date) + interval '1 month' - interval '1 day')::date::text AS end`,
      [seed.paid_on],
    );
    return row.rows[0].end;
  });
  const paid = await loadIncomeExpense(admin, { start: paidStart, end: paidEnd });
  const xinyiPaid = propertyRow(paid, "信義松仁");
  assert.equal(xinyiPaid?.income_minor, "1000000");
  assert.equal(xinyiPaid?.expense_minor, "0");
  assert.equal(xinyiPaid?.net_minor, "1000000");
  assert.equal(xinyiPaid?.owner_name, "陳建宏");
  assert.equal(propertyRow(paid, "大安和平")?.income_minor, "0");
  assert.equal(propertyRow(paid, "Oakland 12th")?.income_minor, "0");
  assert.equal(propertyRow(paid, "Oakland 12th")?.currency, "USD");
  assert.equal(totalRow(paid, "TWD")?.income_minor, "1000000");
  assert.equal(totalRow(paid, "TWD")?.expense_minor, "0");
  assert.equal(totalRow(paid, "TWD")?.net_minor, "1000000");
  assert.equal(totalRow(paid, "USD")?.income_minor, "0");
  assert.equal(totalRow(paid, "USD")?.net_minor, "0");

  const expenseStart = `${seed.incurred_on.slice(0, 7)}-01`;
  const expenseEnd = await tx(USERS.admin, async (client) => {
    const row = await client.query<{ end: string }>(
      `SELECT (date_trunc('month', $1::date) + interval '1 month' - interval '1 day')::date::text AS end`,
      [seed.incurred_on],
    );
    return row.rows[0].end;
  });
  const next = await loadIncomeExpense(admin, { start: expenseStart, end: expenseEnd });
  const xinyiNext = propertyRow(next, "信義松仁");
  assert.equal(xinyiNext?.income_minor, "0");
  assert.equal(xinyiNext?.expense_minor, "280000");
  assert.equal(xinyiNext?.net_minor, "-280000");

  const from = seed.paid_on < seed.incurred_on ? seed.paid_on : seed.incurred_on;
  const to = seed.paid_on > seed.incurred_on ? seed.paid_on : seed.incurred_on;
  const both = await loadIncomeExpense(admin, { start: from, end: to });
  const xinyiBoth = propertyRow(both, "信義松仁");
  assert.equal(xinyiBoth?.income_minor, "1000000");
  assert.equal(xinyiBoth?.expense_minor, "280000");
  assert.equal(xinyiBoth?.net_minor, "720000");
  assert.equal(totalRow(both, "TWD")?.income_minor, "1000000");
  assert.equal(totalRow(both, "TWD")?.expense_minor, "280000");
  assert.equal(totalRow(both, "TWD")?.net_minor, "720000");
  assert.equal(totalRow(both, "USD")?.income_minor, "0");

  const byOwner = await loadIncomeExpense(admin, { start: from, end: to, ownerId: seed.chen });
  assert.equal(propertyRow(byOwner, "信義松仁")?.net_minor, "720000");
  assert.equal(propertyRow(byOwner, "大安和平"), undefined);
  assert.equal(byOwner.filter((row) => row.property_id).length, 1);

  const byProperty = await loadIncomeExpense(admin, { start: from, end: to, propertyId: seed.daan });
  assert.equal(propertyRow(byProperty, "大安和平")?.income_minor, "0");
  assert.equal(propertyRow(byProperty, "信義松仁"), undefined);

  const coastRows = await loadIncomeExpense(coast, { start: from, end: to });
  assert.equal(coastRows.some((row) => row.property_name === "信義松仁"), false);
  assert.equal(propertyRow(coastRows, "延平北路")?.income_minor, "0");

  const otherFirm = await tx(USERS.coastAdmin, (client) =>
    client.query(
      `SELECT property_id FROM app.income_expense_report($1::uuid, NULL, NULL, $2::date, $3::date)`,
      [ORG_ID, from, to],
    ),
  );
  assert.equal(otherFirm.rows.length, 0);

  await assert.rejects(
    () => loadIncomeExpense(maintenance, { start: from, end: to }),
    (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden",
  );

  await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const lease = await client.query<{ lease_id: string; property_id: string; contact_id: string }>(
        `SELECT l.id::text AS lease_id, l.property_id::text, lp.contact_id::text
           FROM leases l
           JOIN properties p ON p.id = l.property_id
           JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
          WHERE p.org_id = $1 AND p.name = '信義松仁' AND l.status = 'active'
          LIMIT 1`,
        [ORG_ID],
      );
      const place = lease.rows[0];
      assert.ok(place);
      const stamp = Date.now().toString(36);
      async function book(day: string, lines: { type: string; amount: number }[], pay: number) {
        const invoice = await client.query<{ id: string }>(
          `INSERT INTO invoices (
             org_id, property_id, lease_id, bill_to_contact_id, invoice_number, currency,
             issue_date, due_date, period_start, period_end, status, source, created_by
           ) VALUES ($1,$2,$3,$4,$5,'TWD',$6::date,$6::date,$6::date,$6::date,'open','one_off',$7)
           RETURNING id`,
          [ORG_ID, place.property_id, place.lease_id, place.contact_id, `RPT-${stamp}-${day}`, day, USERS.admin],
        );
        let lineNo = 1;
        for (const line of lines) {
          await client.query(
            `INSERT INTO invoice_lines (
               org_id, invoice_id, line_no, charge_type, description, quantity, unit_amount_minor, amount_minor
             ) VALUES ($1,$2,$3,$4::charge_type,$4,1,$5::numeric,$5::bigint)`,
            [ORG_ID, invoice.rows[0].id, lineNo, line.type, line.amount],
          );
          lineNo += 1;
        }
        const payment = await client.query<{ id: string }>(
          `INSERT INTO payments (
             org_id, property_id, lease_id, payer_contact_id, currency, amount_minor, paid_on, method,
             status, source, submitted_by, confirmed_by, confirmed_at
           ) VALUES ($1,$2,$3,$4,'TWD',$5,$6::date,'bank_transfer','confirmed','manager_entry',$7,$7,now())
           RETURNING id`,
          [ORG_ID, place.property_id, place.lease_id, place.contact_id, pay, day, USERS.admin],
        );
        await client.query(
          `INSERT INTO payment_allocations (org_id, payment_id, invoice_id, amount_minor, created_by)
           VALUES ($1,$2,$3,$4,$5)`,
          [ORG_ID, payment.rows[0].id, invoice.rows[0].id, pay, USERS.admin],
        );
      }
      await book("2099-03-15", [{ type: "rent", amount: 100 }, { type: "deposit", amount: 80 }], 160);
      await book("2099-03-16", [{ type: "rent", amount: 100 }, { type: "utility", amount: 50 }], 120);
      await book("2099-03-17", [{ type: "rent", amount: 100 }, { type: "deposit", amount: 50 }], 30);
      await book("2099-03-18", [{ type: "deposit_refund", amount: 40 }], 40);
      await client.query(
        `INSERT INTO expenses (
           org_id, property_id, category, description, currency, amount_minor, incurred_on, paid_by, bill_to, status, created_by
         ) VALUES
           ($1,$2,'repair',$3,'TWD',50,'2099-03-15','manager_firm','owner','approved',$4),
           ($1,$2,'repair',$5,'TWD',999,'2099-03-15','manager_firm','owner','draft',$4)`,
        [ORG_ID, place.property_id, `attr-${stamp}`, USERS.admin, `attr-draft-${stamp}`],
      );
      await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [USERS.admin]);
      await client.query(`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`);
      await client.query("SET LOCAL ROLE authenticated");
      const read = async (day: string) => {
        const result = await client.query<{ income_minor: string; expense_minor: string; net_minor: string; property_id: string | null }>(
          `SELECT income_minor::text, expense_minor::text, net_minor::text, property_id::text
             FROM app.income_expense_report($1::uuid, $2::uuid, NULL::uuid, $3::date, $3::date)`,
          [ORG_ID, place.property_id, day],
        );
        return result.rows.find((row) => row.property_id);
      };
      const depositDay = await read("2099-03-15");
      assert.equal(depositDay?.income_minor, "100");
      assert.notEqual(depositDay?.income_minor, "160");
      assert.equal(depositDay?.expense_minor, "50");
      assert.equal(depositDay?.net_minor, "50");
      const utilityDay = await read("2099-03-16");
      assert.equal(utilityDay?.income_minor, "120");
      assert.equal(utilityDay?.expense_minor, "0");
      const partial = await read("2099-03-17");
      assert.equal(partial?.income_minor, "30");
      const refund = await read("2099-03-18");
      assert.equal(refund?.income_minor, "40");
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
