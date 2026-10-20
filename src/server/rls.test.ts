import assert from "node:assert/strict";
import test from "node:test";
import { writeAudit } from "./audit";
import { tx } from "./db";
import { ORG2_ID, ORG_ID, USERS } from "./ids";

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
