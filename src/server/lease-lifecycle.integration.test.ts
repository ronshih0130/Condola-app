import assert from "node:assert/strict";
import test from "node:test";
import { query, tx, withClient } from "./db";
import { createLease, createProperty } from "./domain";
import { FlowError } from "./errors";
import { ORG_ID, USERS } from "./ids";
import { addDeduction, cancelLease, confirmSettlement, renewLease, scheduleMoveOut } from "./lease-lifecycle";
import { shortfallBody } from "./lease-lifecycle-rules";
import { addDays, taipeiToday } from "./money";
import { ensureSandbox } from "./sandbox";
import type { Session } from "./types";

const admin: Session = {
  userId: USERS.admin,
  sessionId: "lease-lifecycle",
  email: "yating.lin@songxin.demo",
  name: "林雅婷",
  kind: "staff",
  role: "admin",
  orgId: ORG_ID,
  liveOrgId: ORG_ID,
  environment: "live",
  locale: "zh-TW",
  calendar: "gregorian",
  leaseId: null,
};

const accountant: Session = { ...admin, userId: USERS.accountant, role: "accountant", email: "meiling.zhou@songxin.demo", name: "周美玲" };

function leaseInput(roomId: string, stamp: string, start: string, end: string, name: string, slug: string) {
  return {
    roomId,
    tenantName: name,
    tenantPhone: `0912${slug}`,
    tenantEmail: `lifecycle.${slug}.${stamp}@example.com`,
    lineUserId: "",
    startDate: start,
    endDate: end,
    rentMajor: 21000,
    depositMonths: 2,
    depositReason: "",
    dueDay: 5,
    splitMethod: "even" as const,
    periodStart: start,
    periodEnd: addDays(start, 40),
    billTotalMajor: null,
    usageKwh: null,
    rateMajor: null,
    rateSource: "bill_average" as const,
    overrideReason: "",
    subUsages: [],
  };
}

test("renewal keeps the old lease, move-out uses the overridden rent, and a closed lease keeps an end date", async () => {
  const stamp = Date.now().toString(36);
  const propertyIds: string[] = [];
  const userIds: string[] = [];
  const extraOrgIds: string[] = [];
  const today = taipeiToday();
  const start = "2026-11-01";
  const end = "2026-12-31";
  try {
    const flag = await query<{ flag: string }>(
      `SELECT feature_flags->>'lease_lifecycle' AS flag FROM organizations WHERE id = $1 AND plan_tier = 'beta'`,
      [ORG_ID],
    );
    assert.equal(flag.rows[0]?.flag, "true");
    const sandboxId = await ensureSandbox(admin);
    const sandbox = await query<{ flag: string; environment: string }>(
      `SELECT feature_flags->>'lease_lifecycle' AS flag, environment::text FROM organizations WHERE id = $1`,
      [sandboxId],
    );
    assert.equal(sandbox.rows[0]?.environment, "sandbox");
    assert.equal(sandbox.rows[0]?.flag, "true");

    const pro = await query<{ id: string; flag: string }>(
      `INSERT INTO organizations (name, country_code, jurisdiction_id, default_currency, timezone, plan_tier, environment, created_by)
       SELECT 'QA 生命週期公司', country_code, jurisdiction_id, default_currency, timezone, 'pro', 'live', $2
         FROM organizations WHERE id = $1
       RETURNING id::text, feature_flags->>'lease_lifecycle' AS flag`,
      [ORG_ID, USERS.admin],
    );
    extraOrgIds.push(pro.rows[0].id);
    assert.equal(pro.rows[0]?.flag, "false");
    await query(`INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1, $2, 'admin', 'active')`, [pro.rows[0].id, USERS.admin]);
    await assert.rejects(
      () => renewLease({ ...admin, orgId: pro.rows[0].id, liveOrgId: pro.rows[0].id }, { leaseId: "00000000-0000-4000-8000-000000000099", rentMajor: 1, depositMajor: 1, startDate: start, endDate: end, dueDay: 5, depositReason: "" }),
      (error: unknown) => error instanceof FlowError && error.key === "errors.lifecycleOff",
    );

    const rooms = await createProperty(admin, {
      name: `續約物件 ${stamp}`,
      city: "台北市",
      district: "大安區",
      street: "練習路9號",
      currency: "TWD",
      ownerMode: "new",
      ownerName: "練習屋主",
      ownerPhone: "0912345678",
      ownerEmail: `lifecycle.owner.${stamp}@example.com`,
      canViewTenantPhone: false,
      unitLabel: "3F",
      floor: "3",
      rentalMode: "by_room",
      rooms: [
        { label: "A", roomType: "suite", baseRentMajor: 21000 },
        { label: "B", roomType: "suite", baseRentMajor: 21000 },
        { label: "C", roomType: "suite", baseRentMajor: 21000 },
      ],
    });
    propertyIds.push(rooms.propertyId);

    const created = await createLease(admin, leaseInput(rooms.roomIds[0], stamp, start, end, "續約租客", "100001"));
    userIds.push(created.tenantUserId);
    await query(`UPDATE leases SET status = 'active', esign_status = 'fully_signed', signed_at = now() WHERE id = $1`, [created.leaseId]);
    const contact = await query<{ id: string }>(`SELECT contact_id::text AS id FROM lease_parties WHERE lease_id = $1 AND role = 'primary'`, [created.leaseId]);
    await query(
      `INSERT INTO invoices (
         org_id, property_id, lease_id, bill_to_contact_id, invoice_number, currency,
         issue_date, due_date, period_start, period_end, status, source, created_by
       ) VALUES ($1,$2,$3,$4,$5,'TWD',$6,$6,$6,'2026-11-30','open','recurring',$7)`,
      [ORG_ID, rooms.propertyId, created.leaseId, contact.rows[0].id, `QA-${stamp}`, start, USERS.admin],
    );
    await query(
      `INSERT INTO invoice_lines (org_id, invoice_id, line_no, charge_type, description, quantity, unit_amount_minor, amount_minor)
       SELECT $1, id, 1, 'rent', 'rent', 1, 2100000, 2100000 FROM invoices WHERE invoice_number = $2`,
      [ORG_ID, `QA-${stamp}`],
    );

    await assert.rejects(
      () => renewLease(accountant, { leaseId: created.leaseId, rentMajor: 22000, depositMajor: 44000, startDate: "2027-01-01", endDate: "2027-02-28", dueDay: 5, depositReason: "" }),
      (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden",
    );

    const renewed = await renewLease(admin, {
      leaseId: created.leaseId,
      rentMajor: 22000,
      depositMajor: 44000,
      startDate: "2027-01-01",
      endDate: "2027-02-28",
      dueDay: 5,
      depositReason: "",
    });
    assert.match(renewed.text, /新租約已建立，2027年1月 起的帳單會依新租金產生。/);
    const oldRow = await query<{ status: string; end_date: string }>(`SELECT status::text, end_date::text FROM leases WHERE id = $1`, [created.leaseId]);
    assert.equal(oldRow.rows[0]?.status, "active");
    assert.equal(oldRow.rows[0]?.end_date, end);
    const carried = await query<{ tenant: string; room: string; rent: string; due: number; status: string }>(
      `SELECT c.display_name AS tenant, l.target_room_id::text AS room, l.rent_amount_minor::text AS rent, l.due_day AS due, l.status::text
         FROM leases l
         JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
         JOIN contacts c ON c.id = lp.contact_id
        WHERE l.id = $1 AND l.renewed_from_id = $2`,
      [renewed.leaseId, created.leaseId],
    );
    assert.equal(carried.rows[0]?.tenant, "續約租客");
    assert.equal(carried.rows[0]?.room, rooms.roomIds[0]);
    assert.equal(carried.rows[0]?.rent, "2200000");
    assert.equal(carried.rows[0]?.due, 5);
    assert.equal(carried.rows[0]?.status, "pending_signature");

    const moved = await scheduleMoveOut(admin, {
      leaseId: created.leaseId,
      moveOutOn: "2026-11-17",
      reason: "early",
      handover: "2026-11-17T10:00",
      overrideMajor: 10000,
    });
    assert.equal(moved.defaultMinor, 1_190_000);
    assert.equal(moved.finalMinor, 1_000_000);
    assert.equal(moved.days, 17);
    const bill = await query<{ amount: string; description: string }>(
      `SELECT amount_minor::text AS amount, description FROM invoice_lines WHERE invoice_id = (SELECT id FROM invoices WHERE invoice_number = $1)`,
      [`QA-${stamp}`],
    );
    assert.equal(bill.rows[0]?.amount, "1000000");
    assert.match(bill.rows[0]?.description ?? "", /未繳租金 2026年11月（1–17 日）/);
    const audit = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log WHERE event_type = 'moveout_rent_override' AND new_row->>'leaseId' = $1`,
      [created.leaseId],
    );
    assert.equal(audit.rows[0]?.count, "1");

    await addDeduction(admin, { leaseId: created.leaseId, kind: "repair", amountMajor: 3000, item: "牆面", photos: 1 });
    await addDeduction(admin, { leaseId: created.leaseId, kind: "electricity", amountMajor: 860, item: "", photos: 0 });
    const preview = await query<{ refund: string; shortfall: string; label: string }>(
      `SELECT s.refund_minor::text AS refund, s.shortfall_minor::text AS shortfall, l.item AS label
         FROM lease_settlements s
         JOIN lease_settlement_lines l ON l.settlement_id = s.id AND l.kind = 'repair'
        WHERE s.lease_id = $1`,
      [created.leaseId],
    );
    assert.equal(preview.rows[0]?.refund, "2814000");
    assert.equal(preview.rows[0]?.shortfall, "0");
    assert.equal(preview.rows[0]?.label, "牆面");
    const confirmed = await confirmSettlement(admin, { leaseId: created.leaseId, refundOn: today });
    assert.equal(confirmed.endDate, "2026-11-17");
    const closed = await query<{ status: string; end_date: string }>(`SELECT status::text, end_date::text FROM leases WHERE id = $1`, [created.leaseId]);
    assert.equal(closed.rows[0]?.status, "ended");
    assert.equal(closed.rows[0]?.end_date, "2026-11-17");

    const hidden = await tx(USERS.coastAdmin, (client) => client.query(`SELECT id FROM lease_settlements WHERE lease_id = $1`, [created.leaseId]));
    assert.equal(hidden.rows.length, 0);

    const second = await createLease(admin, leaseInput(rooms.roomIds[1], stamp, start, end, "不足租客", "100002"));
    userIds.push(second.tenantUserId);
    await query(`UPDATE leases SET status = 'active', esign_status = 'fully_signed', signed_at = now() WHERE id = $1`, [second.leaseId]);
    await scheduleMoveOut(admin, { leaseId: second.leaseId, moveOutOn: "2026-11-17", reason: "early", handover: "2026-11-17T10:00", overrideMajor: null });
    await addDeduction(admin, { leaseId: second.leaseId, kind: "repair", amountMajor: 36300, item: "修繕", photos: 0 });
    const gap = await query<{ shortfall: string; deductions: string }>(
      `SELECT shortfall_minor::text AS shortfall, deductions_minor::text AS deductions FROM lease_settlements WHERE lease_id = $1`,
      [second.leaseId],
    );
    assert.equal(gap.rows[0]?.deductions, "4820000");
    assert.equal(gap.rows[0]?.shortfall, "620000");
    assert.equal(shortfallBody(6200), "扣款超過押金，租客還需補付 NT$6,200");
    await assert.rejects(
      () => tx(USERS.accountant, (client) => client.query(
        `INSERT INTO lease_settlements (
           org_id, lease_id, moveout_id, deposit_minor, deductions_minor, refund_minor, shortfall_minor, currency
         ) SELECT $1, id, id, 1, 0, 1, 0, 'TWD' FROM leases WHERE id = $2`,
        [ORG_ID, second.leaseId],
      )),
      (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden",
    );

    const pending = await createLease(admin, leaseInput(rooms.roomIds[2], stamp, start, end, "取消租客", "100003"));
    userIds.push(pending.tenantUserId);
    const cancelled = await cancelLease(admin, pending.leaseId);
    assert.equal(cancelled.endDate, today < start ? start : today);
    await query(`ALTER TABLE leases DISABLE TRIGGER trg_lease_close_end_date`);
    try {
      await assert.rejects(
        () => query(`UPDATE leases SET end_date = NULL WHERE id = $1 AND status = 'cancelled'`, [pending.leaseId]),
        (error: unknown) => {
          const row = error as { code?: string; constraint?: string };
          return row.code === "23514" && row.constraint === "leases_closed_end_date_chk";
        },
      );
    } finally {
      await query(`ALTER TABLE leases ENABLE TRIGGER trg_lease_close_end_date`);
    }
  } finally {
    await query(`ALTER TABLE leases ENABLE TRIGGER trg_lease_close_end_date`).catch(() => undefined);
    await withClient(async (client) => {
      await client.query(`ALTER TABLE lease_signature_events DISABLE TRIGGER trg_lease_signature_events_append_only`);
      try {
        for (const propertyId of propertyIds) {
          await client.query(`DELETE FROM notifications WHERE lease_id IN (SELECT id FROM leases WHERE property_id = $1)`, [propertyId]);
          await client.query(`DELETE FROM invoice_lines WHERE invoice_id IN (SELECT id FROM invoices WHERE property_id = $1)`, [propertyId]);
          await client.query(`DELETE FROM invoices WHERE property_id = $1`, [propertyId]);
          await client.query(`UPDATE leases SET previous_lease_id = NULL, renewed_from_id = NULL WHERE property_id = $1`, [propertyId]);
          await client.query(`DELETE FROM leases WHERE property_id = $1`, [propertyId]);
          await client.query(`DELETE FROM management_agreements WHERE property_id = $1`, [propertyId]);
          await client.query(`DELETE FROM properties WHERE id = $1`, [propertyId]);
        }
        if (userIds.length) {
          await client.query(`DELETE FROM contacts WHERE user_id = ANY($1::uuid[])`, [userIds]);
          await client.query(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [userIds]);
        }
        await client.query(`DELETE FROM contacts WHERE email LIKE $1`, [`%${stamp}@example.com`]);
        for (const orgId of extraOrgIds) await client.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
      } finally {
        await client.query(`ALTER TABLE lease_signature_events ENABLE TRIGGER trg_lease_signature_events_append_only`);
      }
    });
  }
});
