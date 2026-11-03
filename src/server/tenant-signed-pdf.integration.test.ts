import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { query, withClient } from "./db";
import { createProperty } from "./domain";
import { ORG_ID, USERS } from "./ids";
import { createLeaseFromForm } from "./lease-form";
import type { Session } from "./types";
import { insertTestAuthSession } from "./test-auth-session";

test("tenant signed PDF RLS requires global and org flags and own lease; team access is unchanged", async () => {
  const stamp = randomUUID();
  const ownerEmail = `signed.pdf.owner.${stamp}@example.com`;
  const tenantEmail = `signed.pdf.tenant.${stamp}@example.com`;
  let fixtureOrgId: string | undefined;
  let propertyId: string | undefined;
  let fixtureLeaseId: string | undefined;
  let tenantUserId: string | undefined;
  let fixtureSessionId: string | undefined;

  try {
    await withClient(async (client) => {
      await client.query("BEGIN");
      try {
        // Keep PDF fixtures and flag changes inside this rolled-back transaction.
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
            ORDER BY l.id, c.user_id, c.id
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
        let otherOrg = others.find((row) => row.org_id !== own.org_id);
        assert.ok(otherLease, "seed must contain another lease in the organization");

        if (!otherOrg) {
          const staff = (await query<{
            org_id: string;
            user_id: string;
            role: Session["role"];
          }>(
            `SELECT m.org_id, m.user_id, m.role
               FROM org_members m
              WHERE m.org_id <> $1
                AND m.role = 'admin'
              ORDER BY m.org_id, m.user_id
              LIMIT 1`,
            [own.org_id],
          )).rows[0];
          assert.ok(staff, "seed must contain an administrator in another organization");
          fixtureOrgId = staff.org_id;
          fixtureSessionId=await withClient(c=>insertTestAuthSession(c,staff.user_id));

          const session: Session = {
            userId: staff.user_id,
            sessionId: fixtureSessionId,
            email: `signed.pdf.staff.${stamp}@example.com`,
            name: "Signed PDF fixture administrator",
            kind: "staff",
            role: staff.role,
            orgId: staff.org_id,
            liveOrgId: staff.org_id,
            environment: "live",
            locale: "zh-TW",
            calendar: "gregorian",
            leaseId: null,
          };

          const property = await createProperty(session, {
            name: `Tenant signed PDF ${stamp}`,
            city: "台北市",
            district: "大安區",
            street: "測試路9號",
            currency: "TWD",
            ownerMode: "new",
            ownerName: "Signed PDF fixture owner",
            ownerPhone: "",
            ownerEmail,
            canViewTenantPhone: false,
            unitLabel: "9F",
            floor: "9",
            rentalMode: "by_room",
            rooms: [
              { label: "A", roomType: "suite", baseRentMajor: 10000 },
            ],
          });
          propertyId = property.propertyId;
          assert.ok(property.roomIds[0], "fixture property must contain a room");

          const form = new FormData();
          for (const [key, value] of Object.entries({
            roomId: property.roomIds[0],
            tenantName: "Signed PDF fixture tenant",
            tenantPhone: "0912345678",
            tenantEmail,
            lineUserId: "",
            startDate: "2026-11-01",
            months: "12",
            rent: "10000",
            depositMonths: "2",
            depositReason: "",
            dueDay: "5",
            splitMethod: "even",
            billTotal: "",
            usage: "",
            rate: "",
            overrideReason: "",
          })) {
            form.set(key, value);
          }

          const created = await createLeaseFromForm(session, form);
          fixtureLeaseId = created.leaseId;
          tenantUserId = created.tenantUserId;
          otherOrg = { id: created.leaseId, org_id: staff.org_id };
        }

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
        // ROLLBACK also works when a failed statement has aborted the transaction.
        await client.query("ROLLBACK");
      }
    });
  } finally {
    if(fixtureSessionId)await query(`DELETE FROM auth_sessions WHERE id=$1`,[fixtureSessionId]);
    if (fixtureOrgId) {
      await withClient(async (client) => {
        await client.query("BEGIN");
        try {
          // Domain helpers commit independently. Remove their fixtures explicitly,
          // including append-only records, on this dedicated superuser client.
          await client.query("SET LOCAL session_replication_role = replica");

          // Recover identities if a helper committed before throwing.
          const tenants = (await client.query<{ id: string }>(
            `SELECT id FROM auth.users WHERE email = $1`,
            [tenantEmail],
          )).rows.map((row) => row.id);
          if (tenantUserId && !tenants.includes(tenantUserId)) {
            tenants.push(tenantUserId);
          }

          const properties = (await client.query<{ id: string }>(
            `SELECT id FROM properties
              WHERE org_id = $1 AND name = $2`,
            [fixtureOrgId, `Tenant signed PDF ${stamp}`],
          )).rows.map((row) => row.id);
          if (propertyId && !properties.includes(propertyId)) {
            properties.push(propertyId);
          }

          const leases = (await client.query<{ id: string }>(
            `SELECT l.id
               FROM leases l
              WHERE l.org_id = $1 AND l.property_id = ANY($2::uuid[])`,
            [fixtureOrgId, properties],
          )).rows.map((row) => row.id);
          if (fixtureLeaseId && !leases.includes(fixtureLeaseId)) {
            leases.push(fixtureLeaseId);
          }

          await client.query(
            `DELETE FROM lease_signature_events
              WHERE signature_id IN (
                SELECT id FROM lease_signatures
                 WHERE lease_id = ANY($1::uuid[])
              )`,
            [leases],
          );
          await client.query(
            `DELETE FROM lease_signatures WHERE lease_id = ANY($1::uuid[])`,
            [leases],
          );
          await client.query(
            `DELETE FROM lease_signed_pdfs WHERE lease_id = ANY($1::uuid[])`,
            [leases],
          );
          await client.query(
            `DELETE FROM invoice_lines
              WHERE invoice_id IN (
                SELECT id FROM invoices WHERE lease_id = ANY($1::uuid[])
              )`,
            [leases],
          );
          await client.query(
            `DELETE FROM invoices WHERE lease_id = ANY($1::uuid[])`,
            [leases],
          );
          await client.query(
            `DELETE FROM lease_parties WHERE lease_id = ANY($1::uuid[])`,
            [leases],
          );
          await client.query(
            `DELETE FROM leases WHERE id = ANY($1::uuid[])`,
            [leases],
          );
          await client.query(
            `DELETE FROM files
              WHERE org_id = $1
                AND split_part(storage_path, '/', 2) = ANY($2::text[])`,
            [fixtureOrgId, leases],
          );
          await client.query(
            `DELETE FROM rooms
              WHERE unit_id IN (
                SELECT id FROM units WHERE property_id = ANY($1::uuid[])
              )`,
            [properties],
          );
          await client.query(
            `DELETE FROM units WHERE property_id = ANY($1::uuid[])`,
            [properties],
          );
          await client.query(
            `DELETE FROM properties WHERE id = ANY($1::uuid[])`,
            [properties],
          );

          const contacts = (await client.query<{ id: string }>(
            `DELETE FROM contacts
              WHERE org_id = $1
                AND (user_id = ANY($2::uuid[]) OR email IN ($3, $4))
              RETURNING id`,
            [fixtureOrgId, tenants, ownerEmail, tenantEmail],
          )).rows.map((row) => row.id);
          await client.query(
            `DELETE FROM auth.users WHERE id = ANY($1::uuid[])`,
            [tenants],
          );
          await client.query(
            `DELETE FROM audit_log
              WHERE org_id = $1
                AND (
                  row_id::text = ANY($2::text[])
                  OR new_row->>'lease_id' = ANY($3::text[])
                  OR new_row->>'property_id' = ANY($4::text[])
                  OR new_row->>'email' IN ($5, $6)
                )`,
            [
              fixtureOrgId,
              [...leases, ...properties, ...contacts, ...tenants],
              leases,
              properties,
              ownerEmail,
              tenantEmail,
            ],
          );

          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      });
    }
  }
});
