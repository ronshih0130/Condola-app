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

test("tenant payee RPC: narrow escalation tests", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const seed = (await client.query(
        `SELECT l.org_id, l.property_id, l.currency,
                o.default_currency
         FROM leases l
         JOIN organizations o ON o.id=l.org_id
         WHERE o.environment::text <> 'sandbox'
           AND EXISTS (
             SELECT 1 FROM org_members m
             WHERE m.org_id=l.org_id AND m.role='admin'
           )
           AND EXISTS (
             SELECT 1 FROM org_members m
             WHERE m.org_id=l.org_id AND m.role='manager'
           )
         ORDER BY l.org_id, l.id
         LIMIT 1`,
      )).rows[0];
      assert.ok(seed, "integration database needs a lease, admin and manager");

      const members = (await client.query(
        `SELECT user_id, role FROM org_members
         WHERE org_id=$1 AND role IN ('admin','manager')`,
        [seed.org_id],
      )).rows;
      const admin = members.find((member) => member.role === "admin");
      const manager = members.find((member) => member.role === "manager");
      assert.ok(admin);
      assert.ok(manager);

      const functionInfo = (await client.query(
        `SELECT p.prosecdef, p.provolatile, p.proconfig,
                pg_get_userbyid(p.proowner) AS owner_name,
                has_function_privilege(
                  'anon', p.oid, 'EXECUTE'
                ) AS anon_execute,
                has_function_privilege(
                  'authenticated', p.oid, 'EXECUTE'
                ) AS authenticated_execute,
                EXISTS (
                  SELECT 1
                  FROM aclexplode(
                    coalesce(p.proacl, acldefault('f', p.proowner))
                  ) AS acl
                  WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
                ) AS public_execute
         FROM pg_proc p
         WHERE p.oid='public.tenant_payee_account(uuid)'::regprocedure`,
      )).rows[0];
      assert.ok(functionInfo);
      assert.equal(functionInfo.prosecdef, true);
      assert.equal(functionInfo.provolatile, "v");
      assert.ok(functionInfo.proconfig.includes("search_path=pg_catalog, public"));
      assert.equal(functionInfo.anon_execute, false);
      assert.equal(functionInfo.authenticated_execute, true);
      assert.equal(functionInfo.public_execute, false);

      const tenantA = randomUUID();
      const tenantB = randomUUID();
      const unattributableUser = randomUUID();
      const contactA = randomUUID();
      const contactB = randomUUID();
      const unitA = randomUUID();
      const unitB = randomUUID();
      const leaseA = randomUUID();
      const leaseB = randomUUID();
      const missingLease = randomUUID();
      const accountA = randomUUID();
      const accountB = randomUUID();
      const numberA = "731904628512345";
      const numberB = "842015739623456";

      await client.query(
        "INSERT INTO auth.users (id) VALUES ($1), ($2), ($3)",
        [tenantA, tenantB, unattributableUser],
      );
      await client.query(
        `INSERT INTO contacts (id,org_id,user_id,display_name,is_tenant)
         VALUES ($1,$3,$4,'Payee RPC tenant A',true),
                ($2,$3,$5,'Payee RPC tenant B',true)`,
        [contactA, contactB, seed.org_id, tenantA, tenantB],
      );
      assert.equal((await client.query(
        `SELECT
           (SELECT count(*) FROM contacts WHERE user_id=$1)
           + (SELECT count(*) FROM org_members WHERE user_id=$1)
           AS count`,
        [unattributableUser],
      )).rows[0].count, "0");
      await client.query(
        `INSERT INTO bank_accounts
         (id,org_id,nickname,holder_name,bank_name,bank_code,branch_code,
          currency,show_to_tenants)
         VALUES
           ($1,$3,'RPC payee A','Holder A','Bank A','012','1001',$4,true),
           ($2,$3,'RPC payee B','Holder B','Bank B','013','1002',$4,true)`,
        [accountA, accountB, seed.org_id, seed.default_currency],
      );
      await client.query(
        `INSERT INTO payee_account_numbers
         (bank_account_id,org_id,account_number)
         VALUES ($1,$3,$4), ($2,$3,$5)`,
        [accountA, accountB, seed.org_id, numberA, numberB],
      );

      // Fresh whole-unit targets avoid overlaps with seeded leases.
      // All fixtures, including these units, roll back with the transaction.
      await client.query(
        `INSERT INTO units (id,org_id,property_id,label)
         VALUES ($1,$3,$4,$5), ($2,$3,$4,$6)`,
        [
          unitA, unitB, seed.org_id, seed.property_id,
          `Payee RPC A ${unitA}`, `Payee RPC B ${unitB}`,
        ],
      );
      await client.query(
        `INSERT INTO leases
         (id,org_id,property_id,unit_id,target_unit_id,status,start_date,end_date,
          currency,rent_amount_minor,payee_bank_account_id)
         VALUES
           ($1,$3,$4,$5,$5,'active',current_date-1,current_date+1,$7,0,$8),
           ($2,$3,$4,$6,$6,'active',current_date-1,current_date+1,$7,0,$9)`,
        [
          leaseA, leaseB, seed.org_id, seed.property_id, unitA, unitB,
          seed.currency, accountA, accountB,
        ],
      );
      assert.equal((await client.query(
        `SELECT count(*)::integer AS count FROM leases
         WHERE id=ANY($1::uuid[])
           AND status='active'
           AND start_date <= current_date
           AND end_date >= current_date`,
        [[leaseA, leaseB]],
      )).rows[0].count, 2);
      await client.query(
        `INSERT INTO lease_parties (org_id,lease_id,contact_id)
         VALUES ($1,$2,$3), ($1,$4,$5)`,
        [seed.org_id, leaseA, contactA, leaseB, contactB],
      );

      const expectedAudit: {
        actor: string;
        org_id: string;
        row_id: string;
        new_row: {
          lease_id: string;
          result: string;
          account_last5: string | null;
        };
      }[] = [];
      let completedCalls = 0;

      const callAs = async (
        userId: string,
        leaseId: string,
        account?: { id: string; number: string },
      ) => {
        const auditOrg = (await client.query(
          `SELECT coalesce(
             (SELECT c.org_id FROM contacts c
              WHERE c.user_id=$1 AND c.archived_at IS NULL
              ORDER BY c.created_at, c.id LIMIT 1),
             (SELECT m.org_id FROM org_members m
              WHERE m.user_id=$1 AND m.status='active'
              ORDER BY m.org_id LIMIT 1),
             (SELECT l.org_id FROM leases l WHERE l.id=$2)
           ) AS org_id`,
          [userId, leaseId],
        )).rows[0].org_id;
        await client.query("SET LOCAL ROLE authenticated");
        await client.query(
          "SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', 'authenticated', true)",
          [userId],
        );
        const rows = (await client.query(
          "SELECT * FROM public.tenant_payee_account($1)",
          [leaseId],
        )).rows;
        completedCalls += 1;
        await client.query("RESET ROLE");
        expectedAudit.push({
          actor: userId,
          org_id: auditOrg,
          row_id: account ? account.id : leaseId,
          new_row: {
            lease_id: leaseId,
            result: account ? "one" : "none",
            account_last5: account ? account.number.slice(-5) : null,
          },
        });
        if (account) {
          assert.equal(rows.length, 1);
          assert.equal(rows[0].bank_account_id, account.id);
          assert.equal(rows[0].account_number, account.number);
        } else {
          assert.deepEqual(rows, []);
        }
        return rows;
      };

      const own = await callAs(tenantA, leaseA, {
        id: accountA, number: numberA,
      });
      assert.deepEqual(own[0], {
        bank_account_id: accountA,
        holder_name: "Holder A",
        bank_name: "Bank A",
        bank_code: "012",
        branch_code: "1001",
        account_number: numberA,
        account_last5: numberA.slice(-5),
        is_owner_account: false,
        details: {},
      });

      await callAs(tenantA, leaseB);
      await callAs(tenantB, leaseB, { id: accountB, number: numberB });

      // Reuse A's isolated unit to test each denial independently.
      await client.query(
        `UPDATE leases
         SET start_date=current_date+1, end_date=current_date+2
         WHERE id=$1`,
        [leaseA],
      );
      await callAs(tenantA, leaseA);

      await client.query(
        `UPDATE leases
         SET start_date=current_date-2, end_date=current_date-1
         WHERE id=$1`,
        [leaseA],
      );
      assert.equal((await client.query(
        "SELECT status FROM leases WHERE id=$1",
        [leaseA],
      )).rows[0].status, "active");
      await callAs(tenantA, leaseA);

      await client.query(
        `UPDATE leases
         SET start_date=current_date-1, end_date=current_date+1, status='ended'
         WHERE id=$1`,
        [leaseA],
      );
      await callAs(tenantA, leaseA);

      // B remains current and active, so status cannot conceal a staff bypass.
      for (const member of [manager, admin]) {
        await callAs(member.user_id, leaseB);
      }

      await callAs(tenantA, missingLease);

      // A valid authenticated identity without a contact, membership or
      // existing lease org must raise rather than complete without audit.
      await client.query("SET LOCAL ROLE authenticated");
      await client.query(
        "SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', 'authenticated', true)",
        [unattributableUser],
      );
      await client.query("SAVEPOINT unattributable_payee");
      await assert.rejects(client.query(
        "SELECT * FROM public.tenant_payee_account($1)",
        [missingLease],
      ), (error: unknown) => {
        const failure = error as { code: string; message: string };
        return failure.code === "42501"
          && failure.message === "tenant payee read requires an attributable caller";
      });
      await client.query("ROLLBACK TO SAVEPOINT unattributable_payee");
      await client.query("RELEASE SAVEPOINT unattributable_payee");
      await client.query("RESET ROLE");

      await client.query("SET LOCAL ROLE anon");
      // Even forged authenticated claims cannot bypass the EXECUTE ACL.
      await client.query(
        "SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', 'authenticated', true)",
        [tenantB],
      );
      await client.query("SAVEPOINT anon_payee");
      await assert.rejects(client.query(
        "SELECT * FROM public.tenant_payee_account($1)",
        [leaseB],
      ), (error: unknown) => (error as { code: string }).code === "42501");
      await client.query("ROLLBACK TO SAVEPOINT anon_payee");
      await client.query("RELEASE SAVEPOINT anon_payee");
      await client.query("RESET ROLE");

      await client.query("SET LOCAL ROLE authenticated");
      await client.query(
        "SELECT set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', 'authenticated', true)",
      );
      await client.query("SAVEPOINT missing_payee_identity");
      await assert.rejects(client.query(
        "SELECT * FROM public.tenant_payee_account($1)",
        [leaseB],
      ), (error: unknown) => (error as { code: string }).code === "42501");
      await client.query("ROLLBACK TO SAVEPOINT missing_payee_identity");
      await client.query("RELEASE SAVEPOINT missing_payee_identity");

      await client.query(
        "SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', 'anon', true)",
        [tenantB],
      );
      await client.query("SAVEPOINT wrong_payee_claim");
      await assert.rejects(client.query(
        "SELECT * FROM public.tenant_payee_account($1)",
        [leaseB],
      ), (error: unknown) => (error as { code: string }).code === "42501");
      await client.query("ROLLBACK TO SAVEPOINT wrong_payee_claim");
      await client.query("RELEASE SAVEPOINT wrong_payee_claim");
      await client.query("RESET ROLE");

      // ACL-denied, context-rejected and unattributable calls never return
      // data. PostgreSQL cannot run function code for ACL-denied calls.
      // Every call that completes must write exactly one audit row.
      const audit = (await client.query(
        `SELECT * FROM audit_log
         WHERE reason='tenant_payee_read'
           AND new_row->>'lease_id'=ANY($1::text[])
         ORDER BY id`,
        [[leaseA, leaseB, missingLease]],
      )).rows;
      assert.equal(completedCalls, 9);
      assert.equal(audit.length, completedCalls);
      assert.deepEqual(audit.map((row) => ({
        actor: row.actor_user_id,
        org_id: row.org_id,
        row_id: row.row_id,
        new_row: row.new_row,
      })), expectedAudit);
      assert.equal(audit.some((row) =>
        row.actor_user_id === unattributableUser
      ), false);
      const missingAudit = audit.filter((row) =>
        row.new_row.lease_id === missingLease
      );
      assert.equal(missingAudit.length, 1);
      assert.equal(missingAudit[0].org_id, seed.org_id);
      assert.equal(missingAudit[0].row_id, missingLease);
      assert.deepEqual(missingAudit[0].new_row, {
        lease_id: missingLease, result: "none", account_last5: null,
      });

      for (const row of audit) {
        assert.equal(row.actor_role, functionInfo.owner_name);
        assert.equal(row.table_name, "payee_account_numbers");
        assert.equal(row.action, "select");
        assert.equal(row.old_row, null);
        assert.equal(row.changed_cols, null);
        assert.equal(row.reason, "tenant_payee_read");
        assert.deepEqual(
          Object.keys(row.new_row).sort(),
          ["account_last5", "lease_id", "result"],
        );
        if (row.new_row.result === "none") {
          assert.equal(row.row_id, row.new_row.lease_id);
          assert.equal(row.new_row.account_last5, null);
        }
      }
      const allFixtureAudit = (await client.query(
        `SELECT * FROM audit_log
         WHERE row_id=ANY($1::text[])
            OR (reason='tenant_payee_read'
                AND new_row->>'lease_id'=ANY($2::text[]))`,
        [
          [accountA, accountB, leaseA, leaseB, missingLease],
          [leaseA, leaseB, missingLease],
        ],
      )).rows;
      for (const row of allFixtureAudit) {
        const serializedAudit = JSON.stringify(row);
        assert.equal(serializedAudit.includes(numberA), false);
        assert.equal(serializedAudit.includes(numberB), false);
      }
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
