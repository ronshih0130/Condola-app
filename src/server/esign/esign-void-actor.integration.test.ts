import { disposableDbUrl } from "../test-disposable-db";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { withClient } from "../db";
import { ORG_ID, USERS } from "../ids";
import { insertTestAuthSession } from "../test-auth-session";
import { EsignRepo, type TransactionRunner } from "./repo";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
process.env.ESIGN_ENABLED = "true";

test("void actor is bound to auth.uid() and authenticated has no esign_versions UPDATE (B-001 item 11)", async () => {
  await withClient(async (client) => {
    const property = randomUUID(), unit = randomUUID(), lease = randomUUID();
    let sequence = 0;
    await client.query("BEGIN");
    try {
      const sessionId = await insertTestAuthSession(client, USERS.admin);
      await client.query(`UPDATE organizations SET feature_flags=feature_flags || '{"esign":true}'::jsonb WHERE id=$1`, [ORG_ID]);
      await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true), set_config('app.active_org_id',$2,true), set_config('app.env','live',true)`, [USERS.admin, ORG_ID]);

      await client.query(`INSERT INTO properties(id,org_id,name,country_code,currency,timezone) VALUES ($1,$2,'Synthetic','TW','TWD','Asia/Taipei')`, [property, ORG_ID]);
      await client.query(`INSERT INTO units(id,org_id,property_id,label) VALUES ($1,$2,$3,'Synthetic')`, [unit, ORG_ID, property]);
      await client.query(`INSERT INTO leases(id,org_id,property_id,unit_id,target_unit_id,start_date,end_date,currency,rent_amount_minor) VALUES ($1,$2,$3,$4,$4,'2026-01-01','2027-01-31','TWD',0)`, [lease, ORG_ID, property, unit]);

      const run: TransactionRunner = async (actor, fn) => {
        await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claim.role','service_role',true)`, [actor]);
        await client.query("SET LOCAL ROLE service_role");
        try { return await fn(client); } finally { await client.query("RESET ROLE"); }
      };
      const repo = new EsignRepo({ check: async () => true }, run);

      const admin = { userId: USERS.admin, sessionId, orgId: ORG_ID, liveOrgId: ORG_ID, environment: "live", kind: "staff", role: "admin" } as const;
      const makeCase = async () => {
        const caseId = randomUUID(), versionId = randomUUID();
        await repo.createCase(admin, {
          caseId, leaseId: lease, versionId, body: "Synthetic contract",
          pdfBytes: new TextEncoder().encode("%PDF synthetic"),
          signers: [
            { id: USERS.owner, role: "owner", email: "owner@example.com" },
            { id: USERS.tenant, role: "tenant", email: "tenant@example.com" },
          ],
        });
        return { caseId, versionId };
      };

      const draftA = await makeCase();
      const draftB = await makeCase();
      const draftC = await makeCase();
      void draftC;

      async function scoped<T>(
        role: "authenticated" | "service_role" | "anon",
        cfg: { sub: string; org?: string; env?: string },
        fn: () => Promise<T>,
      ): Promise<T> {
        const savepoint = `void_${++sequence}`;
        await client.query(`SAVEPOINT ${savepoint}`);
        try {
          await client.query(
            `SELECT set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claim.role',$2,true), set_config('app.active_org_id',$3,true), set_config('app.env',$4,true)`,
            [cfg.sub, role, cfg.org ?? ORG_ID, cfg.env ?? "live"],
          );
          await client.query(`SET LOCAL ROLE ${role}`);
          const result = await fn();
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
          return result;
        } catch (error) {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
          throw error;
        }
      }

      const SPOOF = `UPDATE public.esign_versions
           SET status='voided',
               voided_by=$1,
               voided_at=now(),
               void_reason='spoofed void evidence',
               state = jsonb_set(jsonb_set(state,'{status}','"voided"'),'{effect}','"voided"')
         WHERE id=$2`;

      const statusOf = async (versionId: string) => {
        const { rows } = await client.query(`SELECT status::text AS status, voided_by::text AS voided_by FROM public.esign_versions WHERE id=$1`, [versionId]);
        return rows[0];
      };

      // 1. Grants: anon/authenticated have no write privileges; service_role may UPDATE.
      const { rows: grants } = await client.query(
        `SELECT
           has_table_privilege('anon','public.esign_versions','UPDATE') AS anon_update,
           has_table_privilege('anon','public.esign_versions','INSERT') AS anon_insert,
           has_table_privilege('anon','public.esign_versions','DELETE') AS anon_delete,
           has_table_privilege('authenticated','public.esign_versions','UPDATE') AS auth_update,
           has_table_privilege('authenticated','public.esign_versions','INSERT') AS auth_insert,
           has_table_privilege('authenticated','public.esign_versions','DELETE') AS auth_delete,
           has_table_privilege('service_role','public.esign_versions','UPDATE') AS service_update`,
      );
      assert.equal(grants[0].anon_update, false);
      assert.equal(grants[0].anon_insert, false);
      assert.equal(grants[0].anon_delete, false);
      assert.equal(grants[0].auth_update, false);
      assert.equal(grants[0].auth_insert, false);
      assert.equal(grants[0].auth_delete, false);
      assert.equal(grants[0].service_update, true);

      // 2. Legitimate server/DB void path binds voided_by to the session user.
      await repo.voidUnsigned(
        admin,
        draftA.caseId,
        draftA.versionId,
        "Owner withdrew before signing",
        "2026-11-10T08:00:00.000Z",
      );
      const voided = await statusOf(draftA.versionId);
      assert.equal(voided.status, "voided");
      assert.equal(voided.voided_by, USERS.admin);

      // 3. Spoof: service_role actor admin tries to record manager as the voider.
      await assert.rejects(
        () => scoped("service_role", { sub: USERS.admin }, () => client.query(SPOOF, [USERS.manager, draftB.versionId])),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "42501");
          assert.match(String((error as { message?: string }).message), /Void actor must be the session user/);
          return true;
        },
      );
      assert.notEqual((await statusOf(draftB.versionId)).status, "voided");

      // 4. Missing session: auth.uid() is NULL so the void cannot bind an actor.
      await assert.rejects(
        () => scoped("service_role", { sub: "" }, () => client.query(SPOOF, [USERS.admin, draftB.versionId])),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "42501");
          assert.match(String((error as { message?: string }).message), /Void actor must be the session user/);
          return true;
        },
      );
      assert.notEqual((await statusOf(draftB.versionId)).status, "voided");

      // 5. Non-admin session user may not void even when acting as themselves.
      await assert.rejects(
        () => scoped("service_role", { sub: USERS.manager }, () => client.query(SPOOF, [USERS.manager, draftB.versionId])),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "42501");
          assert.match(String((error as { message?: string }).message), /Company admin required to void/);
          return true;
        },
      );
      assert.notEqual((await statusOf(draftB.versionId)).status, "voided");

      // 6. Authenticated role has no UPDATE grant at all; the void is denied outright.
      await assert.rejects(
        () =>
          scoped("authenticated", { sub: USERS.admin, org: ORG_ID, env: "live" }, () =>
            client.query(SPOOF, [USERS.admin, draftB.versionId]),
          ),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "42501");
          assert.match(String((error as { message?: string }).message), /permission denied/i);
          return true;
        },
      );
      assert.notEqual((await statusOf(draftB.versionId)).status, "voided");
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
