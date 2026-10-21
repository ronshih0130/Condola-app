import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { writeAudit } from "./audit";
import { leasePdfForSession, statementPdfForSession } from "./pdf-download";
import { query, svc, tx, withClient } from "./db";
import { createLease, createProperty } from "./domain";
import { FlowError } from "./errors";
import { ORG2_ID, ORG_ID, USERS } from "./ids";
import { hashInviteToken, issuePortalInvite } from "./portal-invite";
import { seedPortfolio } from "./portfolio";
import type { Session } from "./types";

test("one organization cannot read another's properties", async () => {
  const songxin = await tx(USERS.admin, async (client) => {
    const own = await client.query<{ id: string }>(`SELECT id::text FROM properties WHERE org_id = $1`, [ORG_ID]);
    const other = await client.query<{ id: string }>(`SELECT id::text FROM properties WHERE org_id = $1`, [ORG2_ID]);
    const all = await client.query<{ org_id: string }>(`SELECT org_id::text FROM properties`);
    return { own: own.rows.length, other: other.rows.length, orgs: new Set(all.rows.map((row) => row.org_id)) };
  });
  assert.ok(songxin.own > 0);
  assert.equal(songxin.other, 0);
  assert.deepEqual([...songxin.orgs], [ORG_ID]);

  const coast = await tx(USERS.coastAdmin, async (client) => {
    const own = await client.query<{ id: string }>(`SELECT id::text FROM properties WHERE org_id = $1`, [ORG2_ID]);
    const other = await client.query<{ id: string }>(`SELECT id::text FROM properties WHERE org_id = $1`, [ORG_ID]);
    const leaked = await client.query(`SELECT id FROM leases WHERE org_id = $1`, [ORG_ID]);
    return { own: own.rows.length, other: other.rows.length, leaked: leaked.rows.length };
  });
  assert.ok(coast.own > 0);
  assert.equal(coast.other, 0);
  assert.equal(coast.leaked, 0);
});

test("accountants do not receive tenant phone numbers; maintenance does", async () => {
  const sql = `SELECT CASE WHEN app.has_role(l.org_id, '{admin,manager,maintenance}') THEN c.phone_e164 END AS phone
      FROM leases l
      JOIN lease_parties lp ON lp.lease_id = l.id AND lp.role = 'primary'
      JOIN contacts c ON c.id = lp.contact_id
     WHERE c.phone_e164 IS NOT NULL
     LIMIT 1`;
  const hidden = await tx(USERS.accountant, (client) => client.query<{ phone: string | null }>(sql));
  const shown = await tx(USERS.maintenance, (client) => client.query<{ phone: string | null }>(sql));
  assert.equal(hidden.rows[0]?.phone ?? null, null);
  assert.ok(shown.rows[0]?.phone);
});

test("audit events store an action type and only an admin can read them", async () => {
  await writeAudit(ORG_ID, USERS.admin, "sign_in", { via: "test" });
  const adminRows = await tx(USERS.admin, (client) =>
    client.query<{ event_type: string }>(
      `SELECT event_type FROM audit_log WHERE org_id = $1 AND event_type = 'sign_in'`,
      [ORG_ID],
    ),
  );
  assert.ok(adminRows.rows.some((row) => row.event_type === "sign_in"));
  const accountant = await tx(USERS.accountant, (client) =>
    client.query(`SELECT id FROM audit_log WHERE org_id = $1`, [ORG_ID]),
  );
  assert.equal(accountant.rows.length, 0);
  const visible = await tx(USERS.accountant, (client) =>
    client.query<{ n: string }>(`SELECT count(*)::text AS n FROM maintenance_tickets`),
  );
  assert.ok(Number(visible.rows[0].n) > 0);
});

const SEEDED_NAMES = ["中壢範例分租公寓", "桃園區範例學舍", "青埔範例住宅大樓"];
const SEEDED_EMAILS = ["owner1.demo@example.com", "owner2.demo@example.com", "owner3.demo@example.com"];

test("seeded portfolio rows stay inside the firm and only admin or manager can write them", async () => {
  const csv = readFileSync(new URL("./fixtures/portfolio-sample.csv", import.meta.url), "utf8");
  const admin: Session = {
    userId: USERS.admin,
    sessionId: "rls",
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
  try {
    await seedPortfolio(admin, csv);
    const own = await tx(USERS.admin, async (client) => {
      const properties = await client.query<{ name: string }>(
        `SELECT name FROM properties WHERE name = ANY($1::text[])`,
        [SEEDED_NAMES],
      );
      const rooms = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM rooms r
           JOIN units u ON u.id = r.unit_id
           JOIN properties p ON p.id = u.property_id
          WHERE p.name = '中壢範例分租公寓'`,
      );
      const wholes = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM units u
           JOIN properties p ON p.id = u.property_id
          WHERE p.name = '青埔範例住宅大樓' AND u.rental_mode = 'whole_unit'`,
      );
      const room = await client.query<{ method: string; rate: string; rent: string; area: string }>(
        `SELECT r.electricity_method AS method, r.rate_per_kwh::text AS rate,
                r.base_rent_minor::text AS rent, r.area_value::text AS area
           FROM rooms r
           JOIN units u ON u.id = r.unit_id
           JOIN properties p ON p.id = u.property_id
          WHERE p.name = '中壢範例分租公寓' AND u.label = '2F' AND r.label = 'A'`,
      );
      const whole = await client.query<{ method: string | null; rate: string | null; rent: string; tenant: string | null }>(
        `SELECT u.electricity_method AS method, u.rate_per_kwh::text AS rate, u.base_rent_minor::text AS rent,
                lt.tenant_name AS tenant
           FROM units u
           JOIN properties p ON p.id = u.property_id
           LEFT JOIN listing_terms lt ON lt.unit_id = u.id
          WHERE p.name = '青埔範例住宅大樓' AND u.label = '3F'`,
      );
      return { properties: properties.rows.map((row) => row.name), rooms: rooms.rows[0].n, wholes: wholes.rows[0].n, room: room.rows[0], whole: whole.rows[0] };
    });
    assert.deepEqual(own.properties.sort(), [...SEEDED_NAMES].sort());
    assert.equal(own.rooms, "16");
    assert.equal(own.wholes, "7");
    assert.equal(own.room.method, "submeter");
    assert.equal(Number(own.room.rate), 4);
    assert.equal(own.room.rent, "1050000");
    assert.equal(Number(own.room.area), 8);
    assert.equal(own.whole.method, "tenant_direct");
    assert.equal(own.whole.rate, null);
    assert.equal(own.whole.rent, "1890000");
    assert.equal(own.whole.tenant, "試測七三（範例）");

    const coast = await tx(USERS.coastAdmin, async (client) => {
      const properties = await client.query(`SELECT id FROM properties WHERE name = ANY($1::text[])`, [SEEDED_NAMES]);
      const terms = await client.query(`SELECT id FROM listing_terms WHERE tenant_email = 'tenant1.demo@example.com'`);
      const owners = await client.query(`SELECT id FROM contacts WHERE lower(email::text) = ANY($1::text[])`, [SEEDED_EMAILS]);
      return { properties: properties.rows.length, terms: terms.rows.length, owners: owners.rows.length };
    });
    assert.equal(coast.properties, 0);
    assert.equal(coast.terms, 0);
    assert.equal(coast.owners, 0);

    const manager = await tx(USERS.manager, (client) =>
      client.query<{ n: string }>(`SELECT count(*)::text AS n FROM listing_terms WHERE org_id = $1`, [ORG_ID]),
    );
    assert.equal(manager.rows[0].n, "38");
    const accountantRead = await tx(USERS.accountant, (client) => client.query(`SELECT id FROM listing_terms`));
    assert.equal(accountantRead.rows.length, 0);

    await assert.rejects(
      tx(USERS.accountant, (client) =>
        client.query(
          `INSERT INTO listing_terms (org_id, room_id, opening_arrears_minor)
           SELECT r.org_id, r.id, 0
             FROM rooms r
             JOIN units u ON u.id = r.unit_id
             JOIN properties p ON p.id = u.property_id
            WHERE p.name = '中壢範例分租公寓'
            LIMIT 1`,
        ),
      ),
    );
  } finally {
    await svc(null, async (client) => {
      await client.query(`DELETE FROM properties WHERE org_id = $1 AND name = ANY($2::text[])`, [ORG_ID, SEEDED_NAMES]);
      await client.query(`DELETE FROM contacts WHERE org_id = $1 AND lower(email::text) = ANY($2::text[])`, [
        ORG_ID,
        SEEDED_EMAILS,
      ]);
    });
  }
});

test("a deposit over two months of rent is saved only with a reason", async () => {
  const room = await tx(USERS.admin, async (client) => {
    const found = await client.query<{ id: string; unit_id: string; currency: string }>(
      `SELECT r.id::text, r.unit_id::text, p.currency
         FROM rooms r
         JOIN units u ON u.id = r.unit_id
         JOIN properties p ON p.id = u.property_id
        WHERE r.org_id = $1 AND p.name = '信義松仁' AND r.label = 'C'`,
      [ORG_ID],
    );
    return found.rows[0];
  });
  assert.ok(room);

  const insertOverCap = (reason: string | null) =>
    tx(USERS.admin, (client) =>
      client.query<{ id: string }>(
        `INSERT INTO leases (
           org_id, unit_id, target_room_id, status, start_date, end_date, currency,
           rent_amount_minor, due_day, deposit_amount_minor, deposit_months,
           deposit_override_reason, deposit_overridden_by, deposit_overridden_at, created_by
         ) VALUES (
           $1,$2,$3,'pending_signature', current_date, current_date + 120, $4,
           1200000, 5, 3600000, 3,
           $5, CASE WHEN $5::text IS NULL THEN NULL ELSE $6::uuid END,
           CASE WHEN $5::text IS NULL THEN NULL ELSE now() END, $6
         ) RETURNING id::text`,
        [ORG_ID, room.unit_id, room.id, room.currency, reason, USERS.admin],
      ),
    );

  await assert.rejects(() => insertOverCap(null), /errors\.depositCap/);

  const created = await insertOverCap("屋主同意兩個月以上押金");
  const leaseId = created.rows[0].id;
  try {
    const check = await tx(USERS.admin, (client) =>
      client.query<{ outcome: string }>(
        `SELECT outcome::text FROM rule_check_results
          WHERE entity_table = 'leases' AND entity_id = $1
          ORDER BY checked_at DESC LIMIT 1`,
        [leaseId],
      ),
    );
    assert.equal(check.rows[0]?.outcome, "overridden");

    const lineId = "U-rls-line";
    await tx(USERS.admin, (client) =>
      client.query(
        `INSERT INTO contacts (org_id, is_tenant, display_name, phone_e164, line_user_id, locale)
         VALUES ($1, true, '押金測試房客', '+886912300099', $2, 'zh-TW')`,
        [ORG_ID, lineId],
      ),
    );
    const leakedLine = await tx(USERS.coastAdmin, (client) =>
      client.query(`SELECT id FROM contacts WHERE line_user_id = $1`, [lineId]),
    );
    assert.equal(leakedLine.rows.length, 0);

    const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
    const path = `${ORG_ID}/${leaseId}/rls-test.pdf`;
    await tx(USERS.admin, (client) =>
      client.query(
        `WITH stored AS (
           INSERT INTO files (org_id, storage_bucket, storage_path, file_name, mime_type, size_bytes, uploaded_by)
           VALUES ($1, 'lease-documents-private', $2, 'signed.pdf', 'application/pdf', $3, $4)
           RETURNING id
         )
         INSERT INTO lease_signed_pdfs (org_id, lease_id, file_id, object_path, content)
         SELECT $1, $5, stored.id, $2, $6 FROM stored`,
        [ORG_ID, path, pdf.length, USERS.admin, leaseId, pdf],
      ),
    );
    const own = await tx(USERS.admin, (client) =>
      client.query(`SELECT id FROM lease_signed_pdfs WHERE lease_id = $1`, [leaseId]),
    );
    const leaked = await tx(USERS.coastAdmin, (client) =>
      client.query(`SELECT id FROM lease_signed_pdfs WHERE lease_id = $1 OR org_id = $2`, [leaseId, ORG_ID]),
    );
    assert.equal(own.rows.length, 1);
    assert.equal(leaked.rows.length, 0);
    await assert.rejects(
      () =>
        tx(USERS.accountant, (client) =>
          client.query(
            `INSERT INTO lease_signed_pdfs (org_id, lease_id, file_id, object_path, content)
             SELECT org_id, lease_id, file_id, object_path || '-copy', content FROM lease_signed_pdfs WHERE lease_id = $1`,
            [leaseId],
          ),
        ),
      /errors\.forbidden/,
    );
  } finally {
    await tx(USERS.admin, async (client) => {
      await client.query(`DELETE FROM leases WHERE id = $1`, [leaseId]);
      await client.query(`DELETE FROM contacts WHERE org_id = $1 AND line_user_id = 'U-rls-line'`, [ORG_ID]);
      await client.query(`DELETE FROM files WHERE org_id = $1 AND storage_path LIKE $2`, [ORG_ID, `${ORG_ID}/${leaseId}/%`]);
    });
  }
});

async function assertPortalAccount(email: string) {
  const row = await query<{
    id: string;
    instance_id: string;
    aud: string;
    role: string;
    confirmation_token: string;
    recovery_token: string;
    email_change_token_new: string;
    email_change: string;
    email_change_token_current: string;
    phone_change: string;
    phone_change_token: string;
    reauthentication_token: string;
    created_at: Date | null;
    updated_at: Date | null;
  }>(
    `SELECT id::text, instance_id::text, aud, role,
            confirmation_token, recovery_token, email_change_token_new, email_change,
            email_change_token_current, phone_change, phone_change_token, reauthentication_token,
            created_at, updated_at
       FROM auth.users WHERE lower(email) = lower($1)`,
    [email],
  );
  const account = row.rows[0];
  assert.ok(account?.id);
  assert.equal(account.instance_id, "00000000-0000-0000-0000-000000000000");
  assert.equal(account.aud, "authenticated");
  assert.equal(account.role, "authenticated");
  assert.equal(account.confirmation_token, "");
  assert.equal(account.recovery_token, "");
  assert.equal(account.email_change_token_new, "");
  assert.equal(account.email_change, "");
  assert.equal(account.email_change_token_current, "");
  assert.equal(account.phone_change, "");
  assert.equal(account.phone_change_token, "");
  assert.equal(account.reauthentication_token, "");
  assert.ok(account.created_at);
  assert.ok(account.updated_at);
}

test("creating a property with a new owner works as service_role without write access to auth.users", async () => {
  const idDefault = await query<{ column_default: string | null }>(
    `SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'id'`,
  );
  assert.equal(idDefault.rows[0]?.column_default ?? null, null);
  const grants = await query<{ privilege_type: string }>(
    `SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = 'auth' AND table_name = 'users' AND grantee = 'service_role'`,
  );
  const privileges = grants.rows.map((row) => row.privilege_type);
  assert.equal(privileges.includes("INSERT"), false);
  assert.equal(privileges.includes("UPDATE"), false);
  assert.equal(privileges.includes("DELETE"), false);
  assert.equal(privileges.includes("SELECT"), false);

  const role = await svc(USERS.admin, async (client) => {
    const row = await client.query<{ role: string }>(`SELECT current_user AS role`);
    return row.rows[0].role;
  });
  assert.equal(role, "service_role");

  const email = `new.owner.${Date.now().toString(36)}@example.com`;
  await assert.rejects(
    () => svc(null, (client) => client.query(`INSERT INTO auth.users (email) VALUES ($1)`, [email])),
    (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden",
  );

  const admin: Session = {
    userId: USERS.admin,
    sessionId: "owner-provision",
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
  let propertyId = "";
  let contactId = "";
  try {
    const created = await createProperty(admin, {
      name: `新屋主物件 ${email}`,
      city: "台北市",
      district: "大安區",
      street: "測試路1號",
      currency: "TWD",
      ownerMode: "new",
      ownerName: "新屋主",
      ownerPhone: "+886912000222",
      ownerEmail: email,
      canViewTenantPhone: false,
      unitLabel: "2F",
      floor: "2",
      rentalMode: "whole_unit",
      rooms: [],
    });
    propertyId = created.propertyId;
    contactId = created.ownerContactId;
    const linked = await query<{ email: string; name: string }>(
      `SELECT u.email, p.display_name AS name
         FROM contacts c
         JOIN auth.users u ON u.id = c.user_id
         JOIN profiles p ON p.id = u.id
        WHERE c.id = $1 AND c.is_owner`,
      [contactId],
    );
    assert.equal(linked.rows[0]?.email, email);
    assert.equal(linked.rows[0]?.name, "新屋主");
    await assertPortalAccount(email);

    const unit = await query<{ id: string }>(`SELECT id::text FROM units WHERE property_id = $1`, [propertyId]);
    const tenantEmail = `new.tenant.${email}`;
    const lease = await createLease(admin, {
      roomId: unit.rows[0].id,
      tenantName: "新租客",
      tenantPhone: "+886912000333",
      tenantEmail,
      lineUserId: "",
      startDate: "2027-03-01",
      endDate: "2028-02-29",
      rentMajor: 15000,
      depositMonths: 2,
      depositReason: "",
      dueDay: 5,
      splitMethod: "even",
      periodStart: "2027-03-01",
      periodEnd: "2027-03-31",
      billTotalMajor: 1000,
      usageKwh: 100,
      rateMajor: 10,
      rateSource: "bill_average",
      overrideReason: "",
      subUsages: [],
    });
    const tenant = await query<{ email: string }>(
      `SELECT u.email FROM contacts c JOIN auth.users u ON u.id = c.user_id
        WHERE c.user_id = $1 AND c.is_tenant`,
      [lease.tenantUserId],
    );
    assert.equal(tenant.rows[0]?.email, tenantEmail);
    await assertPortalAccount(tenantEmail);
  } finally {
    const tenantEmail = `new.tenant.${email}`;
    await withClient(async (client) => {
      await client.query(`ALTER TABLE lease_signature_events DISABLE TRIGGER trg_lease_signature_events_append_only`);
      try {
        if (propertyId) {
          await client.query(
            `DELETE FROM utility_allocation_lines
              WHERE lease_id IN (SELECT id FROM leases WHERE property_id = $1)`,
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
        }
        if (contactId) {
          await client.query(`DELETE FROM management_agreements WHERE owner_contact_id = $1`, [contactId]);
        }
        if (propertyId) await client.query(`DELETE FROM properties WHERE id = $1`, [propertyId]);
        await client.query(
          `DELETE FROM contacts WHERE id = $1 OR lower(email::text) = lower($2) OR lower(email::text) = lower($3)`,
          [contactId || "00000000-0000-0000-0000-000000000000", email, tenantEmail],
        );
        await client.query(`DELETE FROM auth.users WHERE lower(email) = lower($1) OR lower(email) = lower($2)`, [email, tenantEmail]);
      } finally {
        await client.query(`ALTER TABLE lease_signature_events ENABLE TRIGGER trg_lease_signature_events_append_only`);
      }
    });
  }
});

test("another firm cannot issue or redeem a portal invite, and anon cannot read the lockout table", async () => {
  const admin: Session = {
    userId: USERS.admin,
    sessionId: "rls-invite",
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
  const contact = await tx(USERS.admin, (client) =>
    client.query<{ id: string }>(
      `INSERT INTO contacts (org_id, is_owner, display_name, email, locale)
       VALUES ($1, true, '隔離屋主', 'rls.owner@example.com', 'zh-TW') RETURNING id::text`,
      [ORG_ID],
    ),
  );
  const contactId = contact.rows[0].id;
  let userId: string | null = null;
  try {
    const issued = await issuePortalInvite(admin, { kind: "owner", contactId }, "https://app.condola.app");
    assert.equal(issued.activated, false);
    if (issued.activated) return;
    const owner = await query<{ user_id: string }>(`SELECT user_id::text AS user_id FROM contacts WHERE id = $1`, [contactId]);
    userId = owner.rows[0].user_id;

    const coast = await tx(USERS.coastAdmin, async (client) => {
      const selected = await client.query(`SELECT id FROM invitations WHERE contact_id = $1`, [contactId]);
      const updated = await client.query(`UPDATE invitations SET status = 'accepted' WHERE code_hash = $1`, [hashInviteToken(issued.token)]);
      return { selected: selected.rowCount, updated: updated.rowCount };
    });
    assert.equal(coast.selected, 0);
    assert.equal(coast.updated, 0);

    await assert.rejects(
      () =>
        tx(USERS.coastAdmin, (client) =>
          client.query(
            `INSERT INTO invitations (org_id, kind, contact_id, email, code_hash, expires_at, invited_by)
             VALUES ($1, 'owner', $2, 'rls.owner@example.com', $3, now() + interval '7 days', $4)`,
            [ORG_ID, contactId, hashInviteToken("other-firm"), USERS.coastAdmin],
          ),
        ),
      (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden",
    );
    await assert.rejects(
      () =>
        tx(USERS.accountant, (client) =>
          client.query(
            `INSERT INTO invitations (org_id, kind, contact_id, email, code_hash, expires_at, invited_by)
             VALUES ($1, 'owner', $2, 'accountant.rls@example.com', $3, now() + interval '7 days', $4)`,
            [ORG_ID, contactId, hashInviteToken("accountant"), USERS.accountant],
          ),
        ),
      (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden",
    );

    const grants = await query<{ grantee: string }>(
      `SELECT grantee FROM information_schema.role_table_grants
        WHERE table_name = 'portal_invite_attempts' AND grantee IN ('anon', 'authenticated', 'PUBLIC')`,
    );
    assert.equal(grants.rows.length, 0);
    await withClient(async (client) => {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE anon");
      await assert.rejects(() => client.query(`SELECT ip FROM portal_invite_attempts`), /permission denied/i);
      await client.query("ROLLBACK");
    });
  } finally {
    await query(`DELETE FROM invitations WHERE contact_id = $1`, [contactId]);
    await query(`UPDATE contacts SET user_id = NULL WHERE id = $1`, [contactId]);
    if (userId) {
      await query(`DELETE FROM profiles WHERE id = $1`, [userId]);
      await query(`DELETE FROM auth.users WHERE id = $1`, [userId]);
    }
    await query(`DELETE FROM contacts WHERE id = $1`, [contactId]);
  }
});

function pdfSession(userId: string, kind: Session["kind"], role: Session["role"], orgId: string): Session {
  return {
    userId,
    sessionId: "pdf",
    email: "pdf@test",
    name: "Pdf",
    kind,
    role,
    orgId,
    liveOrgId: orgId,
    environment: "live",
    locale: "zh-TW",
    calendar: "gregorian",
    leaseId: null,
  };
}

async function pdfAuditCount(table: string, rowId: string) {
  const rows = await tx(USERS.admin, (client) =>
    client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE table_name = $1 AND row_id = $2 AND event_type = 'pdf_download'`,
      [table, rowId],
    ),
  );
  return Number(rows.rows[0]?.n ?? 0);
}

test("PDF download follows RLS, records an audit row, and stays inside the firm", async () => {
  const lease = await tx(USERS.tenant, (client) =>
    client.query<{ id: string; document_sha256: string }>(
      `SELECT id::text, document_sha256 FROM leases WHERE org_id = $1 LIMIT 1`,
      [ORG_ID],
    ),
  );
  const leaseId = lease.rows[0]?.id;
  const hash = lease.rows[0]?.document_sha256;
  assert.ok(leaseId);
  assert.match(hash ?? "", /^[a-f0-9]{64}$/);

  const before = await pdfAuditCount("leases", leaseId);
  const maintenance = pdfSession(USERS.maintenance, "staff", "maintenance", ORG_ID);
  const visibleToMaintenance = await tx(USERS.maintenance, (client) =>
    client.query(`SELECT id FROM leases WHERE id = $1`, [leaseId]),
  );
  assert.equal(visibleToMaintenance.rows.length, 1);
  assert.equal(await leasePdfForSession(maintenance, leaseId), null);

  const coast = pdfSession(USERS.coastAdmin, "staff", "admin", ORG2_ID);
  const leaked = await tx(USERS.coastAdmin, (client) => client.query(`SELECT id FROM leases WHERE id = $1`, [leaseId]));
  assert.equal(leaked.rows.length, 0);
  assert.equal(await leasePdfForSession(coast, leaseId), null);
  assert.equal(await pdfAuditCount("leases", leaseId), before);

  const manager = pdfSession(USERS.manager, "staff", "manager", ORG_ID);
  const managerDoc = await leasePdfForSession(manager, leaseId);
  const managerText = JSON.stringify(managerDoc);
  const sublessor = "二" + "房東";
  assert.equal(managerDoc?.footerHash, hash);
  assert.match(managerText, /出租人/);
  assert.match(managerText, /承租人/);
  assert.match(managerText, /陳建宏/);
  assert.equal(managerText.includes(sublessor), true);
  assert.equal(managerText.split(sublessor).join("").includes("房東"), false);
  assert.equal(managerText.includes("88921"), false);

  const tenant = pdfSession(USERS.tenant, "tenant", null, ORG_ID);
  const tenantDoc = await leasePdfForSession(tenant, leaseId);
  const tenantText = JSON.stringify(tenantDoc);
  assert.equal(tenantDoc?.footerHash, hash);
  assert.match(tenantText, /承租人/);
  assert.match(tenantText, /出租人/);
  assert.match(tenantText, /陳建宏/);
  assert.equal(tenantText.includes("88921"), false);
  assert.equal(await pdfAuditCount("leases", leaseId), before + 2);

  const statement = await tx(USERS.owner, (client) =>
    client.query<{ id: string }>(`SELECT id::text FROM owner_statements LIMIT 1`),
  );
  const statementId = statement.rows[0]?.id;
  assert.ok(statementId);
  const statementBefore = await pdfAuditCount("owner_statements", statementId);
  assert.equal(await statementPdfForSession(tenant, statementId), null);
  assert.equal(await statementPdfForSession(coast, statementId), null);
  assert.equal(await statementPdfForSession(maintenance, statementId), null);
  assert.equal(await pdfAuditCount("owner_statements", statementId), statementBefore);

  const owner = pdfSession(USERS.owner, "owner", null, ORG_ID);
  const ownerDoc = await statementPdfForSession(owner, statementId);
  assert.match(JSON.stringify(ownerDoc), /屋主應補繳/);
  assert.equal(JSON.stringify(ownerDoc).includes("房東"), false);
  const managerStatement = await statementPdfForSession(manager, statementId);
  assert.ok(managerStatement);
  assert.equal(await pdfAuditCount("owner_statements", statementId), statementBefore + 2);
  const coastRead = await tx(USERS.coastAdmin, (client) =>
    client.query(`SELECT id FROM owner_statements WHERE id = $1`, [statementId]),
  );
  assert.equal(coastRead.rows.length, 0);
});
