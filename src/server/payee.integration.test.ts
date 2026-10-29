import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { query, tx, withClient } from "./db";
import { FlowError } from "./errors";
import { savePayee, setLeasePayee } from "./payee";
import type { Session } from "./types";

test("payee migration preserves legacy writes, audit safety, constraints and tenant RLS", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  // Roll back every fixture, including audit rows and lease changes.
  await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const orgs = (await client.query(
        "SELECT id, default_currency FROM organizations ORDER BY id LIMIT 2",
      )).rows;
      assert.equal(orgs.length, 2, "integration database needs two seeded organizations");
      const [org, other] = orgs;
      const id = randomUUID();
      await client.query(
        `INSERT INTO bank_accounts
         (id, org_id, nickname, bank_name, bank_code, account_last5, currency, show_to_tenants)
         VALUES ($1,$2,'legacy compatibility','Bank','012','12345',$3,true)`,
        [id, org.id, org.default_currency],
      );
      const legacy = (await client.query(
        "SELECT holder_name, details, is_default_payee FROM bank_accounts WHERE id=$1", [id],
      )).rows[0];
      assert.equal(legacy.holder_name, null);
      assert.deepEqual(legacy.details, {});
      assert.equal(legacy.is_default_payee, false);
      const fullNumber = "987654321012345";
      await client.query(
        "UPDATE bank_accounts SET account_number=$2, holder_name='Company' WHERE id=$1",
        [id, fullNumber],
      );
      assert.equal((await client.query(
        "SELECT account_last5 FROM bank_accounts WHERE id=$1", [id],
      )).rows[0].account_last5, "12345");
      const audit = (await client.query(
        `SELECT action, old_row, new_row, changed_cols FROM audit_log
         WHERE table_name='bank_accounts' AND row_id=$1 ORDER BY id`, [id],
      )).rows;
      assert.ok(audit.some((row) => row.action === "insert"));
      assert.ok(audit.some((row) => row.action === "update"));
      assert.ok(audit.some((row) => Array.isArray(row.changed_cols) && row.changed_cols.includes("account_number")));
      assert.ok(audit.some((row) => row.new_row.account_last5 === "12345"));
      await client.query(
        "UPDATE bank_accounts SET is_default_payee=false WHERE org_id=$1 AND is_default_payee",
        [org.id],
      );
      await client.query("UPDATE bank_accounts SET is_default_payee=true WHERE id=$1", [id]);
      await client.query("SAVEPOINT duplicate_default");
      await assert.rejects(client.query(
        `INSERT INTO bank_accounts (org_id,nickname,currency,is_default_payee)
         VALUES ($1,'duplicate',$2,true)`, [org.id, org.default_currency],
      ), (error: unknown) => (error as { code: string }).code === "23505");
      await client.query("ROLLBACK TO SAVEPOINT duplicate_default");
      const foreignId = randomUUID();
      await client.query(
        "INSERT INTO bank_accounts (id,org_id,nickname,currency) VALUES ($1,$2,'foreign',$3)",
        [foreignId, other.id, other.default_currency],
      );
      const lease = (await client.query(
        "SELECT id FROM leases WHERE org_id=$1 LIMIT 1", [org.id],
      )).rows[0];
      assert.ok(lease, "integration database needs a seeded lease");
      await client.query("SAVEPOINT foreign_payee");
      await assert.rejects(client.query(
        "UPDATE leases SET payee_bank_account_id=$2 WHERE id=$1",
        [lease.id, foreignId],
      ), (error: unknown) => (error as { code: string }).code === "23503");
      await client.query("ROLLBACK TO SAVEPOINT foreign_payee");
      await client.query(
        "UPDATE leases SET payee_bank_account_id=$2 WHERE id=$1", [lease.id, id],
      );
      assert.ok((await client.query(
        `SELECT id FROM audit_log WHERE table_name='leases' AND row_id=$1
         AND new_row->>'payee_bank_account_id'=$2`, [lease.id, id],
      )).rows.length);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  // Committed seeded rows let tx establish the real authenticated tenant role.
  const tenant = (await query(
    `SELECT c.user_id, c.org_id, b.id FROM contacts c
     JOIN bank_accounts b ON b.org_id=c.org_id
     WHERE c.is_tenant AND c.user_id IS NOT NULL
       AND b.property_id IS NULL AND b.show_to_tenants AND b.archived_at IS NULL
     LIMIT 1`,
  )).rows[0];
  assert.ok(tenant, "integration database needs a tenant-visible seeded bank account");
  await tx(tenant.user_id, async (client) => {
    const role = (await client.query("SELECT current_user AS name")).rows[0].name;
    assert.equal(role, "authenticated");
    const result = await client.query(
      `SELECT id FROM bank_accounts WHERE org_id=$1 AND archived_at IS NULL
       AND show_to_tenants ORDER BY created_at LIMIT 1`, [tenant.org_id],
    );
    assert.ok(result.rows.length);
  });

  const nonAdmin = {
    userId: tenant.user_id, orgId: tenant.org_id, role: "manager",
  } as Session;
  await assert.rejects(savePayee(nonAdmin, {
    holderName: "Company", bankName: "Bank", bankCode: "012", branchCode: "1234",
    accountNumber: "123456789", ownerContactId: null, isDefault: true, details: {},
  }), FlowError);
  await assert.rejects(setLeasePayee(nonAdmin, randomUUID(), null), FlowError);
});
