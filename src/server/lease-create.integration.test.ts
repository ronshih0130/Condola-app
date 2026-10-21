import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { query, withClient } from "./db";
import { createProperty } from "./domain";
import { updateProperty } from "./portfolio";
import { FlowError } from "./errors";
import { ORG_ID, USERS } from "./ids";
import { createLeaseFromForm } from "./lease-form";
import { listLeases, listSpaces, vacantRooms } from "./queries";
import { ensureSandbox } from "./sandbox";
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

test("a new tenant lease is saved in live and sandbox, including a whole unit that was given rooms", async () => {
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

    const blankPhone = await createProperty(admin, {
      name: `無電話 ${stamp}`,
      city: "台北市",
      district: "大安區",
      street: "測試路4號",
      currency: "TWD",
      ownerMode: "new",
      ownerName: "無電話屋主",
      ownerPhone: "",
      ownerEmail: `nophone.${stamp}@example.com`,
      canViewTenantPhone: false,
      unitLabel: "1F",
      floor: "1",
      rentalMode: "whole_unit",
      rooms: [],
    });
    propertyIds.push(blankPhone.propertyId);
    const storedPhone = await query<{ phone: string | null }>(
      `SELECT phone_e164 AS phone FROM contacts WHERE id = $1`,
      [blankPhone.ownerContactId],
    );
    assert.equal(storedPhone.rows[0]?.phone ?? null, null);
    const dashed = await createProperty(admin, {
      name: `有電話 ${stamp}`,
      city: "台北市",
      district: "大安區",
      street: "測試路5號",
      currency: "TWD",
      ownerMode: "new",
      ownerName: "有電話屋主",
      ownerPhone: "0912-345-678",
      ownerEmail: `phone.${stamp}@example.com`,
      canViewTenantPhone: false,
      unitLabel: "2F",
      floor: "2",
      rentalMode: "whole_unit",
      rooms: [],
    });
    propertyIds.push(dashed.propertyId);
    const normalized = await query<{ phone: string | null }>(
      `SELECT phone_e164 AS phone FROM contacts WHERE id = $1`,
      [dashed.ownerContactId],
    );
    assert.equal(normalized.rows[0]?.phone, "+886912345678");
    await updateProperty(admin, dashed.propertyId, {
      name: `有電話 ${stamp}`,
      city: "台北市",
      district: "大安區",
      street: "測試路5號",
      ownerContactId: dashed.ownerContactId,
      electricity: { serial: "12-34-5678-90-1", split: "even", bill: "1000", usage: "200", rate: "4" },
    });
    const setupMeter = await query<{ serial: string | null; split: string; rate: string; bill: string; usage: string }>(
      `SELECT m.serial_number AS serial, m.split_method::text AS split, m.rate_minor_per_unit::text AS rate,
              b.total_amount_minor::text AS bill, b.total_usage::text AS usage
         FROM meters m
         JOIN utility_bills b ON b.meter_id = m.id
        WHERE m.property_id = $1 AND m.utility = 'electricity' AND m.room_id IS NULL`,
      [dashed.propertyId],
    );
    assert.equal(setupMeter.rows[0]?.serial, "12-34-5678-90-1");
    assert.equal(setupMeter.rows[0]?.split, "even");
    assert.equal(Number(setupMeter.rows[0]?.rate), 400);
    assert.equal(setupMeter.rows[0]?.bill, "100000");
    assert.equal(Number(setupMeter.rows[0]?.usage), 200);

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
    const listed = await listLeases(admin);
    assert.equal(listed.find((row) => row.id === even.leaseId)?.electricity, "even");
    assert.equal(listed.find((row) => row.id === sub.leaseId)?.electricity, "sub_meter");

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
    await assert.rejects(
      () =>
        createProperty(admin, {
          name: `缺地址 ${stamp}`,
          city: "台北市",
          district: "大安區",
          street: "",
          currency: "TWD",
          ownerMode: "new",
          ownerName: "測試屋主",
          ownerPhone: "0912345678",
          ownerEmail: "",
          canViewTenantPhone: false,
          unitLabel: "8F",
          floor: "8",
          rentalMode: "by_room",
          rooms: [{ label: "A", roomType: "suite", baseRentMajor: 10000 }],
        }),
      (error: unknown) => error instanceof FlowError && error.key === "errors.required" && error.vars?.field === "i_address",
    );
    const oneRoom = await createProperty(admin, {
      name: `單房 ${stamp}`,
      city: "台北市",
      district: "大安區",
      street: "測試路8號",
      currency: "TWD",
      ownerMode: "new",
      ownerName: "單房屋主",
      ownerPhone: "0912345678",
      ownerEmail: `owner.one.${stamp}@example.com`,
      canViewTenantPhone: false,
      unitLabel: "8F",
      floor: "8",
      rentalMode: "by_room",
      rooms: [
        { label: "A", roomType: "suite", baseRentMajor: 8000 },
        { label: "", roomType: "suite", baseRentMajor: 0 },
        { label: "", roomType: "suite", baseRentMajor: 0 },
      ],
    });
    propertyIds.push(oneRoom.propertyId);
    assert.equal(oneRoom.roomIds.length, 1);

    const repair = readFileSync(new URL("../../supabase/migrations/20261022170000_archive_whole_unit_rooms.sql", import.meta.url), "utf8");
    assert.match(repair, /SET archived_at/);
    assert.match(repair, /u\.rental_mode = 'whole_unit'/);
    assert.match(repair, /NOT EXISTS \(SELECT 1 FROM leases l WHERE l\.target_room_id = r\.id\)/);
    assert.doesNotMatch(repair, /DELETE FROM rooms/i);

    const sandboxId = await ensureSandbox(admin);
    const sandbox: Session = {
      ...admin,
      sessionId: "lease-create-sandbox",
      orgId: sandboxId,
      environment: "sandbox",
    };
    const wholeSandbox = await createProperty(sandbox, {
      name: `沙盒整層 ${stamp}`,
      city: "台北市",
      district: "大安區",
      street: "測試路5號",
      currency: "TWD",
      ownerMode: "new",
      ownerName: "沙盒屋主",
      ownerPhone: "0912345678",
      ownerEmail: `owner.sb.${stamp}@example.com`,
      canViewTenantPhone: false,
      unitLabel: "5F",
      floor: "5",
      rentalMode: "whole_unit",
      rooms: [
        { label: "A", roomType: "suite", baseRentMajor: 10000 },
        { label: "B", roomType: "suite", baseRentMajor: 10000 },
        { label: "C", roomType: "suite", baseRentMajor: 10000 },
      ],
    });
    propertyIds.push(wholeSandbox.propertyId);
    assert.equal(wholeSandbox.roomIds.length, 0);
    const sandboxUnit = await query<{ id: string }>(`SELECT id::text FROM units WHERE property_id = $1`, [wholeSandbox.propertyId]);
    const sandboxUnitId = sandboxUnit.rows[0].id;
    const inserted = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM rooms WHERE unit_id = $1`,
      [sandboxUnitId],
    );
    assert.equal(inserted.rows[0]?.n, "0");
    const stray = await withClient(async (client) => {
      const created = await client.query<{ id: string }>(
        `INSERT INTO rooms (org_id, unit_id, label, room_type, base_rent_minor, area_unit)
         SELECT $1, $2, label, 'suite', 0, 'ping'
           FROM unnest(ARRAY['A','B','C']) AS label
         RETURNING id::text`,
        [sandboxId, sandboxUnitId],
      );
      return created.rows.map((row) => row.id);
    });
    assert.equal(stray.length, 3);

    const before = await listSpaces(sandbox);
    assert.ok(before.some((row) => row.id === sandboxUnitId && row.kind === "whole_unit"));
    assert.equal(before.some((row) => stray.includes(row.id)), false);
    const openSpaces = await vacantRooms(sandbox);
    assert.ok(openSpaces.some((row) => row.id === sandboxUnitId));
    assert.equal(openSpaces.some((row) => stray.includes(row.id)), false);

    const sandboxLease = await createLeaseFromForm(
      sandbox,
      form({
        ...base,
        roomId: sandboxUnitId,
        tenantName: "沙盒租客",
        tenantEmail: `tenant.sb.${stamp}@example.com`,
        splitMethod: "even",
      }),
    );
    userIds.push(sandboxLease.tenantUserId);
    assert.equal(sandboxLease.reused, false);

    await query(
      `UPDATE rooms r
          SET archived_at = coalesce(r.archived_at, now()),
              updated_at = now()
         FROM units u
        WHERE u.id = r.unit_id
          AND u.id = $1
          AND u.rental_mode = 'whole_unit'
          AND r.archived_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.target_room_id = r.id)`,
      [sandboxUnitId],
    );
    const archived = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM rooms WHERE unit_id = $1 AND archived_at IS NOT NULL`,
      [sandboxUnitId],
    );
    assert.equal(archived.rows[0]?.n, "3");

    const byRoom = await createProperty(sandbox, {
      name: `沙盒分租 ${stamp}`,
      city: "台北市",
      district: "大安區",
      street: "測試路6號",
      currency: "TWD",
      ownerMode: "new",
      ownerName: "沙盒分租屋主",
      ownerPhone: "0912345678",
      ownerEmail: `owner.rooms.${stamp}@example.com`,
      canViewTenantPhone: false,
      unitLabel: "6F",
      floor: "6",
      rentalMode: "by_room",
      rooms: [
        { label: "A", roomType: "suite", baseRentMajor: 8000 },
        { label: "B", roomType: "suite", baseRentMajor: 9000 },
      ],
    });
    propertyIds.push(byRoom.propertyId);
    assert.equal(byRoom.roomIds.length, 2);
    const roomLease = await createLeaseFromForm(
      sandbox,
      form({
        ...base,
        roomId: byRoom.roomIds[0],
        tenantName: "分租租客",
        tenantEmail: `tenant.room.${stamp}@example.com`,
      }),
    );
    userIds.push(roomLease.tenantUserId);
    const stillOpen = await vacantRooms(sandbox);
    assert.ok(stillOpen.some((row) => row.id === byRoom.roomIds[1]));
    assert.equal(stillOpen.some((row) => row.id === byRoom.roomIds[0]), false);
    assert.equal(stillOpen.some((row) => stray.includes(row.id)), false);

    const liveWhole = await createProperty(admin, {
      name: `正式整層 ${stamp}`,
      city: "台北市",
      district: "大安區",
      street: "測試路7號",
      currency: "TWD",
      ownerMode: "new",
      ownerName: "正式屋主",
      ownerPhone: "0912345678",
      ownerEmail: `owner.live.${stamp}@example.com`,
      canViewTenantPhone: false,
      unitLabel: "7F",
      floor: "7",
      rentalMode: "whole_unit",
      rooms: [
        { label: "A", roomType: "suite", baseRentMajor: 10000 },
        { label: "B", roomType: "suite", baseRentMajor: 10000 },
        { label: "C", roomType: "suite", baseRentMajor: 10000 },
      ],
    });
    propertyIds.push(liveWhole.propertyId);
    assert.equal(liveWhole.roomIds.length, 0);
    const liveUnit = await query<{ id: string }>(`SELECT id::text FROM units WHERE property_id = $1`, [liveWhole.propertyId]);
    const liveUnitId = liveUnit.rows[0].id;
    const liveStray = await withClient(async (client) => {
      const created = await client.query<{ id: string }>(
        `INSERT INTO rooms (org_id, unit_id, label, room_type, base_rent_minor, area_unit)
         SELECT $1, $2, label, 'suite', 0, 'ping'
           FROM unnest(ARRAY['A','B','C']) AS label
         RETURNING id::text`,
        [ORG_ID, liveUnitId],
      );
      return created.rows.map((row) => row.id);
    });
    const liveSpaces = await listSpaces(admin);
    assert.ok(liveSpaces.some((row) => row.id === liveUnitId && row.kind === "whole_unit"));
    assert.equal(liveSpaces.some((row) => liveStray.includes(row.id)), false);
    const liveVacant = await vacantRooms(admin);
    assert.ok(liveVacant.some((row) => row.id === liveUnitId));
    assert.equal(liveVacant.some((row) => liveStray.includes(row.id)), false);

    const missingEmail = `missing.${stamp}@example.com`;
    await assert.rejects(
      () => createLeaseFromForm(sandbox, form({ ...base, roomId: "00000000-0000-4000-8000-000000000099", tenantEmail: missingEmail })),
      (error: unknown) => error instanceof FlowError && error.key === "errors.notFound",
    );
    const missingUser = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM auth.users WHERE lower(email) = $1`,
      [missingEmail],
    );
    assert.equal(missingUser.rows[0]?.n, "0");

    await query(`UPDATE leases SET created_at = now() - interval '3 minutes' WHERE id = $1`, [roomLease.leaseId]);
    const clashEmail = `clash.${stamp}@example.com`;
    await assert.rejects(
      () =>
        createLeaseFromForm(
          sandbox,
          form({ ...base, roomId: byRoom.roomIds[0], tenantName: "衝突租客", tenantEmail: clashEmail }),
        ),
      (error: unknown) => error instanceof FlowError && error.key === "errors.occupied",
    );
    const clashUser = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM auth.users WHERE lower(email) = $1`,
      [clashEmail],
    );
    assert.equal(clashUser.rows[0]?.n, "0");
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
