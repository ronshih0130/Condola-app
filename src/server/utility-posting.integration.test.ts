import assert from "node:assert/strict";
import test from "node:test";
import { query, tx, withClient } from "./db";
import { createProperty, generateStatement, importBankCsv, recordPayment, signLease, simulateTenantSignature } from "./domain";
import { FlowError } from "./errors";
import { ORG2_ID, ORG_ID, USERS } from "./ids";
import { createLeaseFromForm } from "./lease-form";
import { nextInvoiceNumber } from "./invoice-number";
import { addDays, monthBounds, taipeiToday } from "./money";
import type { Session } from "./types";
import { allocateUtilityMinor, meterUsageKwh, spreadCommonMilli, utilityLineDescription } from "./utility-post";
import { BILL_GAP_DESCRIPTION, PUBLIC_ELECTRICITY_DESCRIPTION, VACANT_ELECTRICITY_DESCRIPTION } from "./utility-expense";
import { confirmUtilityRun, currentUtilityPeriod, listUtilityBoard, prepareUtilityRun, utilityRunDetail, voidUtilityRun } from "./utility-posting";

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

async function markLeaseIdReady(leaseId: string) {
  const party = await query<{ org_id: string; contact_id: string }>(
    `SELECT l.org_id::text, lp.contact_id::text
       FROM leases l
       JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
      WHERE l.id = $1`,
    [leaseId],
  );
  const orgId = party.rows[0]?.org_id ?? "";
  const contactId = party.rows[0]?.contact_id ?? "";
  const doc = await query<{ id: string }>(
    `INSERT INTO identity_documents (
       org_id, contact_id, lease_id, doc_type, number_masked, storage_path, encryption_key_ref,
       review_status, created_by
     ) VALUES ($1,$2,$3,'passport','A**789',$4,'env:ID_DOC_ENCRYPTION_KEY','pending_review',$5)
     RETURNING id::text`,
    [orgId, contactId, leaseId, `${orgId}/${leaseId}/doc`, USERS.admin],
  );
  for (const slot of ["front", "selfie"]) {
    await query(
      `INSERT INTO identity_document_photos (
         org_id, document_id, slot, storage_path, mime_type, size_bytes, sha256
       ) VALUES ($1,$2,$3,$4,'image/jpeg',4,'abc')`,
      [orgId, doc.rows[0]?.id, slot, `${orgId}/${leaseId}/${slot}`],
    );
  }
}

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
    await activateLease(leaseA.leaseId);
    await activateLease(leaseB.leaseId);

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
    await voidUtilityRun(admin, mixed.runId, "共同電表不登記");

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
    const expected = allocateUtilityMinor({
      currency: "TWD",
      rateMajor: 4,
      mode: "each",
      parts: [
        { key: roomA, kwhMilli: 100000 },
        { key: roomB, kwhMilli: 50000 },
      ],
    });
    const prepared = await prepareUtilityRun(admin, { ...input, totalKwh: 151 });
    await query(`UPDATE utility_allocation_runs SET inputs = jsonb_set(inputs, '{readings}', '[]'::jsonb) WHERE id = $1`, [
      prepared.runId,
    ]);
    await assert.rejects(
      () => confirmUtilityRun(admin, prepared.runId),
      (error: unknown) => error instanceof FlowError && error.key === "errors.amount",
    );
    const repaired = await prepareUtilityRun(admin, { ...input, totalKwh: 151 });
    assert.equal(repaired.runId, prepared.runId);
    const posted = await confirmUtilityRun(admin, prepared.runId);
    assert.equal(posted.changed, 3);
    assert.equal(posted.reversed, 0);
    await withClient(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query(`DROP INDEX utility_allocation_runs_open_period_uidx`);
        await client.query(`ALTER TABLE utility_allocation_runs DROP CONSTRAINT utility_allocation_runs_unit_period_excl`);
        await client.query(
          `INSERT INTO utility_allocation_runs (
             org_id, unit_id, meter_id, utility_bill_id, period_start, period_end, split_method, rate_source, currency,
             total_usage, common_area_usage, common_area_policy, rate_minor_per_unit, total_amount_minor,
             inputs, algorithm_version, status, computed_by, approved_by, approved_at
           )
           SELECT org_id, unit_id, meter_id, utility_bill_id, period_start, period_end, split_method, rate_source, currency,
                  total_usage, common_area_usage, common_area_policy, rate_minor_per_unit, total_amount_minor,
                  inputs, algorithm_version, status, computed_by, approved_by, approved_at
             FROM utility_allocation_runs WHERE id = $1`,
          [prepared.runId],
        );
        let raised = false;
        await client.query("SAVEPOINT posted_dupes");
        try {
          await client.query(`DO $$
            BEGIN
              IF EXISTS (
                SELECT 1 FROM utility_allocation_runs
                 WHERE status IN ('approved', 'posted')
                 GROUP BY meter_id, period_start, period_end
                HAVING count(*) > 1
              ) THEN
                RAISE EXCEPTION 'cannot merge allocation runs: a meter period has more than one approved or posted run'
                  USING ERRCODE = 'unique_violation';
              END IF;
            END $$`);
        } catch (error) {
          raised = true;
          await client.query("ROLLBACK TO SAVEPOINT posted_dupes");
          const message = error instanceof Error ? error.message : String(error);
          assert.match(message, /cannot merge allocation runs/);
        }
        assert.equal(raised, true);
        const stillPosted = await client.query(
          `SELECT count(*)::text AS n FROM utility_allocation_runs
            WHERE meter_id = (SELECT meter_id FROM utility_allocation_runs WHERE id = $1)
              AND status = 'posted'`,
          [prepared.runId],
        );
        assert.equal(stillPosted.rows[0]?.n, "2");
      } finally {
        await client.query("ROLLBACK");
      }
    });
    const postedOn = await query<{ effective_date: string }>(
      `SELECT effective_date::text FROM ledger_transactions
        WHERE source_table = 'utility_allocation_lines' AND kind = 'invoice'
          AND source_id IN (SELECT id FROM utility_allocation_lines WHERE run_id = $1)`,
      [prepared.runId],
    );
    assert.ok(postedOn.rows.length > 0);
    assert.ok(postedOn.rows.every((row) => row.effective_date === taipeiToday()));

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
    await assert.rejects(
      () =>
        tx(
          admin.userId,
          (client) =>
            client.query(`SELECT app.audit_event($1::uuid, 'utility_charge_posted', $2::jsonb)`, [
              ORG_ID,
              JSON.stringify({ runId: prepared.runId, lines: 2, reversed: 0 }),
            ]),
          { orgId: ORG_ID, environment: "live" },
        ),
      (error: unknown) => error instanceof FlowError,
    );
    assert.equal(
      (
        await query<{ n: string }>(
          `SELECT count(*)::text AS n FROM audit_log WHERE event_type = 'utility_charge_posted' AND new_row->>'runId' = $1`,
          [prepared.runId],
        )
      ).rows[0]?.n,
      "1",
    );
    const reason = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE table_name = 'utility_allocation_runs' AND row_id = $1 AND reason = '確認登記電費'`,
      [prepared.runId],
    );
    assert.equal(Number(reason.rows[0].n) >= 1, true);

    const postedLines = await query<{ id: string; line: string; amount: string }>(
      `SELECT id::text, posted_invoice_line_id::text AS line, posted_amount_minor::text AS amount
         FROM utility_allocation_lines WHERE run_id = $1 ORDER BY id`,
      [prepared.runId],
    );
    await assert.rejects(
      () => prepareUtilityRun(admin, { ...input, totalKwh: 151, readings: [{ spaceId: roomA, kwh: 90 }] }),
      (error: unknown) => error instanceof FlowError && error.key === "errors.amount",
    );
    const postedLinesAfterGap = await query<{ id: string; line: string; amount: string }>(
      `SELECT id::text, posted_invoice_line_id::text AS line, posted_amount_minor::text AS amount
         FROM utility_allocation_lines WHERE run_id = $1 ORDER BY id`,
      [prepared.runId],
    );
    assert.deepEqual(postedLinesAfterGap.rows, postedLines.rows);
    await assert.rejects(
      () =>
        prepareUtilityRun(admin, {
          ...input,
          periodStart: addDays(period.start, 10),
          periodEnd: addDays(period.end, 5),
          totalKwh: 151,
        }),
      (error: unknown) => error instanceof FlowError && error.key === "errors.utilityOverlap",
    );
    await assert.rejects(
      () =>
        prepareUtilityRun(admin, {
          ...input,
          periodStart: period.end,
          periodEnd: addDays(period.end, 30),
          totalKwh: 151,
        }),
      (error: unknown) => error instanceof FlowError && error.key === "errors.utilityOverlap",
    );
    await withClient(async (client) => {
      await client.query("BEGIN");
      try {
        let rejected = false;
        try {
          await client.query(
            `INSERT INTO utility_allocation_runs (
               org_id, unit_id, meter_id, utility_bill_id, period_start, period_end, split_method, rate_source, currency,
               total_usage, common_area_usage, common_area_policy, rate_minor_per_unit, total_amount_minor,
               inputs, algorithm_version, status, computed_by
             )
             SELECT org_id, unit_id, meter_id, utility_bill_id, $2::date, $3::date, split_method, rate_source, currency,
                    total_usage, common_area_usage, common_area_policy, rate_minor_per_unit, total_amount_minor,
                    inputs, algorithm_version, 'draft', computed_by
               FROM utility_allocation_runs WHERE id = $1`,
            [prepared.runId, period.end, addDays(period.end, 30)],
          );
        } catch (error) {
          rejected = true;
          const message = error instanceof Error ? error.message : String(error);
          assert.match(message, /utility_allocation_runs_unit_period_excl/);
        }
        assert.equal(rejected, true);
      } finally {
        await client.query("ROLLBACK");
      }
    });
    let boardPage = 1;
    let foundUnit = false;
    const seenUnits = new Set<string>();
    for (;;) {
      const board = await listUtilityBoard(admin, period.start, period.end, boardPage, 1);
      const ids = [...new Set(board.spaces.map((space) => space.unit_id))];
      assert.ok(ids.length <= 1);
      if (ids[0]) {
        assert.equal(seenUnits.has(ids[0]), false);
        seenUnits.add(ids[0]);
      }
      if (ids[0] === input.unitId) {
        foundUnit = true;
        assert.equal(board.spaces.length, 2);
        assert.deepEqual(
          board.spaces.map((space) => space.space_id).sort(),
          [roomA, roomB].sort(),
        );
      }
      if (!board.hasMore) break;
      boardPage += 1;
      assert.ok(boardPage < 40);
    }
    assert.equal(foundUnit, true);

    const edited = await prepareUtilityRun(admin, {
      ...input,
      totalKwh: 151,
      readings: [
        { spaceId: roomA, kwh: 90 },
        { spaceId: roomB, kwh: 40 },
      ],
    });
    assert.equal(edited.runId, prepared.runId);
    const stillPosted = await query<{ status: string }>(
      `SELECT status::text FROM utility_allocation_runs WHERE id = $1`,
      [prepared.runId],
    );
    assert.equal(stillPosted.rows[0]?.status, "pending_repost");
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
      mode: "each",
      parts: [
        { key: roomA, kwhMilli: 90000 },
        { key: roomB, kwhMilli: 40000 },
      ],
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
    await assert.rejects(
      () =>
        tx(
          admin.userId,
          (client) =>
            client.query(`SELECT app.audit_event($1::uuid, 'utility_charge_reposted', $2::jsonb)`, [
              ORG_ID,
              JSON.stringify({ runId: prepared.runId, lines: 2, reversed: 2 }),
            ]),
          { orgId: ORG_ID, environment: "live" },
        ),
      (error: unknown) => error instanceof FlowError,
    );
    await tx(
      admin.userId,
      async (client) => {
        await client.query(`UPDATE utility_allocation_runs SET computed_at = now() WHERE id = $1`, [prepared.runId]);
        await client.query(`SELECT app.audit_event($1::uuid, 'utility_charge_reposted', $2::jsonb)`, [
          ORG_ID,
          JSON.stringify({ runId: prepared.runId, lines: 2, reversed: 2 }),
        ]);
      },
      { orgId: ORG_ID, environment: "live" },
    );
    await assert.rejects(
      () =>
        tx(
          admin.userId,
          (client) =>
            client.query(`SELECT app.audit_event($1::uuid, 'utility_charge_reposted', $2::jsonb)`, [
              ORG_ID,
              JSON.stringify({ runId: prepared.runId, lines: 2, reversed: 2 }),
            ]),
          { orgId: ORG_ID, environment: "live" },
        ),
      (error: unknown) => error instanceof FlowError,
    );
    assert.equal(
      (
        await query<{ n: string }>(
          `SELECT count(*)::text AS n FROM audit_log WHERE event_type = 'utility_charge_reposted' AND new_row->>'runId' = $1`,
          [prepared.runId],
        )
      ).rows[0]?.n,
      "2",
    );
    const credits = await query<{ n: string; total: string }>(
      `SELECT count(*)::text AS n, coalesce(sum(amount_minor), 0)::text AS total
         FROM invoice_lines
        WHERE charge_type = 'credit' AND description LIKE '沖銷電費%'
          AND invoice_id IN (SELECT id FROM invoices WHERE lease_id = ANY($1::uuid[]))`,
      [[leaseA.leaseId, leaseB.leaseId]],
    );
    assert.equal(credits.rows[0]?.n, "2");
    assert.equal(Number(credits.rows[0]?.total), -expected.reduce((sum, row) => sum + row.amountMinor, 0));
    const keptUtility = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM invoice_lines
        WHERE charge_type = 'utility' AND description LIKE '電費%'
          AND invoice_id IN (SELECT id FROM invoices WHERE lease_id = ANY($1::uuid[]))`,
      [[leaseA.leaseId, leaseB.leaseId]],
    );
    assert.equal(keptUtility.rows[0]?.n, "4");

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
    const dangling = await query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM invoices i
         JOIN ledger_transactions t ON t.id = i.ledger_transaction_id
        WHERE i.lease_id = ANY($1::uuid[])
          AND EXISTS (SELECT 1 FROM ledger_transactions rev WHERE rev.reverses_transaction_id = t.id)`,
      [[leaseA.leaseId, leaseB.leaseId]],
    );
    assert.equal(dangling.rows[0]?.n, "0");

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
    const linked = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM invoices
        WHERE lease_id = $1 AND owner_statement_id = $2`,
      [leaseA.leaseId, statement.statementId],
    );
    assert.equal(Number(linked.rows[0]?.n) >= 1, true);

    const csv = `date,amount,last5,memo\n${taipeiToday()},10002,24680,電費${stamp}`;
    const imported = await importBankCsv(admin, csv);
    importId = imported.importId;
    const match = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM bank_match_suggestions WHERE payment_id = $1`,
      [paid.paymentId],
    );
    assert.equal(Number(match.rows[0].n) >= 1, true);
  } finally {
    await cleanupFixture({ propertyIds, userIds, importId, stamp });
  }
});

async function cleanupFixture(input: { propertyIds: string[]; userIds: string[]; importId: string | null; stamp: string }) {
  const { propertyIds, userIds, importId, stamp } = input;
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
          `DELETE FROM owner_statement_lines
            WHERE property_id = $1
               OR expense_id IN (SELECT id FROM expenses WHERE property_id = $1)`,
          [propertyId],
        );
        await client.query(`UPDATE expenses SET ledger_transaction_id = NULL WHERE property_id = $1`, [propertyId]);
        await client.query(`DELETE FROM expenses WHERE property_id = $1`, [propertyId]);
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
        await client.query(`DELETE FROM owner_statement_lines WHERE property_id = $1 OR statement_id IN (SELECT id FROM owner_statements WHERE owner_contact_id IN (SELECT owner_contact_id FROM property_owners WHERE property_id = $1))`, [propertyId]);
        await client.query(
          `DELETE FROM owner_statements WHERE owner_contact_id IN (SELECT owner_contact_id FROM property_owners WHERE property_id = $1)`,
          [propertyId],
        );
        await client.query(`DELETE FROM deliveries WHERE notification_id IN (SELECT id FROM notifications WHERE lease_id IN (SELECT id FROM leases WHERE property_id = $1))`, [propertyId]);
        await client.query(`DELETE FROM notifications WHERE lease_id IN (SELECT id FROM leases WHERE property_id = $1)`, [propertyId]);
        await client.query(`DELETE FROM utility_allocation_lines WHERE lease_id IN (SELECT id FROM leases WHERE property_id = $1) OR run_id IN (SELECT id FROM utility_allocation_runs WHERE meter_id IN (SELECT id FROM meters WHERE property_id = $1))`, [propertyId]);
        await client.query(`DELETE FROM utility_allocation_runs WHERE meter_id IN (SELECT id FROM meters WHERE property_id = $1)`, [propertyId]);
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

async function activateLease(leaseId: string) {
  await query(
    `UPDATE leases
        SET status = 'active', esign_status = 'fully_signed', signed_at = coalesce(signed_at, now())
      WHERE id = $1`,
    [leaseId],
  );
}

function leaseFields(email: string) {
  const period = currentUtilityPeriod();
  return {
    tenantPhone: "0912345678",
    tenantEmail: email,
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
}

test("concurrent prepares share one meter and one open run", async () => {
  const stamp = `c${Date.now().toString(36)}`;
  const propertyIds: string[] = [];
  const userIds: string[] = [];
  const period = currentUtilityPeriod();
  try {
    const created = await createProperty(admin, {
      name: `並行電費 ${stamp}`,
      city: "台北市",
      district: "信義區",
      street: `並行路${stamp}`,
      currency: "TWD",
      ownerMode: "new",
      ownerName: "並行屋主",
      ownerPhone: "0912000222",
      ownerEmail: `owner.conc.${stamp}@example.com`,
      canViewTenantPhone: false,
      unitLabel: "4F",
      floor: "4",
      rentalMode: "by_room",
      rooms: [{ label: "A", roomType: "suite", baseRentMajor: 10000 }],
    });
    propertyIds.push(created.propertyId);
    const roomA = created.roomIds[0];
    const lease = await createLeaseFromForm(
      admin,
      form({ ...leaseFields(`conc.${stamp}@example.com`), roomId: roomA, tenantName: "並行租客" }),
    );
    userIds.push(lease.tenantUserId);
    await activateLease(lease.leaseId);
    await query(`UPDATE rooms SET electricity_method = 'by_reading', rate_per_kwh = 4 WHERE id = $1`, [roomA]);
    const unitId = (await query<{ id: string }>(`SELECT unit_id::text AS id FROM rooms WHERE id = $1`, [roomA])).rows[0].id;
    const input = {
      unitId,
      periodStart: period.start,
      periodEnd: period.end,
      rateMajor: 4,
      totalKwh: null as number | null,
      billTotalMajor: null as number | null,
      overrideReason: "",
      readings: [{ spaceId: roomA, kwh: 10 }],
    };
    const [first, second] = await Promise.all([prepareUtilityRun(admin, input), prepareUtilityRun(admin, input)]);
    assert.equal(first.runId, second.runId);
    const meters = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM meters
        WHERE unit_id = $1 AND utility = 'electricity' AND room_id IS NULL AND archived_at IS NULL`,
      [unitId],
    );
    const runs = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM utility_allocation_runs
        WHERE meter_id IN (SELECT id FROM meters WHERE unit_id = $1) AND status <> 'void'
          AND period_start = $2::date AND period_end = $3::date`,
      [unitId, period.start, period.end],
    );
    assert.equal(meters.rows[0]?.n, "1");
    assert.equal(runs.rows[0]?.n, "1");
    const [again, more] = await Promise.all([prepareUtilityRun(admin, input), prepareUtilityRun(admin, { ...input, readings: [{ spaceId: roomA, kwh: 12 }] })]);
    assert.equal(again.runId, first.runId);
    assert.equal(more.runId, first.runId);
    assert.equal(
      (await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM meters
          WHERE unit_id = $1 AND utility = 'electricity' AND room_id IS NULL AND archived_at IS NULL`,
        [unitId],
      )).rows[0]?.n,
      "1",
    );

    const [yearText, monthText] = period.start.split("-");
    const nextMonth = Number(monthText) + 1;
    const later = monthBounds(nextMonth === 13 ? `${Number(yearText) + 1}-01` : `${yearText}-${String(nextMonth).padStart(2, "0")}`);
    const party = await query<{ contact_id: string; property_id: string }>(
      `SELECT lp.contact_id::text, l.property_id::text
         FROM leases l JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
        WHERE l.id = $1`,
      [lease.leaseId],
    );
    await query(
      `INSERT INTO invoices (
         org_id, property_id, lease_id, bill_to_contact_id, invoice_number, currency,
         issue_date, due_date, period_start, period_end, status, source, created_by
       ) VALUES ($1,$2,$3,$4,$5,'TWD',$6::date,$7::date,$6::date,$7::date,'open','recurring',$8)`,
      [ORG_ID, party.rows[0].property_id, lease.leaseId, party.rows[0].contact_id, `INV-C-${stamp}`, period.start, later.end, USERS.admin],
    );
    const wide = await prepareUtilityRun(admin, input);
    const nextRun = await prepareUtilityRun(admin, { ...input, periodStart: later.start, periodEnd: later.end, readings: [{ spaceId: roomA, kwh: 8 }] });
    assert.notEqual(wide.runId, nextRun.runId);
    const [left, right] = await Promise.all([confirmUtilityRun(admin, wide.runId), confirmUtilityRun(admin, nextRun.runId)]);
    assert.equal(left.changed > 0 && right.changed > 0, true);
    const numbers = await query<{ line_no: number }>(
      `SELECT line_no FROM invoice_lines
        WHERE invoice_id = (SELECT id FROM invoices WHERE invoice_number = $1)
          AND charge_type = 'utility'
        ORDER BY line_no`,
      [`INV-C-${stamp}`],
    );
    assert.equal(numbers.rows.length, 2);
    assert.notEqual(numbers.rows[0]?.line_no, numbers.rows[1]?.line_no);
  } finally {
    await cleanupFixture({ propertyIds, userIds, importId: null, stamp });
  }
});

test("a paid invoice is left alone and the correction is a credit on a new utility invoice", async () => {
  const stamp = `p${Date.now().toString(36)}`;
  const propertyIds: string[] = [];
  const userIds: string[] = [];
  const period = currentUtilityPeriod();
  try {
    const created = await createProperty(admin, {
      name: `已付電費 ${stamp}`,
      city: "台北市",
      district: "信義區",
      street: `已付路${stamp}`,
      currency: "TWD",
      ownerMode: "new",
      ownerName: "已付屋主",
      ownerPhone: "0912000333",
      ownerEmail: `owner.paid.${stamp}@example.com`,
      canViewTenantPhone: false,
      unitLabel: "5F",
      floor: "5",
      rentalMode: "by_room",
      rooms: [{ label: "A", roomType: "suite", baseRentMajor: 10000 }],
    });
    propertyIds.push(created.propertyId);
    const roomA = created.roomIds[0];
    const lease = await createLeaseFromForm(
      admin,
      form({
        tenantName: "已付租客",
        tenantPhone: "0912345678",
        tenantEmail: `paid.${stamp}@example.com`,
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
        roomId: roomA,
      }),
    );
    userIds.push(lease.tenantUserId);
    await activateLease(lease.leaseId);
    await query(`UPDATE rooms SET electricity_method = 'by_reading', rate_per_kwh = 4 WHERE id = $1`, [roomA]);
    const unitId = (await query<{ id: string }>(`SELECT unit_id::text AS id FROM rooms WHERE id = $1`, [roomA])).rows[0].id;
    const party = await query<{ contact_id: string; property_id: string }>(
      `SELECT lp.contact_id::text, l.property_id::text FROM leases l
         JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary' WHERE l.id = $1`,
      [lease.leaseId],
    );
    await query(
      `INSERT INTO invoices (
         org_id, property_id, lease_id, bill_to_contact_id, invoice_number, currency,
         issue_date, due_date, period_start, period_end, status, source, created_by
       ) VALUES ($1,$2,$3,$4,$5,'TWD',$6::date,$7::date,$6::date,$7::date,'open','recurring',$8)`,
      [ORG_ID, party.rows[0].property_id, lease.leaseId, party.rows[0].contact_id, `INV-P-${stamp}`, period.start, period.end, USERS.admin],
    );
    const invoice = await query<{ id: string }>(`SELECT id::text FROM invoices WHERE invoice_number = $1`, [`INV-P-${stamp}`]);
    await query(
      `INSERT INTO invoice_lines (org_id, invoice_id, line_no, charge_type, description, quantity, unit_amount_minor, amount_minor)
       VALUES ($1,$2,1,'rent','rent',1,1000000::numeric,1000000)`,
      [ORG_ID, invoice.rows[0].id],
    );
    const input = {
      unitId,
      periodStart: period.start,
      periodEnd: period.end,
      rateMajor: 4,
      totalKwh: null,
      billTotalMajor: null,
      overrideReason: "",
      readings: [{ spaceId: roomA, kwh: 10 }],
    };
    const prepared = await prepareUtilityRun(admin, input);
    await confirmUtilityRun(admin, prepared.runId);
    const before = await query<{ id: string; amount: string; description: string; charge_type: string }>(
      `SELECT id::text, amount_minor::text AS amount, description, charge_type::text
         FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_no`,
      [invoice.rows[0].id],
    );
    const balance = await query<{ balance: string; total: string }>(
      `SELECT balance_minor::text AS balance, total_minor::text AS total FROM invoices WHERE id = $1`,
      [invoice.rows[0].id],
    );
    await recordPayment(admin, {
      leaseId: lease.leaseId,
      amountMajor: Number(balance.rows[0].balance) / 100,
      paidOn: taipeiToday(),
      last5: "13579",
      reference: `paid-${stamp}`,
    });
    const paid = await query<{ status: string; paid_minor: string; total: string }>(
      `SELECT status::text, paid_minor::text, total_minor::text AS total FROM invoices WHERE id = $1`,
      [invoice.rows[0].id],
    );
    assert.equal(paid.rows[0]?.status, "paid");
    assert.ok(Number(paid.rows[0]?.paid_minor) <= Number(paid.rows[0]?.total));

    const pointerBefore = await query<{ ledger: string | null }>(
      `SELECT ledger_transaction_id::text AS ledger FROM invoices WHERE id = $1`,
      [invoice.rows[0].id],
    );
    assert.ok(pointerBefore.rows[0]?.ledger);
    const edited = await prepareUtilityRun(admin, { ...input, readings: [{ spaceId: roomA, kwh: 20 }] });
    assert.equal(edited.runId, prepared.runId);
    const pending = await query<{ status: string }>(`SELECT status::text FROM utility_allocation_runs WHERE id = $1`, [
      prepared.runId,
    ]);
    assert.equal(pending.rows[0]?.status, "pending_repost");
    await confirmUtilityRun(admin, prepared.runId);
    const pointerAfter = await query<{ ledger: string | null }>(
      `SELECT ledger_transaction_id::text AS ledger FROM invoices WHERE id = $1`,
      [invoice.rows[0].id],
    );
    assert.equal(pointerAfter.rows[0]?.ledger, pointerBefore.rows[0]?.ledger);
    const afterEdit = await query<{ id: string; amount: string; description: string; charge_type: string }>(
      `SELECT id::text, amount_minor::text AS amount, description, charge_type::text
         FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_no`,
      [invoice.rows[0].id],
    );
    assert.deepEqual(afterEdit.rows, before.rows);
    const fresh = await query<{ source: string; invoice_number: string; credit: string; utility: string }>(
      `SELECT i.source, i.invoice_number,
              (SELECT count(*) FROM invoice_lines l WHERE l.invoice_id = i.id AND l.charge_type = 'credit' AND l.amount_minor < 0)::text AS credit,
              (SELECT count(*) FROM invoice_lines l WHERE l.invoice_id = i.id AND l.charge_type = 'utility' AND l.description LIKE '電費%')::text AS utility
         FROM invoices i
        WHERE i.lease_id = $1 AND i.id <> $2 AND i.status <> 'void'
        ORDER BY i.created_at DESC
        LIMIT 1`,
      [lease.leaseId, invoice.rows[0].id],
    );
    assert.equal(fresh.rows[0]?.source, "utility");
    assert.match(fresh.rows[0]?.invoice_number ?? "", /^INV-\d{6}-\d{4}$/);
    assert.equal(fresh.rows[0]?.invoice_number.startsWith("INV-E-"), false);
    const creditLedger = await query<{ id: string; ledger: string }>(
      `SELECT i.id::text, i.ledger_transaction_id::text AS ledger
         FROM invoices i
        WHERE i.lease_id = $1 AND i.id <> $2 AND i.source = 'utility'
        ORDER BY i.created_at DESC
        LIMIT 1`,
      [lease.leaseId, invoice.rows[0].id],
    );
    assert.ok(creditLedger.rows[0]?.ledger);
    const reversalEntries = await query<{ on_credit: string; elsewhere: string; reverses: string }>(
      `SELECT
         (SELECT count(*) FROM ledger_entries e WHERE e.transaction_id = t.id AND e.invoice_id = $2::uuid)::text AS on_credit,
         (SELECT count(*) FROM ledger_entries e WHERE e.transaction_id = t.id AND e.invoice_id IS DISTINCT FROM $2::uuid)::text AS elsewhere,
         t.reverses_transaction_id::text AS reverses
         FROM ledger_transactions t
        WHERE t.id = $1::uuid`,
      [creditLedger.rows[0].ledger, creditLedger.rows[0].id],
    );
    assert.equal(Number(reversalEntries.rows[0]?.on_credit) >= 1, true);
    assert.equal(reversalEntries.rows[0]?.elsewhere, "0");
    assert.equal(reversalEntries.rows[0]?.reverses, pointerBefore.rows[0]?.ledger);
    assert.equal(Number(fresh.rows[0]?.credit) >= 1, true);
    assert.equal(Number(fresh.rows[0]?.utility) >= 1, true);
    const stillPaid = await query<{ paid_minor: string; total: string }>(
      `SELECT paid_minor::text, total_minor::text AS total FROM invoices WHERE id = $1`,
      [invoice.rows[0].id],
    );
    assert.ok(Number(stillPaid.rows[0]?.paid_minor) <= Number(stillPaid.rows[0]?.total));

    const voided = await voidUtilityRun(admin, prepared.runId, "帳單已付款");
    assert.equal(voided.reversed, 1);
    const afterVoid = await query<{ id: string; amount: string; description: string; charge_type: string }>(
      `SELECT id::text, amount_minor::text AS amount, description, charge_type::text
         FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_no`,
      [invoice.rows[0].id],
    );
    assert.deepEqual(afterVoid.rows, before.rows);
    const pointerAfterVoid = await query<{ ledger: string | null }>(
      `SELECT ledger_transaction_id::text AS ledger FROM invoices WHERE id = $1`,
      [invoice.rows[0].id],
    );
    assert.equal(pointerAfterVoid.rows[0]?.ledger, pointerBefore.rows[0]?.ledger);
    const again = await voidUtilityRun(admin, prepared.runId, "帳單已付款");
    assert.equal(again.reversed, 0);
  } finally {
    await cleanupFixture({ propertyIds, userIds, importId: null, stamp });
  }
});

test("a void run with a blank reason fails a validated check and passes after backfill", async () => {
  const stamp = `v${Date.now().toString(36)}`;
  const propertyIds: string[] = [];
  const userIds: string[] = [];
  const period = currentUtilityPeriod();
  let runId = "";
  try {
    const created = await createProperty(admin, {
      name: `作廢遷移 ${stamp}`,
      city: "台北市",
      district: "信義區",
      street: `作廢路${stamp}`,
      currency: "TWD",
      ownerMode: "new",
      ownerName: "作廢屋主",
      ownerPhone: "0912000444",
      ownerEmail: `owner.void.${stamp}@example.com`,
      canViewTenantPhone: false,
      unitLabel: "6F",
      floor: "6",
      rentalMode: "by_room",
      rooms: [{ label: "A", roomType: "suite", baseRentMajor: 10000 }],
    });
    propertyIds.push(created.propertyId);
    const roomA = created.roomIds[0];
    const lease = await createLeaseFromForm(
      admin,
      form({
        tenantName: "作廢租客",
        tenantPhone: "0912345678",
        tenantEmail: `void.${stamp}@example.com`,
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
        roomId: roomA,
      }),
    );
    userIds.push(lease.tenantUserId);
    await query(`UPDATE rooms SET electricity_method = 'by_reading' WHERE id = $1`, [roomA]);
    const unitId = (await query<{ id: string }>(`SELECT unit_id::text AS id FROM rooms WHERE id = $1`, [roomA])).rows[0].id;
    const prepared = await prepareUtilityRun(admin, {
      unitId,
      periodStart: period.start,
      periodEnd: period.end,
      rateMajor: 4,
      totalKwh: null,
      billTotalMajor: null,
      overrideReason: "",
      readings: [{ spaceId: roomA, kwh: 3 }],
    });
    runId = prepared.runId;
    await voidUtilityRun(admin, runId, "先作廢");
    await withClient(async (client) => {
      await client.query("BEGIN");
      try {
        await client.query(`ALTER TABLE utility_allocation_runs DROP CONSTRAINT utility_allocation_runs_void_chk`);
        await client.query(
          `UPDATE utility_allocation_runs SET void_reason = NULL, voided_by = NULL, voided_at = NULL WHERE id = $1`,
          [runId],
        );
        await client.query("SAVEPOINT immediate_void_chk");
        let rejected = false;
        try {
          await client.query(
            `ALTER TABLE utility_allocation_runs ADD CONSTRAINT utility_allocation_runs_void_chk
               CHECK (status <> 'void' OR (nullif(btrim(void_reason), '') IS NOT NULL AND voided_by IS NOT NULL))`,
          );
        } catch (error) {
          rejected = true;
          await client.query("ROLLBACK TO SAVEPOINT immediate_void_chk");
          const message = error instanceof Error ? error.message : String(error);
          assert.match(message, /utility_allocation_runs_void_chk|check/i);
        }
        assert.equal(rejected, true);
        await client.query(
          `UPDATE utility_allocation_runs
              SET void_reason = '既有作廢分攤（遷移補記）',
                  voided_at = coalesce(voided_at, computed_at, now()),
                  voided_by = coalesce(voided_by, approved_by, computed_by, $2)
            WHERE id = $1`,
          [runId, USERS.admin],
        );
        await client.query(
          `ALTER TABLE utility_allocation_runs ADD CONSTRAINT utility_allocation_runs_void_chk
             CHECK (status <> 'void' OR (nullif(btrim(void_reason), '') IS NOT NULL AND voided_by IS NOT NULL))
             NOT VALID`,
        );
        await client.query(`ALTER TABLE utility_allocation_runs VALIDATE CONSTRAINT utility_allocation_runs_void_chk`);
        const row = await client.query<{ void_reason: string; voided_by: string }>(
          `SELECT void_reason, voided_by::text FROM utility_allocation_runs WHERE id = $1`,
          [runId],
        );
        assert.equal(row.rows[0]?.void_reason, "既有作廢分攤（遷移補記）");
        assert.equal(row.rows[0]?.voided_by, USERS.admin);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  } finally {
    await cleanupFixture({ propertyIds, userIds, importId: null, stamp });
  }
});

test("vacant rooms are an owner expense, and the board lists them without a signed lease", async () => {
  const stamp = `vac${Date.now().toString(36)}`;
  const period = currentUtilityPeriod();
  const propertyIds: string[] = [];
  const userIds: string[] = [];
  try {
    const created = await createProperty(admin, {
      name: `空房電費 ${stamp}`,
      city: "桃園市",
      district: "中壢區",
      street: `空房路${stamp}`,
      currency: "TWD",
      ownerMode: "new",
      ownerName: "空房屋主",
      ownerPhone: "0912000555",
      ownerEmail: `owner.vac.${stamp}@example.com`,
      canViewTenantPhone: false,
      unitLabel: "8F",
      floor: "8",
      rentalMode: "by_room",
      rooms: ["A", "B", "C", "D", "E", "F", "G", "H"].map((label) => ({ label, roomType: "suite", baseRentMajor: 8000 })),
    });
    propertyIds.push(created.propertyId);
    assert.equal(created.roomIds.length, 8);
    for (let index = 0; index < 6; index += 1) {
      const label = "ABCDEF"[index];
      const lease = await createLeaseFromForm(
        admin,
        form({
          tenantName: `租客${label}`,
          tenantPhone: "0912345678",
          tenantEmail: `vac.${label}.${stamp}@example.com`,
          lineUserId: "",
          startDate: period.start,
          months: "12",
          rent: "8000",
          depositMonths: "2",
          depositReason: "",
          dueDay: "5",
          splitMethod: "even",
          billTotal: "2000",
          usage: "400",
          rate: "5",
          overrideReason: "",
          roomId: created.roomIds[index],
        }),
      );
      userIds.push(lease.tenantUserId);
    }
    const leaseStatus = await query<{ status: string }>(
      `SELECT status::text FROM leases WHERE property_id = $1`,
      [created.propertyId],
    );
    assert.equal(leaseStatus.rows.length, 6);
    assert.ok(leaseStatus.rows.every((row) => row.status === "pending_signature"));
    const shares = await query<{ label: string; bearer: string; lease_id: string | null; amount: string; usage: string }>(
      `SELECT r.label, l.bearer::text, l.lease_id::text, l.amount_minor::text AS amount, l.allocated_usage::text AS usage
         FROM utility_allocation_lines l
         JOIN rooms r ON r.id = l.room_id
         JOIN utility_allocation_runs run ON run.id = l.run_id
        WHERE run.unit_id = (SELECT unit_id FROM rooms WHERE id = $1) AND run.status <> 'void'
        ORDER BY r.label`,
      [created.roomIds[0]],
    );
    assert.deepEqual(
      shares.rows.map((row) => row.label),
      ["A", "B", "C", "D", "E", "F", "G", "H"],
    );
    for (const row of shares.rows) {
      assert.equal(Number(row.amount), 25000);
      assert.equal(Number(row.usage), 50);
      assert.equal(row.bearer, "owner");
      assert.equal(row.lease_id, null);
    }
    const expense = await query<{ description: string; amount: string; status: string; bill_to: string; category: string }>(
      `SELECT description, amount_minor::text AS amount, status::text, bill_to::text, category
         FROM expenses WHERE property_id = $1 AND status <> 'void'`,
      [created.propertyId],
    );
    assert.equal(expense.rows.length, 1);
    assert.equal(expense.rows[0]?.description, VACANT_ELECTRICITY_DESCRIPTION);
    assert.equal(expense.rows[0]?.amount, "200000");
    assert.equal(expense.rows[0]?.status, "posted");
    assert.equal(expense.rows[0]?.bill_to, "owner");
    assert.equal(expense.rows[0]?.category, "utility");
    const utilityInvoices = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM invoice_lines il
         JOIN invoices i ON i.id = il.invoice_id
        WHERE i.property_id = $1 AND il.charge_type = 'utility'`,
      [created.propertyId],
    );
    assert.equal(utilityInvoices.rows[0]?.n, "0");
    const statement = await generateStatement(admin, {
      ownerContactId: created.ownerContactId,
      month: period.start.slice(0, 7),
    });
    const statementLine = await query<{ description: string; amount: string }>(
      `SELECT description, amount_minor::text AS amount
         FROM owner_statement_lines
        WHERE statement_id = $1 AND line_type = 'expense'`,
      [statement.statementId],
    );
    assert.equal(statementLine.rows.length, 1);
    assert.equal(statementLine.rows[0]?.description, VACANT_ELECTRICITY_DESCRIPTION);
    assert.equal(statementLine.rows[0]?.amount, "200000");

    const meters = await createProperty(admin, {
      name: `度數電費 ${stamp}`,
      city: "桃園市",
      district: "中壢區",
      street: `度數路${stamp}`,
      currency: "TWD",
      ownerMode: "new",
      ownerName: "度數屋主",
      ownerPhone: "0912000666",
      ownerEmail: `owner.read.${stamp}@example.com`,
      canViewTenantPhone: false,
      unitLabel: "9F",
      floor: "9",
      rentalMode: "by_room",
      rooms: [
        { label: "A", roomType: "suite", baseRentMajor: 8000 },
        { label: "B", roomType: "suite", baseRentMajor: 8000 },
      ],
    });
    propertyIds.push(meters.propertyId);
    const [roomA, roomB] = meters.roomIds;
    const occupied = await createLeaseFromForm(
      admin,
      form({
        tenantName: "度數租客",
        tenantPhone: "0912345678",
        tenantEmail: `read.${stamp}@example.com`,
        lineUserId: "",
        startDate: period.start,
        months: "12",
        rent: "8000",
        depositMonths: "2",
        depositReason: "",
        dueDay: "5",
        splitMethod: "even",
        billTotal: "",
        usage: "",
        rate: "",
        overrideReason: "",
        roomId: roomA,
      }),
    );
    userIds.push(occupied.tenantUserId);
    await query(`UPDATE rooms SET electricity_method = 'by_reading', rate_per_kwh = 4 WHERE id = ANY($1::uuid[])`, [[roomA, roomB]]);
    const unitId = (await query<{ id: string }>(`SELECT unit_id::text AS id FROM rooms WHERE id = $1`, [roomA])).rows[0].id;
    const earlier = monthBounds(addDays(period.start, -1).slice(0, 7));
    const before = await listUtilityBoard(admin, earlier.start, earlier.end);
    const beforeRooms = before.spaces.filter((space) => space.unit_id === unitId);
    assert.equal(beforeRooms.length, 2);
    assert.ok(beforeRooms.every((space) => space.lease_id == null));
    const during = await listUtilityBoard(admin, period.start, period.end);
    const duringRooms = during.spaces.filter((space) => space.unit_id === unitId);
    assert.equal(duringRooms.find((space) => space.space_id === roomA)?.lease_id ?? null, null);
    assert.equal(duringRooms.find((space) => space.space_id === roomB)?.lease_id ?? null, null);
    const input = {
      unitId,
      periodStart: period.start,
      periodEnd: period.end,
      rateMajor: 4,
      totalKwh: null,
      billTotalMajor: null,
      overrideReason: "",
      readings: [
        { spaceId: roomA, kwh: meterUsageKwh(1000, 1010), previousKwh: 1000, currentKwh: 1010 },
        { spaceId: roomB, kwh: meterUsageKwh(500, 510), previousKwh: 500, currentKwh: 510 },
      ],
    };
    const prepared = await prepareUtilityRun(admin, input);
    const draftExpense = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM expenses WHERE property_id = $1 AND status <> 'void'`,
      [meters.propertyId],
    );
    assert.equal(draftExpense.rows[0]?.n, "0");
    const detail = await utilityRunDetail(admin, prepared.runId);
    assert.equal(detail?.lines.find((line) => line.room_id === roomA)?.previousKwh, 1000);
    assert.equal(detail?.lines.find((line) => line.room_id === roomA)?.currentKwh, 1010);
    assert.equal(detail?.lines.find((line) => line.room_id === roomB)?.bearer, "owner");
    await confirmUtilityRun(admin, prepared.runId);
    const postedExpense = await query<{ amount: string; description: string }>(
      `SELECT amount_minor::text AS amount, description FROM expenses WHERE property_id = $1 AND status <> 'void'`,
      [meters.propertyId],
    );
    assert.equal(postedExpense.rows.length, 1);
    assert.equal(postedExpense.rows[0]?.amount, "8000");
    assert.equal(postedExpense.rows[0]?.description, VACANT_ELECTRICITY_DESCRIPTION);
    const postedLines = await query<{ label: string; bearer: string; invoice: string | null }>(
      `SELECT r.label, l.bearer::text, l.posted_invoice_id::text AS invoice
         FROM utility_allocation_lines l
         JOIN rooms r ON r.id = l.room_id
        WHERE l.run_id = $1
        ORDER BY r.label`,
      [prepared.runId],
    );
    assert.equal(postedLines.rows.find((row) => row.label === "A")?.bearer, "owner");
    assert.equal(postedLines.rows.find((row) => row.label === "A")?.invoice ?? null, null);
    assert.equal(postedLines.rows.find((row) => row.label === "B")?.bearer, "owner");
    assert.equal(postedLines.rows.find((row) => row.label === "B")?.invoice ?? null, null);
    const reposted = await prepareUtilityRun(admin, {
      ...input,
      readings: [
        input.readings[0],
        { spaceId: roomB, kwh: meterUsageKwh(500, 520), previousKwh: 500, currentKwh: 520 },
      ],
    });
    await confirmUtilityRun(admin, reposted.runId);
    const updated = await query<{ amount: string; n: string }>(
      `SELECT amount_minor::text AS amount, count(*)::text AS n
         FROM expenses WHERE property_id = $1 AND status <> 'void'
        GROUP BY amount_minor`,
      [meters.propertyId],
    );
    assert.equal(updated.rows.length, 1);
    assert.equal(updated.rows[0]?.n, "1");
    assert.equal(updated.rows[0]?.amount, "12000");
    await voidUtilityRun(admin, prepared.runId, "空房電費作廢");
    const voided = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM expenses WHERE property_id = $1 AND status <> 'void'`,
      [meters.propertyId],
    );
    assert.equal(voided.rows[0]?.n, "0");
  } finally {
    await cleanupFixture({ propertyIds, userIds, importId: null, stamp });
  }
});

test("公共用電 and 電費（帳單差額） are separate owner lines, including a negative gap", async () => {
  const stamp = Date.now().toString(36);
  const period = currentUtilityPeriod();
  const propertyIds: string[] = [];
  const userIds: string[] = [];
  try {
    const created = await createProperty(admin, {
      name: `公共電費 ${stamp}`,
      city: "台北市",
      district: "信義區",
      street: `公共路${stamp}`,
      currency: "TWD",
      ownerMode: "new",
      ownerName: "公共屋主",
      ownerPhone: "0912000777",
      ownerEmail: `owner.pub.${stamp}@example.com`,
      canViewTenantPhone: false,
      unitLabel: "2F",
      floor: "2",
      rentalMode: "by_room",
      rooms: [
        { label: "A", roomType: "suite", baseRentMajor: 8000 },
        { label: "B", roomType: "suite", baseRentMajor: 8000 },
      ],
    });
    propertyIds.push(created.propertyId);
    const [roomA, roomB] = created.roomIds;
    const lease = await createLeaseFromForm(
      admin,
      form({
        tenantName: "公共租客",
        tenantPhone: "0912345678",
        tenantEmail: `pub.${stamp}@example.com`,
        lineUserId: "",
        startDate: period.start,
        months: "12",
        rent: "8000",
        depositMonths: "2",
        depositReason: "",
        dueDay: "5",
        splitMethod: "even",
        billTotal: "",
        usage: "",
        rate: "",
        overrideReason: "",
        roomId: roomA,
      }),
    );
    userIds.push(lease.tenantUserId);
    await query(`UPDATE rooms SET electricity_method = 'submeter', rate_per_kwh = 5 WHERE id = ANY($1::uuid[])`, [[roomA, roomB]]);
    const unitId = (await query<{ id: string }>(`SELECT unit_id::text AS id FROM rooms WHERE id = $1`, [roomA])).rows[0].id;
    const input = {
      unitId,
      periodStart: period.start,
      periodEnd: period.end,
      rateMajor: 5,
      totalKwh: 160,
      billTotalMajor: 500,
      overrideReason: "",
      readings: [
        { spaceId: roomA, kwh: 100, previousKwh: 0, currentKwh: 100 },
        { spaceId: roomB, kwh: 50, previousKwh: 0, currentKwh: 50 },
      ],
    };
    const prepared = await prepareUtilityRun(admin, input);
    const detail = await utilityRunDetail(admin, prepared.runId);
    assert.equal(detail?.adjustments.publicKwhMilli, 10000);
    assert.equal(detail?.adjustments.publicAmountMinor, 5000);
    assert.equal(detail?.adjustments.billGapMinor, -30000);
    assert.equal(detail?.adjustments.billGapWarn, true);
    assert.equal(detail?.lines.find((line) => line.room_id === roomB)?.bearer, "owner");
    assert.equal(detail?.lines.find((line) => line.room_id === roomA)?.bearer, "owner");
    assert.equal(detail?.lines.find((line) => line.room_id === roomA)?.amount, "50000");
    await confirmUtilityRun(admin, prepared.runId);
    const expenses = await query<{ description: string; amount: string }>(
      `SELECT description, amount_minor::text AS amount
         FROM expenses WHERE property_id = $1 AND status <> 'void'`,
      [created.propertyId],
    );
    const expenseByDescription = Object.fromEntries(expenses.rows.map((row) => [row.description, row.amount]));
    assert.equal(expenses.rows.length, 3);
    assert.equal(expenseByDescription[PUBLIC_ELECTRICITY_DESCRIPTION], "5000");
    assert.equal(expenseByDescription[VACANT_ELECTRICITY_DESCRIPTION], "75000");
    assert.equal(expenseByDescription[BILL_GAP_DESCRIPTION], "-30000");
    const statement = await generateStatement(admin, {
      ownerContactId: created.ownerContactId,
      month: period.start.slice(0, 7),
    });
    const lines = await query<{ description: string; amount: string }>(
      `SELECT description, amount_minor::text AS amount
         FROM owner_statement_lines
        WHERE statement_id = $1 AND line_type = 'expense'`,
      [statement.statementId],
    );
    const lineByDescription = Object.fromEntries(lines.rows.map((row) => [row.description, row.amount]));
    assert.equal(lines.rows.length, 3);
    assert.equal(lineByDescription[PUBLIC_ELECTRICITY_DESCRIPTION], "5000");
    assert.equal(lineByDescription[VACANT_ELECTRICITY_DESCRIPTION], "75000");
    assert.equal(lineByDescription[BILL_GAP_DESCRIPTION], "-30000");
  } finally {
    await cleanupFixture({ propertyIds, userIds, importId: null, stamp });
  }
});

test("平均分攤 accepts a blank total kWh and the owner expense is visible when confirm returns", async () => {
  const stamp = Date.now().toString(36);
  const period = currentUtilityPeriod();
  const propertyIds: string[] = [];
  try {
    const created = await createProperty(admin, {
      name: `均分 ${stamp}`,
      city: "台北市",
      district: "松山區",
      street: `松德路${stamp}`,
      currency: "TWD",
      ownerMode: "new",
      ownerName: "均分屋主",
      ownerPhone: "0912000777",
      ownerEmail: `even.blank.${stamp}@example.com`,
      canViewTenantPhone: false,
      unitLabel: "3F",
      floor: "3",
      rentalMode: "by_room",
      rooms: [
        { label: "A", roomType: "suite", baseRentMajor: 10000 },
        { label: "B", roomType: "suite", baseRentMajor: 10000 },
        { label: "C", roomType: "suite", baseRentMajor: 10000 },
      ],
      electric: { split: "even", rateMajor: 5, openings: [] },
    });
    propertyIds.push(created.propertyId);
    const unit = await query<{ id: string }>(`SELECT id::text AS id FROM units WHERE property_id = $1`, [created.propertyId]);
    const prepared = await prepareUtilityRun(admin, {
      unitId: unit.rows[0].id,
      periodStart: period.start,
      periodEnd: period.end,
      rateMajor: 5,
      totalKwh: null,
      billTotalMajor: 3000,
      overrideReason: "",
      readings: [],
    });
    const detail = await utilityRunDetail(admin, prepared.runId);
    assert.equal(detail?.lines.length, 3);
    assert.equal(detail?.lines.every((line) => line.bearer === "owner" && Number(line.amount) === 100000), true);
    assert.equal(detail?.adjustments.billGapMinor, 0);
    assert.equal(detail?.adjustments.billGapWarn, false);
    const posted = await confirmUtilityRun(admin, prepared.runId);
    assert.ok(posted.changed >= 1);
    const expense = await query<{ amount: string; status: string }>(
      `SELECT e.amount_minor::text AS amount, r.status::text AS status
         FROM expenses e
         JOIN utility_allocation_runs r ON r.id = e.utility_run_id
        WHERE e.utility_run_id = $1 AND e.description = $2 AND e.status <> 'void'`,
      [prepared.runId, VACANT_ELECTRICITY_DESCRIPTION],
    );
    assert.equal(expense.rows.length, 1);
    assert.equal(expense.rows[0].amount, "300000");
    assert.equal(expense.rows[0].status, "posted");
    const bill = await query<{ usage: string }>(
      `SELECT total_usage::text AS usage
         FROM utility_bills
        WHERE id = (SELECT utility_bill_id FROM utility_allocation_runs WHERE id = $1)`,
      [prepared.runId],
    );
    assert.ok(Number(bill.rows[0].usage) > 0);
  } finally {
    await cleanupFixture({ propertyIds, userIds: [], importId: null, stamp });
  }
});

test("electricity split bills signed tenants only and treats a pending lease as vacant", async () => {
  const stamp = `mix${Date.now().toString(36)}`;
  const period = currentUtilityPeriod();
  const propertyIds: string[] = [];
  const userIds: string[] = [];
  try {
    const created = await createProperty(admin, {
      name: `簽署才分攤 ${stamp}`,
      city: "台北市",
      district: "中山區",
      street: `分攤路${stamp}`,
      currency: "TWD",
      ownerMode: "new",
      ownerName: "分攤屋主",
      ownerPhone: "0912000888",
      ownerEmail: `split.owner.${stamp}@example.com`,
      canViewTenantPhone: false,
      unitLabel: "7F",
      floor: "7",
      rentalMode: "by_room",
      rooms: ["A", "B", "C"].map((label) => ({ label, roomType: "suite", baseRentMajor: 9000 })),
      electric: { split: "even", rateMajor: 5, openings: [] },
    });
    propertyIds.push(created.propertyId);
    const [roomA, roomB, roomC] = created.roomIds;
    const fields = {
      tenantPhone: "0912345678",
      lineUserId: "",
      startDate: period.start,
      months: "12",
      rent: "9000",
      depositMonths: "2",
      depositReason: "",
      dueDay: "5",
      splitMethod: "even",
      billTotal: "",
      usage: "",
      rate: "",
      overrideReason: "",
    };
    const signed = await createLeaseFromForm(
      admin,
      form({ ...fields, roomId: roomA, tenantName: "已簽署租客", tenantEmail: `signed.${stamp}@example.com` }),
    );
    const pending = await createLeaseFromForm(
      admin,
      form({ ...fields, roomId: roomB, tenantName: "待簽署租客", tenantEmail: `pending.${stamp}@example.com` }),
    );
    userIds.push(signed.tenantUserId, pending.tenantUserId);
    await markLeaseIdReady(signed.leaseId);
    const tenantSigned = await simulateTenantSignature(admin, signed.leaseId);
    assert.equal(tenantSigned.esign, "partially_signed");
    const activated = await signLease(admin, { leaseId: signed.leaseId, signedName: "管理方", consent: true });
    assert.equal(activated.esign, "fully_signed");
    const statuses = await query<{ id: string; status: string }>(
      `SELECT id::text, status::text FROM leases WHERE id = ANY($1::uuid[])`,
      [[signed.leaseId, pending.leaseId]],
    );
    assert.equal(statuses.rows.find((row) => row.id === signed.leaseId)?.status, "active");
    assert.equal(statuses.rows.find((row) => row.id === pending.leaseId)?.status, "pending_signature");

    const unitId = (await query<{ id: string }>(`SELECT unit_id::text AS id FROM rooms WHERE id = $1`, [roomA])).rows[0].id;
    const prepared = await prepareUtilityRun(admin, {
      unitId,
      periodStart: period.start,
      periodEnd: period.end,
      rateMajor: 5,
      totalKwh: null,
      billTotalMajor: 3000,
      overrideReason: "",
      readings: [],
    });
    await confirmUtilityRun(admin, prepared.runId);
    const shares = await query<{ label: string; bearer: string; lease_id: string | null; amount: string; invoice: string | null }>(
      `SELECT r.label, l.bearer::text, l.lease_id::text, l.amount_minor::text AS amount, l.posted_invoice_id::text AS invoice
         FROM utility_allocation_lines l
         JOIN rooms r ON r.id = l.room_id
        WHERE l.run_id = $1
        ORDER BY r.label`,
      [prepared.runId],
    );
    assert.deepEqual(
      shares.rows.map((row) => row.label),
      ["A", "B", "C"],
    );
    for (const row of shares.rows) assert.equal(row.amount, "100000");
    const byLabel = Object.fromEntries(shares.rows.map((row) => [row.label, row]));
    assert.equal(byLabel.A?.bearer, "tenant");
    assert.equal(byLabel.A?.lease_id, signed.leaseId);
    assert.ok(byLabel.A?.invoice);
    assert.equal(byLabel.B?.bearer, "owner");
    assert.equal(byLabel.B?.lease_id, null);
    assert.equal(byLabel.B?.invoice, null);
    assert.equal(byLabel.C?.bearer, "owner");
    assert.equal(byLabel.C?.lease_id, null);
    assert.equal(byLabel.C?.invoice, null);
    const pendingCharges = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM invoice_lines il
         JOIN invoices i ON i.id = il.invoice_id
        WHERE i.lease_id = $1 AND il.charge_type = 'utility'`,
      [pending.leaseId],
    );
    assert.equal(pendingCharges.rows[0]?.n, "0");
    const expense = await query<{ description: string; amount: string; bill_to: string }>(
      `SELECT description, amount_minor::text AS amount, bill_to::text
         FROM expenses WHERE property_id = $1 AND status <> 'void'`,
      [created.propertyId],
    );
    assert.equal(expense.rows.length, 1);
    assert.equal(expense.rows[0]?.description, VACANT_ELECTRICITY_DESCRIPTION);
    assert.equal(expense.rows[0]?.amount, "200000");
    assert.equal(expense.rows[0]?.bill_to, "owner");
    const board = await listUtilityBoard(admin, period.start, period.end);
    const rooms = board.spaces.filter((space) => space.unit_id === unitId);
    assert.equal(rooms.find((space) => space.space_id === roomA)?.lease_id, signed.leaseId);
    assert.equal(rooms.find((space) => space.space_id === roomB)?.lease_id ?? null, null);
    assert.equal(rooms.find((space) => space.space_id === roomC)?.lease_id ?? null, null);
  } finally {
    await cleanupFixture({ propertyIds, userIds, importId: null, stamp });
  }
});

test("countersign leaves a pending room's electricity on the owner", async () => {
  const stamp = Date.now().toString(36);
  const period = currentUtilityPeriod();
  const propertyIds: string[] = [];
  const userIds: string[] = [];
  try {
    const created = await createProperty(admin, {
      name: `簽署電費 ${stamp}`,
      city: "台北市",
      district: "大安區",
      street: `復興南路${stamp}`,
      currency: "TWD",
      ownerMode: "new",
      ownerName: "簽署屋主",
      ownerPhone: "0912000666",
      ownerEmail: `sign.util.${stamp}@example.com`,
      canViewTenantPhone: false,
      unitLabel: "3F",
      floor: "3",
      rentalMode: "by_room",
      rooms: [{ label: "A", roomType: "suite", baseRentMajor: 10000 }],
    });
    propertyIds.push(created.propertyId);
    const roomId = created.roomIds[0];
    await query(`UPDATE rooms SET electricity_method = 'submeter', rate_per_kwh = 4 WHERE id = $1`, [roomId]);
    const lease = await createLeaseFromForm(
      admin,
      form({
        roomId,
        tenantName: "待簽署租客",
        tenantPhone: "0912345678",
        tenantEmail: `sign.util.${stamp}@example.com`,
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
      }),
    );
    userIds.push(lease.tenantUserId);
    const before = await query<{ status: string; esign: string }>(
      `SELECT status::text, esign_status::text AS esign FROM leases WHERE id = $1`,
      [lease.leaseId],
    );
    assert.equal(before.rows[0]?.status, "pending_signature");

    const unit = await query<{ id: string }>(`SELECT unit_id::text AS id FROM rooms WHERE id = $1`, [roomId]);
    const prepared = await prepareUtilityRun(admin, {
      unitId: unit.rows[0].id,
      periodStart: period.start,
      periodEnd: period.end,
      rateMajor: 4,
      totalKwh: 100,
      billTotalMajor: 400,
      overrideReason: "",
      readings: [{ spaceId: roomId, kwh: 100 }],
    });
    await confirmUtilityRun(admin, prepared.runId);
    const postedLine = await query<{ bearer: string; lease_id: string | null; invoice_id: string | null; amount: string }>(
      `SELECT bearer::text, lease_id::text, posted_invoice_id::text AS invoice_id, amount_minor::text AS amount
         FROM utility_allocation_lines
        WHERE run_id = $1`,
      [prepared.runId],
    );
    assert.equal(postedLine.rows.length, 1);
    assert.equal(postedLine.rows[0]?.bearer, "owner");
    assert.equal(postedLine.rows[0]?.lease_id, null);
    assert.equal(postedLine.rows[0]?.invoice_id, null);
    assert.equal(postedLine.rows[0]?.amount, "40000");
    const vacant = await query<{ amount: string }>(
      `SELECT amount_minor::text AS amount FROM expenses
        WHERE property_id = $1 AND description = $2 AND status <> 'void'`,
      [created.propertyId, VACANT_ELECTRICITY_DESCRIPTION],
    );
    assert.equal(vacant.rows[0]?.amount, "40000");

    await markLeaseIdReady(lease.leaseId);
    const tenantSigned = await simulateTenantSignature(admin, lease.leaseId);
    assert.equal(tenantSigned.esign, "partially_signed");
    const waiting = await query<{ status: string; move_in: string }>(
      `SELECT l.status::text,
              (SELECT count(*)::text FROM invoices i WHERE i.lease_id = l.id AND i.source = 'move_in') AS move_in
         FROM leases l WHERE l.id = $1`,
      [lease.leaseId],
    );
    assert.equal(waiting.rows[0]?.status, "pending_signature");
    assert.equal(waiting.rows[0]?.move_in, "0");

    const activated = await signLease(admin, { leaseId: lease.leaseId, signedName: "管理方", consent: true });
    assert.equal(activated.esign, "fully_signed");
    assert.ok(activated.invoiceId);

    const after = await query<{ status: string; esign: string }>(
      `SELECT status::text, esign_status::text AS esign FROM leases WHERE id = $1`,
      [lease.leaseId],
    );
    assert.equal(after.rows[0]?.status, "active");
    assert.equal(after.rows[0]?.esign, "fully_signed");
    const moveIn = await query<{ id: string; total: string }>(
      `SELECT id::text, total_minor::text AS total
         FROM invoices WHERE lease_id = $1 AND source = 'move_in' AND status <> 'void'`,
      [lease.leaseId],
    );
    assert.equal(moveIn.rows.length, 1);
    assert.equal(moveIn.rows[0].id, activated.invoiceId);
    const moveInLines = await query<{ charge_type: string; amount: string; allocation_line_id: string | null }>(
      `SELECT charge_type::text, amount_minor::text AS amount, allocation_line_id::text
         FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_no`,
      [moveIn.rows[0].id],
    );
    assert.deepEqual(
      moveInLines.rows.map((row) => row.charge_type),
      ["rent", "deposit"],
    );
    assert.equal(moveInLines.rows.every((row) => row.allocation_line_id === null), true);
    assert.equal(moveIn.rows[0].total, "3000000");
    const utilityInvoices = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM invoices WHERE lease_id = $1 AND source = 'utility' AND status <> 'void'`,
      [lease.leaseId],
    );
    assert.equal(utilityInvoices.rows[0]?.n, "0");
  } finally {
    await cleanupFixture({ propertyIds, userIds, importId: null, stamp });
  }
});

test("monthly invoice numbers ignore seed invoices and share one sequence", async () => {
  const seq = await tx(
    admin.userId,
    async (client) => {
      const first = await nextInvoiceNumber(client, ORG_ID, 0);
      const second = await nextInvoiceNumber(client, ORG_ID, 1);
      const count = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM invoices WHERE org_id = $1`, [ORG_ID]);
      return { first, second, count: Number(count.rows[0]?.n ?? 0) };
    },
    { orgId: ORG_ID, environment: "live" },
  );
  assert.match(seq.first, /^INV-\d{6}-\d{4}$/);
  assert.equal(seq.second.slice(0, 11), seq.first.slice(0, 11));
  assert.equal(Number(seq.second.slice(11)), Number(seq.first.slice(11)) + 1);
  assert.ok(seq.count > Number(seq.first.slice(11)));
});
