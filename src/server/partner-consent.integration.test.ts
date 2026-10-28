import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Client } from "pg";
import { buildStoredConsent } from "./consent";
import { requireCurrentConsent } from "./consent-gate";
import { query, svc, withClient } from "./db";
import {
  insertPartnerDocumentsOn, partnerConsentHistory, readPartnerStateOn, recordPartnerConsentOn,
} from "./partner-consent";
import { partnerTestRuntime } from "./partner-consent-test-fixture";
import { createFirm } from "./signup";
import type { Session } from "./types";

const migration = readFileSync(new URL("../../supabase/migrations/20261030151300_partner_agreement_consents.sql", import.meta.url), "utf8");
const attestationMigration = readFileSync(new URL("../../supabase/migrations/20261030151301_partner_consent_attestation.sql", import.meta.url), "utf8");
const runtime = partnerTestRuntime();

function session(userId: string, companyId: string): Session {
  return {
    userId, orgId: companyId, liveOrgId: companyId, kind: "staff", role: "admin",
    sessionId: "partner-db", email: "partner@example.com", name: "Person",
    environment: "live", locale: "en", calendar: "gregorian", leaseId: null,
    consent: buildStoredConsent("reconsent"),
  };
}
function denied(error: unknown) {
  assert.equal((error as { code?: string }).code, "42501");
  return true;
}

test("AC4 AC7 migrations apply twice; attestation constraints, RLS, ACL, append-only and retained evidence", async () => {
  await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query(migration);
      await client.query(migration);
      await client.query(attestationMigration);
      await client.query(attestationMigration);
      const own = randomUUID();
      const otherUser = randomUUID();
      const ownOrg = randomUUID();
      const otherOrg = randomUUID();
      for (const id of [own, otherUser]) {
        await client.query("INSERT INTO auth.users (id, email) VALUES ($1, $2)", [id, id + "@partner.example.com"]);
      }
      for (const id of [ownOrg, otherOrg]) {
        await client.query(
          "INSERT INTO organizations (id, name, country_code, default_currency) VALUES ($1, $2, 'TW', 'TWD')",
          [id, id],
        );
      }
      await client.query(
        "INSERT INTO org_members (org_id, user_id, role, status) VALUES ($1, $2, 'admin', 'active'), ($3, $4, 'admin', 'active')",
        [ownOrg, own, otherOrg, otherUser],
      );
      await client.query("INSERT INTO profiles (id, display_name, email) VALUES ($1, 'Signer', $2)", [own, own + "@partner.example.com"]);
      const docs = (await import("./partner-consent")).verifiedPartnerDocuments;
      const selected = (await docs("en", runtime))!;
      await insertPartnerDocumentsOn(client, ownOrg, own, selected, { ip: "203.0.113.7", ua: "x".repeat(700) });
      await insertPartnerDocumentsOn(client, ownOrg, own, selected, { ip: null, ua: null });
      await insertPartnerDocumentsOn(client, otherOrg, otherUser, selected, { ip: null, ua: null });
      const evidence = await client.query(
        "SELECT doc_type, version, document_sha256, ip_address::text AS ip, user_agent, consented_at, authority_attested, actor_role, consenter_name FROM partner_agreement_consents WHERE company_id = $1",
        [ownOrg],
      );
      assert.equal(evidence.rowCount, 2);
      for (const doc of selected) {
        const row = evidence.rows.find((row) => row.doc_type === doc.doc_type);
        assert.equal(row.version, doc.version);
        assert.equal(row.document_sha256, doc.sha256);
        assert.equal(row.ip, "203.0.113.7/32");
        assert.equal(row.user_agent.length, 512);
        assert.equal(row.authority_attested, true);
        assert.equal(row.actor_role, "admin");
        assert.equal(row.consenter_name, "Signer");
        assert.ok(Number.isFinite(new Date(row.consented_at).getTime()));
      }
      for (const [authority, actor, name] of [
        [false, "admin", "Signer"], [null, "admin", "Signer"],
        [true, "manager", "Signer"], [true, null, "Signer"],
        [true, "admin", ""], [true, "admin", "   "],
        [true, "admin", null], [true, "admin", "x".repeat(201)],
      ]) {
        await client.query("SAVEPOINT invalid_attestation");
        await assert.rejects(client.query(
          `INSERT INTO partner_agreement_consents
             (company_id, user_id, doc_type, version, locale, document_sha256,
              authority_attested, actor_role, consenter_name)
           VALUES ($1, $2, 'privacy', 'invalid', 'en', $3, $4, $5, $6)`,
          [ownOrg, own, "a".repeat(64), authority, actor, name],
        ), (error: unknown) => {
          assert.equal((error as { code?: string }).code, "23514");
          return true;
        });
        await client.query("ROLLBACK TO SAVEPOINT invalid_attestation");
        await client.query("RELEASE SAVEPOINT invalid_attestation");
      }
      async function asRole<T>(role: "authenticated" | "service_role" | "anon", run: (db: Client) => Promise<T>) {
        await client.query("SAVEPOINT partner_role");
        try {
          await client.query("SET LOCAL ROLE " + role);
          await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [own]);
          await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: own, role })]);
          await client.query("SELECT set_config('app.active_org_id', $1, true), set_config('app.env', 'live', true)", [ownOrg]);
          return await run(client);
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT partner_role");
          await client.query("RELEASE SAVEPOINT partner_role");
        }
      }
      const rows = await asRole("authenticated", (db) => db.query(
        "SELECT company_id::text FROM partner_agreement_consents WHERE company_id = ANY($1::uuid[])",
        [[ownOrg, otherOrg]],
      ));
      assert.equal(rows.rowCount, 2);
      assert.ok(rows.rows.every((row) => row.company_id === ownOrg));
      await assert.rejects(asRole("anon", (db) => db.query("SELECT * FROM partner_agreement_consents")), denied);
      await assert.rejects(asRole("authenticated", (db) => db.query(
        `INSERT INTO partner_agreement_consents
          (company_id, user_id, doc_type, version, locale, document_sha256)
         VALUES ($1, $2, 'privacy', 'forged', 'en', $3)`,
        [ownOrg, own, "a".repeat(64)],
      )), denied);
      for (const sql of [
        "UPDATE partner_agreement_consents SET version = 'forged'",
        "UPDATE partner_agreement_consents SET authority_attested = true, actor_role = 'owner', consenter_name = 'Changed'",
        "DELETE FROM partner_agreement_consents",
        "TRUNCATE partner_agreement_consents",
      ]) {
        await assert.rejects(asRole("service_role", (db) => db.query(sql)), denied);
        await assert.rejects(asRole("authenticated", (db) => db.query(sql)), denied);
        await client.query("SAVEPOINT partner_trigger");
        await assert.rejects(client.query(sql), denied);
        await client.query("ROLLBACK TO SAVEPOINT partner_trigger");
        await client.query("RELEASE SAVEPOINT partner_trigger");
      }
      const privileges = await client.query(
        `SELECT role, has_function_privilege(role,
         'public.partner_agreement_consents_append_only()', 'EXECUTE') AS allowed
         FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) role`,
      );
      assert.ok(privileges.rows.every((row) => !row.allowed));
      const publicGrant = await client.query(
        `SELECT 1 FROM pg_proc p
         CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
         WHERE p.oid = 'public.partner_agreement_consents_append_only()'::regprocedure
           AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'`,
      );
      assert.equal(publicGrant.rowCount, 0);
      await client.query("DELETE FROM auth.users WHERE id = $1", [own]);
      assert.equal((await client.query("SELECT 1 FROM partner_agreement_consents WHERE company_id = $1", [ownOrg])).rowCount, 2);
      await client.query("DELETE FROM organizations WHERE id = $1", [ownOrg]);
      assert.equal((await client.query("SELECT 1 FROM partner_agreement_consents WHERE company_id = $1", [ownOrg])).rowCount, 0);
    } finally {
      await client.query("ROLLBACK");
    }
  });
});

test("AC1 AC4 AC5 AC6 AC7 signup requires both boxes, rolls back, snapshots pair, and gate passes", { timeout: 180_000 }, async (t) => {
  await withClient(async (client) => {
    const execute = client.query.bind(client);
    await execute("BEGIN");
    await execute(migration);
    await execute(attestationMigration);

    // Production helpers open their own clients and transactions. Keep their
    // real SQL on this connection, using savepoints for their transaction
    // boundaries so COMMIT cannot persist any fixture or sandbox seed data.
    // These mocks are scoped to this serial test and restored in finally.
    t.mock.method(Client.prototype, "connect", async () => {});
    t.mock.method(Client.prototype, "end", async () => {});
    t.mock.method(Client.prototype, "query", (async (
      sql: string, params?: unknown[],
    ) => {
      switch (sql.trim().toUpperCase()) {
        case "BEGIN":
          return execute("SAVEPOINT partner_signup_operation");
        case "COMMIT":
          // A real COMMIT ends SET LOCAL ROLE. Restore that boundary while
          // keeping successful writes inside the rollback-owned transaction.
          await execute("RESET ROLE");
          return execute("RELEASE SAVEPOINT partner_signup_operation");
        case "ROLLBACK":
          await execute("ROLLBACK TO SAVEPOINT partner_signup_operation");
          return execute("RELEASE SAVEPOINT partner_signup_operation");
        default:
          return execute(sql, params);
      }
    }) as Client["query"]);
    const key = "design_partner_consent_gate";
    async function flag(value: unknown) {
      await query(
        `INSERT INTO platform_settings (key, value, description) VALUES ($1, $2::jsonb, 'partner consent integration')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, JSON.stringify(value)],
      );
    }
    async function user() {
      const id = randomUUID();
      const email = id + "@partner-signup.example.com";
      await query("INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1, $2, now())", [id, email]);
      await query("INSERT INTO profiles (id, display_name, email) VALUES ($1, 'Signer', $2)", [id, email]);
      return { id, email };
    }
    function input(person: { id: string; email: string }, name: string) {
      return {
        userId: person.id, email: person.email, name, kind: "firm", contactName: "Signer",
        phone: "", partnerCode: "", partnerLocale: "en", partnerRuntime: runtime,
        consentRepo: { read: async () => buildStoredConsent("signup"), write: async () => {} },
      };
    }
    try {
      await flag("off");
      const old = await user();
      const unchanged = await createFirm(input(old, "Partner-off-" + old.id));
      assert.ok(unchanged.ok);
      if (!unchanged.ok) throw new Error("OFF signup failed");
      assert.equal((await query("SELECT 1 FROM partner_agreement_consents WHERE company_id = $1", [unchanged.orgId])).rowCount, 0);

      await flag("on");
      const person = await user();
      const name = "Partner-on-" + person.id;
      let consentWrites = 0;
      for (const [agreement, authority] of [[false, false], [true, false], [false, true]]) {
        const rejected = await createFirm({
          ...input(person, name), partnerConsent: agreement, partnerAuthority: authority,
          consent: true,
          consentRepo: { read: async () => null, write: async () => { consentWrites++; } },
        });
        assert.deepEqual(rejected, { ok: false, error: "consent" });
        assert.equal(consentWrites, 0);
        assert.equal((await query("SELECT 1 FROM organizations WHERE name = $1", [name])).rowCount, 0);
        assert.equal((await query("SELECT 1 FROM partner_agreement_consents WHERE user_id = $1", [person.id])).rowCount, 0);
      }
      const unavailable = partnerTestRuntime(undefined, "2026-10-22");
      assert.deepEqual(await createFirm({
        ...input(person, name), partnerConsent: true, partnerAuthority: true, partnerRuntime: unavailable,
      }), { ok: false, error: "consent" });
      assert.equal((await query("SELECT 1 FROM organizations WHERE name = $1", [name])).rowCount, 0);
      await assert.rejects(createFirm({
        ...input(person, name), partnerConsent: true, partnerAuthority: true, partnerMeta: { ip: "invalid-inet", ua: "x" },
      }));
      assert.equal((await query("SELECT 1 FROM organizations WHERE name = $1", [name])).rowCount, 0);
      assert.equal((await query("SELECT 1 FROM partner_agreement_consents WHERE user_id = $1", [person.id])).rowCount, 0);

      const created = await createFirm({
        ...input(person, name), partnerConsent: true, partnerAuthority: true, partnerMeta: { ip: "203.0.113.9", ua: "x".repeat(900) },
      });
      assert.ok(created.ok);
      if (!created.ok) throw new Error("ON signup failed");
      const current = session(person.id, created.orgId);
      const state = await withClient((client) => readPartnerStateOn(client, current, runtime));
      assert.equal(state.active, true);
      assert.equal(state.required, false);
      assert.equal(await requireCurrentConsent({ ...current, partnerConsent: state }, "api"), null);
      const evidence = await query(
        `SELECT doc_type, version, document_sha256, user_id::text, ip_address::text AS ip,
                user_agent, consented_at, authority_attested, actor_role, consenter_name
           FROM partner_agreement_consents WHERE company_id = $1`, [created.orgId],
      );
      assert.equal(evidence.rowCount, 2);
      for (const doc of state.documents) {
        const row = evidence.rows.find((row) => row.doc_type === doc.doc_type);
        assert.ok(row, `missing evidence for ${doc.doc_type}`);
        assert.equal(row.document_sha256, doc.sha256);
        assert.equal(row.version, doc.version);
        assert.equal(row.user_id, person.id);
        assert.equal(row.ip, "203.0.113.9/32");
        assert.equal(row.user_agent.length, 512);
        assert.equal(row.authority_attested, true);
        assert.equal(row.actor_role, "owner");
        assert.equal(row.consenter_name, "Signer");
        assert.ok(Number.isFinite(new Date(row.consented_at).getTime()));
      }
      for (const status of ["suspended", "removed", "invited", "active"]) {
        await query("UPDATE org_members SET status = $3 WHERE org_id = $1 AND user_id = $2",
          [created.orgId, person.id, status]);
        if (status !== "active") {
          await assert.rejects(svc(person.id, (client) =>
            recordPartnerConsentOn(client, current, true, true, { ip: null, ua: null }, runtime)));
          assert.equal((await query("SELECT 1 FROM partner_agreement_consents WHERE company_id = $1", [created.orgId])).rowCount, 2);
        }
      }
      // Repeat submissions exercise idempotence. A single rollback-owned
      // connection requires serial transactions; this is not a concurrency check.
      for (let attempt = 0; attempt < 2; attempt++) {
        await svc(person.id, (client) =>
          recordPartnerConsentOn(client, current, true, true, { ip: "203.0.113.9", ua: "again" }, runtime));
      }
      assert.equal((await query("SELECT 1 FROM partner_agreement_consents WHERE company_id = $1", [created.orgId])).rowCount, 2);

      const history = await partnerConsentHistory({ ...current, partnerConsent: state });
      assert.equal(history.length, 2);
      assert.ok(history.every((row) => row.consenter === "Signer"));
      await query("UPDATE profiles SET display_name = 'Renamed', email = 'renamed@example.com' WHERE id = $1", [person.id]);
      const renamedHistory = await partnerConsentHistory({ ...current, partnerConsent: state });
      assert.ok(renamedHistory.every((row) => row.consenter === "Signer"));
      const bump = partnerTestRuntime();
      bump.config.documents.partner_agreement.find((doc) => doc.locale === "en")!.version = "v0.2";
      assert.equal((await withClient((client) => readPartnerStateOn(client, current, bump))).required, true);

      await query("UPDATE org_members SET role = 'manager', is_billing_owner = false WHERE org_id = $1 AND user_id = $2", [created.orgId, person.id]);
      await assert.rejects(svc(person.id, (client) =>
        recordPartnerConsentOn(client, current, true, true, { ip: null, ua: null }, runtime)));
      const nonAdmin = await withClient((client) => readPartnerStateOn(client, current, bump));
      assert.equal(nonAdmin.admin, false);
      assert.equal(nonAdmin.required, true);
    } finally {
      // Restore the real client methods before ending the outer transaction.
      // ROLLBACK also restores the flag, including an originally absent row.
      try {
        t.mock.restoreAll();
      } finally {
        await execute("ROLLBACK");
      }
    }
  });
});
