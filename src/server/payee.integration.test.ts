import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { withClient } from "./db";
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
        `SELECT o.id, o.default_currency FROM organizations o
         WHERE o.environment::text <> 'sandbox'
         ORDER BY (EXISTS (SELECT 1 FROM org_members m WHERE m.org_id=o.id AND m.role='admin')
               AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id=o.id AND m.role='manager')
               AND EXISTS (SELECT 1 FROM contacts c WHERE c.org_id=o.id AND c.is_tenant AND c.user_id IS NOT NULL)) DESC, o.id
         LIMIT 2`,
      )).rows;
      assert.equal(orgs.length, 2, "integration database needs two seeded organizations");
      const [org, other] = orgs;

      const tenant = (await client.query(
        `SELECT user_id FROM contacts WHERE org_id=$1
         AND is_tenant AND user_id IS NOT NULL LIMIT 1`,
        [org.id],
      )).rows[0];
      const members = (await client.query(
        `SELECT user_id, role FROM org_members
         WHERE org_id=$1 AND role IN ('admin','manager','accountant','maintenance')`,
        [org.id],
      )).rows;
      const admin = members.find((member) => member.role === "admin");
      const manager = members.find((member) => member.role === "manager");
      assert.ok(tenant, "integration database needs a tenant");
      assert.ok(admin, "integration database needs an admin");
      assert.ok(manager, "integration database needs a manager");

      let otherAdmin = (await client.query(
        `SELECT m.user_id FROM org_members m
         WHERE m.org_id=$1 AND m.role='admin'
           AND NOT EXISTS (
             SELECT 1 FROM org_members own
             WHERE own.org_id=$2 AND own.user_id=m.user_id AND own.role='admin'
           )
         LIMIT 1`,
        [other.id, org.id],
      )).rows[0];
      if (!otherAdmin) {
        const userId = randomUUID();
        await client.query("INSERT INTO auth.users (id) VALUES ($1)", [userId]);
        await client.query(
          "INSERT INTO org_members (org_id,user_id,role) VALUES ($1,$2,'admin')",
          [other.id, userId],
        );
        otherAdmin = { user_id: userId };
      }

      const id = randomUUID();
      await client.query(
        `INSERT INTO bank_accounts
         (id, org_id, nickname, bank_name, bank_code, account_last5, currency, show_to_tenants)
         VALUES ($1,$2,'legacy compatibility','Bank','012','12345',$3,true)`,
        [id, org.id, org.default_currency],
      );
      const legacy = (await client.query(
        "SELECT holder_name, details, is_default_payee FROM bank_accounts WHERE id=$1",
        [id],
      )).rows[0];
      assert.equal(legacy.holder_name, null);
      assert.deepEqual(legacy.details, {});
      assert.equal(legacy.is_default_payee, false);

      const previousNumber = "876543210998765";
      const fullNumber = "987654321012345";
      const previousLast5 = previousNumber.slice(-5);
      const currentLast5 = fullNumber.slice(-5);
      await client.query("SET LOCAL ROLE authenticated");
      await client.query(
        "SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', 'authenticated', true)",
        [admin.user_id],
      );
      assert.equal(
        (await client.query("SELECT current_user AS name")).rows[0].name,
        "authenticated",
      );
      await client.query(
        `INSERT INTO payee_account_numbers (bank_account_id,org_id,account_number)
         VALUES ($1,$2,$3)`,
        [id, org.id, previousNumber],
      );
      await client.query(
        `INSERT INTO payee_account_numbers (bank_account_id,org_id,account_number)
         VALUES ($1,$2,$3)
         ON CONFLICT (bank_account_id) DO UPDATE
         SET account_number=EXCLUDED.account_number
         WHERE payee_account_numbers.org_id=EXCLUDED.org_id`,
        [id, org.id, fullNumber],
      );
      assert.deepEqual((await client.query(
        `SELECT bank_account_id,account_number FROM payee_account_numbers
         WHERE bank_account_id=$1`,
        [id],
      )).rows, [{ bank_account_id: id, account_number: fullNumber }]);
      await client.query("RESET ROLE");

      assert.equal((await client.query(
        "SELECT account_last5 FROM bank_accounts WHERE id=$1",
        [id],
      )).rows[0].account_last5, currentLast5);

      const assertAuditSafety = async () => {
        const audit = (await client.query(
          `SELECT * FROM audit_log WHERE row_id=$1 ORDER BY id`,
          [id],
        )).rows;
        assert.ok(audit.some((row) => row.action === "insert"));
        assert.ok(audit.some((row) => row.action === "update"));
        const auditJson = JSON.stringify(audit);
        assert.equal(auditJson.includes(fullNumber), false);
        assert.equal(auditJson.includes(previousNumber), false);
        for (const table of ["bank_accounts", "payee_account_numbers"]) {
          assert.ok(audit.some((row) =>
            row.table_name === table && row.new_row?.account_last5 === currentLast5
          ));
        }

        const numberAudit = audit.filter((row) => row.table_name === "payee_account_numbers");
        assert.equal(numberAudit.length, 2);
        const insertAudit = numberAudit.find((row) => row.action === "insert");
        const updateAudit = numberAudit.find((row) => row.action === "update");
        assert.ok(insertAudit);
        assert.ok(updateAudit);
        assert.equal(insertAudit.old_row, null);
        assert.deepEqual(insertAudit.new_row, { account_last5: previousLast5 });
        assert.deepEqual(updateAudit.old_row, { account_last5: previousLast5 });
        assert.deepEqual(updateAudit.new_row, { account_last5: currentLast5 });
        for (const row of numberAudit) {
          for (const snapshot of [row.old_row, row.new_row]) {
            if (snapshot !== null) {
              assert.deepEqual(Object.keys(snapshot), ["account_last5"]);
            }
          }
          assert.deepEqual(row.changed_cols, ["account_number"]);
          assert.equal(row.actor_user_id, admin.user_id);
        }
      };
      await assertAuditSafety();

      const storedNumber = (await client.query(
        `SELECT account_number, updated_by FROM payee_account_numbers
         WHERE bank_account_id=$1`,
        [id],
      )).rows[0];
      assert.equal(storedNumber.account_number, fullNumber);
      assert.equal(storedNumber.updated_by, admin.user_id);

      await client.query(
        "UPDATE bank_accounts SET is_default_payee=false WHERE org_id=$1 AND is_default_payee",
        [org.id],
      );
      await client.query("UPDATE bank_accounts SET is_default_payee=true WHERE id=$1", [id]);
      await client.query("SAVEPOINT duplicate_default");
      await assert.rejects(client.query(
        `INSERT INTO bank_accounts (org_id,nickname,currency,is_default_payee)
         VALUES ($1,'duplicate',$2,true)`,
        [org.id, org.default_currency],
      ), (error: unknown) => (error as { code: string }).code === "23505");
      await client.query("ROLLBACK TO SAVEPOINT duplicate_default");
      await client.query("RELEASE SAVEPOINT duplicate_default");

      const foreignId = randomUUID();
      await client.query(
        `INSERT INTO bank_accounts (id,org_id,nickname,currency,show_to_tenants)
         VALUES ($1,$2,'foreign',$3,true)`,
        [foreignId, other.id, other.default_currency],
      );
      const hiddenId = randomUUID();
      const deniedId = randomUUID();
      await client.query(
        `INSERT INTO bank_accounts (id,org_id,nickname,currency,show_to_tenants)
         VALUES ($1,$3,'hidden',$4,false), ($2,$3,'write denial',$4,true)`,
        [hiddenId, deniedId, org.id, org.default_currency],
      );
      await client.query(
        `INSERT INTO payee_account_numbers (bank_account_id,org_id,account_number)
         VALUES ($1,$3,'1111122222'), ($2,$4,'3333344444')`,
        [hiddenId, foreignId, org.id, other.id],
      );

      await client.query("SET LOCAL ROLE authenticated");
      await client.query(
        "SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', 'authenticated', true)",
        [tenant.user_id],
      );
      assert.equal(
        (await client.query("SELECT current_user AS name")).rows[0].name,
        "authenticated",
      );
      const visible = (await client.query(
        `SELECT bank_account_id,account_number FROM payee_account_numbers
         WHERE bank_account_id = ANY($1::uuid[])`,
        [[id, hiddenId, foreignId]],
      )).rows;
      assert.deepEqual(visible, []);

      const deniedUsers = [
        { user_id: tenant.user_id, role: "tenant" },
        manager,
        ...["accountant", "maintenance"].flatMap((role) => {
          const member = members.find((candidate) => candidate.role === role);
          return member ? [member] : [];
        }),
      ];
      for (const member of deniedUsers) {
        await client.query(
          "SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', 'authenticated', true)",
          [member.user_id],
        );
        assert.deepEqual((await client.query(
          `SELECT bank_account_id,account_number FROM payee_account_numbers
           WHERE bank_account_id = ANY($1::uuid[])`,
          [[id, hiddenId, foreignId]],
        )).rows, [], `${member.role} must not read account numbers`);

        await client.query("SAVEPOINT denied_number_insert");
        await assert.rejects(client.query(
          `INSERT INTO payee_account_numbers (bank_account_id,org_id,account_number)
           VALUES ($1,$2,'5555566666')`,
          [deniedId, org.id],
        ), (error: unknown) => (error as { code: string }).code === "42501");
        await client.query("ROLLBACK TO SAVEPOINT denied_number_insert");
        await client.query("RELEASE SAVEPOINT denied_number_insert");

        await client.query("SAVEPOINT denied_number_update");
        const updated = await client.query(
          `UPDATE payee_account_numbers SET account_number='5555566666'
           WHERE bank_account_id=$1 AND org_id=$2
           RETURNING bank_account_id`,
          [id, org.id],
        );
        assert.equal(updated.rowCount, 0, `${member.role} must not update account numbers`);
        await client.query("ROLLBACK TO SAVEPOINT denied_number_update");
        await client.query("RELEASE SAVEPOINT denied_number_update");
      }

      await client.query(
        "SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', 'authenticated', true)",
        [otherAdmin.user_id],
      );
      assert.deepEqual((await client.query(
        "SELECT bank_account_id,account_number FROM payee_account_numbers WHERE org_id=$1",
        [org.id],
      )).rows, []);
      assert.deepEqual((await client.query(
        `SELECT bank_account_id,account_number FROM payee_account_numbers
         WHERE bank_account_id=$1`,
        [foreignId],
      )).rows, [{ bank_account_id: foreignId, account_number: "3333344444" }]);

      await client.query(
        "SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', 'authenticated', true)",
        [admin.user_id],
      );
      assert.deepEqual((await client.query(
        `SELECT bank_account_id,account_number FROM payee_account_numbers
         WHERE bank_account_id=$1`,
        [id],
      )).rows, [{ bank_account_id: id, account_number: fullNumber }]);
      await client.query("RESET ROLE");

      await client.query("SET LOCAL ROLE service_role");
      await client.query(
        "SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', 'service_role', true)",
      );
      assert.equal(
        (await client.query("SELECT current_user AS name")).rows[0].name,
        "service_role",
      );
      assert.deepEqual((await client.query(
        `SELECT bank_account_id,account_number FROM payee_account_numbers
         WHERE bank_account_id=$1`,
        [id],
      )).rows, [{ bank_account_id: id, account_number: fullNumber }]);
      await client.query("RESET ROLE");
      await client.query(
        "SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', 'authenticated', true)",
        [admin.user_id],
      );

      assert.equal((await client.query(
        "SELECT account_number FROM payee_account_numbers WHERE bank_account_id=$1",
        [id],
      )).rows[0].account_number, fullNumber);
      assert.equal((await client.query(
        "SELECT account_last5 FROM bank_accounts WHERE id=$1",
        [id],
      )).rows[0].account_last5, currentLast5);
      assert.equal((await client.query(
        "SELECT bank_account_id FROM payee_account_numbers WHERE bank_account_id=$1",
        [deniedId],
      )).rows.length, 0);

      const nonAdmin = {
        userId: manager.user_id, orgId: org.id, role: "manager",
      } as Session;
      await assert.rejects(savePayee(nonAdmin, {
        holderName: "Company", bankName: "Bank", bankCode: "012", branchCode: "1234",
        accountNumber: "123456789", ownerContactId: null, isDefault: true, details: {},
      }), FlowError);
      await assert.rejects(setLeasePayee(nonAdmin, randomUUID(), null), FlowError);

      const lease = (await client.query(
        "SELECT id FROM leases WHERE org_id=$1 LIMIT 1",
        [org.id],
      )).rows[0];
      assert.ok(lease, "integration database needs a seeded lease");
      await client.query("SAVEPOINT foreign_payee");
      await assert.rejects(client.query(
        "UPDATE leases SET payee_bank_account_id=$2 WHERE id=$1",
        [lease.id, foreignId],
      ), (error: unknown) => (error as { code: string }).code === "23503");
      await client.query("ROLLBACK TO SAVEPOINT foreign_payee");
      await client.query("RELEASE SAVEPOINT foreign_payee");
      await client.query(
        "UPDATE leases SET payee_bank_account_id=$2 WHERE id=$1",
        [lease.id, id],
      );
      assert.ok((await client.query(
        `SELECT id FROM audit_log WHERE table_name='leases' AND row_id=$1
         AND new_row->>'payee_bank_account_id'=$2`,
        [lease.id, id],
      )).rows.length);
      await assertAuditSafety();
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
