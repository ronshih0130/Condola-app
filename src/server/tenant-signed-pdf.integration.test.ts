import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { withClient } from "./db";
import { ORG_ID, USERS } from "./ids";

test("tenant signed PDF RLS requires global and org flags and own lease; team access is unchanged", async () => {
  await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      // Keep every fixture and flag change inside this rolled-back transaction.
      const own = (await client.query<{
        id: string;
        org_id: string;
        user_id: string;
      }>(
        `SELECT l.id, l.org_id, c.user_id
           FROM leases l
           JOIN lease_parties lp ON lp.lease_id = l.id
           JOIN contacts c ON c.id = lp.contact_id
          WHERE l.org_id = $1 AND c.user_id IS NOT NULL
            AND c.is_tenant
            AND c.archived_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM org_members m WHERE m.user_id = c.user_id
            )
          ORDER BY l.id
          LIMIT 1`,
        [ORG_ID],
      )).rows[0];
      assert.ok(own, "seed must contain a tenant lease");

      const others = (await client.query<{ id: string; org_id: string }>(
        `SELECT l.id, l.org_id FROM leases l
          WHERE l.id <> $1
            AND NOT EXISTS (
              SELECT 1 FROM lease_parties lp
              JOIN contacts c ON c.id = lp.contact_id
              WHERE lp.lease_id = l.id AND c.user_id = $2
                AND c.archived_at IS NULL
            )
          ORDER BY l.id`,
        [own.id, own.user_id],
      )).rows;
      const otherLease = others.find((row) => row.org_id === own.org_id);
      const otherOrg = others.find((row) => row.org_id !== own.org_id);
      assert.ok(otherLease, "seed must contain another lease in the organization");
      assert.ok(otherOrg, "seed must contain another organization's lease");
      const flagOrgIds = [own.org_id, otherOrg.org_id];

      const ids: string[] = [];
      const bytes = Buffer.from("%PDF-1.4\n%%EOF\n");
      for (const lease of [own, own, otherLease, otherOrg]) {
        const id = randomUUID();
        const path = `${lease.org_id}/${lease.id}/${id}.pdf`;
        await client.query(
          `WITH stored AS (
             INSERT INTO files
               (org_id, storage_bucket, storage_path, file_name, mime_type,
                size_bytes, uploaded_by)
             VALUES ($1, 'lease-documents-private', $2, 'signed.pdf',
                     'application/pdf', $3, $4)
             RETURNING id
           )
           INSERT INTO lease_signed_pdfs
             (id, org_id, lease_id, file_id, object_path, content)
           SELECT $5, $1, $6, stored.id, $2, $7 FROM stored`,
          [lease.org_id, path, bytes.length, USERS.admin, id, lease.id, bytes],
        );
        ids.push(id);
      }

      async function readAs(userId: string) {
        await client.query("RESET ROLE");
        await client.query(
          `SELECT set_config('request.jwt.claim.sub', $1, true),
                  set_config('request.jwt.claim.role', 'authenticated', true),
                  set_config('app.active_org_id', $2, true),
                  set_config('app.env', 'live', true)`,
          [userId, own.org_id],
        );
        await client.query("SET LOCAL ROLE authenticated");
        try {
          return (await client.query<{ id: string }>(
            `SELECT id FROM lease_signed_pdfs WHERE id = ANY($1::uuid[]) ORDER BY id`,
            [ids],
          )).rows.map((row) => row.id);
        } finally {
          await client.query("RESET ROLE");
        }
      }

      async function setFlag(value: unknown) {
        await client.query(
          `UPDATE organizations
              SET feature_flags = coalesce(feature_flags, '{}'::jsonb)
                    || jsonb_build_object('tenant_signed_pdf', $1::jsonb)
            WHERE id = ANY($2::uuid[])`,
          [JSON.stringify(value), flagOrgIds],
        );
      }

      // This suite exercises the DB-layer kill switch, including direct reads.
      // App routes additionally require the independent TS code constant.
      await client.query(
        "DELETE FROM platform_settings WHERE key = 'tenant_signed_pdf'",
      );
      await setFlag(true);
      assert.deepEqual(
        await readAs(own.user_id),
        [],
        "an absent global switch denies tenant reads even with the org flag on",
      );
      assert.deepEqual(
        await readAs(USERS.admin),
        ids.slice(0, 3).sort(),
        "team SELECT remains available with the global switch off",
      );

      await client.query(
        `INSERT INTO platform_settings (key, value)
         VALUES ('tenant_signed_pdf', 'true'::jsonb)`,
      );
      await setFlag(false);
      assert.deepEqual(await readAs(own.user_id), [], "global on alone must not enable RLS");
      assert.deepEqual(
        await readAs(USERS.admin),
        ids.slice(0, 3).sort(),
        "team SELECT remains available with the tenant flag off",
      );

      await setFlag("true");
      assert.deepEqual(await readAs(own.user_id), [], "string true must not enable RLS");

      await setFlag(true);
      assert.deepEqual(
        await readAs(own.user_id),
        ids.slice(0, 2).sort(),
        "tenant can read all own versions, but no other lease or organization",
      );
      assert.deepEqual(
        await readAs(USERS.admin),
        ids.slice(0, 3).sort(),
        "team SELECT remains scoped to its organization with the tenant flag on",
      );

      // Set tenant claims explicitly after the preceding admin read.
      await client.query(
        "SELECT set_config('request.jwt.claim.sub', $1, true)",
        [own.user_id],
      );
      await client.query("SET LOCAL ROLE authenticated");
      try {
        const readable = (await client.query<{
          own: boolean;
          other_lease: boolean;
          other_org: boolean;
          own_lease_other_org: boolean;
        }>(
          `SELECT
             app.tenant_signed_pdf_readable($1::uuid, $2::uuid) AS own,
             app.tenant_signed_pdf_readable($1::uuid, $3::uuid) AS other_lease,
             app.tenant_signed_pdf_readable($4::uuid, $5::uuid) AS other_org,
             app.tenant_signed_pdf_readable($4::uuid, $2::uuid) AS own_lease_other_org`,
          [own.org_id, own.id, otherLease.id, otherOrg.org_id, otherOrg.id],
        )).rows[0];
        assert.deepEqual(readable, {
          own: true,
          other_lease: false,
          other_org: false,
          own_lease_other_org: false,
        }, "own lease paired with another org must be denied even with the global switch and both org flags on");
      } finally {
        await client.query("RESET ROLE");
      }

      const privileges = (await client.query<{
        public_execute: boolean;
        anon_execute: boolean;
        authenticated_execute: boolean;
        service_execute: boolean;
      }>(
        `SELECT
          has_function_privilege('public', 'app.tenant_signed_pdf_readable(uuid,uuid)', 'EXECUTE') AS public_execute,
          has_function_privilege('anon', 'app.tenant_signed_pdf_readable(uuid,uuid)', 'EXECUTE') AS anon_execute,
          has_function_privilege('authenticated', 'app.tenant_signed_pdf_readable(uuid,uuid)', 'EXECUTE') AS authenticated_execute,
          has_function_privilege('service_role', 'app.tenant_signed_pdf_readable(uuid,uuid)', 'EXECUTE') AS service_execute`,
      )).rows[0];
      assert.deepEqual(privileges, {
        public_execute: false,
        anon_execute: false,
        authenticated_execute: true,
        service_execute: true,
      });
    } finally {
      try {
        await client.query("RESET ROLE");
        await client.query(
          "DELETE FROM platform_settings WHERE key = 'tenant_signed_pdf'",
        );
      } finally {
        await client.query("ROLLBACK");
      }
    }
  });
});
