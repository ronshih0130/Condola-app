import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { withClient } from "../db";
import { ORG_ID, USERS } from "../ids";

// Run against the migrated, seeded lane database with:
// DATABASE_URL=postgresql://...@127.0.0.1:54371/... \
//   npx tsx --test src/server/esign/esign-retention.integration.test.ts
const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const target = new URL(databaseUrl);
assert.ok(
  target.protocol === "postgres:" || target.protocol === "postgresql:",
  "Use a postgres or postgresql URL",
);
assert.equal(target.hostname, "127.0.0.1", "Only lane-local PostgreSQL is allowed");
assert.equal(target.port, "54371", "Only port 54371 is allowed");
for (const key of target.searchParams.keys()) {
  assert.ok(
    !["host", "hostaddr", "port", "service", "options"].includes(key.toLowerCase()),
    "Connection overrides are forbidden",
  );
}

test("e-sign retention extensions and gated post-retention disposal", async () => {
  await withClient(async (client) => {
    const propertyId = randomUUID();
    const unitId = randomUUID();
    const extensionLease = randomUUID();
    const expiredLease = randomUUID();
    const futureLease = randomUUID();
    const extensionCase = randomUUID();
    const expiredCase = randomUUID();
    const futureCase = randomUUID();
    const expiredVersion = randomUUID();
    const caseIds = [extensionCase, expiredCase, futureCase];
    let savepointNo = 0;

    // Unlike svcOn(), this transaction retains the superuser connection for
    // fixtures. Every role switch and expected failure gets its own savepoint.
    async function scoped<T>(
      role: "authenticated" | "service_role" | null,
      work: () => Promise<T>,
      actorId: string = USERS.admin,
    ): Promise<T> {
      const savepoint = `esign_retention_${++savepointNo}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        if (role) {
          await client.query(
            `SELECT set_config('request.jwt.claim.sub',$1::text,true),
                    set_config('request.jwt.claim.role',$2::text,true)`,
            [actorId, role],
          );
          await client.query(`SET LOCAL ROLE ${role}`);
        }
        const result = await work();
        await client.query("RESET ROLE");
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      }
    }

    const service = <T>(work: () => Promise<T>) => scoped("service_role", work);
    const authenticated = <T>(work: () => Promise<T>) =>
      scoped("authenticated", work);
    const asUser = <T>(id: string, work: () => Promise<T>) =>
      scoped("authenticated", work, id);

    async function effective(id: string): Promise<string> {
      const result = await client.query<{ horizon: string }>(
        `SELECT public.esign_effective_retention($1::uuid)::text AS horizon`,
        [id],
      );
      return result.rows[0].horizon;
    }

    async function evidenceCounts() {
      return (await client.query(
        `SELECT
           (SELECT count(*)::int FROM public.esign_cases
             WHERE id = ANY($1::uuid[])) AS cases,
           (SELECT count(*)::int FROM public.esign_versions
             WHERE case_id = ANY($1::uuid[])) AS versions,
           (SELECT count(*)::int FROM public.esign_signers
             WHERE version_id=$2::uuid) AS signers,
           (SELECT count(*)::int FROM public.esign_signature_images
             WHERE version_id=$2::uuid) AS images,
           (SELECT count(*)::int FROM public.esign_audit_events
             WHERE case_id = ANY($1::uuid[])) AS audit,
           (SELECT count(*)::int FROM public.esign_retention_extensions
             WHERE case_id = ANY($1::uuid[])) AS extensions,
           (SELECT count(*)::int FROM public.esign_disposals
             WHERE case_id = ANY($1::uuid[])) AS tombstones`,
        [caseIds, expiredVersion],
      )).rows[0];
    }

    await client.query("BEGIN");
    try {
      assert.equal((await client.query<{ superuser: boolean }>(
        `SELECT rolsuper AS superuser FROM pg_roles WHERE rolname=current_user`,
      )).rows[0].superuser, true, "Fixtures require the lane superuser");

      // Changes to a pre-existing setting are also rolled back in finally.
      await client.query(
        `DELETE FROM public.platform_settings
         WHERE key='esign_disposal_enabled'`,
      );

      await client.query(
        `INSERT INTO public.properties(
           id,org_id,name,country_code,currency,timezone
         ) VALUES ($1::uuid,$2::uuid,'Retention fixture','US','USD','UTC')`,
        [propertyId, ORG_ID],
      );
      await client.query(
        `INSERT INTO public.units(id,org_id,property_id,label)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'Retention fixture')`,
        [unitId, ORG_ID, propertyId],
      );

      for (const [id, start, end] of [
        [extensionLease, "2020-01-01", "2027-01-31"],
        [expiredLease, "1900-01-01", "1901-01-31"],
        [futureLease, "2090-01-01", "2091-01-31"],
      ]) {
        await client.query(
          `INSERT INTO public.leases(
             id,org_id,property_id,unit_id,target_unit_id,
             start_date,end_date,currency,rent_amount_minor
           ) VALUES (
             $1::uuid,$2::uuid,$3::uuid,$4::uuid,$4::uuid,
             $5::date,$6::date,'USD',0
           )`,
          [id, ORG_ID, propertyId, unitId, start, end],
        );
      }

      for (const [id, lease] of [
        [extensionCase, extensionLease],
        [expiredCase, expiredLease],
        [futureCase, futureLease],
      ]) {
        await client.query(
          `INSERT INTO public.esign_cases(id,org_id,lease_id,created_by)
           VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid)`,
          [id, ORG_ID, lease, USERS.admin],
        );
      }

      const original = await effective(extensionCase);
      await service(() => client.query(
        `UPDATE public.leases SET end_date='2030-01-31'::date WHERE id=$1::uuid`,
        [extensionLease],
      ));
      const extended = await effective(extensionCase);
      assert.notEqual(extended, original);
      assert.equal((await client.query(
        `SELECT count(*)::int AS n FROM public.esign_retention_extensions
         WHERE case_id=$1::uuid
           AND retention_until='2045-01-31T00:00:00Z'::timestamptz
           AND lease_end_date='2030-01-31'::date`,
        [extensionCase],
      )).rows[0].n, 1);

      await service(() => client.query(
        `UPDATE public.leases SET end_date='2028-01-31'::date WHERE id=$1::uuid`,
        [extensionLease],
      ));
      assert.equal(await effective(extensionCase), extended);
      assert.equal((await client.query(
        `SELECT count(*)::int AS n FROM public.esign_retention_extensions
         WHERE case_id=$1::uuid`,
        [extensionCase],
      )).rows[0].n, 1);
      assert.equal((await client.query(
        `SELECT retention_until::text AS horizon
         FROM public.esign_cases WHERE id=$1::uuid`,
        [extensionCase],
      )).rows[0].horizon, original);

      // Multiple extension rows, including a smaller one, must resolve to max.
      await client.query(
        `INSERT INTO public.esign_retention_extensions(
           org_id,case_id,retention_until,lease_end_date
         ) VALUES
           ($1::uuid,$2::uuid,'2044-01-31T00:00:00Z'::timestamptz,'2029-01-31'::date),
           ($1::uuid,$2::uuid,'2050-01-31T00:00:00Z'::timestamptz,'2035-01-31'::date)`,
        [ORG_ID, extensionCase],
      );
      assert.equal((await client.query(
        `SELECT public.esign_effective_retention($1::uuid)
                  ='2050-01-31T00:00:00Z'::timestamptz AS ok`,
        [extensionCase],
      )).rows[0].ok, true);

      // Both staff roles must update leases under authenticated RLS. Roll back
      // each scenario afterward so the existing service-role assertions remain
      // independent. Inspect trigger-created evidence as the lane superuser.
      for (const actorId of [USERS.admin, USERS.manager]) {
        await scoped(null, async () => {
          const scenario = `esign_staff_${++savepointNo}`;
          await client.query(`SAVEPOINT ${scenario}`);
          try {
            await asUser(actorId, async () => {
              const updated = await client.query(
                `UPDATE public.leases SET end_date='2040-01-31'::date
                 WHERE id=$1::uuid RETURNING id`,
                [extensionLease],
              );
              assert.equal(updated.rowCount, 1);
            });

            assert.equal((await client.query(
              `SELECT rolsuper AS superuser
               FROM pg_roles WHERE rolname=current_user`,
            )).rows[0].superuser, true);
            assert.equal((await client.query(
              `SELECT count(*)::int AS n
               FROM public.esign_retention_extensions
               WHERE org_id=$1::uuid AND case_id=$2::uuid
                 AND retention_until='2055-01-31T00:00:00Z'::timestamptz
                 AND lease_end_date='2040-01-31'::date`,
              [ORG_ID, extensionCase],
            )).rows[0].n, 1);
            assert.equal((await client.query(
              `SELECT public.esign_effective_retention($1::uuid)
                        ='2055-01-31T00:00:00Z'::timestamptz AS ok`,
              [extensionCase],
            )).rows[0].ok, true);

            await asUser(actorId, async () => {
              const updated = await client.query(
                `UPDATE public.leases SET end_date=NULL
                 WHERE id=$1::uuid RETURNING id`,
                [extensionLease],
              );
              assert.equal(updated.rowCount, 1);
            });

            assert.equal((await client.query(
              `SELECT rolsuper AS superuser
               FROM pg_roles WHERE rolname=current_user`,
            )).rows[0].superuser, true);
            assert.equal((await client.query(
              `SELECT count(*)::int AS n
               FROM public.esign_retention_extensions
               WHERE org_id=$1::uuid AND case_id=$2::uuid
                 AND retention_until='infinity'::timestamptz
                 AND lease_end_date IS NULL`,
              [ORG_ID, extensionCase],
            )).rows[0].n, 1);
            assert.equal((await client.query(
              `SELECT count(*)::int AS n
               FROM public.esign_retention_extensions WHERE case_id=$1::uuid`,
              [extensionCase],
            )).rows[0].n, 5);
            assert.equal(await effective(extensionCase), "infinity");
            assert.equal((await client.query(
              `SELECT retention_until::text AS horizon
               FROM public.esign_cases WHERE id=$1::uuid`,
              [extensionCase],
            )).rows[0].horizon, original);
          } finally {
            await client.query(`ROLLBACK TO SAVEPOINT ${scenario}`);
            await client.query(`RELEASE SAVEPOINT ${scenario}`);
          }
        });
      }

      await service(() => client.query(
        `UPDATE public.leases SET end_date=NULL WHERE id=$1::uuid`,
        [extensionLease],
      ));
      assert.equal(await effective(extensionCase), "infinity");
      await service(() => client.query(
        `UPDATE public.leases SET end_date='2028-01-31'::date WHERE id=$1::uuid`,
        [extensionLease],
      ));
      assert.equal(await effective(extensionCase), "infinity");

      // Keep this case expired while exercising extension cleanup.
      await client.query(
        `INSERT INTO public.esign_retention_extensions(
           org_id,case_id,retention_until,lease_end_date
         ) VALUES (
           $1::uuid,$2::uuid,'1920-01-31T00:00:00Z'::timestamptz,'1905-01-31'::date
         )`,
        [ORG_ID, expiredCase],
      );

      const pdf = Buffer.from("%PDF-1.7 retention fixture");
      await client.query(
        `INSERT INTO public.esign_versions(
           id,case_id,body,pdf_bytes,content_digest,state,retention_until
         ) VALUES (
           $1::uuid,$2::uuid,'Retention fixture',$3::bytea,
           encode(sha256($3::bytea),'hex'),
           jsonb_build_object(
             'id',($1::uuid)::text,'body','Retention fixture',
             'documentDigest',encode(sha256($3::bytea),'hex'),'status','draft'
           ),'infinity'::timestamptz
         )`,
        [expiredVersion, expiredCase, pdf],
      );
      await client.query(
        `INSERT INTO public.esign_signers(
           version_id,id,party_role,email,email_step_state,state
         ) VALUES (
           $1::uuid,$2::uuid,'owner','retention@example.com','completed',
           jsonb_build_object(
             'id',($2::uuid)::text,'role','owner','status','pending_signature',
             'consent',jsonb_build_object('kind','explicit'),
             'reviewedAt','2000-01-01T00:00:00Z'
           )
         )`,
        [expiredVersion, USERS.owner],
      );
      const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
      await client.query(
        `INSERT INTO public.esign_signature_images(
           version_id,signer_id,image_bytes,image_digest,document_digest,
           signed_at,ip_address,device_id,user_agent
         ) VALUES (
           $1::uuid,$2::uuid,$3::bytea,encode(sha256($3::bytea),'hex'),
           encode(sha256($4::bytea),'hex'),
           '2000-01-01T00:00:00Z'::timestamptz,'127.0.0.1'::inet,'fixture','fixture'
         )`,
        [expiredVersion, USERS.owner, image, pdf],
      );

      const flags = await client.query(
        `SELECT relrowsecurity,relforcerowsecurity
         FROM pg_class WHERE oid IN (
           'public.esign_retention_extensions'::regclass,
           'public.esign_disposals'::regclass
         )`,
      );
      assert.equal(flags.rowCount, 2);
      assert.ok(flags.rows.every((r) => r.relrowsecurity && r.relforcerowsecurity));

      await authenticated(async () => {
        assert.ok((await client.query(
          `SELECT id FROM public.esign_retention_extensions WHERE case_id=$1::uuid`,
          [extensionCase],
        )).rowCount);
      });
      for (const actorId of [USERS.tenant, USERS.owner2]) {
        await asUser(actorId, async () => {
          assert.equal((await client.query(
            `SELECT id FROM public.esign_retention_extensions
             WHERE case_id=ANY($1::uuid[])`,
            [caseIds],
          )).rowCount, 0);
        });
      }
      await assert.rejects(authenticated(() => client.query(
        `SELECT * FROM public.esign_dispose_expired()`,
      )), /permission denied/);

      const before = await evidenceCounts();
      const preview = await service(() => client.query(
        `SELECT * FROM public.esign_dispose_expired(p_limit => 10000)`,
      ));
      const expiredPreview = preview.rows.find((r) => r.case_id === expiredCase);
      assert.ok(expiredPreview);
      assert.equal(expiredPreview.disposed, false);
      assert.ok(!preview.rows.some((r) =>
        r.case_id === extensionCase || r.case_id === futureCase));
      assert.deepEqual(await evidenceCounts(), before);
      assert.equal((await client.query(
        `SELECT count(*)::int AS n FROM public.platform_settings
         WHERE key='esign_disposal_enabled'`,
      )).rows[0].n, 0);

      await assert.rejects(service(() => client.query(
        `SELECT * FROM public.esign_dispose_expired(false,10000)`,
      )), /esign disposal disabled/);
      assert.deepEqual(await evidenceCounts(), before);

      // Exercise the trigger itself, rather than merely missing DELETE grants.
      // These temporary grants/policies disappear with the fixture transaction.
      await client.query(
        `GRANT DELETE ON public.esign_audit_events TO authenticated,service_role`,
      );
      await client.query(
        `CREATE POLICY esign_retention_test_delete
         ON public.esign_audit_events FOR DELETE TO authenticated USING (true)`,
      );
      for (const role of ["authenticated", "service_role"] as const) {
        await assert.rejects(scoped(role, async () => {
          await client.query(
            `SELECT set_config('esign.disposal','on',true)`,
          );
          await client.query(
            `DELETE FROM public.esign_audit_events WHERE case_id=$1::uuid`,
            [expiredCase],
          );
        }), /E-sign evidence is read-only/);
      }

      // Even the owner with the capability cannot delete unexpired evidence.
      await assert.rejects(scoped(null, async () => {
        await client.query(`SELECT set_config('esign.disposal','on',true)`);
        await client.query(
          `DELETE FROM public.esign_audit_events WHERE case_id=$1::uuid`,
          [futureCase],
        );
      }), /E-sign evidence is read-only/);

      for (const table of [
        "esign_cases",
        "esign_versions",
        "esign_signers",
        "esign_signature_images",
        "esign_audit_events",
        "esign_retention_extensions",
        "esign_disposals",
      ]) {
        await assert.rejects(scoped(null, async () => {
          await client.query(`SELECT set_config('esign.disposal','on',true)`);
          // CASCADE reaches the trigger instead of failing an FK precheck.
          await client.query(`TRUNCATE public.${table} CASCADE`);
        }), /E-sign evidence is read-only/);
      }

      await assert.rejects(scoped(null, () => client.query(
        `UPDATE public.esign_retention_extensions
         SET retention_until='infinity'::timestamptz WHERE case_id=$1::uuid`,
        [expiredCase],
      )), /E-sign evidence is read-only/);
      await assert.rejects(scoped(null, () => client.query(
        `DELETE FROM public.esign_retention_extensions WHERE case_id=$1::uuid`,
        [expiredCase],
      )), /E-sign evidence is read-only/);

      await client.query(
        `INSERT INTO public.platform_settings(key,value)
         VALUES ('esign_disposal_enabled','true'::jsonb)`,
      );
      const retainedBefore = (await client.query(
        `SELECT to_jsonb(c) AS row FROM public.esign_cases c
         WHERE id=ANY($1::uuid[]) ORDER BY id`,
        [[extensionCase, futureCase]],
      )).rows;

      const result = await service(() => client.query(
        `SELECT * FROM public.esign_dispose_expired(false,10000)`,
      ));
      const disposed = result.rows.find((r) => r.case_id === expiredCase);
      assert.ok(disposed);
      assert.equal(disposed.disposed, true);
      assert.equal(disposed.org_id, ORG_ID);
      assert.ok(!result.rows.some((r) =>
        r.case_id === extensionCase || r.case_id === futureCase));

      for (const table of [
        "esign_versions",
        "esign_audit_events",
        "esign_retention_extensions",
      ]) {
        assert.equal((await client.query(
          `SELECT count(*)::int AS n FROM public.${table} WHERE case_id=$1::uuid`,
          [expiredCase],
        )).rows[0].n, 0);
      }
      for (const table of ["esign_signers", "esign_signature_images"]) {
        assert.equal((await client.query(
          `SELECT count(*)::int AS n FROM public.${table} WHERE version_id=$1::uuid`,
          [expiredVersion],
        )).rows[0].n, 0);
      }
      assert.equal((await client.query(
        `SELECT id FROM public.esign_cases WHERE id=$1::uuid`,
        [expiredCase],
      )).rowCount, 0);
      assert.deepEqual((await client.query(
        `SELECT to_jsonb(c) AS row FROM public.esign_cases c
         WHERE id=ANY($1::uuid[]) ORDER BY id`,
        [[extensionCase, futureCase]],
      )).rows, retainedBefore);

      const tombstone = (await client.query(
        `SELECT *,effective_retention='1920-01-31T00:00:00Z'::timestamptz AS ok
         FROM public.esign_disposals WHERE case_id=$1::uuid`,
        [expiredCase],
      )).rows[0];
      assert.ok(tombstone);
      assert.equal(tombstone.org_id, ORG_ID);
      assert.equal(tombstone.lease_id, expiredLease);
      assert.equal(tombstone.ok, true);
      assert.deepEqual(tombstone.final_digests, []);
      assert.ok(tombstone.disposed_at);
      assert.equal(tombstone.disposed_by, (await client.query(
        `SELECT pg_get_userbyid(proowner) AS owner
         FROM pg_proc
         WHERE oid='public.esign_dispose_expired(boolean,integer)'::regprocedure`,
      )).rows[0].owner);
      assert.equal((await client.query(
        `SELECT current_setting('esign.disposal',true) AS value`,
      )).rows[0].value, "off");

      // Check denial against a tombstone known to exist, not an empty table.
      for (const actorId of [USERS.tenant, USERS.owner2]) {
        await assert.rejects(asUser(actorId, () => client.query(
          `SELECT * FROM public.esign_disposals WHERE case_id=$1::uuid`,
          [expiredCase],
        )), /permission denied/);
      }

      await assert.rejects(scoped(null, async () => {
        await client.query(`SELECT set_config('esign.disposal','on',true)`);
        await client.query(
          `DELETE FROM public.esign_disposals WHERE case_id=$1::uuid`,
          [expiredCase],
        );
      }), /E-sign evidence is read-only/);
      await assert.rejects(scoped(null, () => client.query(
        `UPDATE public.esign_disposals SET final_digests=ARRAY['changed']::text[]
         WHERE case_id=$1::uuid`,
        [expiredCase],
      )), /E-sign evidence is read-only/);

      const secondPreview = await service(() => client.query(
        `SELECT * FROM public.esign_dispose_expired(true,10000)`,
      ));
      assert.ok(!secondPreview.rows.some((r) => caseIds.includes(r.case_id)));
    } finally {
      await client.query("RESET ROLE");
      try {
        await client.query(
          `DELETE FROM public.platform_settings
           WHERE key='esign_disposal_enabled'`,
        );
      } finally {
        // Rollback removes all fixtures, temporary grants and policies and
        // restores any platform setting that existed before this test.
        await client.query("ROLLBACK");
      }
    }
  });
});
