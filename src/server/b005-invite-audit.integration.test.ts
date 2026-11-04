import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { disposableDbUrl } from "./test-disposable-db";
import { cloneTestDatabase } from "./test-database-clone";

const target = disposableDbUrl(
  process.env.DATABASE_URL,
  process.env.CONDOLA_RLS_DISPOSABLE,
);

let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;

test.before(async () => {
  if (target) clone = await cloneTestDatabase();
});

test.after(async () => {
  if (clone) await clone.cleanup();
});

type AuditRow = {
  action: string;
  old_row: Record<string, unknown> | null;
  new_row: Record<string, unknown> | null;
  changed_cols: string[] | null;
  reason: string | null;
  request_id: string | null;
};

test("invitation audits accept US phones and malformed emails", {
  skip: !target,
}, async () => {
  assert.ok(clone);
  const client = new Client({ connectionString: clone.url });
  await client.connect();

  try {
    await client.query("BEGIN");

    const orgId = randomUUID();
    const invitationId = randomUUID();

    await client.query(
      `INSERT INTO organizations (id, name, country_code, default_currency)
       VALUES ($1, $2, 'TW', 'TWD')`,
      [orgId, `B005 fallback audit organization ${orgId}`],
    );

    const inserted = await client.query(
      `INSERT INTO invitations
         (id, org_id, kind, role, email, phone_e164, code_hash)
       VALUES ($1, $2, 'team_member', 'manager', $3, $4, $5)
       RETURNING id`,
      [invitationId, orgId, "xobody", "+14155550123", "deadbeef".repeat(8)],
    );
    assert.equal(inserted.rows.length, 1);
    assert.equal(inserted.rows[0].id, invitationId);

    const audits = await client.query<AuditRow>(
      `SELECT action::text, old_row, new_row, changed_cols, reason, request_id
         FROM audit_log
        WHERE table_name = 'invitations' AND row_id = $1
          AND action = 'insert'`,
      [invitationId],
    );
    assert.equal(audits.rows.length, 1);
    assert.ok(audits.rows[0].new_row);
    assert.equal(audits.rows[0].new_row.phone_e164, "+*********23");
    assert.equal(audits.rows[0].new_row.email, "x***@");
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
  }
});

test("audit insert failures abort invitation writes", {
  skip: !target,
}, async () => {
  assert.ok(clone);
  const client = new Client({ connectionString: clone.url });
  await client.connect();

  try {
    await client.query("BEGIN");

    const orgId = randomUUID();
    const invitationId = randomUUID();
    const rejectedId = randomUUID();
    const email = "alice@example.com";

    await client.query(
      `INSERT INTO organizations (id, name, country_code, default_currency)
       VALUES ($1, $2, 'TW', 'TWD')`,
      [orgId, `B005 audit failure organization ${orgId}`],
    );
    await client.query(
      `INSERT INTO invitations
         (id, org_id, kind, role, email, code_hash)
       VALUES ($1, $2, 'team_member', 'manager', $3, $4)`,
      [invitationId, orgId, email, "deadbeef".repeat(8)],
    );

    await client.query("SAVEPOINT audit_failure_setup");
    await client.query(
      `CREATE FUNCTION pg_temp.b005_reject_audit_insert()
       RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         RAISE EXCEPTION 'B005 forced audit insert failure';
       END;
       $$`,
    );
    await client.query(
      `CREATE TRIGGER b005_reject_audit_insert
       BEFORE INSERT ON public.audit_log
       FOR EACH ROW EXECUTE FUNCTION pg_temp.b005_reject_audit_insert()`,
    );

    await client.query("SAVEPOINT rejected_insert");
    await assert.rejects(
      client.query(
        `INSERT INTO invitations
           (id, org_id, kind, role, email, code_hash)
         VALUES ($1, $2, 'team_member', 'manager', $3, $4)`,
        [rejectedId, orgId, "bob@example.com", "cafebabe".repeat(8)],
      ),
      /B005 forced audit insert failure/,
    );
    await client.query("ROLLBACK TO SAVEPOINT rejected_insert");
    const rejected = await client.query(
      "SELECT id FROM invitations WHERE id = $1",
      [rejectedId],
    );
    assert.equal(rejected.rows.length, 0);

    await client.query("SAVEPOINT rejected_update");
    await assert.rejects(
      client.query(
        "UPDATE invitations SET email = $2 WHERE id = $1",
        [invitationId, "changed@example.com"],
      ),
      /B005 forced audit insert failure/,
    );
    await client.query("ROLLBACK TO SAVEPOINT rejected_update");
    const unchanged = await client.query(
      "SELECT email FROM invitations WHERE id = $1",
      [invitationId],
    );
    assert.equal(unchanged.rows.length, 1);
    assert.equal(unchanged.rows[0].email, email);

    await client.query("ROLLBACK TO SAVEPOINT audit_failure_setup");
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
  }
});

test("invitation audits mask personal data and omit secrets while preserving generic audits", {
  skip: !target,
}, async () => {
  assert.ok(clone);
  const client = new Client({ connectionString: clone.url });
  await client.connect();

  try {
    await client.query("BEGIN");

    const orgId = randomUUID();
    const invitationId = randomUUID();
    const orgName = `B005 audit organization ${orgId}`;
    const hash = "deadbeef".repeat(8);
    const nextHash = "cafebabe".repeat(8);
    const requestId = randomUUID();

    await client.query(
      `SELECT set_config('app.change_reason', $1, true),
              set_config('app.request_id', $2, true)`,
      ["B005 integration test", requestId],
    );

    await client.query(
      `INSERT INTO organizations (id, name, country_code, default_currency)
       VALUES ($1, $2, 'TW', 'TWD')`,
      [orgId, orgName],
    );

    // Capture the generic audit before invitation operations.
    const organizationAudit = await client.query(
      `SELECT id, old_row, new_row
         FROM audit_log
        WHERE table_name = 'organizations'
          AND row_id = $1
          AND action = 'insert'`,
      [orgId],
    );
    assert.equal(organizationAudit.rows.length, 1);
    assert.equal(organizationAudit.rows[0].new_row.name, orgName);

    await client.query(
      `INSERT INTO invitations
         (id, org_id, kind, role, email, phone_e164, code_hash)
       VALUES ($1, $2, 'team_member', 'manager', $3, $4, $5)`,
      [invitationId, orgId, "alice.smith@example.com", "+886912345678", hash],
    );

    const auditsBeforeNoop = await client.query(
      `SELECT id FROM audit_log
        WHERE table_name = 'invitations' AND row_id = $1
        ORDER BY id`,
      [invitationId],
    );
    assert.equal(auditsBeforeNoop.rows.length, 1);

    const noop = await client.query(
      `UPDATE invitations SET email = email WHERE id = $1`,
      [invitationId],
    );
    assert.equal(noop.rowCount, 1);

    const auditsAfterNoop = await client.query(
      `SELECT id FROM audit_log
        WHERE table_name = 'invitations' AND row_id = $1
        ORDER BY id`,
      [invitationId],
    );
    assert.deepEqual(auditsAfterNoop.rows, auditsBeforeNoop.rows);

    await client.query(
      `UPDATE invitations SET status = 'revoked', code_hash = $2 WHERE id = $1`,
      [invitationId, nextHash],
    );
    await client.query("DELETE FROM invitations WHERE id = $1", [invitationId]);

    const audits = await client.query<AuditRow>(
      `SELECT action::text, old_row, new_row, changed_cols, reason, request_id
         FROM audit_log
        WHERE table_name = 'invitations' AND row_id = $1`,
      [invitationId],
    );
    assert.equal(audits.rows.length, 3);
    assert.deepEqual(
      audits.rows.map((row) => row.action).sort(),
      ["delete", "insert", "update"],
    );

    for (const audit of audits.rows) {
      assert.equal(audit.reason, "B005 integration test");
      assert.equal(audit.request_id, requestId);

      for (const row of [audit.old_row, audit.new_row]) {
        if (row === null) continue;
        assert.equal(row.email, "a***@example.com");
        assert.equal(row.phone_e164, "+886*******78");
        for (const key of [
          "code_hash", "token", "token_hash", "invite_token",
          "invite_token_hash", "portal_token", "portal_token_hash",
        ]) {
          assert.equal(Object.hasOwn(row, key), false);
        }
        const serialized = JSON.stringify(row);
        assert.equal(serialized.includes("alice.smith"), false);
        assert.equal(serialized.includes("+886912345678"), false);
        assert.equal(serialized.includes(hash), false);
        assert.equal(serialized.includes(nextHash), false);
      }
    }

    const inserted = audits.rows.find((row) => row.action === "insert");
    const updated = audits.rows.find((row) => row.action === "update");
    const deleted = audits.rows.find((row) => row.action === "delete");
    assert.ok(inserted);
    assert.ok(updated);
    assert.ok(deleted);
    assert.equal(inserted.old_row, null);
    assert.equal(deleted.new_row, null);
    assert.ok(updated.changed_cols?.includes("status"));
    assert.ok(updated.changed_cols?.includes("code_hash"));
    assert.equal(updated.changed_cols?.includes("updated_at"), false);

    const organizationAuditAfter = await client.query(
      `SELECT id, old_row, new_row
         FROM audit_log
        WHERE table_name = 'organizations'
          AND row_id = $1
          AND action = 'insert'`,
      [orgId],
    );
    assert.deepEqual(organizationAuditAfter.rows, organizationAudit.rows);
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
  }
});
