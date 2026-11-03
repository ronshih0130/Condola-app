import { disposableDbUrl } from "../test-disposable-db";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { withClient } from "../db";
import { ORG_ID, ORG2_ID, USERS } from "../ids";
import { insertSandboxOrg } from "../sandbox";
import { insertTestAuthSession } from "../test-auth-session";
import { EsignRepo, type TransactionRunner } from "./repo";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
process.env.ESIGN_ENABLED = "true";

test("e-sign RLS helpers preserve intended access and honor environment pins", async () => {
  await withClient(async (client) => {
    const property = randomUUID(), unit = randomUUID(), lease = randomUUID();
    const caseId = randomUUID(), version = randomUUID();
    let sequence = 0;
    await client.query("BEGIN");
    const sessionId=await insertTestAuthSession(client,USERS.admin);
    await client.query(`UPDATE organizations SET feature_flags=feature_flags || '{"esign":true}'::jsonb WHERE id=$1`, [ORG_ID]);
    await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true), set_config('app.active_org_id',$2,true), set_config('app.env','live',true)`,[USERS.admin,ORG_ID]);
    async function scoped<T>(role: "authenticated" | "service_role" | "anon", actor: string, pin: string, env: string, fn: () => Promise<T>): Promise<T> {
      const savepoint = `priv_${++sequence}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claim.role',$2,true), set_config('app.active_org_id',$3,true), set_config('app.env',$4,true)`, [actor, role, pin, env]);
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
    try {
      await client.query(`INSERT INTO properties(id,org_id,name,country_code,currency,timezone) VALUES ($1,$2,'Synthetic','TW','TWD','Asia/Taipei')`, [property, ORG_ID]);
      await client.query(`INSERT INTO units(id,org_id,property_id,label) VALUES ($1,$2,$3,'Synthetic')`, [unit, ORG_ID, property]);
      await client.query(`INSERT INTO leases(id,org_id,property_id,unit_id,target_unit_id,start_date,end_date,currency,rent_amount_minor) VALUES ($1,$2,$3,$4,$4,'2026-01-01','2027-01-31','TWD',0)`, [lease, ORG_ID, property, unit]);
      const run: TransactionRunner = async (actor, fn) => {
        await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claim.role','service_role',true)`, [actor]);
        await client.query("SET LOCAL ROLE service_role");
        try { return await fn(client); } finally { await client.query("RESET ROLE"); }
      };
      const repo = new EsignRepo({ check: async () => true }, run);
      await repo.createCase({ userId: USERS.admin, sessionId, orgId: ORG_ID, liveOrgId: ORG_ID, environment: "live", kind: "staff", role: "admin" } as const, {
        caseId, leaseId: lease, versionId: version, body: "Synthetic contract",
        pdfBytes: new TextEncoder().encode("%PDF synthetic"),
        signers: [
          { id: USERS.owner, role: "owner", email: "owner@example.com" },
          { id: USERS.tenant, role: "tenant", email: "tenant@example.com" },
        ],
      });
      const otherVersion = randomUUID();
      const otherBytes = Buffer.from("%PDF different version");
      const admin = { userId: USERS.admin, sessionId, orgId: ORG_ID, liveOrgId: ORG_ID, environment: "live", kind: "staff", role: "admin" } as const;
      await repo.voidUnsigned(admin, caseId, version, "Synthetic replacement", "2026-10-26T12:00:00Z");
      await repo.supersede(admin, caseId, { previousVersionId: version, newVersionId: otherVersion,
        body: "Other version", pdfBytes: otherBytes, at: "2026-10-26T12:00:00Z" });
      await repo.addSigner(admin, caseId, otherVersion, { id: USERS.owner2, role: "owner", email: "other@example.com" });
      const assignedCase = randomUUID(), assignedVersion = randomUUID();
      await repo.createCase({ userId: USERS.admin, sessionId, orgId: ORG_ID, liveOrgId: ORG_ID, environment: "live", kind: "staff", role: "admin" } as const, {
        caseId: assignedCase, leaseId: lease, versionId: assignedVersion, body: "Synthetic assigned signer contract",
        pdfBytes: new TextEncoder().encode("%PDF synthetic assigned signer"),
        signers: [
          { id: USERS.accountant, role: "owner", email: "accountant@example.com" },
          { id: USERS.maintenance, role: "tenant", email: "maintenance@example.com" },
        ],
      });
      const sandbox = await insertSandboxOrg(client, ORG_ID, USERS.admin);
      const sandboxProperty = randomUUID(), sandboxUnit = randomUUID(), sandboxLease = randomUUID();
      await client.query(`SELECT set_config('app.active_org_id',$1,true), set_config('app.env','sandbox',true)`, [sandbox]);
      const sandboxCase = randomUUID(), sandboxVersion = randomUUID();
      await client.query(`INSERT INTO properties(id,org_id,name,country_code,currency,timezone) VALUES ($1,$2,'Synthetic sandbox','TW','TWD','Asia/Taipei')`, [sandboxProperty, sandbox]);
      await client.query(`INSERT INTO units(id,org_id,property_id,label) VALUES ($1,$2,$3,'Synthetic')`, [sandboxUnit, sandbox, sandboxProperty]);
      await client.query(`INSERT INTO leases(id,org_id,property_id,unit_id,target_unit_id,start_date,end_date,currency,rent_amount_minor) VALUES ($1,$2,$3,$4,$4,'2026-01-01','2027-01-31','TWD',0)`, [sandboxLease, sandbox, sandboxProperty, sandboxUnit]);
      await repo.createCase({ userId: USERS.admin, sessionId, orgId: sandbox, liveOrgId: ORG_ID, environment: "sandbox", kind: "staff", role: "admin" } as const, {
        caseId: sandboxCase, leaseId: sandboxLease, versionId: sandboxVersion, body: "Synthetic sandbox contract",
        pdfBytes: new TextEncoder().encode("%PDF synthetic sandbox"),
        signers: [
          { id: USERS.owner, role: "owner", email: "owner@example.com" },
          { id: USERS.tenant, role: "tenant", email: "tenant@example.com" },
        ],
      });
      const matrix = [
        { actor: USERS.admin, pin: ORG_ID, env: "live", cases: 1, signers: 2, summary: 5, management: true },
        { actor: USERS.manager, pin: ORG_ID, env: "live", cases: 1, signers: 2, summary: 5, management: true },
        { actor: USERS.owner, pin: ORG_ID, env: "live", cases: 1, signers: 1, summary: 2, management: false },
        { actor: USERS.tenant, pin: "", env: "", cases: 1, signers: 1, summary: 2, management: false },
        { actor: USERS.accountant, pin: ORG_ID, env: "live", cases: 0, signers: 0, summary: 0, management: false },
        { actor: USERS.maintenance, pin: ORG_ID, env: "live", cases: 0, signers: 0, summary: 0, management: false },
        { actor: USERS.coastAdmin, pin: ORG2_ID, env: "live", cases: 0, signers: 0, summary: 0, management: false },
        { actor: USERS.owner, pin: sandbox, env: "sandbox", cases: 0, signers: 0, summary: 0, management: false },
        { actor: USERS.owner, pin: ORG_ID, env: "sandbox", cases: 0, signers: 0, summary: 0, management: false },
      ];
      for (const item of matrix) {
        await scoped("authenticated", item.actor, item.pin, item.env, async () => {
          assert.equal((await client.query(`SELECT id FROM public.esign_cases WHERE id=$1`, [caseId])).rowCount, item.cases);
          assert.equal((await client.query(`SELECT id FROM public.esign_signers WHERE version_id=$1`, [version])).rowCount, item.signers);
          const summary = await client.query(`SELECT * FROM app.esign_audit_summary($1)`, [caseId]);
          assert.equal(summary.rowCount, item.summary);
          assert.deepEqual(summary.fields.map((f) => f.name), ["version_id", "signer_id", "signed_at", "email_step_state"]);
          if (item.summary === 1) assert.equal(summary.rows[0].signer_id, item.actor);
          assert.equal((await client.query(`SELECT app.esign_is_management($1) AS allowed`, [caseId])).rows[0].allowed, item.management);
          assert.equal((await client.query(`SELECT app.esign_can_read($1) AS allowed`, [randomUUID()])).rows[0].allowed, false);
        });
      }
      for (const [actor, ownVersions, deniedVersions] of [[USERS.owner, [version, otherVersion], []], [USERS.owner2, [otherVersion], [version]]] as const) {
        await scoped("authenticated", actor, ORG_ID, "live", async () => {
          for (const id of ownVersions) assert.equal((await client.query(`SELECT body,pdf_bytes FROM public.esign_versions WHERE id=$1`, [id])).rowCount, 1);
          for (const id of deniedVersions) assert.equal((await client.query(`SELECT body,pdf_bytes FROM public.esign_versions WHERE id=$1`, [id])).rowCount, 0);
          const summary = await client.query(`SELECT * FROM app.esign_audit_summary($1)`, [caseId]);
          assert.ok(summary.rows.every((row) => row.signer_id === actor && ownVersions.includes(row.version_id)));
          assert.equal(summary.rowCount, ownVersions.length);
        });
      }
      for (const actor of [USERS.accountant, USERS.maintenance]) {
        await scoped("authenticated", actor, ORG_ID, "live", async () => {
          assert.equal((await client.query(`SELECT id FROM public.esign_cases WHERE id=$1`, [assignedCase])).rowCount, 1);
          assert.equal((await client.query(`SELECT id FROM public.esign_signers WHERE version_id=$1`, [assignedVersion])).rowCount, 1);
          const summary = await client.query(`SELECT * FROM app.esign_audit_summary($1)`, [assignedCase]);
          assert.equal(summary.rowCount, 1);
          assert.equal(summary.rows[0].signer_id, actor);
        });
        await scoped("authenticated", actor, sandbox, "sandbox", async () => {
          assert.equal((await client.query(`SELECT * FROM app.esign_audit_summary($1)`, [assignedCase])).rowCount, 0);
        });
      }
      for (const [pin, env, visible] of [[sandbox, "sandbox", 1], [ORG_ID, "live", 0]] as const) {
        await scoped("authenticated", USERS.owner, pin, env, async () => {
          assert.equal((await client.query(`SELECT id FROM public.esign_cases WHERE id=$1`, [sandboxCase])).rowCount, visible);
          assert.equal((await client.query(`SELECT id FROM public.esign_signers WHERE version_id=$1`, [sandboxVersion])).rowCount, visible);
          assert.equal((await client.query(`SELECT * FROM app.esign_audit_summary($1)`, [sandboxCase])).rowCount, visible);
        });
      }
      for (const [pin, env] of [["", ""], ["not-a-uuid", "sandbox"], [sandbox, "invalid"]] as const) {
        await scoped("authenticated", USERS.owner, pin, env, async () => {
          assert.equal((await client.query(`SELECT id FROM public.esign_cases WHERE id=$1`, [sandboxCase])).rowCount, 0);
          assert.equal((await client.query(`SELECT app.esign_is_management($1) AS allowed`, [sandboxCase])).rows[0].allowed, false);
        });
      }
      await scoped("authenticated", USERS.admin, "bad-pin", "live", async () => {
        assert.equal((await client.query(`SELECT app.esign_is_management($1) AS allowed`, [caseId])).rows[0].allowed, false);
      });
      for (const signature of ["public.esign_can_read(uuid)", "public.esign_is_management(uuid)", "public.esign_audit_summary(uuid)"]) {
        const grants = await client.query(`SELECT has_function_privilege('authenticated',$1,'EXECUTE') AS authenticated, has_function_privilege('anon',$1,'EXECUTE') AS anon, has_function_privilege('service_role',$1,'EXECUTE') AS service`, [signature]);
        assert.deepEqual(grants.rows[0], { authenticated: false, anon: false, service: true });
      }
      await scoped("anon", "", "", "", async () => {
        await assert.rejects(client.query(`SELECT app.esign_can_read($1)`, [caseId]), /permission denied/i);
      });
      await scoped("authenticated", USERS.owner, ORG_ID, "live", async () => {
        await assert.rejects(client.query(`SELECT public.esign_audit_summary($1)`, [caseId]), /permission denied/i);
      });
      await scoped("service_role", USERS.admin, "", "", async () => {
        assert.equal((await client.query(`SELECT public.esign_can_read($1) AS allowed`, [caseId])).rows[0].allowed, true);
        assert.equal((await client.query(`SELECT * FROM public.esign_audit_summary($1)`, [caseId])).rowCount, 5);
      });
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
