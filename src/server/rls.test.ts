import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { writeAudit } from "./audit";
import { svc, tx } from "./db";
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
