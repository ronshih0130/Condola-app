import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { query, withClient } from "./db";
import { createProperty } from "./domain";
import { FlowError } from "./errors";
import { ORG_ID, USERS } from "./ids";
import { createLeaseFromForm } from "./lease-form";
import type { Session } from "./types";

const admin: Session = {
  userId: USERS.admin,
  sessionId: "lease-create-e2e",
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

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const base = {
  tenantName: "新租客",
  tenantPhone: "0912345678",
  tenantEmail: "",
  lineUserId: "",
  startDate: "2026-11-01",
  months: "12",
  rent: "10000",
  depositMonths: "2",
  depositReason: "",
  dueDay: "5",
  splitMethod: "even",
  billTotal: "1000",
  usage: "100",
  rate: "4",
  overrideReason: "",
};

test("a new tenant lease is saved with no Taipower number, for both electricity splits", async () => {
  const action = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
  assert.match(action, /createLeaseFromForm\(session, formData\)/);

  const stamp = Date.now().toString(36);
  const propertyIds: string[] = [];
  const userIds: string[] = [];
  try {
    const rooms = await createProperty(admin, {
      name: `QA物件 ${stamp}`,
      city: "台北市",
      district: "大安區",
      street: "測試路3號",
      currency: "TWD",
      ownerMode: "new",
      ownerName: "測試屋主",
      ownerPhone: "0912345678",
      ownerEmail: `owner.${stamp}@example.com`,
      canViewTenantPhone: false,
      unitLabel: "3F",
      floor: "3",
      rentalMode: "by_room",
      rooms: [
        { label: "A", roomType: "suite", baseRentMajor: 10000 },
        { label: "B", roomType: "suite", baseRentMajor: 10000 },
      ],
    });
    propertyIds.push(rooms.propertyId);
    assert.equal(rooms.roomIds.length, 2);

    const even = await createLeaseFromForm(
      admin,
      form({
        ...base,
        roomId: rooms.roomIds[0],
        tenantEmail: `tenant.even.${stamp}@example.com`,
        splitMethod: "even",
      }),
    );
    userIds.push(even.tenantUserId);
    assert.equal(even.reused, false);

    const sub = await createLeaseFromForm(
      admin,
      form({
        ...base,
        roomId: rooms.roomIds[1],
        tenantName: "無信箱租客",
        tenantEmail: "",
        splitMethod: "sub_meter",
      }),
    );
    userIds.push(sub.tenantUserId);
    assert.equal(sub.reused, false);
    assert.notEqual(sub.leaseId, even.leaseId);

    const saved = await query<{
      id: string;
      rent: string;
      deposit: string;
      start_date: string;
      end_date: string;
      phone: string;
      email: string | null;
      auth_email: string;
    }>(
      `SELECT l.id::text, l.rent_amount_minor::text AS rent, l.deposit_months::text AS deposit,
              l.start_date::text, l.end_date::text,
              c.phone_e164 AS phone, c.email::text AS email, u.email AS auth_email
         FROM leases l
         JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
         JOIN contacts c ON c.id = lp.contact_id
         JOIN auth.users u ON u.id = c.user_id
        WHERE l.id = ANY($1::uuid[])`,
      [[even.leaseId, sub.leaseId]],
    );
    const evenRow = saved.rows.find((row) => row.id === even.leaseId);
    const subRow = saved.rows.find((row) => row.id === sub.leaseId);
    assert.ok(evenRow);
    assert.equal(evenRow.rent, "1000000");
    assert.equal(Number(evenRow.deposit), 2);
    assert.equal(evenRow.start_date, "2026-11-01");
    assert.equal(evenRow.end_date, "2027-10-31");
    assert.equal(evenRow.phone, "+886912345678");
    assert.equal(evenRow.email, `tenant.even.${stamp}@example.com`);
    assert.equal(evenRow.auth_email, `tenant.even.${stamp}@example.com`);

    assert.ok(subRow);
    assert.equal(subRow.phone, "+886912345678");
    assert.equal(subRow.email, null);
    assert.match(subRow.auth_email, /^portal-.+@demo\.condola\.local$/);

    const meter = await query<{ serial: string | null; n: string }>(
      `SELECT serial_number AS serial, count(*)::text AS n
         FROM meters
        WHERE unit_id IN (SELECT id FROM units WHERE property_id = $1)
        GROUP BY serial_number`,
      [rooms.propertyId],
    );
    assert.equal(meter.rows.length, 1);
    assert.equal(meter.rows[0]?.serial ?? null, null);

    const splits = await query<{ lease_id: string; split: string }>(
      `SELECT line.lease_id::text, r.split_method::text AS split
         FROM utility_allocation_lines line
         JOIN utility_allocation_runs r ON r.id = line.run_id
        WHERE line.lease_id = ANY($1::uuid[])`,
      [[even.leaseId, sub.leaseId]],
    );
    assert.ok(splits.rows.some((row) => row.lease_id === even.leaseId && row.split === "even"));
    assert.ok(splits.rows.some((row) => row.lease_id === sub.leaseId && row.split === "sub_meter"));

    const bills = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM utility_bills
        WHERE meter_id IN (SELECT id FROM meters WHERE unit_id IN (SELECT id FROM units WHERE property_id = $1))`,
      [rooms.propertyId],
    );
    assert.equal(bills.rows[0]?.n, "1");

    const whole = await createProperty(admin, {
      name: `整層 ${stamp}`,
      city: "台北市",
      district: "大安區",
      street: "測試路4號",
      currency: "TWD",
      ownerMode: "new",
      ownerName: "整層屋主",
      ownerPhone: "0912-345-678",
      ownerEmail: "",
      canViewTenantPhone: false,
      unitLabel: "4F",
      floor: "4",
      rentalMode: "whole_unit",
      rooms: [],
    });
    propertyIds.push(whole.propertyId);
    const unit = await query<{ id: string }>(`SELECT id::text FROM units WHERE property_id = $1`, [whole.propertyId]);
    const bare = form({
      ...base,
      roomId: unit.rows[0].id,
      tenantName: "免電費租客",
      tenantEmail: "",
      splitMethod: "even",
    });
    bare.delete("billTotal");
    bare.delete("usage");
    bare.delete("rate");
    const open = await createLeaseFromForm(admin, bare);
    userIds.push(open.tenantUserId);
    assert.equal(open.reused, false);
    const meters = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM meters WHERE unit_id IN (SELECT id FROM units WHERE property_id = $1)`,
      [whole.propertyId],
    );
    assert.equal(meters.rows[0]?.n, "0");

    await assert.rejects(
      () => createLeaseFromForm(admin, form({ ...base, roomId: rooms.roomIds[0], rent: "" })),
      (error: unknown) => error instanceof FlowError && error.key === "errors.amount",
    );
  } finally {
    await withClient(async (client) => {
      await client.query(`ALTER TABLE lease_signature_events DISABLE TRIGGER trg_lease_signature_events_append_only`);
      try {
        for (const propertyId of propertyIds) {
          await client.query(
            `DELETE FROM utility_allocation_lines WHERE lease_id IN (SELECT id FROM leases WHERE property_id = $1)`,
            [propertyId],
          );
          await client.query(
            `DELETE FROM utility_allocation_runs
              WHERE meter_id IN (SELECT m.id FROM meters m JOIN units u ON u.id = m.unit_id WHERE u.property_id = $1)`,
            [propertyId],
          );
          await client.query(
            `DELETE FROM utility_bills
              WHERE meter_id IN (SELECT m.id FROM meters m JOIN units u ON u.id = m.unit_id WHERE u.property_id = $1)`,
            [propertyId],
          );
          await client.query(`DELETE FROM meters WHERE unit_id IN (SELECT id FROM units WHERE property_id = $1)`, [propertyId]);
          await client.query(`DELETE FROM notifications WHERE lease_id IN (SELECT id FROM leases WHERE property_id = $1)`, [propertyId]);
          await client.query(`DELETE FROM leases WHERE property_id = $1`, [propertyId]);
          await client.query(`DELETE FROM management_agreements WHERE property_id = $1`, [propertyId]);
          await client.query(`DELETE FROM properties WHERE id = $1`, [propertyId]);
        }
        if (userIds.length) {
          await client.query(`DELETE FROM contacts WHERE user_id = ANY($1::uuid[])`, [userIds]);
          await client.query(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [userIds]);
        }
        await client.query(`DELETE FROM contacts WHERE lower(email::text) LIKE $1`, [`%${stamp}@example.com`]);
        await client.query(`DELETE FROM auth.users WHERE lower(email) LIKE $1`, [`%${stamp}@example.com`]);
      } finally {
        await client.query(`ALTER TABLE lease_signature_events ENABLE TRIGGER trg_lease_signature_events_append_only`);
      }
    });
  }
});
