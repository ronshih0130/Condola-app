import { disposableDbUrl } from "../test-disposable-db";
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
import { PDFDocument } from "pdf-lib";
import { buildStoredConsent } from "../consent";
import type { Session } from "../types";
import { EsignFlow } from "./flow";
import { contractVersionDigest } from "./document";
import { EsignDenied } from "./access";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);

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
  const admin: Actor = { userId: adminId, orgId: org, liveOrgId: org, environment: "live", kind: "staff", role: "admin" };
  const owner: Actor = { userId: ownerId, orgId: org, liveOrgId: org, environment: "live", kind: "owner", role: null };
  const tenant: Actor = { userId: tenantId, orgId: org, liveOrgId: org, environment: "live", kind: "tenant", role: null };
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

    async function prepare(versionId: string, actor: Actor, targetCase = caseId) {
      await repo.apply(actor, targetCase, {
        type: "consent", versionId, signerId: actor.userId, kind: "explicit", at: time,
      });
      await repo.apply(actor, targetCase, {
        type: "issue_identity", versionId, signerId: actor.userId,
        method: "email", expiresAt: expiry, attemptCap: 3, at: time,
      });
      await repo.recordEmailStep(actor, targetCase, {
        versionId, signerId: actor.userId, response: "synthetic-response", at: time,
      });
      await repo.apply(actor, targetCase, {
        type: "review", versionId, signerId: actor.userId, scrolledToEnd: true, at: time,
      });
    }

    async function sign(versionId: string, actor: Actor, state: SigningCase, last: boolean, targetRepo = repo, targetCase = caseId) {
      return targetRepo.recordSignature(actor, targetCase, {
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
           VALUES ($1,$2,$3,$4,$4,'2026-01-01','2027-01-31','TWD',10000)`,
          [leaseId, org, propertyId, unitId],
        );

        const contact = (await client.query<{id:string}>(`SELECT id::text FROM contacts WHERE org_id=$1 AND user_id=$2`, [org, tenantId])).rows[0].id;
        await client.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES ($1,$2,$3,'primary')`, [org,leaseId,contact]);

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
        const privateBoundary=await client.query<{ok:boolean}>(`SELECT
          pg_get_userbyid(c.relowner) NOT IN ('anon','authenticated','service_role')
          AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r
            CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
            WHERE has_table_privilege(r,c.oid,p))
          AND (SELECT count(*)=3 AND bool_and(pg_get_userbyid(f.proowner) NOT IN ('anon','authenticated','service_role')
            AND NOT has_function_privilege('anon',f.oid,'EXECUTE')
            AND NOT has_function_privilege('authenticated',f.oid,'EXECUTE')
            AND NOT has_function_privilege('service_role',f.oid,'EXECUTE'))
            FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace
            WHERE n.nspname='app' AND f.proname IN ('b001_lock_parent_before_case','b001_record_completion_requirement','b001_require_completion_financials')) AS ok
          FROM pg_class c WHERE c.oid='app.b001_completion_requirements'::regclass`);
        assert.equal(privateBoundary.rows[0].ok,true);

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
          { userId: otherAdminId, orgId: otherOrg, liveOrgId: otherOrg, environment: "live", kind: "staff", role: "admin" }, caseId, firstId, "Synthetic reason", time,
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
        state = await sign(firstId, tenant, state, false);
        await assert.rejects(repo.finalize(admin, caseId, firstId));
        await assert.rejects(sign(firstId, owner, state, true), (error: unknown) => (error as {key?:string}).key === "errors.idDocRequired");
        assert.equal(await sqlStatus(firstId), "partially_signed");
        const doc = (await client.query<{id:string}>(`INSERT INTO identity_documents(org_id,contact_id,lease_id,doc_type,number_masked,storage_path,encryption_key_ref,review_status,created_by) VALUES ($1,$2,$3,'passport','A**789',$4,'fixture-key','pending_review',$5) RETURNING id::text`,[org,contact,leaseId,`${org}/${leaseId}/doc`,adminId])).rows[0].id;
        for (const slot of ["front", "selfie"]) await client.query(`INSERT INTO identity_document_photos(org_id,document_id,slot,storage_path,mime_type,size_bytes,sha256) VALUES ($1,$2,$3,$4,'image/jpeg',4,'abc')`,[org,doc,slot,`${org}/${leaseId}/${slot}`]);
        const failing = new EsignRepo({check: async () => true}, (actorId, work) => scoped("service_role", actorId, () => work(new Proxy(client, {
          get(target, key) {
            if (key === "query") return (...args: unknown[]) => {
              if (typeof args[0] === "string" && args[0].includes("INSERT INTO invoices")) throw new Error("synthetic invoice fault");
              return Reflect.apply(target.query, target, args);
            };
            return Reflect.get(target, key, target);
          },
        }))));
        const beforeFailure = (await client.query<{n:string}>(`SELECT count(*)::text AS n FROM esign_audit_events WHERE case_id=$1`,[caseId])).rows[0].n;
        await assert.rejects(sign(firstId, owner, state, true, failing), /synthetic invoice fault/);
        assert.equal(await sqlStatus(firstId), "partially_signed");
        assert.equal((await client.query(`SELECT 1 FROM esign_signature_images WHERE version_id=$1 AND signer_id=$2`,[firstId,ownerId])).rowCount,0);
        assert.equal((await client.query<{n:string}>(`SELECT count(*)::text AS n FROM esign_audit_events WHERE case_id=$1`,[caseId])).rows[0].n,beforeFailure);
        assert.equal((await client.query(`SELECT 1 FROM invoices WHERE lease_id=$1`,[leaseId])).rowCount,0);
        // Simulate a pre-hook writer that persists the final signature but does no activation.
        const oldWriter = new EsignRepo({check: async () => true}, (actorId, work) => scoped("service_role", actorId, async () => {
          const result = await work(new Proxy(client, { get(target, key) {
            if (key === "query") return (...args: unknown[]) => {
              if (typeof args[0] === "string" && args[0].includes("SELECT l.id::text, l.status::text")) return Promise.resolve({rows:[{status:"active",esign_status:"not_sent"}],rowCount:1});
              return Reflect.apply(target.query,target,args);
            };
            return Reflect.get(target,key,target);
          }}));
          await client.query("SET CONSTRAINTS app.b001_completion_financials IMMEDIATE");
          return result;
        }));
        await assert.rejects(sign(firstId, owner, state, true, oldWriter), (error: unknown) => (error as {code?:string}).code === "23514");
        assert.equal(await sqlStatus(firstId), "partially_signed");
        assert.equal((await client.query(`SELECT 1 FROM esign_signature_images WHERE version_id=$1 AND signer_id=$2`,[firstId,ownerId])).rowCount,0);
        assert.equal((await client.query<{n:string}>(`SELECT count(*)::text AS n FROM esign_audit_events WHERE case_id=$1`,[caseId])).rows[0].n,beforeFailure);
        state = await sign(firstId, owner, state, true);
        await client.query("SET CONSTRAINTS app.b001_completion_financials IMMEDIATE");
        await client.query("RESET ROLE");
        assert.equal((await client.query(`SELECT 1 FROM app.b001_completion_requirements WHERE version_id=$1`,[firstId])).rowCount,0);
        await client.query("SET LOCAL ROLE service_role");
        await client.query("SET CONSTRAINTS app.b001_completion_financials DEFERRED");
        const activated = await client.query(`SELECT l.status::text, l.esign_status::text, i.created_by::text, a.actor_user_id::text, a.new_row->>'case_creator_id' AS creator FROM leases l JOIN invoices i ON i.lease_id=l.id AND i.source='move_in' JOIN audit_log a ON a.row_id=l.id::text AND a.event_type='esign_lease_activated' WHERE l.id=$1`,[leaseId]);
        assert.deepEqual(activated.rows[0],{status:"active",esign_status:"fully_signed",created_by:ownerId,actor_user_id:ownerId,creator:adminId});
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

        const retryUnit=randomUUID(), retryLease=randomUUID();
        await client.query(`INSERT INTO units(id,org_id,property_id,label) VALUES ($1,$2,$3,'Retry unit')`,[retryUnit,org,propertyId]);
        await client.query(`INSERT INTO leases(id,org_id,property_id,unit_id,target_unit_id,start_date,end_date,currency,rent_amount_minor,deposit_amount_minor) VALUES ($1,$2,$3,$4,$4,'2026-01-01','2027-01-31','TWD',0,0)`,[retryLease,org,propertyId,retryUnit]);
        await client.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id,role) VALUES ($1,$2,$3,'primary')`,[org,retryLease,contact]);
        const retryDoc=(await client.query<{id:string}>(`INSERT INTO identity_documents(org_id,contact_id,lease_id,doc_type,number_masked,storage_path,encryption_key_ref,review_status,created_by) VALUES ($1,$2,$3,'passport','A**789',$4,'fixture-key','pending_review',$5) RETURNING id::text`,[org,contact,retryLease,`${org}/${retryLease}/doc`,adminId])).rows[0].id;
        for (const slot of ["front","selfie"]) await client.query(`INSERT INTO identity_document_photos(org_id,document_id,slot,storage_path,mime_type,size_bytes,sha256) VALUES ($1,$2,$3,$4,'image/jpeg',4,'abc')`,[org,retryDoc,slot,`${org}/${retryLease}/${slot}`]);
        const unsignedCase = randomUUID();
        const unsignedVersion = randomUUID();
        await repo.createCase(admin, {
          caseId: unsignedCase, leaseId: retryLease, versionId: unsignedVersion,
          body: "Synthetic unsigned case", pdfBytes: document,
          signers: [
            { id: ownerId, role: "owner", email: "jianhong.chen@owner.demo" },
            { id: tenantId, role: "tenant", email: "yawen.zhang@tenant.demo" },
          ],
        });
        await assert.rejects(repo.voidUnsigned(owner, unsignedCase, unsignedVersion, "No permission", time));
        await repo.voidUnsigned(admin, unsignedCase, unsignedVersion, "Synthetic admin cancellation", time);
        assert.equal(await sqlStatus(unsignedVersion), "voided");
        const retryVersion=randomUUID();
        let retry=await repo.supersede(admin,unsignedCase,{previousVersionId:unsignedVersion,newVersionId:retryVersion,body:"Retry contract",pdfBytes:document,at:time});
        await repo.apply(admin,unsignedCase,{type:"send",versionId:retryVersion,at:time,presumedConsentDeadline:expiry,termsVersion:"synthetic-v1"});
        await prepare(retryVersion,owner,unsignedCase);
        await prepare(retryVersion,tenant,unsignedCase);
        retry=await sign(retryVersion,owner,retry,false,repo,unsignedCase);
        await assert.rejects(sign(retryVersion,tenant,retry,true,repo,unsignedCase), (error:unknown) => (error as {key?:string}).key === "errors.generic");
        assert.equal(await sqlStatus(retryVersion),"partially_signed");
        assert.equal((await client.query(`SELECT 1 FROM invoices WHERE lease_id=$1`,[retryLease])).rowCount,0);
        const retryMeter=randomUUID(), retryRun=randomUUID();
        await client.query(`INSERT INTO meters(id,org_id,property_id,unit_id,utility,rate_minor_per_unit) VALUES ($1,$2,$3,$4,'water',10000)`,[retryMeter,org,propertyId,retryUnit]);
        await client.query(`INSERT INTO utility_allocation_runs(id,org_id,meter_id,period_start,period_end,split_method,rate_source,currency,total_usage,rate_minor_per_unit,total_amount_minor) VALUES ($1,$2,$3,'2026-01-01','2026-01-31','none','fixed_rate','TWD',1,10000,10000)`,[retryRun,org,retryMeter]);
        await client.query(`INSERT INTO utility_allocation_lines(org_id,run_id,lease_id,share_ratio,allocated_usage,amount_minor) VALUES ($1,$2,$3,1,1,10000)`,[org,retryRun,retryLease]);
        await sign(retryVersion,tenant,retry,true,repo,unsignedCase);
        await client.query("SET CONSTRAINTS app.b001_completion_financials IMMEDIATE");
        assert.equal((await client.query(`SELECT 1 FROM leases l JOIN invoices i ON i.lease_id=l.id AND i.source='move_in' WHERE l.id=$1 AND l.status='active'`,[retryLease])).rowCount,1);
        const credits=await client.query<{account:string;amount:string}>(`SELECT e.account::text,e.amount_minor::text AS amount FROM ledger_entries e JOIN invoices i ON i.id=e.invoice_id WHERE i.lease_id=$1 ORDER BY e.account`,[retryLease]);
        assert.deepEqual(credits.rows,[{account:"tenant_receivable",amount:"10000"},{account:"other_income",amount:"-10000"}]);
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
            `SELECT * FROM app.esign_audit_summary($1)`, [caseId],
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

test("mounted action service on PG: Email replay, permissions, atomic replacement and purge isolation", async () => {
  const leaseId = randomUUID(), propertyId = randomUUID(), unitId = randomUUID();
  const font = new Uint8Array(await readFile(new URL("../../../public/fonts/DroidSansFallback-subset.ttf", import.meta.url)));
  const initial = await generateContractPdf("住宅租約\n屋主與租客", font);
  const messages: { to: string; text: string }[] = [];
  let now = new Date("2026-10-26T12:00:00Z");
  const base: Session = {
    userId: USERS.admin, orgId: ORG_ID, liveOrgId: ORG_ID, sessionId: "synthetic-session",
    kind: "staff", role: "admin", environment: "live", calendar: "gregorian", locale: "zh-TW",
    leaseId, email: "admin@example.com", name: "測試", consent: buildStoredConsent("reconsent"),
  };
  const manager = { ...base, userId: USERS.manager, role: "manager" as const };
  const owner = { ...base, userId: USERS.owner, kind: "owner" as const, role: null };
  const tenant = { ...base, userId: USERS.tenant, kind: "tenant" as const, role: null };
  const outsider = { ...base, userId: USERS.owner2, kind: "owner" as const, role: null };
  const foreign = { ...base, userId: USERS.coastAdmin, orgId: ORG2_ID, liveOrgId: ORG2_ID };
  const strokes = [[{ x: 2, y: 2 }, { x: 30, y: 40 }, { x: 80, y: 8 }]];
  await withClient(async (client) => {
    const rollback = new FlowError("Rollback mounted e-sign fixtures");
    try {
      await svcOn(client, USERS.admin, async () => {
        let index = 0;
        const run: TransactionRunner = async (actorId, work) => {
          const save = "mounted_esign_" + (++index);
          await client.query("SAVEPOINT " + save);
          try {
            await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [actorId]);
            const result = await work(client);
            await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [USERS.admin]);
            await client.query("RELEASE SAVEPOINT " + save);
            return result;
          } catch (error) {
            await client.query("ROLLBACK TO SAVEPOINT " + save);
            await client.query("RELEASE SAVEPOINT " + save);
            throw error;
          }
        };
        const flow = new EsignFlow({
          run, enabled: () => true, font: async () => font, now: () => now,
          secret: "synthetic-esign-secret-only-at-least-32-bytes",
          mail: async (message) => { messages.push(message); return { ok: true, messageId: "synthetic", provider: "cloudflare" }; },
        });
        await client.query(
          "INSERT INTO properties(id,org_id,name,country_code,currency,timezone) VALUES ($1,$2,'Synthetic mounted property','TW','TWD','Asia/Taipei')",
          [propertyId, ORG_ID],
        );
        await client.query("INSERT INTO units(id,org_id,property_id,label) VALUES ($1,$2,$3,'Synthetic mounted unit')", [unitId, ORG_ID, propertyId]);
        await client.query(
          "INSERT INTO leases(id,org_id,property_id,unit_id,target_unit_id,start_date,end_date,currency,rent_amount_minor) VALUES ($1,$2,$3,$4,$4,'2026-01-01','2027-01-31','TWD',10000)",
          [leaseId, ORG_ID, propertyId, unitId],
        );
        const contacts = await client.query<{ id: string; user_id: string }>(
          "SELECT id::text,user_id::text FROM contacts WHERE org_id=$1 AND user_id=ANY($2::uuid[]) AND archived_at IS NULL",
          [ORG_ID, [USERS.owner, USERS.tenant]],
        );
        const ownerContact = contacts.rows.find((r) => r.user_id === USERS.owner)!.id;
        const tenantContact = contacts.rows.find((r) => r.user_id === USERS.tenant)!.id;
        await client.query("INSERT INTO property_owners(org_id,property_id,owner_contact_id) VALUES ($1,$2,$3)", [ORG_ID, propertyId, ownerContact]);
        await client.query("INSERT INTO lease_parties(org_id,lease_id,contact_id) VALUES ($1,$2,$3)", [ORG_ID, leaseId, tenantContact]);
        const doc = (await client.query<{id:string}>(`INSERT INTO identity_documents(org_id,contact_id,lease_id,doc_type,number_masked,storage_path,encryption_key_ref,review_status,created_by) VALUES ($1,$2,$3,'passport','A**789',$4,'fixture-key','pending_review',$5) RETURNING id::text`,[ORG_ID,tenantContact,leaseId,`${ORG_ID}/${leaseId}/doc`,USERS.admin])).rows[0].id;
        for (const slot of ["front", "selfie"]) await client.query(`INSERT INTO identity_document_photos(org_id,document_id,slot,storage_path,mime_type,size_bytes,sha256) VALUES ($1,$2,$3,$4,'image/jpeg',4,'abc')`,[ORG_ID,doc,slot,`${ORG_ID}/${leaseId}/${slot}`]);
        const create = {
          type: "create" as const, leaseId, pdf: initial.bytes, ownerId: USERS.owner, tenantId: USERS.tenant,
          ownerDocument: true, tenantDocument: false, order: "parallel" as const, deadline: "2026-11-01T12:00:00Z",
        };
        await assert.rejects(flow.execute({ ...base, role: "accountant" }, create));
        await assert.rejects(flow.execute(owner, create));
        await assert.rejects(flow.execute(foreign, create));
        await assert.rejects(flow.execute(manager, { ...create, tenantId: USERS.tenant2 }));
        await flow.execute(manager, create);
        assert.equal(messages.length, 2);
        const first = (await flow.list(manager, leaseId)).versions[0];
        const target = { caseId: first.caseId, versionId: first.id };
        await assert.rejects(flow.list(outsider, leaseId));
        await assert.rejects(flow.pdf(foreign, first.caseId, first.id, false));
        await assert.rejects(flow.execute(manager, { ...target, type: "consent" }));
        await assert.rejects(flow.execute(manager, { ...target, type: "void", reason: "Manager cannot void" }));
        await assert.rejects(flow.execute(owner, { ...target, type: "review" }));
        await assert.rejects(flow.execute(owner, { ...target, type: "confirm", response: "no challenge" }));

        async function prepare(actor: Session, version: { caseId: string; id: string; digest: string; pages: number }) {
          const target = { caseId: version.caseId, versionId: version.id };
          await flow.execute(actor, { ...target, type: "consent" });
          await flow.execute(actor, { ...target, type: "email" });
          const count = messages.length;
          const code = messages.at(-1)!.text.match(/[a-f0-9]{32}$/)![0];
          await flow.execute(actor, { ...target, type: "email" });
          assert.equal(messages.length, count, "duplicate requests cannot reset attempts or send more mail");
          await flow.execute(actor, { ...target, type: "confirm", response: "wrong" });
          assert.equal((await flow.list(actor, leaseId)).versions.find((v) => v.id === version.id)!.own!.status, "pending_identity");
          await flow.execute(actor, { ...target, type: "confirm", response: code });
          await assert.rejects(flow.execute(actor, { ...target, type: "confirm", response: code }));

          // Identity alone cannot acknowledge review. Check this for each signer
          // and replacement so delivery evidence cannot carry across bindings.
          assert.equal((await flow.list(actor, leaseId)).versions.find((v) => v.id === version.id)!.own!.status, "pending_review");
          await assert.rejects(
            flow.execute(actor, { ...target, type: "review" }),
            (error: unknown) => error instanceof EsignDenied
              && error.message === "Document delivery required before acknowledgement",
          );
          assert.equal((await flow.list(actor, leaseId)).versions.find((v) => v.id === version.id)!.own!.status, "pending_review");

          // Fetch the complete unsigned PDF through the production flow, which
          // records durable delivery evidence for this signer and version.
          const delivered = await flow.pdf(actor, version.caseId, version.id, false);
          assert.equal(delivered.digest, version.digest);
          assert.equal(await contractVersionDigest(delivered.bytes), version.digest);
          assert.equal((await PDFDocument.load(delivered.bytes)).getPageCount(), version.pages);
          await flow.execute(actor, { ...target, type: "review" });
          return code;
        }
        const firstCode = await prepare(owner, first);
        await prepare(tenant, first);
        const sign = (actor: Session, v: typeof first) => flow.execute(actor, {
          type: "sign", caseId: v.caseId, versionId: v.id, strokes, digest: v.digest,
          ip: "127.0.0.1", userAgent: "Synthetic mounted action test",
        });
        await assert.rejects(sign(owner, first), /Document check required/);
        await flow.execute(manager, { ...target, type: "document", signerId: USERS.owner, documentType: "passport" });
        await sign(owner, first);
        await assert.rejects(flow.pdf(owner, first.caseId, first.id, true));
        await sign(tenant, first);
        const complete = await flow.pdf(tenant, first.caseId, first.id, true);
        assert.equal((await PDFDocument.load(complete.bytes)).getPageCount(), 3);
        assert.equal(await contractVersionDigest(complete.bytes), complete.digest);
        const ownView = (await flow.list(owner, leaseId)).versions[0];
        assert.equal(ownView.audit.length, 1);
        assert.equal(ownView.history.length, 0);
        assert.equal(ownView.own!.identityLabel, "已完成 Email 身分確認步驟");
        assert.ok(ownView.audit.every((r) => !("ip" in r) && !("device" in r) && !("userAgent" in r)));
        const staffView = (await flow.list(manager, leaseId)).versions[0];
        assert.ok(staffView.history.length > 0);
        assert.ok(staffView.audit.every((r) => r.ip === "127.0.0.1"));
        await assert.rejects(flow.execute(base, { ...target, type: "void", reason: "Signed cannot be voided" }));

        await flow.execute(manager, { ...target, type: "replace", body: "新版住宅租約", deadline: create.deadline });
        let versions = (await flow.list(manager, leaseId)).versions;
        const next = versions.find((v) => v.previousId === first.id)!;
        assert.ok(next.replacementText?.includes("本版取代 2026-10-26 簽署之前版"));
        assert.equal(versions.find((v) => v.id === first.id)!.effect, "effective");
        await flow.execute(owner, { caseId: next.caseId, versionId: next.id, type: "consent" });
        await flow.execute(owner, { caseId: next.caseId, versionId: next.id, type: "email" });
        await flow.execute(owner, { caseId: next.caseId, versionId: next.id, type: "confirm", response: firstCode });
        assert.equal((await flow.list(owner, leaseId)).versions.find((v) => v.id === next.id)!.own!.status, "pending_identity");
        // This replacement is cancelled unsigned; the original remains effective.
        await flow.execute(base, { caseId: next.caseId, versionId: next.id, type: "void", reason: "Synthetic restart" });
        await flow.execute(manager, { caseId: next.caseId, versionId: next.id, type: "replace", body: "重新建立新版住宅租約", deadline: create.deadline });
        versions = (await flow.list(manager, leaseId)).versions;
        const fresh = versions.find((v) => v.previousId === next.id)!;
        await prepare(owner, fresh);
        await prepare(tenant, fresh);
        await assert.rejects(sign(owner, fresh), /Document check required/);
        await flow.execute(manager, { caseId: fresh.caseId, versionId: fresh.id, type: "document", signerId: USERS.owner, documentType: "residence_permit" });
        await sign(owner, fresh);
        assert.equal((await flow.list(owner, leaseId)).versions.find((v) => v.id === first.id)!.effect, "effective");
        await sign(tenant, fresh);
        assert.equal((await flow.list(owner, leaseId)).versions.find((v) => v.id === first.id)!.effect, "superseded");
        assert.deepEqual((await flow.pdf(owner, first.caseId, first.id, true)).bytes, complete.bytes);

        const retained = await client.query<{ row: unknown }>(
          "SELECT to_jsonb(v) AS row FROM esign_versions v WHERE case_id=$1 ORDER BY id", [first.caseId],
        );
        // Purge isolation is meaningful only with the current explicit ON guard.
        // svcOn rolls this fixture setting back with the rest of the test.
        await client.query(`INSERT INTO platform_settings(key,value) VALUES ('ID_PURGE_ENABLED','"on"'::jsonb)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
        await client.query("SELECT purge_due_identity_documents(1)");
        assert.deepEqual((await client.query(
          "SELECT to_jsonb(v) AS row FROM esign_versions v WHERE case_id=$1 ORDER BY id", [first.caseId],
        )).rows, retained.rows);
        assert.equal((await client.query<{ ok: boolean }>(
          "SELECT bool_and(retention_until='2042-01-31T00:00:00Z'::timestamptz) AS ok FROM esign_versions WHERE case_id=$1", [first.caseId],
        )).rows[0].ok, true);
        assert.equal((await client.query(
          "SELECT id FROM esign_audit_events WHERE case_id=$1 AND payload::text LIKE $2", [first.caseId, "%" + firstCode + "%"],
        )).rowCount, 0);
        now = new Date("2026-10-26T13:00:00Z");
        throw rollback;
      });
    } catch (error) { if (error !== rollback) throw error; }
  });
});
