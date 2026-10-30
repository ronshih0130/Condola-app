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
import { FlowError } from "./errors";

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
      for (const [attempt, [agreement, authority]] of [[false, false], [true, false], [false, true]].entries()) {
        const rejected = await createFirm({
          ...input(person, name), partnerConsent: agreement, partnerAuthority: authority,
          consent: true,
          consentRepo: { read: async () => null, write: async () => { consentWrites++; } },
        });
        assert.deepEqual(rejected, { ok: false, error: "consent" });
        // Personal consent is recorded before the partner gate rejects this attempt.
        assert.equal(consentWrites, attempt + 1);
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

test("AC4 concurrency: admin suspended while signing is refused or serialized", { timeout: 90_000 }, async () => {
  // These are real, independent connections; no Client prototype mocks.
  const a = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 8000 });
  const b = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 8000 });
  const observer = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 8000 });
  const connected: Client[] = [];
  const org = randomUUID();
  const user = randomUUID();
  const key = "design_partner_consent_gate";
  let saved: Record<string, unknown> | undefined;
  let flagSaved = false;
  let pending: Promise<unknown> | undefined;
  const backendPids: number[] = [];

  function noDeadlock(error: unknown) {
    assert.notEqual((error as { code?: string } | null)?.code, "40P01", "deadlock");
  }
  function track<T>(promise: Promise<T>) {
    // Attach rejection handling immediately, including while lock polling runs.
    const result = promise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    pending = result;
    return result;
  }
  async function waiting(pid: number, blocker: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await observer.query(
        `SELECT a.wait_event_type = 'Lock'
                AND $2::int = ANY(pg_blocking_pids(a.pid))
                AND EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = a.pid AND NOT l.granted)
                  AS blocked
           FROM pg_stat_activity a WHERE a.pid = $1`,
        [pid, blocker],
      );
      if (result.rows[0]?.blocked === true) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`backend ${pid} did not wait on backend ${blocker}`);
  }
  async function beginSigner() {
    await a.query("BEGIN");
    await a.query("SET LOCAL lock_timeout = '10s'");
    // Explicitly reproduce svcOn(): no additional org/GUC scope is implicit.
    await a.query(
      "SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', 'service_role', true)",
      [user],
    );
    await a.query("SET LOCAL ROLE service_role");
  }
  async function count(expected: number) {
    const rows = await observer.query(
      "SELECT authority_attested, actor_role, consenter_name FROM partner_agreement_consents WHERE company_id = $1",
      [org],
    );
    assert.equal(rows.rowCount, expected);
    for (const row of rows.rows) {
      assert.equal(row.authority_attested, true);
      assert.equal(row.actor_role, "admin");
      assert.equal(row.consenter_name, "Concurrency Signer");
    }
  }
  const sign = () => recordPartnerConsentOn(
    a, session(user, org), true, true, { ip: null, ua: "concurrency-f1" }, runtime,
  );
  const suspend = () => b.query(
    "UPDATE org_members SET status = 'suspended' WHERE org_id = $1 AND user_id = $2",
    [org, user],
  );
  try {
    for (const client of [a, b, observer]) {
      await client.connect();
      connected.push(client);
      await client.query("SET lock_timeout = '10s'");
      await client.query("SET statement_timeout = '15s'");
    }
    const apid = (await a.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const bpid = (await b.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    backendPids.push(apid, bpid);
    saved = (await observer.query(
      "SELECT * FROM platform_settings WHERE key = $1", [key],
    )).rows[0];
    flagSaved = true;

    // Committed fixtures are essential for cross-connection visibility.
    // Direct inserts avoid createFirm and its sandbox seeds.
    await observer.query("BEGIN");
    await observer.query(
      "INSERT INTO organizations (id, name, country_code, default_currency) VALUES ($1, $2, 'TW', 'TWD')",
      [org, "Concurrency-" + org],
    );
    await observer.query("INSERT INTO auth.users (id, email) VALUES ($1, $2)", [user, user + "@concurrency.example.com"]);
    await observer.query(
      "INSERT INTO profiles (id, display_name, email) VALUES ($1, 'Concurrency Signer', $2)",
      [user, user + "@concurrency.example.com"],
    );
    await observer.query(
      "INSERT INTO org_members (org_id, user_id, role, status, is_billing_owner) VALUES ($1, $2, 'admin', 'active', false)",
      [org, user],
    );
    await observer.query(
      `INSERT INTO platform_settings (key, value, description)
       VALUES ($1, '"on"'::jsonb, 'concurrency-f1')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key],
    );
    await observer.query("COMMIT");
    await count(0);

    // A: suspension owns the membership lock before signing starts.
    await b.query("BEGIN");
    await b.query("SET LOCAL lock_timeout = '10s'");
    await suspend();
    await beginSigner();
    const refused = track(sign());
    await waiting(apid, bpid);
    await b.query("COMMIT");
    const rejection = await refused;
    assert.equal(rejection.ok, false);
    if (rejection.ok) assert.fail("suspended administrator signed");
    noDeadlock(rejection.error);
    assert.ok(rejection.error instanceof FlowError);
    assert.equal(rejection.error.key, "errors.consentRequired");
    await a.query("ROLLBACK");
    await count(0);

    // B/B2: signing owns FOR UPDATE on the org and FOR SHARE on membership.
    for (const commit of [false, true]) {
      await observer.query(
        "UPDATE org_members SET status = 'active' WHERE org_id = $1 AND user_id = $2", [org, user],
      );
      await beginSigner();
      try { await sign(); } catch (error) { noDeadlock(error); throw error; }
      await b.query("BEGIN");
      await b.query("SET LOCAL lock_timeout = '10s'");
      const suspension = track(suspend());
      await waiting(bpid, apid);
      await a.query(commit ? "COMMIT" : "ROLLBACK");
      const outcome = await suspension;
      if (!outcome.ok) { noDeadlock(outcome.error); throw outcome.error; }
      assert.equal(outcome.value.rowCount, 1);
      await b.query("COMMIT");
      await count(commit ? 2 : 0);
      assert.equal((await observer.query(
        "SELECT status FROM org_members WHERE org_id = $1 AND user_id = $2", [org, user],
      )).rows[0].status, "suspended");
    }
  } finally {
    // Release both transactions before waiting for an outstanding blocked query.
    // Query cancellation uses the third connection, never the blocked socket.
    try {
      if (connected.includes(observer)) {
        await observer.query("ROLLBACK");
        if (pending) {
          const pids = backendPids;
          if (pids.length) await observer.query(
            "SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND state = 'active'",
            [pids],
          );
        }
      }
      for (const client of [a, b]) {
        if (connected.includes(client)) await client.query("ROLLBACK");
      }
      if (pending) await pending;
      if (connected.includes(observer)) {
        await observer.query("BEGIN");
        // Parent deletion is the append-only trigger's permitted cascade.
        await observer.query("DELETE FROM organizations WHERE id = $1", [org]);
        await observer.query("DELETE FROM org_members WHERE user_id = $1", [user]);
        await observer.query("DELETE FROM profiles WHERE id = $1", [user]);
        await observer.query("DELETE FROM auth.users WHERE id = $1", [user]);
        if (flagSaved) {
          await observer.query("DELETE FROM platform_settings WHERE key = $1", [key]);
          if (saved) await observer.query(
            "INSERT INTO platform_settings SELECT (jsonb_populate_record(NULL::platform_settings, $1::jsonb)).*",
            [JSON.stringify(saved)],
          );
        }
        await observer.query("COMMIT");
        for (const [table, column, id] of [
          ["organizations", "id", org], ["partner_agreement_consents", "company_id", org],
          ["org_members", "user_id", user], ["profiles", "id", user], ["auth.users", "id", user],
        ]) {
          assert.equal((await observer.query(
            `SELECT 1 FROM ${table} WHERE ${column} = $1`, [id],
          )).rowCount, 0, `leaked ${table} fixture`);
        }
        if (flagSaved) assert.deepEqual((await observer.query(
          "SELECT * FROM platform_settings WHERE key = $1", [key],
        )).rows, saved ? [saved] : []);
      }
    } finally {
      await Promise.all(connected.map((client) => client.end()));
    }
  }
});
