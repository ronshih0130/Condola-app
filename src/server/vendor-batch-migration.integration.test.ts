import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import pg from "pg";
import { ORG_ID, ORG2_ID, USERS } from "./ids";

const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATION_PATH =
  "supabase/migrations/20261030150800_vendor_onboarding_job_types_receipts.sql";

test("vendor batch migration SQL structure and integration checks", async (t) => {
  const sqlText = readFileSync(MIGRATION_PATH, "utf8");
  assert.match(sqlText, /^-- Version 20261030150800\./);
  assert.match(sqlText, /Down:/);
  assert.match(sqlText, /\nBEGIN;\s+SET LOCAL lock_timeout = '5s';/);
  assert.match(sqlText, /COMMIT;\s*$/);
  const sharingSql = readFileSync(
    "supabase/migrations/20261030150700_vendor_link_sharing_approval.sql",
    "utf8",
  );
  assert.match(sharingSql, /\nBEGIN;\s+SET LOCAL lock_timeout = '5s';/);
  assert.match(sharingSql, /COMMIT;\s*$/);

  if (!DATABASE_URL) {
    t.skip("DATABASE_URL is not set; skipping live Postgres integration test");
    return;
  }

  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  const clients: pg.PoolClient[] = [];
  t.after(async () => {
    try {
      const rollbacks = await Promise.allSettled(
        clients.map((client) => client.query("ROLLBACK")),
      );
      for (const [index, client] of clients.entries()) {
        client.release(rollbacks[index].status === "rejected");
      }
      const errors = rollbacks.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length > 0) {
        throw new AggregateError(errors, "Failed to roll back test clients");
      }
    } finally {
      await pool.end();
    }
  });

  const clientA = await pool.connect();
  clients.push(clientA);
  const clientB = await pool.connect();
  clients.push(clientB);
  const contactId = randomUUID();
  const propertyId = randomUUID();
  const legacyTicketId = randomUUID();
  const vendorProfileId = randomUUID();

  async function applyMigration() {
    try {
      // The migration owns its transaction, including SET LOCAL.
      await clientA.query(sqlText);
    } catch (error) {
      await clientA.query("ROLLBACK");
      throw error;
    }
  }

  async function asAuthenticated<T>(
    userId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    await clientA.query("BEGIN");
    try {
      await clientA.query(
        `SELECT set_config('request.jwt.claim.sub', $1, true),
                set_config('request.jwt.claims', $2, true)`,
        [userId, JSON.stringify({ sub: userId, role: "authenticated" })],
      );
      await clientA.query("SET LOCAL ROLE authenticated");
      return await run();
    } finally {
      await clientA.query("ROLLBACK");
    }
  }

  async function allocateSequence(
    client: pg.PoolClient,
    kind = "receipt",
  ): Promise<number> {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE service_role");
      const result = await client.query<{ seq: string }>(
        `SELECT app.next_vendor_document_seq($1, $2)::text AS seq`,
        [vendorProfileId, kind],
      );
      await client.query("COMMIT");
      return Number(result.rows[0]?.seq);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  try {
    const members = await clientA.query(
      `SELECT org_id, user_id FROM public.org_members
        WHERE status = 'active'
          AND ((org_id = $1 AND user_id = $2)
            OR (org_id = $3 AND user_id = $4))`,
      [ORG_ID, USERS.admin, ORG2_ID, USERS.coastAdmin],
    );
    assert.equal(members.rows.length, 2, "Run src/server/seed.ts first");
    const outsiderMembership = await clientA.query(
      `SELECT id FROM public.org_members
        WHERE org_id = $1 AND user_id = $2 AND status = 'active'`,
      [ORG_ID, USERS.coastAdmin],
    );
    assert.equal(outsiderMembership.rows.length, 0);

    await clientA.query(
      `INSERT INTO public.properties
         (id, org_id, name, address_display, country_code, currency, timezone)
       VALUES ($1,$2,'Vendor batch test property',
               '台北市大安區信義路1號','TW','TWD','Asia/Taipei')`,
      [propertyId, ORG_ID],
    );
    await clientA.query(
      `INSERT INTO public.maintenance_tickets
         (id, org_id, ticket_number, property_id, title, job_type_code)
       VALUES ($1,$2,
         (SELECT COALESCE(MAX(ticket_number), 0) + 1
            FROM public.maintenance_tickets WHERE org_id = $2),
         $3,'Vendor batch legacy ticket',NULL)`,
      [legacyTicketId, ORG_ID, propertyId],
    );
    await applyMigration();

    const tables = await clientA.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND c.relname = ANY($1::text[])`,
      [[
        "job_types",
        "vendor_profiles",
        "vendor_profile_versions",
        "vendor_onboarding_invites",
        "vendor_document_sequences",
        "vendor_documents",
      ]],
    );
    assert.equal(tables.rows.length, 6);
    for (const row of tables.rows) {
      assert.equal(row.relrowsecurity, true, `${row.relname} must enable RLS`);
      assert.equal(row.relforcerowsecurity, true, `${row.relname} must force RLS`);
    }
    const badColumns = await clientA.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN (
            'job_types','vendor_profiles','vendor_profile_versions',
            'vendor_onboarding_invites','vendor_document_sequences',
            'vendor_documents','contacts','maintenance_tickets','ticket_attachments'
          )
          AND column_name ~* '(national|id_no|身分)'`,
    );
    assert.equal(badColumns.rowCount, 0);
    const seeded = await clientA.query<{ code: string }>(
      `SELECT code FROM public.job_types WHERE active ORDER BY code`,
    );
    const codes = new Set(seeded.rows.map((row) => row.code));
    for (const code of [
      "cleaning", "plumbing", "painting", "aircon", "moving",
      "pest_control", "locksmith", "masonry", "appliance_repair", "leak_repair",
    ]) {
      assert.ok(codes.has(code), `Missing seeded job type: ${code}`);
    }
    const legacy = await clientA.query(
      `SELECT job_type_code FROM public.maintenance_tickets WHERE id = $1`,
      [legacyTicketId],
    );
    assert.equal(legacy.rows.length, 1);
    assert.equal(legacy.rows[0].job_type_code, null);

    await clientA.query(
      `INSERT INTO public.contacts
         (id, org_id, is_vendor, display_name, phone_e164)
       VALUES ($1,$2,true,'大安水電行','+886912345678')`,
      [contactId, ORG_ID],
    );
    await clientA.query(
      `INSERT INTO public.vendor_profiles
         (id,org_id,contact_id,vendor_code,kind,display_name,business_name,
          representative_name,tax_id,phone_e164,address,service_job_types,
          qualification_attested_at,current_version)
       VALUES ($1,$2,$3,$4,'business','大安水電行','大安水電工程行',
               '王大明','04595257','+886912345678','台北市大安區信義路1號',
               ARRAY['plumbing']::text[],now(),1)`,
      [vendorProfileId, ORG_ID, contactId, vendorProfileId.replaceAll("-", "")],
    );

    await asAuthenticated(USERS.coastAdmin, async () => {
      const rows = await clientA.query(
        `SELECT id FROM public.vendor_profiles WHERE org_id = $1`,
        [ORG_ID],
      );
      assert.equal(rows.rowCount, 0);
    });
    await asAuthenticated(USERS.admin, async () => {
      const rows = await clientA.query(
        `SELECT id FROM public.vendor_profiles WHERE org_id = $1 AND id = $2`,
        [ORG_ID, vendorProfileId],
      );
      assert.equal(rows.rowCount, 1);
    });
    await asAuthenticated(USERS.admin, async () => {
      await assert.rejects(
        clientA.query(
          `INSERT INTO public.vendor_profiles
             (org_id,contact_id,vendor_code,kind,display_name,phone_e164)
           VALUES ($1,$2,'DENIED','individual','師傅','+886911222333')`,
          [ORG_ID, contactId],
        ),
        { code: "42501" },
      );
    });
    await asAuthenticated(USERS.admin, async () => {
      await assert.rejects(
        clientA.query(`SELECT app.next_vendor_document_seq($1, $2)`, [
          vendorProfileId, "receipt",
        ]),
        { code: "42501" },
      );
    });

    const allocationResults = await Promise.allSettled([
      allocateSequence(clientA),
      allocateSequence(clientB),
    ]);
    const first = allocationResults.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    const third = await allocateSequence(clientA);
    assert.deepEqual([...first, third].sort((a, b) => a - b), [1, 2, 3]);
    assert.equal(await allocateSequence(clientB, "completion_statement"), 1);
    assert.equal(await allocateSequence(clientA, "completion_statement"), 2);

    await assert.rejects(allocateSequence(clientA, "invalid"), { code: "23514" });
    await clientA.query("BEGIN");
    await clientA.query("SET LOCAL ROLE service_role");
    const rolledBack = await clientA.query<{ seq: string }>(
      `SELECT app.next_vendor_document_seq($1, 'receipt')::text AS seq`,
      [vendorProfileId],
    );
    assert.equal(rolledBack.rows[0].seq, "4");
    await clientA.query("ROLLBACK");

    await applyMigration();
    const state = await clientA.query<{ kind: string; next_seq: string }>(
      `SELECT kind,next_seq::text FROM public.vendor_document_sequences
        WHERE vendor_profile_id = $1 ORDER BY kind`,
      [vendorProfileId],
    );
    assert.deepEqual(state.rows, [
      { kind: "completion_statement", next_seq: "3" },
      { kind: "receipt", next_seq: "4" },
    ]);

    await asAuthenticated(USERS.coastAdmin, async () => {
      const rows = await clientA.query(
        `SELECT kind FROM public.vendor_document_sequences
          WHERE vendor_profile_id = $1`,
        [vendorProfileId],
      );
      assert.equal(rows.rowCount, 0);
    });
    await asAuthenticated(USERS.admin, async () => {
      const rows = await clientA.query(
        `SELECT kind FROM public.vendor_document_sequences
          WHERE vendor_profile_id = $1`,
        [vendorProfileId],
      );
      assert.equal(rows.rowCount, 2);
    });

    const functionInfo = await clientA.query<{
      prosecdef: boolean;
      proconfig: string[];
      public_execute: boolean;
      anon_execute: boolean;
      authenticated_execute: boolean;
      service_execute: boolean;
    }>(
      `SELECT p.prosecdef,p.proconfig,
              EXISTS (
                SELECT 1 FROM aclexplode(p.proacl) a
                 WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
              ) AS public_execute,
              has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
              has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute,
              has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute
         FROM pg_proc p
        WHERE p.oid = 'app.next_vendor_document_seq(uuid,text)'::regprocedure`,
    );
    const info = functionInfo.rows[0];
    assert.equal(info.prosecdef, true);
    assert.ok(info.proconfig.includes("search_path=pg_catalog, public"));
    assert.equal(info.public_execute, false);
    assert.equal(info.anon_execute, false);
    assert.equal(info.authenticated_execute, false);
    assert.equal(info.service_execute, true);
  } finally {
    await clientA.query("ROLLBACK");
    await clientB.query("ROLLBACK");
    await clientA.query(
      `DELETE FROM public.vendor_document_sequences WHERE vendor_profile_id = $1`,
      [vendorProfileId],
    );
    await clientA.query(`DELETE FROM public.vendor_profiles WHERE id = $1`, [vendorProfileId]);
    await clientA.query(`DELETE FROM public.contacts WHERE id = $1`, [contactId]);
    await clientA.query(`DELETE FROM public.maintenance_tickets WHERE id = $1`, [legacyTicketId]);
    await clientA.query(`DELETE FROM public.properties WHERE id = $1`, [propertyId]);
  }
});
