import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { writeAudit } from "./audit";
import { query, svc, tx } from "./db";
import { createProperty } from "./domain";
import { FlowError } from "./errors";
import { ORG2_ID, ORG_ID, USERS } from "./ids";
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

test("creating a property with a new owner works as service_role without write access to auth.users", async () => {
  const grants = await query<{ privilege_type: string }>(
    `SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = 'auth' AND table_name = 'users' AND grantee = 'service_role'`,
  );
  const privileges = grants.rows.map((row) => row.privilege_type);
  assert.equal(privileges.includes("INSERT"), false);
  assert.equal(privileges.includes("UPDATE"), false);
  assert.equal(privileges.includes("DELETE"), false);

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
  } finally {
    if (contactId) {
      await query(`DELETE FROM management_agreements WHERE owner_contact_id = $1`, [contactId]);
      if (propertyId) await query(`DELETE FROM properties WHERE id = $1`, [propertyId]);
      await query(`DELETE FROM contacts WHERE id = $1`, [contactId]);
    }
    await query(`DELETE FROM auth.users WHERE lower(email) = lower($1)`, [email]);
  }
});
