import { disposableDbUrl } from "./test-disposable-db";
import { cloneTestDatabase } from "./test-database-clone";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { recordMoveOutNotice } from "./move-out-notice";
import { USERS } from "./ids";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let DATABASE_URL: string;
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MIGRATION = path.join(
  ROOT,
  "supabase/migrations/20261031090000_id_delete_after_move_out.sql",
);

test.before(async () => {
  clone = await cloneTestDatabase();
  DATABASE_URL = clone.url;
  execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-f", MIGRATION], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
});

test.after(async () => { await clone?.cleanup(); });

type Fixture = {
  client: Client;
  noticeClient: {
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  };
  orgId: string;
  otherOrgId: string;
  leaseId: string;
  documentId: string;
};

async function withLease(fn: (fixture: Fixture) => Promise<void>) {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    try {
      const org = await client.query<{ id: string }>(
        `INSERT INTO organizations (name, country_code, default_currency)
         VALUES ('Move-out notice test', 'TW', 'TWD') RETURNING id::text`,
      );
      const orgId = org.rows[0]!.id;
      const otherOrg = await client.query<{ id: string }>(
        `INSERT INTO organizations (name, country_code, default_currency)
         VALUES ('Other move-out notice org', 'TW', 'TWD') RETURNING id::text`,
      );
      await client.query(`INSERT INTO org_members(org_id,user_id,role,status) VALUES ($1,$2,'admin','active'),($3,$2,'admin','active')`, [orgId, USERS.admin, otherOrg.rows[0]!.id]);
      // Admit both orgs: the per-org gate must open, and the "another org"
      // sub-test needs otherOrgId admitted so RLS yields not_found, not disabled.
      await client.query(
        `INSERT INTO platform_settings(key, value)
         VALUES ('move_out_notice', jsonb_build_object('enabled', true, 'allowed_org_ids', jsonb_build_array($1::text, $2::text)))
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [orgId, otherOrg.rows[0]!.id],
      );
      await client.query(
        `UPDATE organizations SET feature_flags = jsonb_set(coalesce(feature_flags, '{}'::jsonb), '{move_out_notice}', 'true'::jsonb, true) WHERE id IN ($1, $2)`,
        [orgId, otherOrg.rows[0]!.id],
      );
      const contact = await client.query<{ id: string }>(
        `INSERT INTO contacts (org_id, is_tenant, display_name)
         VALUES ($1, true, 'Move-out notice tenant') RETURNING id::text`,
        [orgId],
      );

      const property = await client.query<{ id: string }>(
        `INSERT INTO properties (
           org_id, name, country_code, currency, timezone, default_rental_mode
         )
         VALUES ($1, 'Move-out notice property', 'TW', 'TWD', 'Asia/Taipei', 'whole_unit')
         RETURNING id::text`,
        [orgId],
      );
      const propertyId = property.rows[0]!.id;
      const unit = await client.query<{ id: string }>(
        `INSERT INTO units (org_id, property_id, label, rental_mode)
         VALUES ($1, $2, 'Move-out notice unit', 'whole_unit')
         RETURNING id::text`,
        [orgId, propertyId],
      );
      const unitId = unit.rows[0]!.id;
      const lease = await client.query<{ id: string }>(
        `INSERT INTO leases (
           org_id, property_id, unit_id, target_unit_id, status,
           start_date, currency, rent_amount_minor
         )
         VALUES ($1, $2, $3, $3, 'active', DATE '2020-01-01', 'TWD', 0)
         RETURNING id::text`,
        [orgId, propertyId, unitId],
      );
      const leaseId = lease.rows[0]!.id;

      const document = await client.query<{ id: string; due: string }>(
        `INSERT INTO identity_documents (
           org_id, contact_id, lease_id, doc_type, number_masked,
           storage_path, encryption_key_ref, created_at
         )
         VALUES ($1, $2, $3, 'passport', 'A***CD', $4,
                 'env:ID_DOC_ENCRYPTION_KEY',
                 TIMESTAMPTZ '2025-01-01 17:00:00+00')
         RETURNING id::text, delete_after::text AS due`,
        [orgId, contact.rows[0]!.id, leaseId, `${orgId}/move-out-notice/front`],
      );
      assert.equal(document.rows[0]!.due, "9999-12-31");

      // Map the service transaction onto a savepoint so the outer fixture
      // transaction can roll back every inserted row, including audit rows.
      const noticeClient = {
        async query(sql: string, params?: unknown[]) {
          if (sql === "BEGIN") {
            return client.query("SAVEPOINT move_out_notice");
          }
          if (sql === "COMMIT") {
            await client.query("RESET ROLE");
            return client.query("RELEASE SAVEPOINT move_out_notice");
          }
          if (sql === "ROLLBACK") {
            await client.query("ROLLBACK TO SAVEPOINT move_out_notice");
            return client.query("RELEASE SAVEPOINT move_out_notice");
          }
          return client.query(sql, params);
        },
      };

      await fn({
        client,
        noticeClient,
        orgId,
        otherOrgId: otherOrg.rows[0]!.id,
        leaseId,
        documentId: document.rows[0]!.id,
      });
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    await client.end();
  }
}

test("move-out notice integration", { concurrency: false }, async (t) => {
  const previous = process.env.MOVE_OUT_NOTICE_ENABLED;
  process.env.MOVE_OUT_NOTICE_ENABLED = "true";
  t.after(() => {
    if (previous === undefined) delete process.env.MOVE_OUT_NOTICE_ENABLED;
    else process.env.MOVE_OUT_NOTICE_ENABLED = previous;
  });

  await t.test("writes move-out and refreshes an existing live document", async () => {
    await withLease(async ({
      client,
      noticeClient,
      orgId,
      leaseId,
      documentId,
    }) => {
      assert.deepEqual(
        await recordMoveOutNotice(noticeClient, {
          orgId,
          leaseId,
          movedOutOn: "2026-06-10",
          actorUserId: USERS.admin,
          liveOrgId: orgId,
          environment: "live",
        }),
        { ok: true },
      );

      const lease = await client.query<{
        moved: string | null;
        terminated: string | null;
        ends: string | null;
        status: string;
      }>(
        `SELECT moved_out_on::text AS moved,
                terminated_on::text AS terminated,
                end_date::text AS ends, status::text
           FROM leases WHERE id = $1 AND org_id = $2`,
        [leaseId, orgId],
      );
      assert.deepEqual(lease.rows[0], {
        moved: "2026-06-10",
        terminated: null,
        ends: null,
        status: "active",
      });
      assert.deepEqual(await recordMoveOutNotice(noticeClient, {
        orgId, liveOrgId: orgId, environment: "live", leaseId,
        movedOutOn: "2026-06-11", actorUserId: USERS.admin, reason: "Synthetic correction",
      }), { ok: true });
      const audits = await client.query<{ actor: string; reason: string; old_date: string | null; new_date: string }>(
        `SELECT actor_user_id::text AS actor,reason,old_row->>'moved_out_on' AS old_date,new_row->>'moved_out_on' AS new_date
           FROM audit_log WHERE org_id=$1 AND table_name='leases' AND row_id=$2 AND action='update'
            AND changed_cols @> ARRAY['moved_out_on']::text[] ORDER BY id`, [orgId, leaseId]);
      assert.deepEqual(audits.rows, [
        { actor: USERS.admin, reason: "move-out notice (CAP-M-13)", old_date: null, new_date: "2026-06-10" },
        { actor: USERS.admin, reason: "Synthetic correction", old_date: "2026-06-10", new_date: "2026-06-11" },
      ]);

      const document = await client.query<{
        due: string;
        expected: string;
        deleted: boolean;
      }>(
        `SELECT delete_after::text AS due,
                (DATE '2026-06-11' + id_document_keep_days())::text AS expected,
                deleted_at IS NOT NULL AS deleted
           FROM identity_documents WHERE id = $1`,
        [documentId],
      );
      assert.equal(document.rows.length, 1);
      assert.equal(document.rows[0]!.deleted, false);
      assert.equal(document.rows[0]!.due, document.rows[0]!.expected);
    });
  });

  await t.test("another org cannot update the lease or its document", async () => {
    await withLease(async ({
      client,
      noticeClient,
      otherOrgId,
      leaseId,
      documentId,
    }) => {
      assert.deepEqual(
        await recordMoveOutNotice(noticeClient, {
          orgId: otherOrgId,
          leaseId,
          movedOutOn: "2026-06-10",
          actorUserId: USERS.admin,
          liveOrgId: otherOrgId,
          environment: "live",
        }),
        { ok: false, reason: "not_found" },
      );

      const lease = await client.query<{
        moved: string | null;
        terminated: string | null;
        ends: string | null;
        status: string;
      }>(
        `SELECT moved_out_on::text AS moved,
                terminated_on::text AS terminated,
                end_date::text AS ends, status::text
           FROM leases WHERE id = $1`,
        [leaseId],
      );
      assert.deepEqual(lease.rows[0], {
        moved: null,
        terminated: null,
        ends: null,
        status: "active",
      });

      const document = await client.query<{ due: string }>(
        `SELECT delete_after::text AS due
           FROM identity_documents WHERE id = $1`,
        [documentId],
      );
      assert.equal(document.rows[0]!.due, "9999-12-31");
    });
  });
});
