import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { writeSignedPdfDownload } from "./audit";
import { query, withClient } from "./db";
import { ORG_ID, USERS } from "./ids";
import { tenantSignedLeasePdf } from "./queries";
import { tenantSignedPdfDownload } from "./tenant-signed-pdf-download";
import type { Session } from "./types";

process.env.TENANT_SIGNED_PDF_ENABLED = "true";

// Run against seeded local Postgres:
// DATABASE_URL=postgres://... npx tsx --test --test-concurrency=1 \
//   src/server/tenant-signed-pdf-download-audit.integration.test.ts
// Run separately from suites that change the same global/org feature flags.
test("tenant signed PDF downloads audit success exactly once and never audit denied reads", async () => {
  const pdfIds = [randomUUID(), randomUUID()];
  const fileIds = [randomUUID(), randomUUID()];
  const requestIds = [randomUUID(), randomUUID(), randomUUID()];
  const bytes = Buffer.from(
    `%PDF-1.4\n${"signed-download-audit-fixture\n".repeat(256)}%%EOF\n`,
  );

  await withClient(async (client) => {
    let committed = false;
    let orgId: string | undefined;
    let originalFlags: string | null = null;
    let originalGlobal: { value: string } | undefined;

    try {
      await client.query("BEGIN");
      try {
        const own = (await client.query<{
          id: string;
          org_id: string;
          user_id: string;
        }>(
          `SELECT l.id, l.org_id, c.user_id
             FROM leases l
             JOIN lease_parties lp ON lp.lease_id = l.id
             JOIN contacts c ON c.id = lp.contact_id
            WHERE l.org_id = $1
              AND c.user_id IS NOT NULL
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
        orgId = own.org_id;

        const other = (await client.query<{ id: string }>(
          `SELECT l.id
             FROM leases l
            WHERE l.org_id = $1
              AND l.id <> $2
              AND NOT EXISTS (
                SELECT 1
                  FROM lease_parties lp
                  JOIN contacts c ON c.id = lp.contact_id
                 WHERE lp.lease_id = l.id
                   AND c.user_id = $3
                   AND c.archived_at IS NULL
              )
            ORDER BY l.id
            LIMIT 1`,
          [own.org_id, own.id, own.user_id],
        )).rows[0];
        assert.ok(other, "seed must contain another tenant's lease in the org");

        const organization = (await client.query<{
          flags: string | null;
        }>(
          `SELECT feature_flags::text AS flags
             FROM organizations WHERE id = $1 FOR UPDATE`,
          [own.org_id],
        )).rows[0];
        assert.ok(organization);
        originalFlags = organization.flags;

        originalGlobal = (await client.query<{ value: string }>(
          `SELECT value::text AS value
             FROM platform_settings
            WHERE key = 'tenant_signed_pdf'
            FOR UPDATE`,
        )).rows[0];

        await client.query(
          `INSERT INTO platform_settings (key, value)
           VALUES ('tenant_signed_pdf', 'true'::jsonb)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        );
        await client.query(
          `UPDATE organizations
              SET feature_flags = coalesce(feature_flags, '{}'::jsonb)
                    || '{"tenant_signed_pdf":true}'::jsonb
            WHERE id = $1`,
          [own.org_id],
        );

        for (const [index, leaseId] of [own.id, other.id].entries()) {
          const path = `${own.org_id}/${leaseId}/${pdfIds[index]}.pdf`;
          await client.query(
            `INSERT INTO files
               (id, org_id, storage_bucket, storage_path, file_name,
                mime_type, size_bytes, uploaded_by)
             VALUES ($1, $2, 'lease-documents-private', $3, 'signed.pdf',
                     'application/pdf', $4, $5)`,
            [fileIds[index], own.org_id, path, bytes.length, USERS.admin],
          );
          await client.query(
            `INSERT INTO lease_signed_pdfs
               (id, org_id, lease_id, file_id, object_path, content)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              pdfIds[index],
              own.org_id,
              leaseId,
              fileIds[index],
              path,
              bytes,
            ],
          );
        }

        // Both the real RLS read and svc audit open separate connections.
        // Commit fixtures and gates before invoking either; finally removes
        // committed fixtures/audits and restores the original gate values.
        await client.query("COMMIT");
        committed = true;

        const session: Session = {
          userId: own.user_id,
          sessionId: `signed-pdf-download-audit-${randomUUID()}`,
          email: "signed.pdf.download.audit@example.com",
          name: "Signed PDF download audit tenant",
          kind: "tenant",
          role: null,
          orgId: own.org_id,
          liveOrgId: own.org_id,
          environment: "live",
          locale: "zh-TW",
          calendar: "gregorian",
          leaseId: own.id,
        };

        const auditErrors: { tag: string; error: unknown }[] = [];
        async function download(
          leaseId: string,
          pdfId: string,
          requestId: string,
        ) {
          return tenantSignedPdfDownload({
            orgId: session.orgId,
            userId: session.userId,
            leaseId,
            pdfId,
            requestId,
          }, {
            read: () => tenantSignedLeasePdf(session, leaseId, pdfId),
            audit: writeSignedPdfDownload,
            logError: (tag, error) => {
              auditErrors.push({ tag, error });
            },
          });
        }

        async function auditRows(requestId: string) {
          // Deliberately do not filter by event_type: an extra or incorrectly
          // classified audit for this request must also fail the assertions.
          return (await query<{
            event_type: string;
            request_id: string;
            org_id: string;
            actor_user_id: string;
            actor_role: string;
            table_name: string;
            row_id: string;
            new_row: Record<string, unknown>;
          }>(
            `SELECT event_type, request_id, org_id, actor_user_id,
                    actor_role, table_name, row_id, new_row
               FROM audit_log
              WHERE request_id = $1`,
            [requestId],
          )).rows;
        }

        const authorized = await download(own.id, pdfIds[0], requestIds[0]);
        assert.equal(authorized.status, 200);
        assert.deepEqual(
          Buffer.from(await authorized.arrayBuffer()),
          bytes,
          "authorized response must contain the stored PDF bytes",
        );
        assert.deepEqual(auditErrors, [], "the real audit insert must succeed");

        const rows = await auditRows(requestIds[0]);
        assert.equal(rows.length, 1, "success must write exactly one audit row");
        const row = rows[0];
        assert.equal(row.event_type, "signed_pdf_downloaded");
        assert.equal(row.request_id, requestIds[0]);
        assert.equal(row.org_id, own.org_id);
        assert.equal(row.actor_user_id, own.user_id);
        assert.equal(row.actor_role, "tenant");
        assert.equal(row.table_name, "lease_signed_pdfs");
        assert.equal(row.row_id, pdfIds[0]);
        assert.ok(row.new_row && typeof row.new_row === "object");
        assert.equal(Object.hasOwn(row.new_row, "content"), false);
        assert.deepEqual(row.new_row, {
          event: "signed_pdf_downloaded",
          lease_id: own.id,
        });
        assert.ok(
          Buffer.byteLength(JSON.stringify(row.new_row), "utf8") < 512,
          "audit metadata must remain small and contain no PDF bytes",
        );

        // The target PDF exists and its lease matches the supplied leaseId;
        // denial therefore exercises tenant ownership through the real read.
        const wrongLease = await download(other.id, pdfIds[1], requestIds[1]);
        assert.equal(wrongLease.status, 404);
        assert.deepEqual(await auditRows(requestIds[1]), []);

        const unknownPdf = await download(own.id, randomUUID(), requestIds[2]);
        assert.equal(unknownPdf.status, 404);
        assert.deepEqual(await auditRows(requestIds[2]), []);
        assert.deepEqual(auditErrors, []);
        assert.equal((await auditRows(requestIds[0])).length, 1);
      } catch (error) {
        if (!committed) await client.query("ROLLBACK");
        throw error;
      }
    } finally {
      if (committed) {
        await client.query("BEGIN");
        try {
          // As in tenant-signed-pdf.integration.test.ts, local superuser
          // cleanup disables append-only triggers only in this transaction.
          await client.query("SET LOCAL session_replication_role = replica");
          await client.query(
            `DELETE FROM lease_signed_pdfs WHERE id = ANY($1::uuid[])`,
            [pdfIds],
          );
          await client.query(
            `DELETE FROM files WHERE id = ANY($1::uuid[])`,
            [fileIds],
          );
          await client.query(
            `UPDATE organizations SET feature_flags = $2::jsonb WHERE id = $1`,
            [orgId, originalFlags],
          );
          if (originalGlobal) {
            await client.query(
              `UPDATE platform_settings SET value = $1::jsonb
                WHERE key = 'tenant_signed_pdf'`,
              [originalGlobal.value],
            );
          } else {
            await client.query(
              `DELETE FROM platform_settings WHERE key = 'tenant_signed_pdf'`,
            );
          }
          await client.query(
            `DELETE FROM audit_log
              WHERE request_id::text = ANY($1::text[])
                 OR row_id::text = ANY($2::text[])`,
            [requestIds, [...pdfIds, ...fileIds]],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
    }
  });
});
