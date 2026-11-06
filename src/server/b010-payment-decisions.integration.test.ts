import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { cloneTestDatabase } from "./test-database-clone";
import { disposableDbUrl } from "./test-disposable-db";
import { confirmPayment, recordPayment, rejectPayment, reversePayment } from "./domain";
import { ownerCollectedPaymentIds } from "./payment-request-status";
import type { Session } from "./types";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>;
test.before(async () => { clone = await cloneTestDatabase(); });
test.after(async () => { await clone?.cleanup(); });

type Confirmation = {
  confirmed_via: string;
  on_behalf_of_owner_contact_id: string | null;
  source: string;
  actor_user_id: string;
  from_status: string;
  to_status: string;
};

const isFlowError = (error: unknown): boolean =>
  error instanceof Error && error.constructor.name === "FlowError";

test("B-010 payment decisions", { concurrency: false }, async (t) => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    const session = async (
      userId: string,
      role: "manager" | "admin" | null,
      orgId = ORG_ID,
    ): Promise<Session> => {
      const sid = randomUUID();
      await c.query(
        `INSERT INTO auth_sessions(id,user_id,token_hash,expires_at)
         VALUES ($1,$2,$3,clock_timestamp()+interval '1 hour')`,
        [sid, userId, randomUUID()],
      );
      const common = {
        userId, orgId, liveOrgId: orgId, sessionId: sid,
        environment: "live" as const,
        locale: "en" as const,
        calendar: "gregorian" as const,
        leaseId: null,
        email: "synthetic@example.test",
        name: "Synthetic",
      };
      return role === null
        ? { ...common, kind: "owner", role: null }
        : { ...common, kind: "staff", role };
    };
    const manager = await session(USERS.manager, "manager");
    const admin = await session(USERS.admin, "admin");
    const coastAdmin = await session(USERS.coastAdmin, "admin", ORG2_ID);

    const flag = async (enabled: boolean) => {
      await c.query(
        `UPDATE organizations
         SET feature_flags=feature_flags || jsonb_build_object('payment_results_v2',$2::boolean)
         WHERE id=$1`,
        [ORG_ID, enabled],
      );
      await c.query(
        `UPDATE platform_settings
         SET value=jsonb_build_object('enabled',$2::boolean,'allowed_org_ids',jsonb_build_array($1::text))
         WHERE key='payment_results_v2'`,
        [ORG_ID, enabled],
      );
    };
    const lease = (await c.query<{
      id: string; property_id: string; currency: string; contact_id: string;
    }>(
      `SELECT l.id::text,l.property_id::text,l.currency,lp.contact_id::text
       FROM leases l JOIN lease_parties lp ON lp.lease_id=l.id AND lp.role='primary'
       WHERE l.org_id=$1 AND EXISTS (
         SELECT 1 FROM invoices i WHERE i.lease_id=l.id
         AND i.status IN ('open','partially_paid') AND i.balance_minor>=10000
       ) LIMIT 1`,
      [ORG_ID],
    )).rows[0];
    assert.ok(lease);

    const owner = (await c.query<{ id: string }>(
      `SELECT id::text FROM contacts
       WHERE org_id=$1 AND user_id=$2 AND is_owner AND archived_at IS NULL
       LIMIT 1`,
      [ORG_ID, USERS.owner],
    )).rows[0];
    assert.ok(owner, "an active owner contact linked to USERS.owner in the org is required");

    await c.query(
      `INSERT INTO property_owners(
         org_id,property_id,owner_contact_id,ownership_bp,is_primary
       )
       SELECT $1::uuid,$2::uuid,$3::uuid,10000,false
       WHERE NOT EXISTS (
         SELECT 1 FROM property_owners
         WHERE org_id=$1 AND property_id=$2 AND owner_contact_id=$3
       )`,
      [ORG_ID, lease.property_id, owner.id],
    );
    const ownerSession: Session = {
      ...await session(USERS.owner, null),
      kind: "owner",
      role: null,
      leaseId: lease.id,
    };

    const makeSubmitted = async () => (await c.query<{ id: string }>(
      `INSERT INTO payments(
         org_id,property_id,lease_id,payer_contact_id,currency,amount_minor,
         paid_on,method,status,source,submitted_by
       ) VALUES ($1,$2,$3,$4,$5,1000,'2026-10-30','bank_transfer',
         'submitted','tenant_portal',$6) RETURNING id::text`,
      [ORG_ID, lease.property_id, lease.id, lease.contact_id, lease.currency, USERS.tenant],
    )).rows[0].id;
    const clearCollector = async () => {
      await c.query(
        `DELETE FROM app.b010_lease_collectors WHERE org_id=$1 AND lease_id=$2`,
        [ORG_ID, lease.id],
      );
    };
    const ownerCollector = async () => {
      await clearCollector();
      await c.query(
        `INSERT INTO app.b010_lease_collectors(org_id,lease_id,collector,owner_contact_id)
         VALUES ($1,$2,'owner',$3)`,
        [ORG_ID, lease.id, owner.id],
      );
    };
    const collectors = async () => (await c.query(
      `SELECT * FROM app.b010_lease_collectors WHERE org_id=$1 ORDER BY lease_id`,
      [ORG_ID],
    )).rows;
    const confirmations = async (id: string) => (await c.query<Confirmation>(
      `SELECT confirmed_via,on_behalf_of_owner_contact_id,source,actor_user_id,from_status,to_status
       FROM app.b010_payment_confirmations WHERE org_id=$1 AND payment_id=$2`,
      [ORG_ID, id],
    )).rows;
    const payment = async (id: string) => (await c.query<{
      id: string; status: string; amount_minor: string;
    }>(
      `SELECT id::text,status,amount_minor::text FROM payments WHERE id=$1`,
      [id],
    )).rows[0];
    const ledgerCount = async () => (await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ledger_transactions WHERE lease_id=$1`,
      [lease.id],
    )).rows[0].n;
    const events = async (id: string) => (await c.query(
      `SELECT * FROM app.b010_source_events WHERE payment_id=$1 ORDER BY kind`,
      [id],
    )).rows;

    await t.test("flag OFF leaves confirmations and collectors untouched", async () => {
      await flag(false);
      const id = await makeSubmitted();
      const before = await collectors();
      await confirmPayment(manager, id);
      assert.equal((await payment(id)).status, "confirmed");
      assert.equal((await confirmations(id)).length, 0);
      assert.deepEqual(await collectors(), before);
    });

    await t.test("default collector records management and the supplied source", async () => {
      await flag(true);
      await clearCollector();
      const id = await makeSubmitted();
      await confirmPayment(manager, id, { source: "staff_ui" });
      const rows = await confirmations(id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].confirmed_via, "management");
      assert.equal(rows[0].on_behalf_of_owner_contact_id, null);
      assert.equal(rows[0].source, "staff_ui");
      assert.equal(rows[0].actor_user_id, USERS.manager);

      const emitted = (await events(id)).filter(
        (event) => event.kind === "payment_confirmed",
      );
      assert.equal(emitted.length, 1);
      assert.equal(emitted[0].dedupe_key, `payment:${id}:payment_confirmed`);
      assert.equal(emitted[0].source, "payment_result");
      assert.equal(emitted[0].triggered_by_user_id, USERS.manager);
    });

    await t.test("owner collector requires explicit staff proxy confirmation", async () => {
      await flag(true);
      await ownerCollector();
      const before = await collectors();
      const id = await makeSubmitted();
      await assert.rejects(confirmPayment(manager, id), isFlowError);
      assert.equal((await payment(id)).status, "submitted");
      assert.equal((await confirmations(id)).length, 0);

      await confirmPayment(manager, id, { proxyOwnerConfirmed: true });
      const rows = await confirmations(id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].confirmed_via, "staff_proxy");
      assert.equal(rows[0].on_behalf_of_owner_contact_id, owner.id);
      assert.equal(rows[0].actor_user_id, USERS.manager);
      assert.equal(rows[0].from_status, "submitted");
      assert.equal(rows[0].to_status, "confirmed");
      assert.equal((await payment(id)).status, "confirmed");
      assert.deepEqual(await collectors(), before);
    });

    await t.test("flag ON owner-collected reader works", async () => {
      await flag(true);
      await ownerCollector();
      const id = await makeSubmitted();

      const ids = await ownerCollectedPaymentIds(manager, [id]);
      assert.ok(ids.has(id));

      await flag(false);
      const disabledIds = await ownerCollectedPaymentIds(manager, [id]);
      assert.equal(disabledIds.size, 0);
    });

    await t.test("owner session confirms directly when the flag is ON", async () => {
      await flag(true);
      await ownerCollector();
      const id = await makeSubmitted();
      const beforeCollectors = await collectors();
      const beforeLedger = await ledgerCount();

      await confirmPayment(ownerSession, id);

      assert.equal((await payment(id)).status, "confirmed");
      const rows = await confirmations(id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].confirmed_via, "owner_direct");
      assert.equal(rows[0].on_behalf_of_owner_contact_id, null);
      assert.equal(rows[0].actor_user_id, USERS.owner);
      assert.equal(rows[0].from_status, "submitted");
      assert.equal(rows[0].to_status, "confirmed");
      assert.equal(await ledgerCount(), beforeLedger + 1);
      assert.deepEqual(await collectors(), beforeCollectors);

      const emitted = (await events(id)).filter(
        (event) => event.kind === "payment_confirmed",
      );
      assert.equal(emitted.length, 1);
      assert.equal(emitted[0].dedupe_key, `payment:${id}:payment_confirmed`);
      assert.equal(emitted[0].source, "payment_result");
      assert.equal(emitted[0].triggered_by_user_id, USERS.owner);
    });

    await t.test("owner context cannot reject or reverse", async () => {
      await flag(true);
      await ownerCollector();
      const id = await makeSubmitted();
      const original = await payment(id);

      await assert.rejects(rejectPayment(ownerSession, id, "x"), isFlowError);

      assert.deepEqual(await payment(id), original);
      assert.equal((await payment(id)).status, "submitted");
      assert.equal((await confirmations(id)).length, 0);

      await confirmPayment(ownerSession, id);
      const confirmed = await payment(id);
      const audit = await confirmations(id);
      assert.equal(confirmed.status, "confirmed");
      assert.equal(audit.length, 1);
      assert.equal(audit[0].confirmed_via, "owner_direct");

      await assert.rejects(reversePayment(ownerSession, id, "x"), isFlowError);

      assert.deepEqual(await payment(id), confirmed);
      assert.deepEqual(await confirmations(id), audit);
    });

    await t.test("role restored after owner elevation", async () => {
      await flag(true);

      for (const outcome of ["successful", "failing"] as const) {
        await ownerCollector();
        const id = await makeSubmitted();

        if (outcome === "successful") {
          await confirmPayment(ownerSession, id);
          assert.equal((await payment(id)).status, "confirmed");
          const rows = await confirmations(id);
          assert.equal(rows.length, 1);
          assert.equal(rows[0].confirmed_via, "owner_direct");
        } else {
          await rejectPayment(manager, id, "Synthetic rejection");
          assert.equal((await payment(id)).status, "rejected");

          await assert.rejects(confirmPayment(ownerSession, id), isFlowError);

          assert.equal((await payment(id)).status, "rejected");
          assert.equal((await confirmations(id)).length, 0);
        }

        await clearCollector();
        const newSubmittedId = await makeSubmitted();
        await confirmPayment(manager, newSubmittedId);

        assert.equal((await payment(newSubmittedId)).status, "confirmed");
        const rows = await confirmations(newSubmittedId);
        assert.equal(rows.length, 1);
        assert.equal(
          rows[0].confirmed_via,
          "management",
          `staff confirmation after ${outcome} owner confirmation`,
        );
        assert.equal(rows[0].actor_user_id, USERS.manager);
        assert.equal(rows[0].on_behalf_of_owner_contact_id, null);
      }
    });

    await t.test("owner session cannot confirm when the flag is OFF", async () => {
      await flag(false);
      await ownerCollector();
      const id = await makeSubmitted();
      const original = await payment(id);
      const beforeCollectors = await collectors();
      const beforeLedger = await ledgerCount();

      await assert.rejects(confirmPayment(ownerSession, id), isFlowError);

      assert.deepEqual(await payment(id), original);
      assert.equal((await confirmations(id)).length, 0);
      assert.equal((await events(id)).length, 0);
      assert.equal(await ledgerCount(), beforeLedger);
      assert.deepEqual(await collectors(), beforeCollectors);
    });

    await t.test("owner can read the staff proxy confirmation audit", async () => {
      await flag(true);
      await ownerCollector();
      const id = await makeSubmitted();
      await confirmPayment(manager, id, { proxyOwnerConfirmed: true });

      await c.query("BEGIN");
      try {
        await c.query(
          `SELECT set_config('request.jwt.claim.sub',$1,true),
                  set_config('app.active_org_id',$2,true),
                  set_config('app.env','live',true)`,
          [USERS.owner, ORG_ID],
        );
        await c.query("SET LOCAL ROLE authenticated");
        const audit = await c.query<{ confirmed_via: string }>(
          `SELECT * FROM app.b010_confirmation_audit($1::uuid,$2::uuid,$3::text)`,
          [id, ORG_ID, "live"],
        );
        assert.equal(audit.rows.length, 1);
        assert.equal(audit.rows[0].confirmed_via, "staff_proxy");
      } finally {
        await c.query("ROLLBACK");
      }
    });

    await t.test("audit denies missing, cross-org, and cross-environment settings", async () => {
      await flag(true);
      await ownerCollector();
      const id = await makeSubmitted();
      await confirmPayment(manager, id, { proxyOwnerConfirmed: true });

      for (const actor of [USERS.owner, USERS.manager]) {
        for (const scope of [
          { label: "missing settings", orgId: null, environment: null },
          { label: "another organization", orgId: ORG2_ID, environment: "live" },
          { label: "another environment", orgId: ORG_ID, environment: "sandbox" },
        ]) {
          await c.query("BEGIN");
          try {
            await c.query(
              `SELECT set_config('request.jwt.claim.sub',$1,true)`,
              [actor],
            );
            if (scope.orgId !== null && scope.environment !== null) {
              await c.query(
                `SELECT set_config('app.active_org_id',$1,true),
                        set_config('app.env',$2,true)`,
                [scope.orgId, scope.environment],
              );
            }
            await c.query("SET LOCAL ROLE authenticated");
            const audit = await c.query(
              `SELECT * FROM app.b010_confirmation_audit($1::uuid,$2::uuid,$3::text)`,
              [id, ORG_ID, "live"],
            );
            assert.equal(audit.rows.length, 0, `${actor}: ${scope.label}`);
          } finally {
            await c.query("ROLLBACK");
          }
        }
      }
    });

    await t.test("direct SQL confirmation without a payment context is denied", async () => {
      await flag(true);
      await clearCollector();
      const id = await makeSubmitted();
      const original = await payment(id);
      const beforeLedger = await ledgerCount();

      await c.query("BEGIN");
      try {
        await c.query(
          `SELECT set_config('request.jwt.claim.sub',$1,true),
                  set_config('app.active_org_id',$2,true),
                  set_config('app.env','live',true)`,
          [USERS.manager, ORG_ID],
        );
        await c.query("SET LOCAL ROLE authenticated");
        // This helper runs after the domain's submitted -> confirmed UPDATE.
        // A submitted fixture fails its transition guard with SQLSTATE 23514.
        await assert.rejects(
          c.query(
            `SELECT app.b010_record_confirmation($1::uuid,$2::boolean,$3::text)`,
            [id, false, "staff_ui"],
          ),
          (error: unknown) =>
            error instanceof Error && "code" in error && error.code === "23514",
        );
      } finally {
        await c.query("ROLLBACK");
      }

      assert.deepEqual(await payment(id), original);
      assert.equal((await confirmations(id)).length, 0);
      assert.equal((await events(id)).length, 0);
      assert.equal(await ledgerCount(), beforeLedger);
    });

    await t.test("concurrent confirmation posts once and sequential replay is a no-op", async () => {
      await flag(true);
      await ownerCollector();
      const id = await makeSubmitted();
      const before = await ledgerCount();
      const results = await Promise.allSettled([
        confirmPayment(manager, id, { proxyOwnerConfirmed: true }),
        confirmPayment(manager, id, { proxyOwnerConfirmed: true }),
      ]);
      assert.ok(results.some((result) => result.status === "fulfilled"));
      for (const result of results) {
        if (result.status === "rejected") assert.ok(isFlowError(result.reason));
      }
      assert.equal((await confirmations(id)).length, 1);
      assert.equal((await events(id)).filter((event) => event.kind === "payment_confirmed").length, 1);
      assert.equal((await payment(id)).status, "confirmed");
      assert.equal(await ledgerCount(), before + 1);

      const confirmed = await confirmations(id);
      const emitted = await events(id);
      await confirmPayment(manager, id, { proxyOwnerConfirmed: true });
      assert.equal(await ledgerCount(), before + 1);
      assert.deepEqual(await confirmations(id), confirmed);
      assert.deepEqual(await events(id), emitted);
      assert.equal((await payment(id)).status, "confirmed");
    });

    await t.test("confirmed_via rejects NULL even for superuser inserts", async () => {
      await flag(true);
      await clearCollector();
      const id = await makeSubmitted();

      await assert.rejects(
        c.query(
          `INSERT INTO app.b010_payment_confirmations(
             org_id,payment_id,confirmed_via,on_behalf_of_owner_contact_id,
             source,actor_user_id,from_status,to_status
           ) VALUES ($1,$2,NULL,NULL,'staff_ui',$3,'submitted','confirmed')`,
          [ORG_ID, id, USERS.manager],
        ),
        (error: unknown) =>
          error instanceof Error && "code" in error && error.code === "23502",
      );
      assert.equal((await confirmations(id)).length, 0);
      assert.equal((await payment(id)).status, "submitted");
    });

    await t.test("confirmations enforce uniqueness and reject updates and deletes", async () => {
      await flag(true);
      await clearCollector();
      const id = await makeSubmitted();
      await confirmPayment(manager, id, { source: "staff_ui" });
      const before = await confirmations(id);
      assert.equal(before.length, 1);

      await assert.rejects(c.query(
        `INSERT INTO app.b010_payment_confirmations(
           org_id,payment_id,confirmed_via,on_behalf_of_owner_contact_id,source,actor_user_id,from_status,to_status
         ) SELECT org_id,payment_id,confirmed_via,on_behalf_of_owner_contact_id,source,actor_user_id,from_status,to_status
           FROM app.b010_payment_confirmations WHERE org_id=$1 AND payment_id=$2`,
        [ORG_ID, id],
      ), (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "23505");
      await assert.rejects(c.query(
        `UPDATE app.b010_payment_confirmations SET source=source
         WHERE org_id=$1 AND payment_id=$2`, [ORG_ID, id],
      ), (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "55000");
      await assert.rejects(c.query(
        `DELETE FROM app.b010_payment_confirmations WHERE org_id=$1 AND payment_id=$2`,
        [ORG_ID, id],
      ), (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "55000");

      for (const sql of [
        `UPDATE app.b010_payment_confirmations SET source=source
         WHERE org_id=$1 AND payment_id=$2`,
        `DELETE FROM app.b010_payment_confirmations
         WHERE org_id=$1 AND payment_id=$2`,
      ]) {
        await c.query("BEGIN");
        try {
          await c.query(
            `SELECT set_config('request.jwt.claim.sub',$1,true),
                    set_config('app.active_org_id',$2,true),
                    set_config('app.env','live',true)`,
            [USERS.manager, ORG_ID],
          );
          await c.query("SET LOCAL ROLE authenticated");
          await assert.rejects(
            c.query(sql, [ORG_ID, id]),
            (error: unknown) =>
              error instanceof Error && "code" in error && error.code === "42501",
          );
        } finally {
          await c.query("ROLLBACK");
        }
      }
      assert.deepEqual(await confirmations(id), before);
    });

    await t.test("superuser replica-mode seed wipe can delete confirmations", async () => {
      await flag(true);
      await clearCollector();
      const id = await makeSubmitted();
      await confirmPayment(manager, id);
      const before = await confirmations(id);
      assert.equal(before.length, 1);

      await c.query("BEGIN");
      try {
        await c.query("SET LOCAL session_replication_role=replica");
        const deleted = await c.query(
          `DELETE FROM app.b010_payment_confirmations`,
        );
        assert.ok(deleted.rowCount !== null && deleted.rowCount > 0);
        const remaining = await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM app.b010_payment_confirmations`,
        );
        assert.equal(remaining.rows[0].n, 0);
      } finally {
        await c.query("ROLLBACK");
      }

      assert.deepEqual(await confirmations(id), before);
      assert.equal((await payment(id)).status, "confirmed");
    });

    await t.test("rejection requires a reason and only admin can reverse", async () => {
      await flag(true);
      await clearCollector();
      const rejected = await makeSubmitted();
      await assert.rejects(rejectPayment(manager, rejected, "  "), isFlowError);
      assert.equal((await payment(rejected)).status, "submitted");
      assert.equal((await confirmations(rejected)).length, 0);
      assert.equal((await events(rejected)).length, 0);
      await rejectPayment(manager, rejected, "Synthetic rejection");
      assert.equal((await payment(rejected)).status, "rejected");

      const id = await makeSubmitted();
      await confirmPayment(manager, id);
      const original = await payment(id);
      await assert.rejects(reversePayment(manager, id, "Synthetic correction"), isFlowError);
      assert.deepEqual(await payment(id), original);
      await assert.rejects(reversePayment(admin, id, "  "), isFlowError);
      assert.deepEqual(await payment(id), original);
      await reversePayment(admin, id, "Synthetic correction");
      assert.deepEqual(await payment(id), { ...original, status: "reversed" });
    });

    await t.test("another organization's admin cannot confirm or write results", async () => {
      await flag(true);
      await clearCollector();
      await c.query(
        `UPDATE organizations SET feature_flags=feature_flags || '{"payment_results_v2":true}'::jsonb
         WHERE id=$1`, [ORG2_ID],
      );
      await c.query(
        `UPDATE platform_settings SET value=jsonb_build_object(
           'enabled',true,'allowed_org_ids',jsonb_build_array($1::text,$2::text))
         WHERE key='payment_results_v2'`,
        [ORG_ID, ORG2_ID],
      );
      const id = await makeSubmitted();
      const original = await payment(id);
      const beforeLedger = await ledgerCount();
      const beforeCollectors = await collectors();
      await assert.rejects(
        confirmPayment(coastAdmin, id, { proxyOwnerConfirmed: true }),
        isFlowError,
      );
      assert.deepEqual(await payment(id), original);
      assert.equal((await confirmations(id)).length, 0);
      assert.equal((await events(id)).length, 0);
      assert.equal(await ledgerCount(), beforeLedger);
      assert.deepEqual(await collectors(), beforeCollectors);
    });

    await t.test("staff manual entry on an owner-collected lease is rejected; management entry still records", async () => {
      await flag(true);
      await ownerCollector();
      const count = async () => (await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM payments WHERE lease_id=$1`, [lease.id],
      )).rows[0].n;
      const beforePayments = await count();
      const beforeLedger = await ledgerCount();
      const input = {
        leaseId: lease.id, amountMajor: 10, paidOn: "2026-10-30",
        last5: lease.currency === "TWD" ? "12345" : "", reference: "",
      };
      await assert.rejects(
        recordPayment(manager, { ...input, requestId: randomUUID() }),
        (error: unknown) => isFlowError(error) && (error as { key?: string }).key === "errors.proxyOwnerConfirmRequired",
      );
      assert.equal(await count(), beforePayments);
      assert.equal(await ledgerCount(), beforeLedger);
      await clearCollector();
      const recorded = await recordPayment(manager, { ...input, requestId: randomUUID() });
      assert.equal(recorded.status, "confirmed");
      assert.equal(await count(), beforePayments + 1);
    });
  } finally {
    await c.end();
  }
});
