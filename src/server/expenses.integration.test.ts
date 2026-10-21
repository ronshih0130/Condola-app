import assert from "node:assert/strict";
import test from "node:test";
import { svc, tx } from "./db";
import { FlowError } from "./errors";
import {
  STATEMENT_EXPENSE_SQL,
  createExpense,
  getExpense,
  updateExpense,
  voidExpense,
  type ExpenseDetail,
} from "./expenses";
import { ORG_ID, USERS } from "./ids";
import type { OrgRole, Session } from "./types";

function staff(userId: string, role: OrgRole, orgId = ORG_ID): Session {
  return {
    userId,
    sessionId: "expenses",
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
const manager = staff(USERS.manager, "manager");
const accountant = staff(USERS.accountant, "accountant");
const maintenance = staff(USERS.maintenance, "maintenance");

function draftFrom(row: ExpenseDetail, patch: Partial<{ description: string; amountMajor: number }> = {}) {
  return {
    propertyId: row.property_id,
    unitId: row.unit_id ?? "",
    category: row.category,
    amountMajor: patch.amountMajor ?? Number(row.amount_minor) / 100,
    incurredOn: row.incurred_on,
    vendorName: row.vendor_name ?? "",
    description: patch.description ?? row.description,
    receiptName: "",
  };
}

test("staff can add, edit, and void an expense; the statement only keeps approved and posted", async () => {
  const stamp = Date.now().toString(36);
  const note = `水管${stamp}`;
  const vendor = `測試廠商${stamp}`;
  const voidReason = `重複登錄${stamp}`;
  const draftNote = `draft${stamp}`;
  let linkedId = "";
  let linkedNote = "";
  try {
    const place = await tx(USERS.admin, async (client) => {
      const row = await client.query<{ id: string; unit_id: string }>(
        `SELECT p.id::text, u.id::text AS unit_id
           FROM properties p
           JOIN units u ON u.property_id = p.id AND u.label = '3F'
          WHERE p.org_id = $1 AND p.name = '信義松仁'
          LIMIT 1`,
        [ORG_ID],
      );
      return row.rows[0];
    });
    assert.ok(place, "seeded 信義松仁 / 3F");

    await assert.rejects(() => createExpense(maintenance, {
      propertyId: place.id,
      category: "repair",
      amountMajor: 10,
      incurredOn: "2099-06-15",
      description: "nope",
    }), (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden");

    await assert.rejects(
      () =>
        tx(USERS.maintenance, (client) =>
          client.query(
            `INSERT INTO expenses (
               org_id, property_id, category, currency, amount_minor, incurred_on, paid_by, bill_to, status
             ) VALUES ($1,$2,'repair','TWD',100,'2099-06-15','manager_firm','owner','posted')`,
            [ORG_ID, place.id],
          ),
        ),
      (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden",
    );

    const created = await createExpense(manager, {
      propertyId: place.id,
      unitId: place.unit_id,
      category: "cleaning",
      amountMajor: 1500,
      incurredOn: "2099-06-15",
      vendorName: vendor,
      description: note,
      receiptName: `receipt-${stamp}.txt`,
    });
    const row = await getExpense(accountant, created.expenseId);
    assert.ok(row);
    assert.equal(row.status, "posted");
    assert.equal(row.included, true);
    assert.equal(row.bill_to, "owner");
    assert.equal(row.unit_label, "3F");
    assert.equal(row.vendor_name, vendor);
    assert.equal(row.description, note);
    assert.equal(row.amount_minor, "150000");
    assert.equal(row.receipt_name, `receipt-${stamp}.txt`);
    assert.equal(row.incurred_on, "2099-06-15");

    const counted = await tx(USERS.admin, (client) =>
      client.query(`SELECT id FROM expenses WHERE id = $1 AND ${STATEMENT_EXPENSE_SQL}`, [created.expenseId]),
    );
    assert.equal(counted.rows.length, 1);

    const audit = await tx(USERS.admin, (client) =>
      client.query<{ action: string; reason: string | null; actor_user_id: string }>(
        `SELECT action, reason, actor_user_id::text
           FROM audit_log WHERE table_name = 'expenses' AND row_id = $1
          ORDER BY id`,
        [created.expenseId],
      ),
    );
    assert.ok(audit.rows.some((entry) => entry.action === "insert" && entry.reason === "expense_create" && entry.actor_user_id === USERS.manager));
    const hiddenAudit = await tx(USERS.accountant, (client) =>
      client.query(`SELECT id FROM audit_log WHERE table_name = 'expenses' AND row_id = $1`, [created.expenseId]),
    );
    assert.equal(hiddenAudit.rows.length, 0);

    const coast = await tx(USERS.coastAdmin, (client) =>
      client.query(`SELECT id FROM expenses WHERE description = $1`, [note]),
    );
    assert.equal(coast.rows.length, 0);

    await updateExpense(accountant, created.expenseId, draftFrom(row, { description: `${note}改` }));
    const edited = await getExpense(admin, created.expenseId);
    assert.equal(edited?.description, `${note}改`);
    const updateAudit = await tx(USERS.admin, (client) =>
      client.query<{ reason: string | null }>(
        `SELECT reason FROM audit_log WHERE table_name = 'expenses' AND row_id = $1 AND action = 'update' AND reason = 'expense_update'`,
        [created.expenseId],
      ),
    );
    assert.ok(updateAudit.rows.length > 0);

    await voidExpense(admin, created.expenseId, voidReason);
    const voided = await getExpense(admin, created.expenseId);
    assert.equal(voided?.status, "void");
    assert.equal(voided?.included, false);
    const afterVoid = await tx(USERS.admin, (client) =>
      client.query(`SELECT id FROM expenses WHERE id = $1 AND ${STATEMENT_EXPENSE_SQL}`, [created.expenseId]),
    );
    assert.equal(afterVoid.rows.length, 0);
    const reversal = await tx(USERS.admin, (client) =>
      client.query(
        `SELECT r.id
           FROM expenses e
           JOIN ledger_transactions r ON r.reverses_transaction_id = e.ledger_transaction_id
          WHERE e.id = $1`,
        [created.expenseId],
      ),
    );
    assert.equal(reversal.rows.length, 1);
    const voidAudit = await tx(USERS.admin, (client) =>
      client.query(
        `SELECT reason FROM audit_log WHERE table_name = 'expenses' AND row_id = $1 AND reason = $2`,
        [created.expenseId, voidReason],
      ),
    );
    assert.equal(voidAudit.rows.length > 0, true);
    await assert.rejects(
      () => voidExpense(admin, created.expenseId, "again"),
      (error: unknown) => error instanceof FlowError && error.key === "errors.expenseVoid",
    );

    const bare = await createExpense(admin, {
      propertyId: place.id,
      category: "repair",
      amountMajor: 20,
      incurredOn: "2099-07-01",
      description: `無收據${stamp}`,
    });
    const bareRow = await getExpense(admin, bare.expenseId);
    assert.equal(bareRow?.receipt_name ?? null, null);
    assert.equal(bareRow?.vendor_name ?? null, null);
    assert.equal(bareRow?.included, true);

    const draft = await tx(USERS.admin, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO expenses (
           org_id, property_id, category, description, currency, amount_minor, incurred_on, paid_by, bill_to, status, created_by
         ) VALUES ($1,$2,'tax',$3,'TWD',100,'2099-08-01','manager_firm','owner','draft',$4)
         RETURNING id::text`,
        [ORG_ID, place.id, draftNote, USERS.admin],
      );
      return inserted.rows[0].id;
    });
    const draftCount = async (status: string) => {
      await tx(USERS.admin, (client) => client.query(`UPDATE expenses SET status = $2::expense_status WHERE id = $1`, [draft, status]));
      const found = await tx(USERS.admin, (client) =>
        client.query(`SELECT id FROM expenses WHERE id = $1 AND ${STATEMENT_EXPENSE_SQL}`, [draft]),
      );
      return found.rows.length;
    };
    assert.equal(await draftCount("draft"), 0);
    assert.equal(await draftCount("submitted"), 0);
    assert.equal(await draftCount("rejected"), 0);
    assert.equal(await draftCount("approved"), 1);
    assert.equal(await draftCount("posted"), 1);
    assert.equal(await draftCount("void"), 0);

    await svc(null, async (client) => {
      await client.query(
        `INSERT INTO month_closes (org_id, period_month, closed_by) VALUES ($1, '2020-01-01', $2)
         ON CONFLICT (org_id, period_month) DO NOTHING`,
        [ORG_ID, USERS.admin],
      );
      await client.query(
        `INSERT INTO expenses (
           org_id, property_id, category, description, currency, amount_minor, incurred_on, paid_by, bill_to, status, created_by
         ) VALUES ($1,$2,'repair',$3,'TWD',100,'2020-01-15','manager_firm','owner','posted',$4)`,
        [ORG_ID, place.id, `closed-${stamp}`, USERS.admin],
      );
    });
    await assert.rejects(
      () =>
        createExpense(admin, {
          propertyId: place.id,
          category: "repair",
          amountMajor: 30,
          incurredOn: "2020-01-20",
          description: `closed-new-${stamp}`,
        }),
      (error: unknown) => error instanceof FlowError && error.key === "errors.monthClosed",
    );
    const closedRow = await tx(USERS.admin, async (client) => {
      const found = await client.query<{ id: string }>(
        `SELECT id::text FROM expenses WHERE org_id = $1 AND description = $2`,
        [ORG_ID, `closed-${stamp}`],
      );
      return found.rows[0].id;
    });
    await assert.rejects(
      () => voidExpense(admin, closedRow, "too late"),
      (error: unknown) => error instanceof FlowError && error.key === "errors.monthClosed",
    );
    const stillOpen = await createExpense(admin, {
      propertyId: place.id,
      category: "other",
      amountMajor: 40,
      incurredOn: "2099-09-01",
      description: `open-${stamp}`,
    });
    assert.ok(stillOpen.expenseId);

    const linked = await tx(USERS.admin, async (client) => {
      const found = await client.query<{ id: string }>(
        `SELECT id::text FROM expenses WHERE org_id = $1 AND description = '冷氣維修' AND status = 'approved' LIMIT 1`,
        [ORG_ID],
      );
      return found.rows[0]?.id;
    });
    if (!linked) throw new Error("seeded 冷氣維修");
    linkedId = linked;
    const linkedRow = await getExpense(admin, linked);
    assert.ok(linkedRow);
    assert.equal(linkedRow.included, true);
    assert.equal(linkedRow.on_issued, true);
    linkedNote = linkedRow.description;
    await updateExpense(manager, linked, draftFrom(linkedRow, { description: "冷氣維修備註" }));
    const renamed = await getExpense(admin, linked);
    assert.equal(renamed?.description, "冷氣維修備註");
    assert.equal(renamed?.amount_minor, linkedRow.amount_minor);
    await assert.rejects(
      () => updateExpense(admin, linked, draftFrom(renamed!, { amountMajor: Number(linkedRow.amount_minor) / 100 + 1 })),
      (error: unknown) => error instanceof FlowError && error.key === "errors.expenseLocked",
    );
  } finally {
    if (linkedId && linkedNote) {
      const current = await getExpense(admin, linkedId);
      if (current && current.description !== linkedNote) {
        await updateExpense(admin, linkedId, draftFrom(current, { description: linkedNote }));
      }
    }
    await svc(null, async (client) => {
      await client.query(`DELETE FROM month_closes WHERE org_id = $1 AND period_month = '2020-01-01'`, [ORG_ID]);
      await client.query(`DELETE FROM expenses WHERE org_id = $1 AND description = $2`, [ORG_ID, draftNote]);
      await client.query(`DELETE FROM expenses WHERE org_id = $1 AND description = $2`, [ORG_ID, `closed-${stamp}`]);
    });
  }
});
