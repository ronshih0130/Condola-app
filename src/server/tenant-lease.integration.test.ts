import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { query, tx, withClient } from "./db";
import { createProperty, updateLease } from "./domain";
import { FlowError } from "./errors";
import { ORG2_ID, ORG_ID, USERS } from "./ids";
import { createLeaseFromForm } from "./lease-form";
import { listTenants, searchTenants } from "./queries";
import { ensureSandbox } from "./sandbox";
import type { Session } from "./types";
import { insertTestAuthSession } from "./test-auth-session";

const admin: Session = {
  userId: USERS.admin,
  sessionId: "tenant-pick",
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
test.before(async()=>{admin.sessionId=await withClient(c=>insertTestAuthSession(c,admin.userId));});
test.after(async()=>{await query(`DELETE FROM auth_sessions WHERE id=$1`,[admin.sessionId]);});

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
  billTotal: "",
  usage: "",
  rate: "",
  overrideReason: "",
};

test("picking an existing 租客 reuses that contact and portal user inside the firm", async () => {
  const domain = readFileSync(new URL("./domain.ts", import.meta.url), "utf8");
  assert.match(domain, /WHERE id = \$1 AND org_id = \$2 AND is_tenant AND archived_at IS NULL/);

  const stamp = Date.now().toString(36);
  const email = `tenant.pick.${stamp}@example.com`;
  const unlinkedEmail = `unlinked.pick.${stamp}@example.com`;
  const propertyIds: string[] = [];
  const userIds: string[] = [];
  try {
    const rooms = await createProperty(admin, {
      name: `現有租客 ${stamp}`,
      city: "台北市",
      district: "大安區",
      street: "測試路9號",
      currency: "TWD",
      ownerMode: "new",
      ownerName: "現有屋主",
      ownerPhone: "0912000000",
      ownerEmail: `owner.pick.${stamp}@example.com`,
      canViewTenantPhone: false,
      unitLabel: "9F",
      floor: "9",
      rentalMode: "by_room",
      rooms: [
        { label: "A", roomType: "suite", baseRentMajor: 10000 },
        { label: "B", roomType: "suite", baseRentMajor: 10000 },
        { label: "C", roomType: "suite", baseRentMajor: 10000 },
      ],
    });
    propertyIds.push(rooms.propertyId);
    const spare = await createProperty(admin, {
      name: `未綁定租客 ${stamp}`,
      city: "台北市",
      district: "大安區",
      street: "測試路10號",
      currency: "TWD",
      ownerMode: "new",
      ownerName: "另一屋主",
      ownerPhone: "",
      ownerEmail: `owner2.pick.${stamp}@example.com`,
      canViewTenantPhone: false,
      unitLabel: "1F",
      floor: "1",
      rentalMode: "by_room",
      rooms: [{ label: "A", roomType: "suite", baseRentMajor: 8000 }],
    });
    propertyIds.push(spare.propertyId);

    const created = await createLeaseFromForm(
      admin,
      form({ ...base, roomId: rooms.roomIds[0], tenantName: "可再用租客", tenantEmail: email }),
    );
    userIds.push(created.tenantUserId);
    assert.equal(created.reused, false);
    const first = await query<{ id: string; user_id: string }>(
      `SELECT c.id::text, c.user_id::text AS user_id
         FROM lease_parties lp
         JOIN contacts c ON c.id = lp.contact_id
        WHERE lp.lease_id = $1 AND lp.role = 'primary'`,
      [created.leaseId],
    );
    const contactId = first.rows[0]?.id ?? "";
    assert.equal(first.rows[0]?.user_id, created.tenantUserId);

    const again = await createLeaseFromForm(
      admin,
      form({
        ...base,
        roomId: rooms.roomIds[1],
        tenantMode: contactId,
        tenantName: "",
        tenantPhone: "",
        tenantEmail: "",
        lineUserId: "",
      }),
    );
    userIds.push(again.tenantUserId);
    assert.equal(again.reused, false);
    assert.equal(again.tenantUserId, created.tenantUserId);
    assert.notEqual(again.leaseId, created.leaseId);
    const parties = await query<{ contact_id: string; user_id: string }>(
      `SELECT lp.contact_id::text, c.user_id::text AS user_id
         FROM lease_parties lp
         JOIN contacts c ON c.id = lp.contact_id
        WHERE lp.lease_id = ANY($1::uuid[]) AND lp.role = 'primary'`,
      [[created.leaseId, again.leaseId]],
    );
    assert.equal(parties.rows.length, 2);
    assert.ok(parties.rows.every((row) => row.contact_id === contactId && row.user_id === created.tenantUserId));
    const copies = await query<{ contacts: string; users: string }>(
      `SELECT
         (SELECT count(*)::text FROM contacts WHERE org_id = $1 AND is_tenant AND lower(email::text) = lower($2)) AS contacts,
         (SELECT count(*)::text FROM auth.users WHERE lower(email) = lower($2)) AS users`,
      [ORG_ID, email],
    );
    assert.equal(copies.rows[0]?.contacts, "1");
    assert.equal(copies.rows[0]?.users, "1");
    const found = await searchTenants(admin, { q: "可再用租客" });
    const summary = found.rows.filter((row) => row.contact_id === contactId);
    assert.equal(summary.length, 1);
    assert.equal(Number(summary[0]?.lease_count), 2);
    assert.equal(summary[0]?.tenant, "可再用租客");
    assert.equal(summary[0]?.id, again.leaseId);

    await assert.rejects(
      () =>
        createLeaseFromForm(
          admin,
          form({ ...base, roomId: rooms.roomIds[2], tenantName: "另一筆", tenantEmail: email, tenantPhone: "0912000111" }),
        ),
      (error: unknown) => error instanceof FlowError && error.key === "errors.tenantExists",
    );
    const stillOne = await query<{ contacts: string; users: string }>(
      `SELECT
         (SELECT count(*)::text FROM contacts WHERE org_id = $1 AND is_tenant AND lower(email::text) = lower($2)) AS contacts,
         (SELECT count(*)::text FROM auth.users WHERE lower(email) = lower($2)) AS users`,
      [ORG_ID, email],
    );
    assert.equal(stillOne.rows[0]?.contacts, "1");
    assert.equal(stillOne.rows[0]?.users, "1");

    await assert.rejects(
      () =>
        createLeaseFromForm(
          admin,
          form({ ...base, roomId: rooms.roomIds[2], tenantName: "小數租金", tenantPhone: "0912000222", tenantEmail: "", rent: "10000.5" }),
        ),
      (error: unknown) => error instanceof FlowError && error.key === "errors.amount" && error.vars?.field === "i_base_rent",
    );
    await assert.rejects(
      () =>
        createLeaseFromForm(
          admin,
          form({
            ...base,
            roomId: rooms.roomIds[2],
            tenantName: "小數押金",
            tenantPhone: "0912000223",
            tenantEmail: "",
            rent: "10001",
            depositMonths: "1.3",
          }),
        ),
      (error: unknown) => error instanceof FlowError && error.key === "errors.depositStep",
    );

    await assert.rejects(
      () =>
        createLeaseFromForm(
          admin,
          form({
            ...base,
            roomId: rooms.roomIds[2],
            tenantMode: rooms.ownerContactId,
            tenantName: "",
            tenantPhone: "",
            tenantEmail: "",
          }),
        ),
      (error: unknown) => error instanceof FlowError && error.key === "errors.notFound",
    );

    const coastContact = await query<{ id: string }>(
      `SELECT id::text FROM contacts WHERE org_id = $1 AND is_tenant AND archived_at IS NULL ORDER BY created_at LIMIT 1`,
      [ORG2_ID],
    );
    const coastId = coastContact.rows[0]?.id ?? "";
    assert.ok(coastId);
    await assert.rejects(
      () =>
        createLeaseFromForm(
          admin,
          form({ ...base, roomId: rooms.roomIds[2], tenantMode: coastId, tenantName: "", tenantPhone: "", tenantEmail: "" }),
        ),
      (error: unknown) => error instanceof FlowError && error.key === "errors.notFound",
    );
    const hiddenFromStaff = await tx(
      USERS.admin,
      (client) => client.query(`SELECT id FROM contacts WHERE id = $1`, [coastId]),
      { orgId: ORG_ID, environment: "live" },
    );
    assert.equal(hiddenFromStaff.rows.length, 0);
    const hiddenFromCoast = await tx(
      USERS.coastAdmin,
      (client) => client.query(`SELECT id FROM contacts WHERE id = $1`, [contactId]),
      { orgId: ORG2_ID, environment: "live" },
    );
    assert.equal(hiddenFromCoast.rows.length, 0);

    const listed = await listTenants(admin);
    assert.ok(listed.some((row) => row.id === contactId && row.name === "可再用租客" && row.email === email));
    assert.equal(listed.some((row) => row.id === coastId || row.id === rooms.ownerContactId), false);
    const coastListed = await listTenants({
      ...admin,
      userId: USERS.coastAdmin,
      orgId: ORG2_ID,
      liveOrgId: ORG2_ID,
    });
    assert.ok(coastListed.some((row) => row.id === coastId));
    assert.equal(coastListed.some((row) => row.id === contactId), false);

    const unlinked = await query<{ id: string }>(
      `INSERT INTO contacts (org_id, user_id, is_tenant, display_name, email, phone_e164, locale)
       VALUES ($1, NULL, true, '未綁定租客', $2, '+886912888777', 'zh-TW')
       RETURNING id::text`,
      [ORG_ID, unlinkedEmail],
    );
    const unlinkedId = unlinked.rows[0]?.id ?? "";
    const linkedLease = await createLeaseFromForm(
      admin,
      form({
        ...base,
        roomId: spare.roomIds[0],
        tenantMode: unlinkedId,
        tenantName: "",
        tenantPhone: "",
        tenantEmail: "",
      }),
    );
    userIds.push(linkedLease.tenantUserId);
    const attached = await query<{ id: string; user_id: string; users: string; contacts: string }>(
      `SELECT c.id::text, c.user_id::text AS user_id,
              (SELECT count(*)::text FROM auth.users WHERE lower(email) = lower($2)) AS users,
              (SELECT count(*)::text FROM contacts WHERE org_id = $3 AND lower(email::text) = lower($2)) AS contacts
         FROM contacts c
        WHERE c.id = $1`,
      [unlinkedId, unlinkedEmail, ORG_ID],
    );
    assert.equal(attached.rows[0]?.id, unlinkedId);
    assert.equal(attached.rows[0]?.user_id, linkedLease.tenantUserId);
    assert.equal(attached.rows[0]?.users, "1");
    assert.equal(attached.rows[0]?.contacts, "1");
    const party = await query<{ contact_id: string }>(
      `SELECT contact_id::text FROM lease_parties WHERE lease_id = $1 AND role = 'primary'`,
      [linkedLease.leaseId],
    );
    assert.equal(party.rows[0]?.contact_id, unlinkedId);
    const login = await query<{ email: string }>(`SELECT email FROM auth.users WHERE id = $1`, [linkedLease.tenantUserId]);
    assert.equal(login.rows[0]?.email, unlinkedEmail);
  } finally {
    await withClient(async (client) => {
      await client.query(`ALTER TABLE lease_signature_events DISABLE TRIGGER trg_lease_signature_events_append_only`);
      await client.query(`ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_entries_append_only`);
      await client.query(`ALTER TABLE ledger_transactions DISABLE TRIGGER trg_ledger_transactions_append_only`);
      try {
        for (const propertyId of propertyIds) {
          await client.query(`UPDATE expenses SET ledger_transaction_id = NULL WHERE property_id = $1`, [propertyId]);
          await client.query(`DELETE FROM expenses WHERE property_id = $1`, [propertyId]);
          await client.query(
            `DELETE FROM ledger_entries
              WHERE transaction_id IN (
                SELECT id FROM ledger_transactions WHERE property_id = $1 AND source_table = 'expenses'
              )`,
            [propertyId],
          );
          await client.query(
            `DELETE FROM ledger_transactions WHERE property_id = $1 AND source_table = 'expenses' AND kind = 'reversal'`,
            [propertyId],
          );
          await client.query(
            `DELETE FROM ledger_transactions WHERE property_id = $1 AND source_table = 'expenses'`,
            [propertyId],
          );
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
        await client.query(`DELETE FROM contacts WHERE lower(email::text) LIKE $1`, [`%${stamp}@example.com`]);
        if (userIds.length) await client.query(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [userIds]);
        await client.query(`DELETE FROM auth.users WHERE lower(email) LIKE $1`, [`%${stamp}@example.com`]);
      } finally {
        await client.query(`ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_entries_append_only`);
        await client.query(`ALTER TABLE ledger_transactions ENABLE TRIGGER trg_ledger_transactions_append_only`);
        await client.query(`ALTER TABLE lease_signature_events ENABLE TRIGGER trg_lease_signature_events_append_only`);
      }
    });
  }
});

test("a taken or sandbox email gets a new portal login, and an archived contact cannot be picked", async () => {
  const domain = readFileSync(new URL("./domain.ts", import.meta.url), "utf8");
  const rule = readFileSync(new URL("./portal-login.ts", import.meta.url), "utf8");
  assert.doesNotMatch(domain, /FROM auth\.users/i);
  assert.match(domain, /emailTaken: false/);
  assert.match(rule, /environment === "sandbox"/);
  assert.match(rule, /emailTaken/);

  const stamp = Date.now().toString(36);
  const takenEmail = `taken.pick.${stamp}@example.com`;
  const sandboxEmail = `sandbox.pick.${stamp}@example.com`;
  const archivedEmail = `archived.pick.${stamp}@example.com`;
  const existingUserId = randomUUID();
  const propertyIds: string[] = [];
  const userIds: string[] = [existingUserId];
  try {
    await query(
      `INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
       VALUES ($1, 'authenticated', 'authenticated', $2, '{}'::jsonb, '{}'::jsonb)`,
      [existingUserId, takenEmail],
    );
    const rooms = await createProperty(admin, {
      name: `已有帳號 ${stamp}`,
      city: "台北市",
      district: "大安區",
      street: "測試路11號",
      currency: "TWD",
      ownerMode: "new",
      ownerName: "帳號屋主",
      ownerPhone: "",
      ownerEmail: `owner.taken.${stamp}@example.com`,
      canViewTenantPhone: false,
      unitLabel: "11F",
      floor: "11",
      rentalMode: "by_room",
      rooms: [
        { label: "A", roomType: "suite", baseRentMajor: 9000 },
        { label: "B", roomType: "suite", baseRentMajor: 9000 },
      ],
    });
    propertyIds.push(rooms.propertyId);

    const archived = await query<{ id: string }>(
      `INSERT INTO contacts (org_id, user_id, is_tenant, display_name, email, phone_e164, locale, archived_at)
       VALUES ($1, NULL, true, '已封存租客', $2, '+886912000333', 'zh-TW', now())
       RETURNING id::text`,
      [ORG_ID, archivedEmail],
    );
    const archivedId = archived.rows[0]?.id ?? "";
    await assert.rejects(
      () =>
        createLeaseFromForm(
          admin,
          form({
            ...base,
            roomId: rooms.roomIds[1],
            tenantMode: archivedId,
            tenantName: "",
            tenantPhone: "",
            tenantEmail: "",
          }),
        ),
      (error: unknown) => error instanceof FlowError && error.key === "errors.notFound",
    );
    const listed = await listTenants(admin);
    assert.equal(listed.some((row) => row.id === archivedId), false);

    const active = await query<{ id: string }>(
      `INSERT INTO contacts (org_id, user_id, is_tenant, display_name, email, phone_e164, locale)
       VALUES ($1, NULL, true, '稍後封存', $2, '+886912000334', 'zh-TW')
       RETURNING id::text`,
      [ORG_ID, `later.archived.${stamp}@example.com`],
    );
    const laterId = active.rows[0]?.id ?? "";
    await query(`UPDATE contacts SET archived_at = now() WHERE id = $1 AND org_id = $2`, [laterId, ORG_ID]);
    await assert.rejects(
      () =>
        createLeaseFromForm(
          admin,
          form({
            ...base,
            roomId: rooms.roomIds[1],
            tenantMode: laterId,
            tenantName: "",
            tenantPhone: "",
            tenantEmail: "",
          }),
        ),
      (error: unknown) => error instanceof FlowError && error.key === "errors.notFound",
    );
    assert.equal((await listTenants(admin)).some((row) => row.id === laterId), false);

    const unlinked = await query<{ id: string }>(
      `INSERT INTO contacts (org_id, user_id, is_tenant, display_name, email, phone_e164, locale)
       VALUES ($1, NULL, true, '信箱已有登入', $2, '+886912000335', 'zh-TW')
       RETURNING id::text`,
      [ORG_ID, takenEmail],
    );
    const contactId = unlinked.rows[0]?.id ?? "";
    const leased = await createLeaseFromForm(
      admin,
      form({
        ...base,
        roomId: rooms.roomIds[0],
        tenantMode: contactId,
        tenantName: "",
        tenantPhone: "",
        tenantEmail: "",
      }),
    );
    userIds.push(leased.tenantUserId);
    assert.notEqual(leased.tenantUserId, existingUserId);
    const attached = await query<{ contact_email: string; user_id: string; auth_email: string; kept: string }>(
      `SELECT c.email::text AS contact_email, c.user_id::text AS user_id, u.email AS auth_email,
              (SELECT email FROM auth.users WHERE id = $2) AS kept
         FROM contacts c
         JOIN auth.users u ON u.id = c.user_id
        WHERE c.id = $1`,
      [contactId, existingUserId],
    );
    assert.equal(attached.rows[0]?.contact_email, takenEmail);
    assert.equal(attached.rows[0]?.user_id, leased.tenantUserId);
    assert.match(attached.rows[0]?.auth_email ?? "", /^portal-.+@demo\.condola\.local$/);
    assert.equal(attached.rows[0]?.kept, takenEmail);
    const holders = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM auth.users WHERE lower(email) = lower($1)`,
      [takenEmail],
    );
    assert.equal(holders.rows[0]?.n, "1");

    const mixedAuth = `Mixed.Case.${stamp}@example.com`;
    const mixedContact = `mixed.case.${stamp}@example.com`;
    const mixedUserId = randomUUID();
    userIds.push(mixedUserId);
    await query(
      `INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
       VALUES ($1, 'authenticated', 'authenticated', $2, '{}'::jsonb, '{}'::jsonb)`,
      [mixedUserId, mixedAuth],
    );
    const mixed = await query<{ id: string }>(
      `INSERT INTO contacts (org_id, user_id, is_tenant, display_name, email, phone_e164, locale)
       VALUES ($1, NULL, true, '大小寫不同', $2, '+886912000337', 'zh-TW')
       RETURNING id::text`,
      [ORG_ID, mixedContact],
    );
    const mixedId = mixed.rows[0]?.id ?? "";
    const mixedLease = await createLeaseFromForm(
      admin,
      form({
        ...base,
        roomId: rooms.roomIds[1],
        tenantMode: mixedId,
        tenantName: "",
        tenantPhone: "",
        tenantEmail: "",
      }),
    );
    userIds.push(mixedLease.tenantUserId);
    assert.notEqual(mixedLease.tenantUserId, mixedUserId);
    assert.notEqual(mixedLease.tenantUserId, existingUserId);
    const mixedRow = await query<{ contact_email: string; auth_email: string; n: string }>(
      `SELECT c.email::text AS contact_email, u.email AS auth_email,
              (SELECT count(*)::text FROM auth.users WHERE lower(email) = lower($2)) AS n
         FROM contacts c
         JOIN auth.users u ON u.id = c.user_id
        WHERE c.id = $1`,
      [mixedId, mixedAuth],
    );
    assert.equal(mixedRow.rows[0]?.contact_email, mixedContact);
    assert.match(mixedRow.rows[0]?.auth_email ?? "", /^portal-.+@demo\.condola\.local$/);
    assert.equal(mixedRow.rows[0]?.n, "1");

    const sandboxId = await ensureSandbox(admin);
    const sandbox: Session = {
      ...admin,
      sessionId: admin.sessionId,
      orgId: sandboxId,
      environment: "sandbox",
    };
    const sandboxRooms = await createProperty(sandbox, {
      name: `沙盒租客 ${stamp}`,
      city: "台北市",
      district: "大安區",
      street: "測試路12號",
      currency: "TWD",
      ownerMode: "new",
      ownerName: "沙盒屋主",
      ownerPhone: "",
      ownerEmail: `owner.sandbox.pick.${stamp}@example.com`,
      canViewTenantPhone: false,
      unitLabel: "12F",
      floor: "12",
      rentalMode: "by_room",
      rooms: [{ label: "A", roomType: "suite", baseRentMajor: 8000 }],
    });
    propertyIds.push(sandboxRooms.propertyId);
    const sandboxContact = await query<{ id: string }>(
      `INSERT INTO contacts (org_id, user_id, is_tenant, display_name, email, phone_e164, locale)
       VALUES ($1, NULL, true, '沙盒未綁定', $2, '+886912000336', 'zh-TW')
       RETURNING id::text`,
      [sandboxId, sandboxEmail],
    );
    const sandboxContactId = sandboxContact.rows[0]?.id ?? "";
    const sandboxLease = await createLeaseFromForm(
      sandbox,
      form({
        ...base,
        roomId: sandboxRooms.roomIds[0],
        tenantMode: sandboxContactId,
        tenantName: "",
        tenantPhone: "",
        tenantEmail: "",
      }),
    );
    userIds.push(sandboxLease.tenantUserId);
    const sandboxRow = await query<{ contact_email: string; auth_email: string; same: string }>(
      `SELECT c.email::text AS contact_email, u.email AS auth_email,
              (SELECT count(*)::text FROM auth.users WHERE lower(email) = lower($2)) AS same
         FROM contacts c
         JOIN auth.users u ON u.id = c.user_id
        WHERE c.id = $1`,
      [sandboxContactId, sandboxEmail],
    );
    assert.equal(sandboxRow.rows[0]?.contact_email, sandboxEmail);
    assert.match(sandboxRow.rows[0]?.auth_email ?? "", /^portal-.+@demo\.condola\.local$/);
    assert.equal(sandboxRow.rows[0]?.same, "0");
    assert.notEqual(sandboxLease.tenantUserId, existingUserId);
  } finally {
    await withClient(async (client) => {
      await client.query(`ALTER TABLE lease_signature_events DISABLE TRIGGER trg_lease_signature_events_append_only`);
      await client.query(`ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_entries_append_only`);
      await client.query(`ALTER TABLE ledger_transactions DISABLE TRIGGER trg_ledger_transactions_append_only`);
      try {
        for (const propertyId of propertyIds) {
          await client.query(`UPDATE expenses SET ledger_transaction_id = NULL WHERE property_id = $1`, [propertyId]);
          await client.query(`DELETE FROM expenses WHERE property_id = $1`, [propertyId]);
          await client.query(
            `DELETE FROM ledger_entries
              WHERE transaction_id IN (
                SELECT id FROM ledger_transactions WHERE property_id = $1 AND source_table = 'expenses'
              )`,
            [propertyId],
          );
          await client.query(
            `DELETE FROM ledger_transactions WHERE property_id = $1 AND source_table = 'expenses' AND kind = 'reversal'`,
            [propertyId],
          );
          await client.query(
            `DELETE FROM ledger_transactions WHERE property_id = $1 AND source_table = 'expenses'`,
            [propertyId],
          );
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
        await client.query(`DELETE FROM contacts WHERE lower(email::text) LIKE $1`, [`%${stamp}@example.com`]);
        if (userIds.length) await client.query(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [userIds]);
        await client.query(`DELETE FROM auth.users WHERE lower(email) LIKE $1`, [`%${stamp}@example.com`]);
      } finally {
        await client.query(`ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_entries_append_only`);
        await client.query(`ALTER TABLE ledger_transactions ENABLE TRIGGER trg_ledger_transactions_append_only`);
        await client.query(`ALTER TABLE lease_signature_events ENABLE TRIGGER trg_lease_signature_events_append_only`);
      }
    });
  }
});

test("a new 租客 whose email already logs in at another firm gets a fresh portal user", async () => {
  const domain = readFileSync(new URL("./domain.ts", import.meta.url), "utf8");
  assert.doesNotMatch(domain, /FROM auth\.users/i);
  assert.match(domain, /insertPortalUserUnlessEmailTaken/);

  const stamp = Date.now().toString(36);
  const exactEmail = `cross.exact.${stamp}@example.com`;
  const mixedAuth = `Other.Org.${stamp}@example.com`;
  const mixedContact = `other.org.${stamp}@example.com`;
  const exactUserId = randomUUID();
  const mixedUserId = randomUUID();
  const propertyIds: string[] = [];
  const userIds: string[] = [exactUserId, mixedUserId];
  try {
    await query(
      `INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
       VALUES ($1, 'authenticated', 'authenticated', $2, '{}'::jsonb, '{}'::jsonb),
              ($3, 'authenticated', 'authenticated', $4, '{}'::jsonb, '{}'::jsonb)`,
      [exactUserId, exactEmail, mixedUserId, mixedAuth],
    );
    await query(
      `INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1, $2, 'manager', 'active'), ($1, $3, 'manager', 'active')`,
      [ORG2_ID, exactUserId, mixedUserId],
    );
    const rooms = await createProperty(admin, {
      name: `跨所登入 ${stamp}`,
      city: "台北市",
      district: "大安區",
      street: "測試路13號",
      currency: "TWD",
      ownerMode: "new",
      ownerName: "跨所屋主",
      ownerPhone: "",
      ownerEmail: `owner.cross.${stamp}@example.com`,
      canViewTenantPhone: false,
      unitLabel: "13F",
      floor: "13",
      rentalMode: "by_room",
      rooms: [
        { label: "A", roomType: "suite", baseRentMajor: 9000 },
        { label: "B", roomType: "suite", baseRentMajor: 9000 },
      ],
    });
    propertyIds.push(rooms.propertyId);

    const exact = await createLeaseFromForm(
      admin,
      form({
        ...base,
        roomId: rooms.roomIds[0],
        tenantName: "跨所同信箱",
        tenantPhone: "0912000441",
        tenantEmail: exactEmail,
      }),
    );
    userIds.push(exact.tenantUserId);
    const mixed = await createLeaseFromForm(
      admin,
      form({
        ...base,
        roomId: rooms.roomIds[1],
        tenantName: "跨所大小寫",
        tenantPhone: "0912000442",
        tenantEmail: mixedAuth,
      }),
    );
    userIds.push(mixed.tenantUserId);
    assert.notEqual(exact.tenantUserId, exactUserId);
    assert.notEqual(mixed.tenantUserId, mixedUserId);

    const rows = await query<{ contact_email: string; auth_email: string; n: string; user_id: string }>(
      `SELECT c.email::text AS contact_email, u.email AS auth_email, c.user_id::text AS user_id,
              (SELECT count(*)::text FROM auth.users WHERE lower(email) = lower(c.email::text)) AS n
         FROM contacts c
         JOIN auth.users u ON u.id = c.user_id
        WHERE c.user_id = ANY($1::uuid[])
        ORDER BY c.email`,
      [[exact.tenantUserId, mixed.tenantUserId]],
    );
    assert.equal(rows.rows.length, 2);
    const byEmail = new Map(rows.rows.map((row) => [row.contact_email, row]));
    assert.equal(byEmail.get(exactEmail)?.user_id, exact.tenantUserId);
    assert.match(byEmail.get(exactEmail)?.auth_email ?? "", /^portal-.+@demo\.condola\.local$/);
    assert.equal(byEmail.get(exactEmail)?.n, "1");
    assert.equal(byEmail.get(mixedContact)?.user_id, mixed.tenantUserId);
    assert.match(byEmail.get(mixedContact)?.auth_email ?? "", /^portal-.+@demo\.condola\.local$/);
    assert.equal(byEmail.get(mixedContact)?.n, "1");
  } finally {
    await withClient(async (client) => {
      await client.query(`ALTER TABLE lease_signature_events DISABLE TRIGGER trg_lease_signature_events_append_only`);
      await client.query(`ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_entries_append_only`);
      await client.query(`ALTER TABLE ledger_transactions DISABLE TRIGGER trg_ledger_transactions_append_only`);
      try {
        for (const propertyId of propertyIds) {
          await client.query(`UPDATE expenses SET ledger_transaction_id = NULL WHERE property_id = $1`, [propertyId]);
          await client.query(`DELETE FROM expenses WHERE property_id = $1`, [propertyId]);
          await client.query(
            `DELETE FROM ledger_entries
              WHERE transaction_id IN (
                SELECT id FROM ledger_transactions WHERE property_id = $1 AND source_table = 'expenses'
              )`,
            [propertyId],
          );
          await client.query(
            `DELETE FROM ledger_transactions WHERE property_id = $1 AND source_table = 'expenses' AND kind = 'reversal'`,
            [propertyId],
          );
          await client.query(
            `DELETE FROM ledger_transactions WHERE property_id = $1 AND source_table = 'expenses'`,
            [propertyId],
          );
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
        await client.query(`DELETE FROM contacts WHERE lower(email::text) LIKE $1`, [`%${stamp}@example.com`]);
        if (userIds.length) await client.query(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [userIds]);
        await client.query(`DELETE FROM auth.users WHERE lower(email) LIKE $1`, [`%${stamp}@example.com`]);
      } finally {
        await client.query(`ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_entries_append_only`);
        await client.query(`ALTER TABLE ledger_transactions ENABLE TRIGGER trg_ledger_transactions_append_only`);
        await client.query(`ALTER TABLE lease_signature_events ENABLE TRIGGER trg_lease_signature_events_append_only`);
      }
    });
  }
});

test("deposit months step by half a month and TWD deposit dollars are rounded", async () => {
  const stamp = Date.now().toString(36);
  const propertyIds: string[] = [];
  const userIds: string[] = [];
  try {
    const rooms = await createProperty(admin, {
      name: `押金半個月 ${stamp}`,
      city: "台北市",
      district: "大安區",
      street: "測試路11號",
      currency: "TWD",
      ownerMode: "new",
      ownerName: "押金屋主",
      ownerPhone: "0912000555",
      ownerEmail: `owner.deposit.${stamp}@example.com`,
      canViewTenantPhone: false,
      unitLabel: "11F",
      floor: "11",
      rentalMode: "by_room",
      rooms: [
        { label: "A", roomType: "suite", baseRentMajor: 10001 },
        { label: "B", roomType: "suite", baseRentMajor: 12000 },
      ],
    });
    propertyIds.push(rooms.propertyId);

    await assert.rejects(
      () =>
        createLeaseFromForm(
          admin,
          form({
            ...base,
            roomId: rooms.roomIds[0],
            tenantName: "非整步押金",
            tenantPhone: "0912000661",
            tenantEmail: `bad.step.${stamp}@example.com`,
            rent: "10001",
            depositMonths: "1.3",
          }),
        ),
      (error: unknown) => error instanceof FlowError && error.key === "errors.depositStep",
    );
    await assert.rejects(
      () =>
        createLeaseFromForm(
          admin,
          form({
            ...base,
            roomId: rooms.roomIds[0],
            tenantName: "超過兩個月",
            tenantPhone: "0912000662",
            tenantEmail: `over.cap.${stamp}@example.com`,
            rent: "10001",
            depositMonths: "2.5",
            depositReason: "",
          }),
        ),
      (error: unknown) => error instanceof FlowError && error.key === "errors.depositCap",
    );

    const half = await createLeaseFromForm(
      admin,
      form({
        ...base,
        roomId: rooms.roomIds[0],
        tenantName: "一個半月",
        tenantPhone: "0912000663",
        tenantEmail: `half.month.${stamp}@example.com`,
        rent: "10001",
        depositMonths: "1.5",
      }),
    );
    userIds.push(half.tenantUserId);
    const zero = await createLeaseFromForm(
      admin,
      form({
        ...base,
        roomId: rooms.roomIds[1],
        tenantName: "零押金",
        tenantPhone: "0912000664",
        tenantEmail: `zero.month.${stamp}@example.com`,
        rent: "12000",
        depositMonths: "0",
      }),
    );
    userIds.push(zero.tenantUserId);

    const saved = await query<{ id: string; deposit_amount_minor: string; deposit_months: string }>(
      `SELECT id::text, deposit_amount_minor::text, deposit_months::text
         FROM leases
        WHERE id = ANY($1::uuid[])`,
      [[half.leaseId, zero.leaseId]],
    );
    const byId = new Map(saved.rows.map((row) => [row.id, row]));
    assert.equal(byId.get(half.leaseId)?.deposit_amount_minor, "1500200");
    assert.equal(Number(byId.get(half.leaseId)?.deposit_months), 1.5);
    assert.equal(byId.get(zero.leaseId)?.deposit_amount_minor, "0");
    assert.equal(Number(byId.get(zero.leaseId)?.deposit_months), 0);

    const version = await query<{ updated_at: string }>(`SELECT updated_at::text FROM leases WHERE id = $1`, [half.leaseId]);
    const updatedAt = version.rows[0]?.updated_at ?? "";
    await assert.rejects(
      () => updateLease(admin, { leaseId: half.leaseId, rentMajor: 10001, depositMonths: "1.3", depositReason: "", updatedAt }),
      (error: unknown) => error instanceof FlowError && error.key === "errors.depositStep",
    );
    await updateLease(admin, { leaseId: half.leaseId, rentMajor: 10001, depositMonths: "0.5", depositReason: "", updatedAt });
    const revised = await query<{ deposit_amount_minor: string; deposit_months: string }>(
      `SELECT deposit_amount_minor::text, deposit_months::text FROM leases WHERE id = $1`,
      [half.leaseId],
    );
    assert.equal(revised.rows[0]?.deposit_amount_minor, "500100");
    assert.equal(Number(revised.rows[0]?.deposit_months), 0.5);
  } finally {
    await withClient(async (client) => {
      await client.query(`ALTER TABLE lease_signature_events DISABLE TRIGGER trg_lease_signature_events_append_only`);
      await client.query(`ALTER TABLE ledger_entries DISABLE TRIGGER trg_ledger_entries_append_only`);
      await client.query(`ALTER TABLE ledger_transactions DISABLE TRIGGER trg_ledger_transactions_append_only`);
      try {
        for (const propertyId of propertyIds) {
          await client.query(`UPDATE expenses SET ledger_transaction_id = NULL WHERE property_id = $1`, [propertyId]);
          await client.query(`DELETE FROM expenses WHERE property_id = $1`, [propertyId]);
          await client.query(
            `DELETE FROM ledger_entries
              WHERE transaction_id IN (
                SELECT id FROM ledger_transactions WHERE property_id = $1 AND source_table = 'expenses'
              )`,
            [propertyId],
          );
          await client.query(
            `DELETE FROM ledger_transactions WHERE property_id = $1 AND source_table = 'expenses' AND kind = 'reversal'`,
            [propertyId],
          );
          await client.query(
            `DELETE FROM ledger_transactions WHERE property_id = $1 AND source_table = 'expenses'`,
            [propertyId],
          );
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
        await client.query(`DELETE FROM contacts WHERE lower(email::text) LIKE $1`, [`%${stamp}@example.com`]);
        if (userIds.length) await client.query(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [userIds]);
        await client.query(`DELETE FROM auth.users WHERE lower(email) LIKE $1`, [`%${stamp}@example.com`]);
      } finally {
        await client.query(`ALTER TABLE ledger_entries ENABLE TRIGGER trg_ledger_entries_append_only`);
        await client.query(`ALTER TABLE ledger_transactions ENABLE TRIGGER trg_ledger_transactions_append_only`);
        await client.query(`ALTER TABLE lease_signature_events ENABLE TRIGGER trg_lease_signature_events_append_only`);
      }
    });
  }
});
