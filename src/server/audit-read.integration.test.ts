import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { auditPageQuery, encodeCursor, loadAuditHistory, loadAuditScreen } from "./audit-read";
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
      `${marker} 屋主同意 A123456789 ${secret} +886912345678 02-2345-6789 0912-345-678`,
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
  assert.doesNotMatch(packed, /02-2345-6789/);
  assert.doesNotMatch(packed, /0912-345-678/);
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

test("an invalid cursor opens the first page", async () => {
  const cursors = [
    encodeCursor("2026-13-40T99:99:99.000000Z", "1"),
    encodeCursor("2026-10-21T01:02:03.123456Z", "9999999999999999999"),
    "a".repeat(240),
    "not-a-cursor",
  ];
  const first = await loadAuditScreen(admin, {});
  assert.ok(first.entries.length > 0);
  for (const cursor of cursors) {
    const page = await loadAuditScreen(admin, { cursor });
    assert.equal(page.filters.cursor, null);
    assert.equal(page.entries[0]?.cursor, first.entries[0]?.cursor);
    assert.equal(page.entries.length, first.entries.length);
  }
});

async function queryCount(run: () => Promise<unknown>) {
  const orig = Client.prototype.query as (queryText: string, values?: unknown[]) => Promise<unknown>;
  let n = 0;
  Client.prototype.query = function (this: Client, queryText: string, values?: unknown[]) {
    if (!/^\s*(BEGIN|COMMIT|ROLLBACK|SET\b|SELECT set_config\()/i.test(String(queryText))) n += 1;
    return values === undefined ? orig.call(this, queryText) : orig.call(this, queryText, values);
  } as typeof Client.prototype.query;
  try {
    await run();
  } finally {
    Client.prototype.query = orig as typeof Client.prototype.query;
  }
  return n;
}

test("the audit page stays within three queries", async () => {
  const tables = [
    "leases",
    "contacts",
    "properties",
    "units",
    "rooms",
    "property_owners",
    "payments",
    "invoices",
    "owner_statements",
    "maintenance_tickets",
    "org_members",
    "lease_signatures",
    "lease_parties",
    "lease_charges",
    "ledger_transactions",
    "management_agreements",
  ];
  const rowId = "10000000-0000-4000-8000-0000000000c9";
  const values = tables
    .map((table, index) => `($1, $2, 'app', '${table}', $3, 'update', 'qcount', NULL, '{}'::jsonb, timestamptz '2099-01-01' + (${index} || ' seconds')::interval)`)
    .join(",\n");
  await query(
    `INSERT INTO audit_log (org_id, actor_user_id, actor_role, table_name, row_id, action, reason, changed_cols, new_row, occurred_at)
     VALUES ${values}`,
    [ORG_ID, USERS.admin, rowId],
  );
  const screen = await queryCount(() => loadAuditScreen(admin, {}));
  assert.equal(screen, 2);
  const history = await queryCount(() => loadAuditHistory(admin, "leases", "10000000-0000-4000-8000-0000000000c1"));
  assert.ok(history <= 2);
  const empty = await queryCount(() => loadAuditScreen(admin, { from: "1990-01-01", to: "1990-01-01" }));
  assert.equal(empty, 1);
  const denied = await queryCount(() => loadAuditScreen(accountant, {}));
  assert.equal(denied, 0);
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
    // The added restrictive policy can make the planner prefer the org keyset
    // over a more selective composite index on this small fixture. Both must
    // seek the cursor in index order; do not prescribe a cost-based choice.
    assert.match(plan, new RegExp(`${item.index}|audit_log_org_keyset_idx`), plan);
    assert.match(plan, /Index Cond:.*ROW\(occurred_at, id\)/, plan);
    assert.doesNotMatch(plan, /Sort/);
    assert.doesNotMatch(plan, /Seq Scan on audit_log/);
  }
});
