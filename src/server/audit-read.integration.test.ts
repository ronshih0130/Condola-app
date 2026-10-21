import assert from "node:assert/strict";
import test from "node:test";
import { auditPageQuery, loadAuditHistory, loadAuditScreen } from "./audit-read";
import { query, tx } from "./db";
import { ORG2_ID, ORG_ID, USERS } from "./ids";
import type { Session } from "./types";

function staff(userId: string, role: Session["role"], orgId: string): Session {
  return {
    userId,
    sessionId: "audit-read",
    email: "audit@example.com",
    name: "Audit",
    kind: "staff",
    role,
    orgId,
    liveOrgId: orgId,
    environment: "live",
    locale: "zh-TW",
    calendar: "gregorian",
    leaseId: null,
  };
}

const admin = staff(USERS.admin, "admin", ORG_ID);
const coast = staff(USERS.coastAdmin, "admin", ORG2_ID);
const accountant = staff(USERS.accountant, "accountant", ORG_ID);
const manager = staff(USERS.manager, "manager", ORG_ID);

test("admins read only their firm's page, with sensitive fields masked", async () => {
  const leaseId = "10000000-0000-4000-8000-0000000000c1";
  const otherLease = "10000000-0000-4000-8000-0000000000c2";
  const secret = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const marker = `audit-marker-${Date.now()}`;
  await query(
    `INSERT INTO audit_log (org_id, actor_user_id, actor_role, table_name, row_id, action, reason, changed_cols, new_row, occurred_at)
     VALUES ($1, $2, 'app', 'leases', $3, 'update', $4, ARRAY['phone_e164','rent_amount_minor','number_hash']::text[], $5::jsonb, '2020-01-01T00:30:00Z'),
            ($1, $2, 'app', 'leases', $7, 'update', 'other-lease', NULL, '{}'::jsonb, '2020-01-01T00:31:00Z'),
            ($6, $2, 'app', 'leases', $3, 'update', 'org-two-marker', NULL, '{}'::jsonb, '2020-01-01T00:32:00Z')`,
    [
      ORG_ID,
      USERS.admin,
      leaseId,
      `${marker} 屋主同意 A123456789 ${secret} +886912345678`,
      JSON.stringify({ phone_e164: "+886912345678", number_hash: "hash-secret", number_masked: "A123456789" }),
      ORG2_ID,
      otherLease,
    ],
  );

  const page = await loadAuditScreen(admin, { record: "leases", from: "2020-01-01", to: "2020-01-01" });
  const hit = page.entries.find((entry) => entry.reason.includes(marker));
  assert.ok(hit);
  assert.match(hit.reason, /屋主同意/);
  assert.equal(hit.actionKey, "i_audit_act_update");
  assert.deepEqual(hit.fields, ["i_audit_f_rent"]);
  assert.equal(hit.masked, true);
  assert.equal(hit.when, "2020-01-01 08:30");
  const packed = JSON.stringify(page);
  assert.equal(packed.includes("org-two-marker"), false);
  assert.doesNotMatch(packed, /A123456789/);
  assert.doesNotMatch(packed, /\+886912345678/);
  assert.equal(packed.includes(secret), false);
  assert.equal(packed.includes("hash-secret"), false);
  assert.equal(packed.includes("number_hash"), false);
  assert.equal(packed.includes("phone_e164"), false);

  const history = await loadAuditHistory(admin, "leases", leaseId);
  assert.ok(history.entries.some((entry) => entry.reason.includes(marker)));
  const other = await loadAuditHistory(admin, "leases", otherLease);
  assert.equal(other.entries.some((entry) => entry.reason.includes(marker)), false);

  const coastPage = await loadAuditScreen(coast, { record: "leases", from: "2020-01-01", to: "2020-01-01" });
  assert.equal(JSON.stringify(coastPage).includes(marker), false);
  assert.ok(coastPage.entries.some((entry) => entry.reason === "org-two-marker"));

  const hidden = await loadAuditScreen(accountant, { record: "leases", from: "2020-01-01", to: "2020-01-01" });
  assert.deepEqual(hidden.entries, []);
  const managerHistory = await loadAuditHistory(manager, "leases", leaseId);
  assert.deepEqual(managerHistory.entries, []);

  const denied = await tx(USERS.accountant, (client) =>
    client.query(`SELECT id FROM audit_log WHERE reason LIKE $1`, [`%${marker}%`]),
  );
  assert.equal(denied.rows.length, 0);
  const managerDenied = await tx(USERS.manager, (client) =>
    client.query(`SELECT id FROM audit_log WHERE org_id = $1 AND reason LIKE $2`, [ORG_ID, `%${marker}%`]),
  );
  assert.equal(managerDenied.rows.length, 0);
});

test("keyset plans seek an index and do not sort", async () => {
  await query(`ANALYZE audit_log`);
  const cases = [
    {
      index: "audit_log_org_keyset_idx",
      input: {
        actorId: null,
        action: null as "update" | null,
        eventType: null,
        tableName: null,
        rowId: null,
      },
    },
    {
      index: "audit_log_actor_keyset_idx",
      input: {
        actorId: USERS.admin,
        action: null as "update" | null,
        eventType: null,
        tableName: null,
        rowId: null,
      },
    },
    {
      index: "audit_log_record_keyset_idx",
      input: {
        actorId: null,
        action: null as "update" | null,
        eventType: null,
        tableName: "leases",
        rowId: "10000000-0000-4000-8000-0000000000c1",
      },
    },
  ];
  for (const item of cases) {
    const built = auditPageQuery({
      orgId: ORG_ID,
      ...item.input,
      from: null,
      to: null,
      cursor: { at: "2026-10-21T00:00:00.000000Z", id: "1" },
      limit: 26,
    });
    const plan = await tx(USERS.admin, async (client) => {
      await client.query("SET LOCAL enable_seqscan = off");
      await client.query("SET LOCAL enable_bitmapscan = off");
      await client.query("SET LOCAL enable_sort = off");
      const explained = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN ${built.sql}`, built.params);
      return explained.rows.map((row) => row["QUERY PLAN"]).join("\n");
    });
    assert.match(plan, new RegExp(item.index), plan);
    assert.doesNotMatch(plan, /Sort/);
    assert.doesNotMatch(plan, /Seq Scan on audit_log/);
  }
});
