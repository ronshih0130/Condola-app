import assert from "node:assert/strict";
import test from "node:test";
import { query, tx, withClient } from "./db";
import { createProperty, generateStatement, importBankCsv, recordPayment } from "./domain";
import { FlowError } from "./errors";
import { ORG2_ID, ORG_ID, USERS } from "./ids";
import { createLeaseFromForm } from "./lease-form";
import { taipeiToday } from "./money";
import type { Session } from "./types";
import { allocateUtilityMinor, spreadCommonMilli, utilityLineDescription } from "./utility-post";
import { confirmUtilityRun, currentUtilityPeriod, prepareUtilityRun, voidUtilityRun } from "./utility-posting";

const admin: Session = {
  userId: USERS.admin,
  sessionId: "utility-post",
  email: "yating.lin@songxin.demo",
  name: "Admin",
  kind: "staff",
  role: "admin",
  orgId: ORG_ID,
  liveOrgId: ORG_ID,
  environment: "live",
  locale: "zh-TW",
  calendar: "gregorian",
  leaseId: null,
};

const accountant: Session = { ...admin, userId: USERS.accountant, role: "accountant", email: "meiling.zhou@songxin.demo" };

const coast: Session = {
  ...admin,
  userId: USERS.coastAdmin,
  email: "coast.admin@coast.demo",
  name: "Coast",
  orgId: ORG2_ID,
  liveOrgId: ORG2_ID,
};

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

test("a confirmed 電費 run posts, reposts, voids, and stays inside the firm", async () => {
  const stamp = Date.now().toString(36);
  const period = currentUtilityPeriod();
  const propertyIds: string[] = [];
  const userIds: string[] = [];
  let importId: string | null = null;
  try {
    const created = await createProperty(admin, {
      name: `電費物件 ${stamp}`,
      city: "台北市",
      district: "信義區",
      street: `測試路${stamp}`,
      currency: "TWD",
      ownerMode: "new",
      ownerName: "測試屋主",
      ownerPhone: "0912000111",
      ownerEmail: `owner.util.${stamp}@example.com`,
      canViewTenantPhone: false,
      unitLabel: "3F",
      floor: "3",
      rentalMode: "by_room",
      rooms: [
        { label: "A", roomType: "suite", baseRentMajor: 10000 },
        { label: "B", roomType: "suite", baseRentMajor: 8000 },
      ],
    });
    propertyIds.push(created.propertyId);
    assert.equal(created.roomIds.length, 2);
    const [roomA, roomB] = created.roomIds;

    const leaseFields = {
      tenantPhone: "0912345678",
      tenantEmail: "",
      lineUserId: "",
      startDate: period.start,
      months: "12",
      rent: "10000",
      depositMonths: "2",
      depositReason: "",
      dueDay: "5",
      splitMethod: "even",
      billTotal: "",
      usage: "",
      rate: "",
      overrideReason: "",
    };
    const leaseA = await createLeaseFromForm(
      admin,
      form({ ...leaseFields, roomId: roomA, tenantName: "甲租客", tenantEmail: `a.util.${stamp}@example.com`, rent: "10000" }),
    );
    const leaseB = await createLeaseFromForm(
      admin,
      form({ ...leaseFields, roomId: roomB, tenantName: "乙租客", tenantEmail: `b.util.${stamp}@example.com`, rent: "8000" }),
    );
    userIds.push(leaseA.tenantUserId, leaseB.tenantUserId);

    const parties = await query<{ lease_id: string; contact_id: string; property_id: string }>(
      `SELECT l.id::text AS lease_id, lp.contact_id::text, l.property_id::text
         FROM leases l JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
        WHERE l.id = ANY($1::uuid[])`,
      [[leaseA.leaseId, leaseB.leaseId]],
    );
    for (const [index, party] of parties.rows.entries()) {
      const rent = party.lease_id === leaseA.leaseId ? 1_000_000 : 800_000;
      await query(
        `INSERT INTO invoices (
           org_id, property_id, lease_id, bill_to_contact_id, invoice_number, currency,
           issue_date, due_date, period_start, period_end, status, source, created_by
         ) VALUES ($1,$2,$3,$4,$5,'TWD',$6::date,$7::date,$6::date,$7::date,'open','recurring',$8)`,
        [ORG_ID, party.property_id, party.lease_id, party.contact_id, `INV-U-${stamp}-${index}`, period.start, period.end, USERS.admin],
      );
      const invoice = await query<{ id: string }>(
        `SELECT id::text FROM invoices WHERE invoice_number = $1`,
        [`INV-U-${stamp}-${index}`],
      );
      await query(
        `INSERT INTO invoice_lines (org_id, invoice_id, line_no, charge_type, description, quantity, unit_amount_minor, amount_minor)
         VALUES ($1,$2,1,'rent','rent',1,$3::numeric,$3::bigint)`,
        [ORG_ID, invoice.rows[0].id, rent],
      );
    }

    await query(`UPDATE rooms SET electricity_method = 'tenant_direct', rate_per_kwh = 4 WHERE id = ANY($1::uuid[])`, [
      [roomA, roomB],
    ]);
    const input = {
      unitId: (await query<{ id: string }>(`SELECT unit_id::text AS id FROM rooms WHERE id = $1`, [roomA])).rows[0].id,
      periodStart: period.start,
      periodEnd: period.end,
      rateMajor: 4,
      totalKwh: null as number | null,
      billTotalMajor: null as number | null,
      overrideReason: "",
      readings: [
        { spaceId: roomA, kwh: 100 },
        { spaceId: roomB, kwh: 50 },
      ],
    };
    await assert.rejects(
      () => prepareUtilityRun(admin, input),
      (error: unknown) => error instanceof FlowError && error.key === "errors.utilityMethod",
    );
    await query(`UPDATE rooms SET electricity_method = 'submeter' WHERE id = $1`, [roomA]);
    await query(`UPDATE rooms SET electricity_method = 'shared' WHERE id = $1`, [roomB]);
    const mixed = await prepareUtilityRun(admin, input);
    const mixedLines = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM utility_allocation_lines WHERE run_id = $1`,
      [mixed.runId],
    );
    assert.equal(mixedLines.rows[0].n, "1");
    await voidUtilityRun(admin, mixed.runId, "共同電表不入帳");

    await query(`UPDATE rooms SET electricity_method = 'submeter' WHERE id = ANY($1::uuid[])`, [[roomA, roomB]]);
    await assert.rejects(
      () => prepareUtilityRun(admin, { ...input, readings: input.readings.map((row) => ({ ...row, kwh: 0 })) }),
      (error: unknown) => error instanceof FlowError && error.key === "errors.amount",
    );

    const spread = spreadCommonMilli(
      [
        { key: roomA, kwhMilli: 100000 },
        { key: roomB, kwhMilli: 50000 },
      ],
      151000,
    );
    assert.ok(spread);
    const expected = allocateUtilityMinor({ currency: "TWD", rateMajor: 4, mode: "split", parts: spread });
    const prepared = await prepareUtilityRun(admin, { ...input, totalKwh: 151 });
    const posted = await confirmUtilityRun(admin, prepared.runId);
    assert.equal(posted.changed, 2);
    assert.equal(posted.reversed, 0);

    const lines = await query<{
      lease_id: string;
      amount: string;
      usage: string;
      description: string;
      invoice_id: string;
      rent_invoice: string;
    }>(
      `SELECT l.lease_id::text, l.amount_minor::text AS amount, l.allocated_usage::text AS usage,
              il.description, il.invoice_id::text, i.invoice_number AS rent_invoice
         FROM utility_allocation_lines l
         JOIN invoice_lines il ON il.id = l.posted_invoice_line_id
         JOIN invoices i ON i.id = il.invoice_id
        WHERE l.run_id = $1
        ORDER BY l.allocated_usage DESC`,
      [prepared.runId],
    );
    assert.equal(lines.rows.length, 2);
    for (const row of lines.rows) {
      const key = row.lease_id === leaseA.leaseId ? roomA : roomB;
      const share = expected.find((item) => item.key === key);
      assert.ok(share);
      assert.equal(Number(row.amount), share.amountMinor);
      assert.equal(share.amountMinor % 100, 0);
      assert.equal(row.description, utilityLineDescription(share.kwhMilli, 4));
      assert.match(row.rent_invoice, /^INV-U-/);
      assert.equal(row.description.startsWith("電費 "), true);
    }
    const invoiceCount = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM invoices WHERE lease_id = ANY($1::uuid[]) AND status <> 'void'`,
      [[leaseA.leaseId, leaseB.leaseId]],
    );
    assert.equal(invoiceCount.rows[0].n, "2");

    const hidden = await tx(
      coast.userId,
      async (client) => {
        const run = await client.query(`SELECT id FROM utility_allocation_runs WHERE id = $1`, [prepared.runId]);
        const charge = await client.query(`SELECT id FROM invoice_lines WHERE description LIKE '電費 %' AND org_id = $1`, [ORG_ID]);
        const updated = await client.query(`UPDATE utility_allocation_runs SET total_usage = total_usage WHERE id = $1`, [prepared.runId]);
        return { runs: run.rowCount, charges: charge.rowCount, updated: updated.rowCount };
      },
      { orgId: ORG2_ID, environment: "live" },
    );
    assert.equal(hidden.runs, 0);
    assert.equal(hidden.charges, 0);
    assert.equal(hidden.updated, 0);
    await assert.rejects(
      () => confirmUtilityRun(coast, prepared.runId),
      (error: unknown) => error instanceof FlowError && (error.key === "errors.notFound" || error.key === "errors.forbidden"),
    );
    await assert.rejects(
      () => confirmUtilityRun(accountant, prepared.runId),
      (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden",
    );

    const ledgerBefore = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ledger_transactions
        WHERE source_table = 'utility_allocation_lines' AND kind = 'invoice'
          AND source_id IN (SELECT id FROM utility_allocation_lines WHERE run_id = $1)`,
      [prepared.runId],
    );
    const again = await confirmUtilityRun(admin, prepared.runId);
    assert.equal(again.changed, 0);
    assert.equal(again.reversed, 0);
    const ledgerAfter = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ledger_transactions
        WHERE source_table = 'utility_allocation_lines' AND kind = 'invoice'
          AND source_id IN (SELECT id FROM utility_allocation_lines WHERE run_id = $1)`,
      [prepared.runId],
    );
    assert.equal(ledgerAfter.rows[0].n, ledgerBefore.rows[0].n);
    const postedEvents = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE event_type = 'utility_charge_posted' AND new_row->>'runId' = $1`,
      [prepared.runId],
    );
    assert.equal(postedEvents.rows[0].n, "1");
    const reason = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE table_name = 'utility_allocation_runs' AND row_id = $1 AND reason = '確認電費入帳'`,
      [prepared.runId],
    );
    assert.equal(Number(reason.rows[0].n) >= 1, true);

    const edited = await prepareUtilityRun(admin, {
      ...input,
      totalKwh: 151,
      readings: [
        { spaceId: roomA, kwh: 90 },
        { spaceId: roomB, kwh: 50 },
      ],
    });
    assert.equal(edited.runId, prepared.runId);
    const reposted = await confirmUtilityRun(admin, prepared.runId);
    assert.equal(reposted.reversed, 2);
    const openLines = await query<{ n: string; total: string }>(
      `SELECT count(*)::text AS n, coalesce(sum(amount_minor),0)::text AS total
         FROM invoice_lines
        WHERE allocation_line_id IN (SELECT id FROM utility_allocation_lines WHERE run_id = $1)`,
      [prepared.runId],
    );
    assert.equal(openLines.rows[0].n, "2");
    const editedExpected = allocateUtilityMinor({
      currency: "TWD",
      rateMajor: 4,
      mode: "split",
      parts: spreadCommonMilli(
        [
          { key: roomA, kwhMilli: 90000 },
          { key: roomB, kwhMilli: 50000 },
        ],
        151000,
      )!,
    });
    assert.equal(
      Number(openLines.rows[0].total),
      editedExpected.reduce((sum, row) => sum + row.amountMinor, 0),
    );
    const reversals = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ledger_transactions
        WHERE kind = 'reversal' AND source_table = 'utility_allocation_lines'
          AND source_id IN (SELECT id FROM utility_allocation_lines WHERE run_id = $1)`,
      [prepared.runId],
    );
    assert.equal(reversals.rows[0].n, "2");
    const repostEvents = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE event_type = 'utility_charge_reposted' AND new_row->>'runId' = $1`,
      [prepared.runId],
    );
    assert.equal(repostEvents.rows[0].n, "1");

    const voided = await voidUtilityRun(admin, prepared.runId, "度數抄錯");
    assert.equal(voided.reversed, 2);
    const afterVoid = await query<{ lines: string; status: string }>(
      `SELECT
         (SELECT count(*) FROM invoice_lines WHERE allocation_line_id IN (SELECT id FROM utility_allocation_lines WHERE run_id = $1))::text AS lines,
         (SELECT status::text FROM utility_allocation_runs WHERE id = $1) AS status`,
      [prepared.runId],
    );
    assert.equal(afterVoid.rows[0].lines, "0");
    assert.equal(afterVoid.rows[0].status, "void");
    const rentLeft = await query<{ n: string; status: string }>(
      `SELECT count(*)::text AS n, min(status::text) AS status
         FROM invoices WHERE invoice_number LIKE $1 AND status <> 'void'`,
      [`INV-U-${stamp}-%`],
    );
    assert.equal(rentLeft.rows[0].n, "2");
    const voidedAgain = await voidUtilityRun(admin, prepared.runId, "度數抄錯");
    assert.equal(voidedAgain.reversed, 0);
    const voidEvents = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE event_type = 'utility_charge_voided' AND new_row->>'runId' = $1`,
      [prepared.runId],
    );
    assert.equal(voidEvents.rows[0].n, "1");

    await query(`UPDATE rooms SET electricity_method = 'by_reading' WHERE id = ANY($1::uuid[])`, [[roomA, roomB]]);
    const reading = await prepareUtilityRun(admin, {
      ...input,
      rateMajor: 1.5,
      totalKwh: null,
      readings: [
        { spaceId: roomA, kwh: 1 },
        { spaceId: roomB, kwh: 1 },
      ],
    });
    assert.notEqual(reading.runId, prepared.runId);
    await confirmUtilityRun(admin, reading.runId);
    const readingLines = await query<{ amount: string; description: string }>(
      `SELECT il.amount_minor::text AS amount, il.description
         FROM invoice_lines il
         JOIN utility_allocation_lines l ON l.posted_invoice_line_id = il.id
        WHERE l.run_id = $1
        ORDER BY il.amount_minor`,
      [reading.runId],
    );
    assert.deepEqual(
      readingLines.rows.map((row) => [Number(row.amount), row.description]),
      [
        [200, "電費 1 度 × 1.5 元"],
        [200, "電費 1 度 × 1.5 元"],
      ],
    );

    const paid = await recordPayment(admin, {
      leaseId: leaseA.leaseId,
      amountMajor: 10002,
      paidOn: taipeiToday(),
      last5: "24680",
      reference: `elec-${stamp}`,
    });
    const statement = await generateStatement(admin, { ownerContactId: created.ownerContactId, month: period.start.slice(0, 7) });
    const statementLine = await query<{ amount: string; description: string }>(
      `SELECT amount_minor::text AS amount, description
         FROM owner_statement_lines
        WHERE statement_id = $1 AND description = '電費'`,
      [statement.statementId],
    );
    assert.equal(statementLine.rows.length, 1);
    assert.equal(statementLine.rows[0].amount, "200");

    const csv = `date,amount,last5,memo\n${taipeiToday()},10002,24680,電費${stamp}`;
    const imported = await importBankCsv(admin, csv);
    importId = imported.importId;
    const match = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM bank_match_suggestions WHERE payment_id = $1`,
      [paid.paymentId],
    );
    assert.equal(Number(match.rows[0].n) >= 1, true);
  } finally {
    await withClient(async (client) => {
      await client.query(`ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_entries_append_only`);
      await client.query(`ALTER TABLE ledger_transactions DISABLE TRIGGER trg_ledger_transactions_append_only`);
      await client.query(`ALTER TABLE audit_log DISABLE TRIGGER trg_audit_log_append_only`);
      await client.query(`ALTER TABLE lease_signature_events DISABLE TRIGGER trg_lease_signature_events_append_only`);
      try {
        if (importId) {
          await client.query(`DELETE FROM bank_match_suggestions WHERE bank_transaction_id IN (SELECT id FROM bank_transactions WHERE import_id = $1)`, [importId]);
          await client.query(`DELETE FROM bank_transactions WHERE import_id = $1`, [importId]);
          const file = await client.query<{ file_id: string }>(`SELECT file_id::text FROM bank_statement_imports WHERE id = $1`, [importId]);
          await client.query(`DELETE FROM bank_statement_imports WHERE id = $1`, [importId]);
          if (file.rows[0]) await client.query(`DELETE FROM files WHERE id = $1`, [file.rows[0].file_id]);
        }
        for (const propertyId of propertyIds) {
          await client.query(
            `UPDATE utility_allocation_lines
                SET posted_invoice_id = NULL, posted_invoice_line_id = NULL, posted_ledger_transaction_id = NULL,
                    posted_amount_minor = NULL, posted_description = NULL
              WHERE lease_id IN (SELECT id FROM leases WHERE property_id = $1)`,
            [propertyId],
          );
          await client.query(
            `UPDATE invoice_lines SET allocation_line_id = NULL
              WHERE invoice_id IN (SELECT id FROM invoices WHERE property_id = $1)`,
            [propertyId],
          );
          await client.query(`DELETE FROM payment_allocations WHERE invoice_id IN (SELECT id FROM invoices WHERE property_id = $1)`, [propertyId]);
          await client.query(`UPDATE payments SET ledger_transaction_id = NULL WHERE property_id = $1`, [propertyId]);
          await client.query(`DELETE FROM bank_match_suggestions WHERE payment_id IN (SELECT id FROM payments WHERE property_id = $1)`, [propertyId]);
          await client.query(`DELETE FROM payments WHERE property_id = $1`, [propertyId]);
          await client.query(`UPDATE invoices SET ledger_transaction_id = NULL WHERE property_id = $1`, [propertyId]);
          await client.query(
            `DELETE FROM ledger_entries
              WHERE property_id = $1
                 OR invoice_id IN (SELECT id FROM invoices WHERE property_id = $1)
                 OR transaction_id IN (SELECT id FROM ledger_transactions WHERE property_id = $1)`,
            [propertyId],
          );
          await client.query(`DELETE FROM ledger_transactions WHERE property_id = $1 AND kind = 'reversal'`, [propertyId]);
          await client.query(`DELETE FROM ledger_transactions WHERE property_id = $1`, [propertyId]);
          await client.query(`DELETE FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoices WHERE property_id = $1)`, [propertyId]);
          await client.query(`DELETE FROM invoices WHERE property_id = $1`, [propertyId]);
          await client.query(`DELETE FROM owner_statement_lines WHERE property_id = $1`, [propertyId]);
          await client.query(
            `DELETE FROM owner_statements WHERE owner_contact_id IN (SELECT owner_contact_id FROM property_owners WHERE property_id = $1)`,
            [propertyId],
          );
          await client.query(`DELETE FROM deliveries WHERE notification_id IN (SELECT id FROM notifications WHERE lease_id IN (SELECT id FROM leases WHERE property_id = $1))`, [propertyId]);
          await client.query(`DELETE FROM notifications WHERE lease_id IN (SELECT id FROM leases WHERE property_id = $1)`, [propertyId]);
          await client.query(`DELETE FROM utility_allocation_lines WHERE lease_id IN (SELECT id FROM leases WHERE property_id = $1)`, [propertyId]);
          await client.query(
            `DELETE FROM utility_allocation_runs WHERE meter_id IN (SELECT id FROM meters WHERE property_id = $1)`,
            [propertyId],
          );
          await client.query(`DELETE FROM utility_bills WHERE meter_id IN (SELECT id FROM meters WHERE property_id = $1)`, [propertyId]);
          await client.query(`DELETE FROM meters WHERE property_id = $1`, [propertyId]);
          await client.query(`DELETE FROM lease_signature_events WHERE signature_id IN (SELECT id FROM lease_signatures WHERE lease_id IN (SELECT id FROM leases WHERE property_id = $1))`, [propertyId]);
          await client.query(`DELETE FROM lease_signatures WHERE lease_id IN (SELECT id FROM leases WHERE property_id = $1)`, [propertyId]);
          await client.query(`DELETE FROM lease_parties WHERE lease_id IN (SELECT id FROM leases WHERE property_id = $1)`, [propertyId]);
          await client.query(`DELETE FROM leases WHERE property_id = $1`, [propertyId]);
          await client.query(`DELETE FROM management_agreements WHERE property_id = $1`, [propertyId]);
          await client.query(`DELETE FROM property_owners WHERE property_id = $1`, [propertyId]);
          await client.query(`DELETE FROM rooms WHERE unit_id IN (SELECT id FROM units WHERE property_id = $1)`, [propertyId]);
          await client.query(`DELETE FROM units WHERE property_id = $1`, [propertyId]);
          await client.query(`DELETE FROM properties WHERE id = $1`, [propertyId]);
        }
        if (userIds.length) {
          await client.query(`DELETE FROM contacts WHERE user_id = ANY($1::uuid[])`, [userIds]);
          await client.query(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [userIds]);
        }
        await client.query(`DELETE FROM invitations WHERE lower(email) LIKE $1`, [`%${stamp}@example.com`]);
        await client.query(`DELETE FROM contacts WHERE lower(email::text) LIKE $1`, [`%${stamp}@example.com`]);
        await client.query(`DELETE FROM auth.users WHERE lower(email) LIKE $1`, [`%${stamp}@example.com`]);
      } finally {
        await client.query(`ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_entries_append_only`);
        await client.query(`ALTER TABLE ledger_transactions ENABLE TRIGGER trg_ledger_transactions_append_only`);
        await client.query(`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_log_append_only`);
        await client.query(`ALTER TABLE lease_signature_events ENABLE TRIGGER trg_lease_signature_events_append_only`);
      }
    });
  }
});
