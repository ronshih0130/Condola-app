import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { svcOn, withClient } from "../db";
import { FlowError } from "../errors";
import { ORG_ID, ORG2_ID, USERS } from "../ids";
import { EsignRepo, type Actor, type TransactionRunner } from "./repo";
import { generateContractPdf } from "./stamp";
import type { SigningCase } from "./rules";

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

test("e-sign schema, service adapter, permissions and retained evidence", async () => {
  const org = ORG_ID;
  const otherOrg = ORG2_ID;
  const adminId = USERS.admin;
  const otherAdminId = USERS.coastAdmin;
  const ownerId = USERS.owner;
  const tenantId = USERS.tenant;
  const outsiderId = USERS.owner2;
  const propertyId = randomUUID();
  const unitId = randomUUID();
  const leaseId = randomUUID();
  const caseId = randomUUID();
  const firstId = randomUUID();
  const admin: Actor = { userId: adminId, orgId: org };
  const owner: Actor = { userId: ownerId, orgId: org };
  const tenant: Actor = { userId: tenantId, orgId: org };
  const time = "2026-10-26T12:00:00.000Z";
  const expiry = "2026-10-27T12:00:00.000Z";
  const document = new TextEncoder().encode("%PDF-1.7 synthetic unsigned contract");
  const image = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 1);
  const finalPdf = new TextEncoder().encode("%PDF-1.7 synthetic signed artifact");

  await withClient(async (client) => {
    // Use the production helper to establish service_role and claims. Keep all
    // fixtures and retained evidence in this transaction, then roll it back.
    // svcOn preserves FlowError instances when rolling back.
    const rollback = new FlowError("Roll back synthetic e-sign fixtures");
    let savepointNo = 0;

    async function scoped<T>(
      role: "service_role" | "authenticated",
      actorId: string,
      work: () => Promise<T>,
    ): Promise<T> {
      const name = `esign_test_${++savepointNo}`;
      await client.query(`SAVEPOINT ${name}`);
      try {
        await client.query(
          `SELECT set_config('request.jwt.claim.sub',$1,true),
            set_config('request.jwt.claim.role',$2,true)`,
          [actorId, role],
        );
        await client.query(`SET LOCAL ROLE ${role}`);
        const value = await work();
        // Restore the enclosing service role and claims without undoing work.
        await client.query("SET LOCAL ROLE service_role");
        await client.query(
          `SELECT set_config('request.jwt.claim.sub',$1,true),
            set_config('request.jwt.claim.role','service_role',true)`,
          [adminId],
        );
        await client.query(`RELEASE SAVEPOINT ${name}`);
        return value;
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        await client.query(`RELEASE SAVEPOINT ${name}`);
        throw error;
      }
    }

    // The production service transaction is already open on this connection.
    // Savepoints isolate expected failures without committing retained fixtures.
    const run: TransactionRunner = (actorId, work) =>
      scoped("service_role", actorId, () => work(client));
    const repo = new EsignRepo({
      check: async ({ response }) => response === "synthetic-response",
    }, run);

    const asUser = <T>(id: string, work: () => Promise<T>) =>
      scoped("authenticated", id, work);
    const asService = <T>(work: () => Promise<T>) =>
      scoped("service_role", adminId, work);

    async function sqlStatus(id: string) {
      return asService(async () => (await client.query<{ status: string }>(
        `SELECT status FROM esign_versions WHERE id = $1`, [id],
      )).rows[0].status);
    }

    async function prepare(versionId: string, actor: Actor) {
      await repo.apply(actor, caseId, {
        type: "consent", versionId, signerId: actor.userId, kind: "explicit", at: time,
      });
      await repo.apply(actor, caseId, {
        type: "issue_identity", versionId, signerId: actor.userId,
        method: "email", expiresAt: expiry, attemptCap: 3, at: time,
      });
      await repo.recordEmailStep(actor, caseId, {
        versionId, signerId: actor.userId, response: "synthetic-response", at: time,
      });
      await repo.apply(actor, caseId, {
        type: "review", versionId, signerId: actor.userId, scrolledToEnd: true, at: time,
      });
    }

    async function sign(versionId: string, actor: Actor, state: SigningCase, last: boolean) {
      return repo.recordSignature(actor, caseId, {
        versionId, signerId: actor.userId, at: time,
        strokes: [[{ x: 0, y: 0 }, { x: 8, y: 12 }, { x: 20, y: 4 }]],
        imageBytes: image,
        documentDigest: state.versions.find((v) => v.id === versionId)!.documentDigest,
        ip: "127.0.0.1", device: "synthetic-device", userAgent: "synthetic-agent",
        ...(last ? { finalPdfBytes: finalPdf } : {}),
      });
    }

    try {
      await svcOn(client, adminId, async () => {
        // The lane harness has already applied migrations and seed.ts.
        // Reuse its users, organizations and active admin memberships.
        // Only the property, unit, lease and e-sign evidence are test fixtures;
        // rolling back also removes retained evidence without bypassing guards.
        await client.query(
          `INSERT INTO properties(id,org_id,name,country_code,currency,timezone)
           VALUES ($1,$2,'Synthetic property','TW','TWD','Asia/Taipei')`,
          [propertyId, org],
        );
        await client.query(
          `INSERT INTO units(id,org_id,property_id,label) VALUES ($1,$2,$3,'Synthetic unit')`,
          [unitId, org, propertyId],
        );
        await client.query(
          `INSERT INTO leases
           (id,org_id,property_id,unit_id,target_unit_id,start_date,end_date,currency,rent_amount_minor)
           VALUES ($1,$2,$3,$4,$4,'2026-01-01','2027-01-31','TWD',0)`,
          [leaseId, org, propertyId, unitId],
        );

        let state = await repo.createCase(admin, {
          caseId, leaseId, versionId: firstId, body: "Synthetic contract",
          pdfBytes: document,
          signers: [
            { id: ownerId, role: "owner", email: "jianhong.chen@owner.demo" },
            { id: tenantId, role: "tenant", email: "yawen.zhang@tenant.demo" },
          ],
        });

        const flags = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
          `SELECT relrowsecurity,relforcerowsecurity FROM pg_class
           WHERE oid IN (
             'esign_cases'::regclass,'esign_versions'::regclass,'esign_signers'::regclass,
             'esign_signature_images'::regclass,'esign_audit_events'::regclass
           )`,
        );
        assert.equal(flags.rowCount, 5);
        assert.ok(flags.rows.every((r) => r.relrowsecurity && r.relforcerowsecurity));

        const grants = await client.query<{ ok: boolean }>(
          `SELECT NOT has_table_privilege('authenticated','esign_cases','INSERT')
           AND NOT has_table_privilege('anon','esign_cases','SELECT')
           AND NOT has_table_privilege('service_role','esign_audit_events','UPDATE')
           AND NOT has_table_privilege('service_role','esign_audit_events','DELETE') AS ok`,
        );
        assert.equal(grants.rows[0].ok, true);

        for (const id of [adminId, ownerId, tenantId]) {
          await asUser(id, async () => {
            assert.equal((await client.query(
              `SELECT id FROM esign_cases WHERE id = $1`, [caseId],
            )).rowCount, 1);
          });
        }
        for (const id of [otherAdminId, outsiderId]) {
          await asUser(id, async () => {
            assert.equal((await client.query(
              `SELECT id FROM esign_cases WHERE id = $1`, [caseId],
            )).rowCount, 0);
            assert.equal((await client.query(
              `SELECT id FROM esign_versions WHERE case_id = $1`, [caseId],
            )).rowCount, 0);
          });
        }
        await assert.rejects(repo.voidUnsigned(
          { userId: otherAdminId, orgId: otherOrg }, caseId, firstId, "Synthetic reason", time,
        ));
        await assert.rejects(asUser(ownerId, () => client.query(
          `UPDATE esign_versions SET status = 'voided' WHERE id = $1`, [firstId],
        )));
        await assert.rejects(asUser(ownerId, () => client.query(
          `SELECT state FROM esign_versions WHERE id = $1`, [firstId],
        )));
        await asUser(ownerId, async () => {
          assert.equal((await client.query(
            `SELECT id FROM esign_audit_events WHERE case_id = $1`, [caseId],
          )).rowCount, 0);
          assert.equal((await client.query(
            `SELECT id FROM esign_signers WHERE version_id = $1`, [firstId],
          )).rowCount, 1);
        });

        await repo.apply(admin, caseId, {
          type: "send", versionId: firstId, at: time,
          presumedConsentDeadline: expiry, termsVersion: "synthetic-v1",
        });
        await prepare(firstId, owner);
        await prepare(firstId, tenant);
        state = await sign(firstId, owner, state, false);
        await assert.rejects(repo.finalize(admin, caseId, firstId));
        state = await sign(firstId, tenant, state, true);
        assert.equal(await sqlStatus(firstId), "fully_signed");
        assert.deepEqual((await repo.finalize(owner, caseId, firstId)).bytes, finalPdf);
        await assert.rejects(repo.voidUnsigned(admin, caseId, firstId, "Cannot void", time));

        const font = new Uint8Array(await readFile(
          new URL("../../../public/fonts/DroidSansFallback-subset.ttf", import.meta.url),
        ));
        const body = "Synthetic replacement\n本版取代 2026-10-26 簽署之前版";
        const generated = await generateContractPdf(body, font);
        const replacementId = randomUUID();
        state = await repo.supersede(admin, caseId, {
          previousVersionId: firstId, newVersionId: replacementId,
          body, pdfBytes: generated.bytes, documentProof: generated.proof, at: time,
        });
        assert.equal(await sqlStatus(firstId), "fully_signed");
        await assert.rejects(asService(() => client.query(
          `UPDATE esign_versions SET status='superseded',
           state=jsonb_set(jsonb_set(state,'{status}','"superseded"'),'{effect}','"superseded"')
           WHERE id=$1`, [firstId],
        )));
        await repo.apply(admin, caseId, {
          type: "send", versionId: replacementId, at: time,
          presumedConsentDeadline: expiry, termsVersion: "synthetic-v2",
        });
        await prepare(replacementId, owner);
        await prepare(replacementId, tenant);
        state = await sign(replacementId, owner, state, false);
        assert.equal(await sqlStatus(firstId), "fully_signed");
        await assert.rejects(repo.finalize(admin, caseId, replacementId));
        state = await sign(replacementId, tenant, state, true);
        assert.equal(await sqlStatus(firstId), "superseded");
        assert.equal(await sqlStatus(replacementId), "fully_signed");

        for (const id of [firstId, replacementId]) {
          await assert.rejects(asService(() => client.query(
            `UPDATE esign_versions SET body='Changed' WHERE id=$1`, [id],
          )));
          await assert.rejects(asService(() => client.query(
            `UPDATE esign_signers SET email_step_state='failed' WHERE version_id=$1`, [id],
          )));
          await assert.rejects(asService(() => client.query(
            `UPDATE esign_signature_images SET device_id='Changed' WHERE version_id=$1`, [id],
          )));
        }

        const unsignedCase = randomUUID();
        const unsignedVersion = randomUUID();
        await repo.createCase(admin, {
          caseId: unsignedCase, leaseId, versionId: unsignedVersion,
          body: "Synthetic unsigned case", pdfBytes: document,
          signers: [
            { id: ownerId, role: "owner", email: "jianhong.chen@owner.demo" },
            { id: tenantId, role: "tenant", email: "yawen.zhang@tenant.demo" },
          ],
        });
        await assert.rejects(repo.voidUnsigned(owner, unsignedCase, unsignedVersion, "No permission", time));
        await repo.voidUnsigned(admin, unsignedCase, unsignedVersion, "Synthetic admin cancellation", time);
        assert.equal(await sqlStatus(unsignedVersion), "voided");
        await assert.rejects(asService(() => client.query(
          `UPDATE esign_versions SET status='draft' WHERE id=$1`, [unsignedVersion],
        )));

        await asUser(adminId, async () => {
          assert.ok((await client.query(
            `SELECT payload FROM esign_audit_events WHERE case_id=$1`, [caseId],
          )).rowCount);
        });
        await asUser(ownerId, async () => {
          const summary = await client.query(
            `SELECT * FROM esign_audit_summary($1)`, [caseId],
          );
          assert.ok(summary.rowCount);
          assert.ok(summary.rows.every((r) => r.signer_id === ownerId));
          assert.ok(summary.fields.every((f) => !/ip|device|agent|payload/.test(f.name)));
        });

        await asService(async () => {
          const retention = await client.query<{ ok: boolean }>(
            `SELECT bool_and(retention_until = '2042-01-31T00:00:00Z'::timestamptz) AS ok
             FROM (
               SELECT retention_until FROM esign_cases WHERE id=$1
               UNION ALL SELECT retention_until FROM esign_versions WHERE case_id=$1
               UNION ALL SELECT retention_until FROM esign_audit_events WHERE case_id=$1
             ) retained`, [caseId],
          );
          assert.equal(retention.rows[0].ok, true);
          const chain = await client.query<{ ok: boolean }>(
            `SELECT bool_and(
              prev_hash = coalesce(prior_hash, repeat('0',64))
              AND hash = encode(sha256(convert_to((row_data - 'hash')::text,'UTF8')),'hex')
            ) AS ok FROM (
              SELECT a.*,to_jsonb(a) AS row_data,
                lag(hash) OVER (ORDER BY sequence_no) AS prior_hash
              FROM esign_audit_events a WHERE case_id=$1
            ) chained`, [caseId],
          );
          assert.equal(chain.rows[0].ok, true);
          assert.equal((await client.query(
            `SELECT id FROM esign_audit_events WHERE case_id=$1
             AND payload::text LIKE '%synthetic-response%'`, [caseId],
          )).rowCount, 0);
        });

        for (const statement of [
          "UPDATE esign_audit_events SET event_type='tampered' WHERE case_id=$1",
          "DELETE FROM esign_audit_events WHERE case_id=$1",
          "DELETE FROM esign_versions WHERE case_id=$1",
          "UPDATE esign_cases SET retention_until=now() WHERE id=$1",
        ]) {
          await assert.rejects(asService(() => client.query(statement, [caseId])));
          await assert.rejects(asUser(adminId, () => client.query(statement, [caseId])));
        }
        assert.equal(state.versions.find((v) => v.id === firstId)?.effect, "superseded");

        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  });
});
