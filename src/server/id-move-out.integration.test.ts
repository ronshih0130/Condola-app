import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const FRESH_URL = process.env.DATABASE_URL ?? "postgres://condola:condola@127.0.0.1:5432/condola";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATION = path.join(
  ROOT,
  "supabase/migrations/20261031090000_id_delete_after_move_out.sql",
);

function psql(databaseUrl: string, file: string) {
  execFileSync("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1", "-f", file], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test.before(() => {
  psql(FRESH_URL, MIGRATION);
  psql(FRESH_URL, MIGRATION);
});

async function withDb<T>(databaseUrl: string, fn: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function withLease(
  fn: (client: Client, leaseId: string, documentId: string) => Promise<void>,
) {
  await withDb(FRESH_URL, async (client) => {
    await client.query("BEGIN");
    try {
      const org = await client.query<{ id: string }>(
        `INSERT INTO organizations (name, country_code, default_currency)
         VALUES ('Move-out test', 'TW', 'TWD') RETURNING id::text`,
      );
      const orgId = org.rows[0]!.id;
      const contact = await client.query<{ id: string }>(
        `INSERT INTO contacts (org_id, is_tenant, display_name)
         VALUES ($1, true, 'Move-out tenant') RETURNING id::text`,
        [orgId],
      );

      const property = await client.query<{ id: string }>(
        `INSERT INTO properties (
           org_id, name, country_code, currency, timezone, default_rental_mode
         )
         VALUES ($1, 'Move-out property', 'TW', 'TWD', 'Asia/Taipei', 'whole_unit')
         RETURNING id::text`,
        [orgId],
      );
      const propertyId = property.rows[0]!.id;
      const unit = await client.query<{ id: string }>(
        `INSERT INTO units (org_id, property_id, label, rental_mode)
         VALUES ($1, $2, 'Move-out unit', 'whole_unit')
         RETURNING id::text`,
        [orgId, propertyId],
      );
      const unitId = unit.rows[0]!.id;
      const lease = await client.query<{ id: string; moved_out_on: string | null }>(
        `INSERT INTO leases (
           org_id, property_id, unit_id, target_unit_id, status,
           start_date, currency, rent_amount_minor
         )
         VALUES ($1, $2, $3, $3, 'active', DATE '2020-01-01', 'TWD', 0)
         RETURNING id::text, moved_out_on::text`,
        [orgId, propertyId, unitId],
      );
      assert.equal(lease.rows[0]!.moved_out_on, null);
      const leaseId = lease.rows[0]!.id;

      const doc = await client.query<{ id: string; due: string }>(
        `INSERT INTO identity_documents (
           org_id, contact_id, lease_id, doc_type, number_masked,
           storage_path, encryption_key_ref, created_at
         )
         VALUES ($1, $2, $3, 'passport', 'A***CD',
                 $4, 'env:ID_DOC_ENCRYPTION_KEY',
                 TIMESTAMPTZ '2025-01-01 17:00:00+00')
         RETURNING id::text, delete_after::text AS due`,
        [orgId, contact.rows[0]!.id, leaseId, `${orgId}/move-out/front`],
      );
      assert.equal(doc.rows[0]!.due, "9999-12-31");
      await fn(client, leaseId, doc.rows[0]!.id);
    } finally {
      await client.query("ROLLBACK");
    }
  });
}

test("moved_out_on is nullable, has no default, and has a comment", async () => {
  await withDb(FRESH_URL, async (client) => {
    const result = await client.query<{
      typ: string;
      attnotnull: boolean;
      def: string | null;
      comment: string | null;
    }>(
      `SELECT format_type(a.atttypid, a.atttypmod) AS typ,
              a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS def,
              col_description(a.attrelid, a.attnum) AS comment
         FROM pg_attribute a
         LEFT JOIN pg_attrdef d
           ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = 'public.leases'::regclass
          AND a.attname = 'moved_out_on' AND NOT a.attisdropped`,
    );
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]!.typ, "date");
    assert.equal(result.rows[0]!.attnotnull, false);
    assert.equal(result.rows[0]!.def, null);
    assert.ok(result.rows[0]!.comment);
  });
});

test("open-ended active lease with no closing dates keeps the sentinel", async () => {
  await withLease(async (client, leaseId, documentId) => {
    const result = await client.query<{ due: string; calculated: string }>(
      `SELECT delete_after::text AS due,
              id_document_delete_after($1, org_id, created_at)::text AS calculated
         FROM identity_documents WHERE id = $2`,
      [leaseId, documentId],
    );
    assert.equal(result.rows[0]!.due, "9999-12-31");
    assert.equal(result.rows[0]!.calculated, "9999-12-31");
  });
});

const formedCases = [
  { name: "moved_out_on only", moved: "2026-06-10", terminated: null, start: "2026-06-10" },
  { name: "terminated_on only", moved: null, terminated: "2026-06-20", start: "2026-06-20" },
  { name: "both: move-out earlier", moved: "2026-06-10", terminated: "2026-06-20", start: "2026-06-20" },
  { name: "both: termination earlier", moved: "2026-06-20", terminated: "2026-06-10", start: "2026-06-20" },
] as const;

for (const scenario of formedCases) {
  test(`formed lease: ${scenario.name} refreshes the existing document`, async () => {
    await withLease(async (client, leaseId, documentId) => {
      await client.query(
        `UPDATE leases SET moved_out_on = $2::date, terminated_on = $3::date
          WHERE id = $1`,
        [leaseId, scenario.moved, scenario.terminated],
      );
      const result = await client.query<{ due: string; calculated: string; expected: string }>(
        `SELECT delete_after::text AS due,
                id_document_delete_after(lease_id, org_id, created_at)::text AS calculated,
                ($2::date + id_document_keep_days())::text AS expected
           FROM identity_documents WHERE id = $1`,
        [documentId, scenario.start],
      );
      assert.equal(result.rows[0]!.due, result.rows[0]!.expected);
      assert.equal(result.rows[0]!.calculated, result.rows[0]!.expected);
    });
  });
}

test("fixed-term early termination still takes precedence over end_date", async () => {
  await withLease(async (client, leaseId, documentId) => {
    await client.query(
      `UPDATE leases
          SET end_date = DATE '2026-12-31',
              terminated_on = DATE '2026-06-10'
        WHERE id = $1`,
      [leaseId],
    );
    const result = await client.query<{ due: string; expected: string }>(
      `SELECT delete_after::text AS due,
              (DATE '2026-06-10' + id_document_keep_days())::text AS expected
         FROM identity_documents WHERE id = $1`,
      [documentId],
    );
    assert.equal(result.rows[0]!.due, result.rows[0]!.expected);
  });
});

for (const status of ["pending_signature", "cancelled"] as const) {
  test(`${status} keeps the Taipei upload clock despite moved_out_on`, async () => {
    await withLease(async (client, leaseId, documentId) => {
      await client.query(
        `UPDATE leases
            SET status = $2, signed_at = NULL, esign_status = 'not_sent',
                end_date = DATE '2026-12-31'
          WHERE id = $1`,
        [leaseId, status],
      );
      const before = await client.query<{ due: string }>(
        `SELECT delete_after::text AS due FROM identity_documents WHERE id = $1`,
        [documentId],
      );
      await client.query(
        `UPDATE leases SET moved_out_on = DATE '2026-06-10' WHERE id = $1`,
        [leaseId],
      );
      const after = await client.query<{ due: string; expected: string }>(
        `SELECT delete_after::text AS due,
                (DATE '2025-01-02' + id_document_keep_days())::text AS expected
           FROM identity_documents WHERE id = $1`,
        [documentId],
      );
      assert.equal(after.rows[0]!.due, before.rows[0]!.due);
      assert.equal(after.rows[0]!.due, after.rows[0]!.expected);
    });
  });
}

test("delete-after signature, security and execute privileges stay unchanged", async () => {
  await withDb(FRESH_URL, async (client) => {
    const result = await client.query<{
      signature: string;
      result: string;
      names: string[];
      definer: boolean;
      volatility: string;
      config: string[];
      pub: boolean;
      anon: boolean;
      authn: boolean;
      svc: boolean;
    }>(
      `SELECT oidvectortypes(p.proargtypes) AS signature,
              pg_get_function_result(p.oid) AS result,
              p.proargnames AS names, p.prosecdef AS definer,
              p.provolatile AS volatility, p.proconfig AS config,
              has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
              has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authn,
              has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'id_document_delete_after'`,
    );
    assert.equal(result.rows.length, 1);
    const row = result.rows[0]!;
    assert.equal(row.signature, "uuid, uuid, timestamp with time zone");
    assert.equal(row.result, "date");
    assert.deepEqual(row.names, ["p_lease_id", "p_org_id", "p_created_at"]);
    assert.equal(row.definer, true);
    assert.equal(row.volatility, "s");
    assert.deepEqual(row.config, ["search_path=public, pg_temp"]);
    assert.equal(row.pub, false);
    assert.equal(row.anon, false);
    assert.equal(row.authn, false);
    assert.equal(row.svc, true);
  });
});
