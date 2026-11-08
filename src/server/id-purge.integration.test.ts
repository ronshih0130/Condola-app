import { disposableDbUrl } from "./test-disposable-db";
import { cloneTestDatabase } from "./test-database-clone";
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { tx } from "./db";
import { FlowError } from "./errors";
import { resetAndSeed } from "./seed";
import { ORG_ID, USERS } from "./ids";
import { runIdPurge } from "../../id-purge-cron.mjs";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let DATABASE_URL: string;
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;

test.before(async () => {
  clone = await cloneTestDatabase();
  DATABASE_URL = clone.url;
  // This file owns its fixtures; earlier suites may legitimately remove leases.
  await resetAndSeed();
});

test.after(async () => { await clone?.cleanup(); });

async function withDb<T>(fn: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const saved = await client.query(
      "SELECT * FROM platform_settings WHERE key = 'ID_PURGE_ENABLED'",
    );
    try {
      await client.query(
        `INSERT INTO platform_settings (key, value) VALUES ('ID_PURGE_ENABLED', '"on"')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      );
      return await fn(client);
    } finally {
      if (saved.rows.length) {
        const row = saved.rows[0];
        await client.query(
          `UPDATE platform_settings SET value = $1, description = $2, updated_at = $3
            WHERE key = 'ID_PURGE_ENABLED'`,
          [JSON.stringify(row.value), row.description, row.updated_at],
        );
      } else {
        await client.query("DELETE FROM platform_settings WHERE key = 'ID_PURGE_ENABLED'");
      }
    }
  } finally {
    await client.end();
  }
}

async function serviceQuery(client: Client, sql: string, params: unknown[] = []) {
  await client.query("BEGIN");
  try {
    await client.query(
      `SELECT set_config('request.jwt.claim.role', 'service_role', true)`,
    );
    await client.query("SET LOCAL ROLE service_role");
    const result = await client.query(sql, params);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

test("a formed lease follows its end date and an unformed lease uses 90 days from upload", async () => {
  await withDb(async (client) => {
    const org = await client.query<{ id: string; days: number }>(
      `SELECT id::text, id_doc_retention_days AS days FROM organizations WHERE name = '松信住宅管理' LIMIT 1`,
    );
    const orgId = org.rows[0]?.id ?? "";
    const originalDays = org.rows[0]?.days ?? 90;
    assert.ok(orgId);
    const lease = await client.query<{ id: string }>(
      `INSERT INTO leases (
         org_id, property_id, unit_id, target_unit_id, target_room_id, status, esign_status,
         start_date, end_date, currency, rent_amount_minor, deposit_amount_minor, created_by
       )
       SELECT org_id, property_id, unit_id, target_unit_id, target_room_id, 'ended', 'fully_signed',
              current_date - 500, current_date + 300, currency, rent_amount_minor, 0, created_by
         FROM leases WHERE org_id = $1 LIMIT 1
       RETURNING id::text`,
      [orgId],
    );
    const leaseId = lease.rows[0]?.id ?? "";
    const contact = await client.query<{ id: string }>(
      `INSERT INTO contacts (org_id, is_tenant, display_name) VALUES ($1, true, 'QA-PR9 clock') RETURNING id::text`,
      [orgId],
    );
    const contactId = contact.rows[0]?.id ?? "";
    try {
      await client.query(`UPDATE organizations SET id_doc_retention_days = platform_max_id_retention_days() WHERE id = $1`, [orgId]);
      const linked = await client.query<{ id: string; delete_after: string }>(
        `INSERT INTO identity_documents (
           org_id, contact_id, lease_id, doc_type, number_masked, storage_path, encryption_key_ref
         ) VALUES ($1, $2, $3, 'passport', 'A******789', $4, 'env:ID_DOC_ENCRYPTION_KEY')
         RETURNING id::text, delete_after::text`,
        [orgId, contactId, leaseId, `${orgId}/qa-pr9-clock/doc`],
      );
      const expectedFuture = await client.query<{ due: string }>(
        `SELECT (current_date + 300 + id_document_keep_days())::text AS due`,
      );
      assert.equal(linked.rows[0]?.delete_after, expectedFuture.rows[0]?.due);
      await client.query(`UPDATE leases SET end_date = current_date - 100 WHERE id = $1`, [leaseId]);
      const moved = await client.query<{ delete_after: string; expected: string }>(
        `SELECT delete_after::text,
                (current_date - 100 + id_document_keep_days())::text AS expected
           FROM identity_documents WHERE id = $1`,
        [linked.rows[0]?.id],
      );
      assert.equal(moved.rows[0]?.delete_after, moved.rows[0]?.expected);
      await client.query(`UPDATE leases SET end_date = NULL WHERE id = $1`, [leaseId]);
      const waiting = await client.query<{ delete_after: string }>(
        `SELECT delete_after::text FROM identity_documents WHERE id = $1`,
        [linked.rows[0]?.id],
      );
      assert.equal(waiting.rows[0]?.delete_after, "9999-12-31");

      const bare = await client.query<{ due: string }>(
        `SELECT id_document_delete_after(NULL, $1, timestamptz '2020-06-01 00:00:00+00')::text AS due`,
        [orgId],
      );
      assert.equal(bare.rows[0]?.due, "2020-08-30");
    } finally {
      await client.query(`UPDATE organizations SET id_doc_retention_days = $2 WHERE id = $1`, [orgId, originalDays]);
      await client.query(`DELETE FROM contacts WHERE id = $1`, [contactId]);
      await client.query(`DELETE FROM leases WHERE id = $1`, [leaseId]);
    }
  });
});

test("ID purge dry-run, protected rows, bucket guard, missing objects, and reruns", async (t) => {
  await withDb(async (client) => {
    const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
    const esignTables = (
      await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_catalog.pg_tables
          WHERE schemaname = 'public' AND left(tablename, 6) = 'esign_'
          ORDER BY tablename`,
      )
    ).rows.map((row) => row.tablename);
    const snapshotEsign = async (table: string) => {
      const result = await client.query<{ data: unknown; count: string }>(
        `SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text), '[]'::jsonb) AS data,
                count(*)::text AS count
           FROM public.${quote(table)} r`,
      );
      assert.equal(result.rows.length, 1);
      return result.rows[0];
    };
    const esignBefore = new Map<string, { data: unknown; count: string }>();
    for (const table of esignTables) {
      esignBefore.set(table, await snapshotEsign(table));
    }
    if (esignTables.length === 0) {
      t.diagnostic("esign_* absent in this schema (prod has them empty since 20261030150900)");
    }
    const assertEsignUnchanged = async () => {
      for (const table of esignTables) {
        const current = await snapshotEsign(table);
        const before = esignBefore.get(table)!;
        assert.equal(current.count, before.count, `${table}: global count unchanged`);
        assert.deepEqual(current.data, before.data, `${table}: unchanged full rows`);
      }
    };

    const orgId = (
      await client.query<{ id: string }>(
        `SELECT id::text FROM organizations WHERE name = '松信住宅管理' LIMIT 1`,
      )
    ).rows[0]?.id;
    assert.ok(orgId);

    const contactId = (
      await client.query<{ id: string }>(
        `INSERT INTO contacts (org_id, is_tenant, display_name)
         VALUES ($1, true, 'QA-ID90 negative') RETURNING id::text`,
        [orgId],
      )
    ).rows[0]?.id;
    assert.ok(contactId);

    const leaseId = (
      await client.query<{ id: string }>(
        `INSERT INTO leases (
           org_id, property_id, unit_id, target_unit_id, target_room_id, status, esign_status,
           start_date, end_date, currency, rent_amount_minor, deposit_amount_minor, created_by
         )
         SELECT org_id, property_id, unit_id, target_unit_id, target_room_id, 'ended', 'fully_signed',
                current_date - 500, current_date - 120, currency, rent_amount_minor, 0, created_by
           FROM leases WHERE org_id = $1 LIMIT 1
         RETURNING id::text`,
        [orgId],
      )
    ).rows[0]?.id;
    assert.ok(leaseId);

    const fileIds: string[] = [];
    let ticketId: string | undefined;
    const sentinels: {
      table: string;
      key: Record<string, unknown>;
      row: unknown;
    }[] = [];
    const cleanupRows: {
      table: string;
      key: Record<string, unknown>;
    }[] = [];
    const remember = async (
      table: string,
      key: Record<string, unknown>,
      cleanup = false,
    ) => {
      // Only fixture-owned rows are registered for cleanup.
      if (cleanup) cleanupRows.push({ table, key });
      const result = await client.query<{ data: unknown; count: number }>(
        `SELECT to_jsonb(r) AS data, count(*) OVER ()::int AS count
           FROM public.${quote(table)} r
          WHERE to_jsonb(r) @> $1::jsonb`,
        [JSON.stringify(key)],
      );
      assert.ok(result.rows.length > 0, `${table}: sentinel exists by key`);
      assert.equal(result.rows[0]?.count, 1, `${table}: unique sentinel`);
      sentinels.push({ table, key, row: result.rows[0].data });
    };
    const assertSentinels = async () => {
      assert.ok(sentinels.length > 0);
      for (const { table, key, row } of sentinels) {
        const result = await client.query<{ data: unknown; count: number }>(
          `SELECT to_jsonb(r) AS data, count(*) OVER ()::int AS count
             FROM public.${quote(table)} r
            WHERE to_jsonb(r) @> $1::jsonb`,
          [JSON.stringify(key)],
        );
        assert.ok(result.rows.length > 0, `${table}: sentinel still exists`);
        assert.equal(result.rows[0]?.count, 1, `${table}: unique sentinel`);
        assert.deepEqual(result.rows[0].data, row, `${table}: unchanged full row`);
      }
    };

    const snapshot = async (table: string) => {
      // Names below come only from fixed lists or pg_catalog, never user input.
      const quoted = `"${table.replaceAll('"', '""')}"`;
      return (
        await client.query<{ data: unknown }>(
          `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS data
             FROM public.${quoted} t`,
        )
      ).rows[0]?.data;
    };
    // PROP-05 audits platform_settings changes; this test toggles ID_PURGE_ENABLED
    // itself, so those control-plane rows are excluded from the purge-audit checks
    // (PROP-05's own tests cover settings auditing).
    const auditRows = async () =>
      (await client.query(`SELECT * FROM audit_log WHERE table_name IS DISTINCT FROM 'platform_settings' ORDER BY id`)).rows;
    const accessRows = async () =>
      (await client.query(`SELECT * FROM identity_document_access_log ORDER BY id`)).rows;

    const extraContactIds: string[] = [];
    try {
      const seed = async (due: boolean, docType: "passport" | "drivers_license" = "passport") => {
        let documentContactId = contactId;
        if (docType === "drivers_license") {
          const contact = await client.query<{ id: string }>(
            `INSERT INTO contacts (org_id, is_tenant, display_name)
             VALUES ($1, true, 'QA-ID90 drivers license') RETURNING id::text`,
            [orgId],
          );
          assert.ok(contact.rows[0]?.id);
          documentContactId = contact.rows[0].id;
          extraContactIds.push(documentContactId);
        }
        const docId = (
          await client.query<{ id: string }>(
            `INSERT INTO identity_documents (
               org_id, contact_id, lease_id, doc_type, storage_path, encryption_key_ref, created_at
             ) VALUES (
               $1, $2, $3, $6, $4, 'env:ID_DOC_ENCRYPTION_KEY',
               now() - make_interval(days => $5::int)
             ) RETURNING id::text`,
            [
              orgId,
              documentContactId,
              due ? leaseId : null,
              `${orgId}/qa-id90/${due ? "due" : "kept"}/document`,
              due ? 120 : 0,
              docType,
            ],
          )
        ).rows[0]?.id;
        assert.ok(docId);
        const path = `${orgId}/qa-id90/${docId}/front`;
        await client.query(
          `INSERT INTO identity_document_photos (
             org_id, document_id, slot, storage_path, mime_type, size_bytes, sha256
           ) VALUES ($1, $2, 'front', $3, 'image/jpeg', 1, $4)`,
          [orgId, docId, path, "a".repeat(64)],
        );
        await client.query(
          `INSERT INTO id_document_objects (bucket, path, mime_type, byte_size, sha256, ciphertext)
           VALUES ('id-documents-private', $1, 'image/jpeg', 1, $2, $3)`,
          [path, "b".repeat(64), Buffer.from([1])],
        );
        await client.query(
          `INSERT INTO id_document_wm_objects (bucket, path, mime_type, byte_size, sha256, ciphertext)
           VALUES ('id-documents-private', $1, 'image/jpeg', 1, $2, $3)`,
          [`${path}.wm`, "c".repeat(64), Buffer.from([2])],
        );
        return { docId, path };
      };
      const due = await seed(true);
      const due2 = await seed(true, "drivers_license");
      const kept = await seed(false);
      const summarySecrets = [
        orgId, contactId, leaseId, ...extraContactIds,
        ...[due, due2, kept].flatMap(({ docId, path }) => [
          docId, path, `${path}.wm`,
        ]),
        `${orgId}/qa-id90/due/document`,
        `${orgId}/qa-id90/kept/document`,
        "basic.pdf", "photo.jpg",
      ];
      const assertSummary = (row: Record<string, unknown>, mode: "dry_run" | "purge") => {
        assert.ok(row);
        assert.equal(row.org_id, null);
        assert.equal(row.actor_user_id, null);
        assert.equal(row.table_name, "id_purge_runs");
        assert.equal(row.row_id, "id_purge_run");
        assert.equal(row.event_type, "id_purge_run");
        assert.equal(row.action, "insert");
        const summary = row.new_row;
        assert.ok(typeof summary === "object" && summary !== null && !Array.isArray(summary));
        assert.ok("mode" in summary);
        assert.equal(summary.mode, mode);
        const allowed = new Set([
          "mode", "limit", "batches", "would_delete", "deleted",
          "upload_slots_would_delete", "upload_slots_deleted",
          "storage_failed", "started_at", "finished_at",
        ]);
        for (const [key, value] of Object.entries(summary)) {
          assert.ok(allowed.has(key), `Unexpected summary key: ${key}`);
          if (key === "mode") {
            assert.equal(value, mode);
          } else if (key === "started_at" || key === "finished_at") {
            assert.equal(typeof value, "string");
            assert.equal(new Date(value as string).toISOString(), value);
          } else {
            assert.equal(typeof value, "number", `${key}: numeric count`);
            assert.ok(Number.isFinite(value));
          }
        }
        const serialized = JSON.stringify(row);
        for (const secret of summarySecrets) {
          assert.equal(serialized.includes(secret), false, "Summary contains no fixture identifiers or paths");
        }
      };

      // Upload slots have no user/document FKs; use this fixture's UUIDs.
      await client.query(
        `INSERT INTO id_upload_slots (
           user_id, lease_id, document_id, slot, mime_type,
           plain_size, sha256, ciphertext, created_at
         ) VALUES
           ($1, $2, $3, 'front', 'image/jpeg', 1, $4, $5, now() - interval '25 hours'),
           ($1, $2, $3, 'back', 'image/jpeg', 1, $4, $5, now() - interval '1 hour')`,
        [contactId, leaseId, due.docId, "d".repeat(64), Buffer.from([3])],
      );
      const expiredSlots = Number(
        (await client.query(
          `SELECT count(*)::int AS count FROM id_upload_slots
            WHERE created_at < now() - interval '24 hours'`,
        )).rows[0].count,
      );

      const leaseFile = (
        await client.query<{ id: string; storage_path: string }>(
          `INSERT INTO files (
             org_id, storage_bucket, storage_path, file_name, mime_type, size_bytes
           ) VALUES (
             $1, 'lease-documents-private', $2, 'basic.pdf', 'application/pdf', 5
           ) RETURNING id::text, storage_path`,
          [orgId, `${orgId}/qa-id90/${leaseId}/basic.pdf`],
        )
      ).rows[0];
      assert.ok(leaseFile);
      fileIds.push(leaseFile.id);
      await client.query(
        `INSERT INTO lease_signed_pdfs (org_id, lease_id, file_id, object_path, content)
         VALUES ($1, $2, $3, $4, $5)`,
        [orgId, leaseId, leaseFile.id, leaseFile.storage_path, Buffer.from("%PDF-")],
      );

      ticketId = (
        await client.query<{ id: string }>(
          `INSERT INTO maintenance_tickets (org_id, ticket_number, property_id, title)
           SELECT l.org_id,
                  (SELECT coalesce(max(ticket_number), 0) + 1
                     FROM maintenance_tickets WHERE org_id = l.org_id),
                  l.property_id, 'QA-ID90 protected ticket'
             FROM leases l WHERE l.id = $1
           RETURNING id::text`,
          [leaseId],
        )
      ).rows[0]?.id;
      assert.ok(ticketId);
      const ticketFileId = (
        await client.query<{ id: string }>(`SELECT gen_random_uuid()::text AS id`)
      ).rows[0]?.id;
      assert.ok(ticketFileId);
      await client.query(
        `INSERT INTO files (
           id, org_id, storage_bucket, storage_path, file_name, mime_type, size_bytes
         ) VALUES ($1, $2, 'ticket-photos-private', $3, 'photo.jpg', 'image/jpeg', 1)`,
        [
          ticketFileId,
          orgId,
          `org/${orgId}/tickets/${ticketId}/${ticketFileId}.jpg`,
        ],
      );
      fileIds.push(ticketFileId);
      await client.query(
        `INSERT INTO ticket_attachments (org_id, ticket_id, file_id)
         VALUES ($1, $2, $3)`,
        [orgId, ticketId, ticketFileId],
      );
      await client.query(
        `INSERT INTO audit_log (
           org_id, actor_role, table_name, row_id, action, event_type, new_row
         ) VALUES (
           $1, 'system', 'leases', $2, 'insert', 'qa_id90_sentinel', '{"keep":true}'
         )`,
        [orgId, leaseId],
      );

      const signature = await client.query<{ id: string }>(
        `INSERT INTO lease_signatures (org_id, lease_id, signer_role, contact_id)
         VALUES ($1, $2, 'tenant', $3) RETURNING id::text`,
        [orgId, leaseId, contactId],
      );
      assert.equal(signature.rowCount, 1);
      const signatureId = signature.rows[0].id;
      await remember("lease_signatures", { id: signatureId }, true);

      const event = await client.query<{ id: string }>(
        `INSERT INTO lease_signature_events (org_id, signature_id, event)
         VALUES ($1, $2, 'sent') RETURNING id::text`,
        [orgId, signatureId],
      );
      assert.equal(event.rowCount, 1);
      // Preserve bigint precision when constructing the JSON key.
      await remember("lease_signature_events", {
        org_id: orgId,
        signature_id: signatureId,
        event: "sent",
      }, true);

      const messageSeed = await client.query<{ id: string }>(
        `SELECT id::text FROM messages WHERE org_id = $1 ORDER BY id LIMIT 1`,
        [orgId],
      );
      if (messageSeed.rows.length > 0) {
        const attachment = await client.query<{ id: string }>(
          `INSERT INTO message_attachments (org_id, message_id, file_id)
           VALUES ($1, $2, $3) RETURNING id::text`,
          [orgId, messageSeed.rows[0].id, leaseFile.id],
        );
        assert.equal(attachment.rowCount, 1);
        await remember("message_attachments", { id: attachment.rows[0].id }, true);
      } else {
        const available = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM messages WHERE org_id = $1`,
          [orgId],
        );
        assert.equal(available.rows[0].count, 0);
        t.diagnostic(
          "message_attachments sentinel skipped: no seeded messages row in the fixture org satisfies (org_id, message_id) FK",
        );
      }

      const ticketAttachment = await client.query<{ id: string }>(
        `SELECT id::text FROM ticket_attachments
          WHERE org_id = $1 AND ticket_id = $2 AND file_id = $3`,
        [orgId, ticketId, ticketFileId],
      );
      assert.equal(ticketAttachment.rowCount, 1);
      const attachmentId = ticketAttachment.rows[0].id;
      const jobSeed = await client.query<{ id: string }>(
        `SELECT id::text FROM repair_vendor_jobs
          WHERE org_id = $1 ORDER BY id LIMIT 1`,
        [orgId],
      );
      if (jobSeed.rows.length > 0) {
        const shared = await client.query(
          `INSERT INTO repair_vendor_job_shared_photos
             (org_id, job_id, attachment_id, approved_by)
           VALUES ($1, $2, $3, $4)`,
          [orgId, jobSeed.rows[0].id, attachmentId, contactId],
        );
        assert.equal(shared.rowCount, 1);
        // This table has a composite primary key and no id column.
        await remember("repair_vendor_job_shared_photos", {
          job_id: jobSeed.rows[0].id,
          attachment_id: attachmentId,
        }, true);
      } else {
        const available = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM repair_vendor_jobs WHERE org_id = $1`,
          [orgId],
        );
        assert.equal(available.rows[0].count, 0);
        t.diagnostic(
          "repair_vendor_job_shared_photos sentinel skipped: no seeded repair_vendor_jobs row in the fixture org satisfies (org_id, job_id) FK",
        );
      }

      await remember("leases", { id: leaseId });
      await remember("maintenance_tickets", { id: ticketId });
      for (const id of fileIds) await remember("files", { id });
      await remember("ticket_attachments", { id: attachmentId });
      const pdf = await client.query<{ id: string }>(
        `SELECT id::text FROM lease_signed_pdfs
          WHERE org_id = $1 AND lease_id = $2 AND file_id = $3`,
        [orgId, leaseId, leaseFile.id],
      );
      assert.equal(pdf.rowCount, 1);
      await remember("lease_signed_pdfs", { id: pdf.rows[0].id });
      const audit = await client.query<{ id: string }>(
        `SELECT id::text FROM audit_log
          WHERE org_id = $1 AND row_id = $2 AND event_type = 'qa_id90_sentinel'`,
        [orgId, leaseId],
      );
      assert.equal(audit.rowCount, 1);
      // audit_log.id is bigint; use its unique fixture marker without a JS number.
      await remember("audit_log", {
        org_id: orgId,
        row_id: leaseId,
        event_type: "qa_id90_sentinel",
      }, true);

      const protectedTables = [
        "leases",
        "lease_signed_pdfs",
        "lease_signatures",
        "lease_signature_events",
        "message_attachments",
        "repair_vendor_job_shared_photos",
        "files",
        "maintenance_tickets",
        "ticket_attachments",
      ];
      const extra = await client.query<{ tablename: string }>(
        `SELECT tablename FROM pg_catalog.pg_tables
          WHERE schemaname = 'public'
            AND (
              left(tablename, 6) = 'esign_'
              OR tablename LIKE '%move_in%'
              OR tablename LIKE '%message%attachment%'
              OR tablename LIKE '%contract%'
            )`,
      );
      protectedTables.push(
        ...extra.rows.map((row) => row.tablename).filter((name) => !protectedTables.includes(name)),
      );
      await assertSentinels();
      const before = new Map<string, unknown>();
      for (const table of protectedTables) before.set(table, await snapshot(table));
      const idTables = [
        "identity_documents",
        "identity_document_photos",
        "id_document_objects",
        "id_document_wm_objects",
        "id_upload_slots",
      ];
      const beforeIds = new Map<string, unknown>();
      for (const table of idTables) beforeIds.set(table, await snapshot(table));
      const oldAudit = await auditRows();
      const oldAccess = await accessRows();

      // Missing global flag: scheduled and manual preview both leave every
      // fingerprint/count, sentinel, e-sign row and audit/access row unchanged.
      await client.query("DELETE FROM platform_settings WHERE key = 'ID_PURGE_ENABLED'");
      for (const dryRun of [false, true]) {
        const disabled = await runIdPurge(client, { dryRun });
        assert.equal(disabled.disabled, true);
        assert.equal(disabled.documents, 0);
        await assertSentinels();
        await assertEsignUnchanged();
        for (const table of protectedTables) {
          assert.deepEqual(await snapshot(table), before.get(table), table);
        }
        for (const table of idTables) {
          assert.deepEqual(await snapshot(table), beforeIds.get(table), table);
        }
        assert.deepEqual(await auditRows(), oldAudit);
        assert.deepEqual(await accessRows(), oldAccess);
      }
      await client.query(
        `INSERT INTO platform_settings (key, value) VALUES ('ID_PURGE_ENABLED', '"dry_run"')`,
      );

      // Preview EXECUTE remains unavailable to tenant roles.
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE authenticated");
        await assert.rejects(
          client.query(`SELECT * FROM public.preview_due_identity_documents(1000)`),
          /permission denied/,
        );
      } finally {
        await client.query("ROLLBACK");
      }

      const preview = await serviceQuery(
        client,
        `SELECT document_id::text, storage_bucket, storage_path
           FROM public.preview_due_identity_documents(1000)`,
      );
      const ours = preview.rows.filter((row) => [due.docId, due2.docId, kept.docId].includes(row.document_id));
      assert.equal(ours.length, 4); // Parent key plus front key for each due document.
      assert.deepEqual(
        [...new Set(ours.map((row) => row.document_id))].sort(),
        [due.docId, due2.docId].sort(),
      );
      assert.ok(ours.every((row) => row.storage_bucket === "id-documents-private"));

      const dry = await runIdPurge(client, { limit: 1000 });
      assert.equal(dry.dryRun, true);
      assert.equal(dry.wouldDelete, new Set(preview.rows.map((row) => row.document_id)).size);
      assert.equal(dry.uploadSlotsWouldDelete, expiredSlots);
      assert.equal(dry.uploadSlotsDeleted, 0);
      assert.ok(dry.wouldDelete >= 2);
      await assertSentinels();
      await assertEsignUnchanged();
      for (const table of protectedTables) {
        assert.deepEqual(await snapshot(table), before.get(table), table);
      }
      for (const table of idTables) {
        assert.deepEqual(await snapshot(table), beforeIds.get(table), table);
      }
      assert.deepEqual(await accessRows(), oldAccess);
      const afterDryAudit = await auditRows();
      assert.deepEqual(afterDryAudit.slice(0, oldAudit.length), oldAudit);
      assert.equal(afterDryAudit.length, oldAudit.length + 1);
      assert.equal(afterDryAudit.at(-1)?.event_type, "id_purge_run");
      assert.equal(afterDryAudit.at(-1)?.action, "insert");
      assert.equal(afterDryAudit.at(-1)?.table_name, "id_purge_runs");
      assertSummary(afterDryAudit.at(-1)!, "dry_run");
      assert.equal(afterDryAudit.at(-1)?.new_row.mode, "dry_run");
      assert.equal(afterDryAudit.at(-1)?.new_row.would_delete, dry.wouldDelete);
      assert.ok(
        preview.rows.some((row) => row.document_id === due2.docId),
        "Dry-run would_delete includes the drivers_license document",
      );
      assert.equal(afterDryAudit.at(-1)?.new_row.upload_slots_would_delete, expiredSlots);

      // The SQL entry point must reject direct purge when the mode is not on.
      for (const mode of ["off", "dry_run"]) {
        await client.query(`UPDATE platform_settings SET value=to_jsonb($1::text) WHERE key='ID_PURGE_ENABLED'`, [mode]);
        await assert.rejects(serviceQuery(client, `SELECT * FROM public.purge_due_identity_documents(1000)`),
          (error: unknown) => (error as { code?: string }).code === "42501");
        for (const table of idTables) assert.deepEqual(await snapshot(table), beforeIds.get(table), table);
      }
      await client.query(`UPDATE platform_settings SET value='"on"' WHERE key='ID_PURGE_ENABLED'`);

      // Force a corrupt due parent as the harness's postgres superuser.
      await client.query(
        `UPDATE identity_documents SET storage_bucket = 'lease-documents-private' WHERE id = $1`,
        [due.docId],
      );
      const corrupt = new Map<string, unknown>();
      for (const table of idTables) corrupt.set(table, await snapshot(table));
      await assert.rejects(
        serviceQuery(client, `SELECT * FROM public.purge_due_identity_documents(1000)`),
        /Unsafe ID purge target/,
      );
      for (const table of idTables) {
        assert.deepEqual(await snapshot(table), corrupt.get(table), table);
      }
      await client.query(
        `UPDATE identity_documents SET storage_bucket = 'id-documents-private' WHERE id = $1`,
        [due.docId],
      );

      // Guard derived targets independently of the parent's bucket.
      await client.query(
        `UPDATE identity_document_photos SET storage_bucket = 'lease-documents-private'
          WHERE document_id = $1`,
        [due.docId],
      ).catch(async () => {
        // The original object's FK prevents this corruption until its bytes
        // are absent. This also exercises already-missing storage below.
        await client.query(
          `DELETE FROM id_document_objects WHERE bucket = 'id-documents-private' AND path = $1`,
          [due.path],
        );
        await client.query(
          `UPDATE identity_document_photos SET storage_bucket = 'lease-documents-private'
            WHERE document_id = $1`,
          [due.docId],
        );
      });
      await assert.rejects(
        serviceQuery(client, `SELECT * FROM public.purge_due_identity_documents(1000)`),
        /Unsafe ID purge target/,
      );
      await client.query(
        `UPDATE identity_document_photos SET storage_bucket = 'id-documents-private'
          WHERE document_id = $1`,
        [due.docId],
      );

      // Missing ciphertext is already deleted, never a storage failure.
      await client.query(
        `DELETE FROM id_document_objects WHERE bucket = 'id-documents-private' AND path = $1`,
        [due.path],
      );
      const keptBefore = (
        await client.query(
          `SELECT to_jsonb(d) AS data FROM identity_documents d WHERE id = $1`,
          [kept.docId],
        )
      ).rows[0]?.data;

      await client.query(
        `UPDATE platform_settings SET value = '"on"' WHERE key = 'ID_PURGE_ENABLED'`,
      );
      const real = await runIdPurge(client);
      assert.ok(real.documents >= 1);
      assert.equal(real.storageFailed, 0);
      assert.equal(real.uploadSlotsDeleted, expiredSlots);
      await assertSentinels();
      await assertEsignUnchanged();
      assert.deepEqual(
        (await client.query(
          `SELECT slot FROM id_upload_slots WHERE user_id = $1 AND lease_id = $2 ORDER BY slot`,
          [contactId, leaseId],
        )).rows,
        [{ slot: "back" }],
      );
      for (const table of protectedTables) {
        assert.deepEqual(await snapshot(table), before.get(table), table);
      }
      const afterRealAudit = await auditRows();
      assert.deepEqual(afterRealAudit.slice(0, afterDryAudit.length), afterDryAudit);
      const summaries = afterRealAudit
        .slice(afterDryAudit.length)
        .filter((row) => row.event_type === "id_purge_run");
      assert.equal(summaries.length, 1);
      assert.equal(summaries[0]?.action, "insert");
      assert.equal(summaries[0]?.table_name, "id_purge_runs");
      assertSummary(summaries[0], "purge");
      assert.equal(summaries[0]?.new_row.mode, "purge");
      assert.equal(summaries[0]?.new_row.storage_failed, 0);
      assert.equal(summaries[0]?.new_row.upload_slots_deleted, expiredSlots);
      assert.deepEqual(Object.keys(summaries[0]?.new_row).sort(), [
        "batches", "deleted", "finished_at", "limit", "mode", "started_at",
        "storage_failed", "upload_slots_deleted",
      ]);
      const afterAccess = await accessRows();
      assert.deepEqual(afterAccess.slice(0, oldAccess.length), oldAccess);

      const purgedLicense = await client.query<{ deleted_at: Date | null; storage_path: string }>(
        `SELECT deleted_at, storage_path FROM identity_documents
          WHERE id = $1 AND doc_type = 'drivers_license'`,
        [due2.docId],
      );
      assert.ok(purgedLicense.rows[0]?.deleted_at, "Real purge deletes drivers_license");
      assert.equal(purgedLicense.rows[0]?.storage_path, `purged/${due2.docId}`);
      const marked = (
        await client.query(
          `SELECT deleted_at, storage_path FROM identity_documents WHERE id = $1`,
          [due.docId],
        )
      ).rows[0];
      assert.ok(marked?.deleted_at);
      assert.equal(marked?.storage_path, `purged/${due.docId}`);
      assert.equal(
        (await client.query(`SELECT 1 FROM identity_document_photos WHERE document_id = $1`, [due.docId])).rowCount,
        0,
      );
      assert.equal(
        (await client.query(`SELECT 1 FROM id_document_objects WHERE path = $1`, [due.path])).rowCount,
        0,
      );
      assert.equal(
        (await client.query(`SELECT 1 FROM id_document_wm_objects WHERE path = $1`, [`${due.path}.wm`])).rowCount,
        0,
      );
      assert.deepEqual(
        (await client.query(`SELECT to_jsonb(d) AS data FROM identity_documents d WHERE id = $1`, [kept.docId])).rows[0]?.data,
        keptBefore,
      );
      assert.equal(
        (await client.query(`SELECT 1 FROM identity_document_photos WHERE document_id = $1`, [kept.docId])).rowCount,
        1,
      );
      assert.equal(
        (await client.query(`SELECT 1 FROM id_document_objects WHERE path = $1`, [kept.path])).rowCount,
        1,
      );
      assert.equal(
        (await client.query(`SELECT 1 FROM id_document_wm_objects WHERE path = $1`, [`${kept.path}.wm`])).rowCount,
        1,
      );

      const second = await runIdPurge(client);
      assert.equal(second.documents, 0);
      assert.equal(second.storageFailed, 0);
      assert.equal(second.uploadSlotsDeleted, 0);
      await assertSentinels();
      await assertEsignUnchanged();
      assert.deepEqual(
        (await client.query(
          `SELECT slot FROM id_upload_slots WHERE user_id = $1 AND lease_id = $2 ORDER BY slot`,
          [contactId, leaseId],
        )).rows,
        [{ slot: "back" }],
      );
      const finalAudit = await auditRows();
      assert.equal(finalAudit.length, afterRealAudit.length + 1);
      assert.equal(finalAudit.at(-1)?.new_row.deleted, 0);
      assertSummary(finalAudit.at(-1)!, "purge");
      for (const table of protectedTables) {
        assert.deepEqual(await snapshot(table), before.get(table), table);
      }
    } finally {
      // The harness already requires postgres superuser privileges. Suppress
      // append-only guards only for explicit fixture-row cleanup, transactionally.
      // Delete children explicitly; normal fixture cleanup below retains cascades.
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL session_replication_role = replica");
        for (const { table, key } of [...cleanupRows].reverse()) {
          await client.query(
            `DELETE FROM public.${quote(table)} r WHERE to_jsonb(r) @> $1::jsonb`,
            [JSON.stringify(key)],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      await client.query(
        `DELETE FROM id_upload_slots WHERE user_id = $1 AND lease_id = $2`,
        [contactId, leaseId],
      );
      if (ticketId) {
        await client.query(`DELETE FROM maintenance_tickets WHERE id = $1`, [ticketId]);
      }
      await client.query(`DELETE FROM leases WHERE id = $1`, [leaseId]);
      await client.query(`DELETE FROM files WHERE id = ANY($1::uuid[])`, [fileIds]);
      await client.query(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [[contactId, ...extraContactIds]]);
    }
  });
});

test("the service_role purge removes expired QA-PR9 lease and upload files and keeps current ones", async () => {
  await withDb(async (client) => {
    const org = await client.query<{ id: string }>(
      `SELECT id::text FROM organizations WHERE name = '松信住宅管理' LIMIT 1`,
    );
    const orgId = org.rows[0]?.id ?? "";
    const makeLease = async (endOffset: number) => {
      const lease = await client.query<{ id: string }>(
        `INSERT INTO leases (
           org_id, property_id, unit_id, target_unit_id, target_room_id, status, esign_status,
           start_date, end_date, currency, rent_amount_minor, deposit_amount_minor, created_by
         )
         SELECT org_id, property_id, unit_id, target_unit_id, target_room_id, 'ended', 'fully_signed',
                current_date - 400, current_date + $2::int, currency, rent_amount_minor, 0, created_by
           FROM leases WHERE org_id = $1 LIMIT 1
         RETURNING id::text`,
        [orgId, endOffset],
      );
      return lease.rows[0]?.id ?? "";
    };
    const seed = async (label: string, leaseId: string | null, createdAt: number) => {
      const contact = await client.query<{ id: string }>(
        `INSERT INTO contacts (org_id, is_tenant, display_name) VALUES ($1, true, $2) RETURNING id::text`,
        [orgId, `QA-PR9 ${label}`],
      );
      const document = await client.query<{ id: string }>(
        `INSERT INTO identity_documents (
           org_id, contact_id, lease_id, doc_type, number_masked, storage_path, encryption_key_ref, created_at
         ) VALUES (
           $1, $2, $3, 'passport', 'A******789', $4, 'env:ID_DOC_ENCRYPTION_KEY',
           now() - make_interval(days => $5::int)
         )
         RETURNING id::text`,
        [orgId, contact.rows[0]?.id, leaseId, `${orgId}/qa-pr9/${label}/doc`, createdAt],
      );
      const documentId = document.rows[0]?.id ?? "";
      const path = `${orgId}/qa-pr9/${documentId}/front`;
      await client.query(
        `INSERT INTO identity_document_photos (
           org_id, document_id, slot, storage_bucket, storage_path, mime_type, size_bytes, sha256
         ) VALUES ($1, $2, 'front', 'id-documents-private', $3, 'image/jpeg', 1, $4)`,
        [orgId, documentId, path, "a".repeat(64)],
      );
      await client.query(
        `INSERT INTO id_document_objects (bucket, path, mime_type, byte_size, sha256, ciphertext)
         VALUES ('id-documents-private', $1, 'image/jpeg', 1, $2, $3)`,
        [path, "b".repeat(64), Buffer.from([1])],
      );
      return { contactId: contact.rows[0]?.id ?? "", documentId, path };
    };
    const expiredLease = await makeLease(-120);
    const keptLease = await makeLease(40);
    const leaseExpired = await seed("lease expired", expiredLease, 0);
    const leaseKept = await seed("lease kept", keptLease, 0);
    const uploadExpired = await seed("upload expired", null, 120);
    const uploadKept = await seed("upload kept", null, 0);
    const contacts = [leaseExpired.contactId, leaseKept.contactId, uploadExpired.contactId, uploadKept.contactId];
    try {
      const counts = await runIdPurge(client);
      assert.ok(counts.documents >= 2);
      assert.equal(JSON.stringify(counts).includes(leaseExpired.documentId), false);
      const rows = await client.query<{ id: string; gone: boolean; photos: string; objects: string }>(
        `SELECT d.id::text, d.deleted_at IS NOT NULL AS gone,
                (SELECT count(*) FROM identity_document_photos p WHERE p.document_id = d.id)::text AS photos,
                (SELECT count(*) FROM id_document_objects o WHERE o.path = ANY($2::text[]))::text AS objects
           FROM identity_documents d
          WHERE d.id = ANY($1::uuid[])`,
        [
          [leaseExpired.documentId, leaseKept.documentId, uploadExpired.documentId, uploadKept.documentId],
          [leaseExpired.path, leaseKept.path, uploadExpired.path, uploadKept.path],
        ],
      );
      const byId = new Map(rows.rows.map((row) => [row.id, row]));
      for (const expired of [leaseExpired, uploadExpired]) {
        assert.equal(byId.get(expired.documentId)?.gone, true);
        const files = await client.query(`SELECT path FROM id_document_objects WHERE path = $1`, [expired.path]);
        assert.equal(files.rows.length, 0);
        assert.equal(byId.get(expired.documentId)?.photos, "0");
      }
      for (const kept of [leaseKept, uploadKept]) {
        assert.equal(byId.get(kept.documentId)?.gone, false);
        assert.equal(byId.get(kept.documentId)?.photos, "1");
        const files = await client.query(`SELECT path FROM id_document_objects WHERE path = $1`, [kept.path]);
        assert.equal(files.rows.length, 1);
      }
    } finally {
      await client.query(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [contacts]);
      await client.query(`DELETE FROM leases WHERE id = ANY($1::uuid[])`, [[expiredLease, keptLease]]);
    }
  });
});

test("purge and photo deletion remove the watermarked copy and the original for every slot", async () => {
  await withDb(async (client) => {
    const org = await client.query<{ id: string }>(
      `SELECT id::text FROM organizations WHERE name = '松信住宅管理' LIMIT 1`,
    );
    const orgId = org.rows[0]?.id ?? "";
    const slots = ["front", "back", "selfie"] as const;
    const seed = async (label: string, endOffset: number) => {
      const lease = await client.query<{ id: string }>(
        `INSERT INTO leases (
           org_id, property_id, unit_id, target_unit_id, target_room_id, status, esign_status,
           start_date, end_date, currency, rent_amount_minor, deposit_amount_minor, created_by
         )
         SELECT org_id, property_id, unit_id, target_unit_id, target_room_id, 'ended', 'fully_signed',
                current_date - 400, current_date + $2::int, currency, rent_amount_minor, 0, created_by
           FROM leases WHERE org_id = $1 LIMIT 1
         RETURNING id::text`,
        [orgId, endOffset],
      );
      const contact = await client.query<{ id: string }>(
        `INSERT INTO contacts (org_id, is_tenant, display_name) VALUES ($1, true, $2) RETURNING id::text`,
        [orgId, `QA-PR9 ${label}`],
      );
      const document = await client.query<{ id: string }>(
        `INSERT INTO identity_documents (
           org_id, contact_id, lease_id, doc_type, number_masked, storage_path, encryption_key_ref
         ) VALUES ($1, $2, $3, 'tw_national_id', 'A******789', $4, 'env:ID_DOC_ENCRYPTION_KEY')
         RETURNING id::text`,
        [orgId, contact.rows[0]?.id, lease.rows[0]?.id, `${orgId}/qa-both/${label}/front`],
      );
      const documentId = document.rows[0]?.id ?? "";
      const paths = slots.map((slot) => `${orgId}/qa-both/${documentId}/${slot}`);
      for (const [index, slot] of slots.entries()) {
        const storagePath = paths[index] ?? "";
        await client.query(
          `INSERT INTO identity_document_photos (
             org_id, document_id, slot, storage_bucket, storage_path, mime_type, size_bytes, sha256
           ) VALUES ($1, $2, $3, 'id-documents-private', $4, 'image/jpeg', 1, $5)`,
          [orgId, documentId, slot, storagePath, "a".repeat(64)],
        );
        await client.query(
          `INSERT INTO id_document_objects (bucket, path, mime_type, byte_size, sha256, ciphertext)
           VALUES ('id-documents-private', $1, 'image/jpeg', 1, $2, $3)`,
          [storagePath, "b".repeat(64), Buffer.from([index + 1])],
        );
        await client.query(
          `INSERT INTO id_document_wm_objects (bucket, path, mime_type, byte_size, sha256, ciphertext)
           VALUES ('id-documents-private', $1, 'image/jpeg', 1, $2, $3)`,
          [`${storagePath}.wm`, "c".repeat(64), Buffer.from([index + 9])],
        );
      }
      return {
        contactId: contact.rows[0]?.id ?? "",
        leaseId: lease.rows[0]?.id ?? "",
        documentId,
        paths,
        wmPaths: paths.map((storagePath) => `${storagePath}.wm`),
      };
    };
    const counts = async (paths: string[], wmPaths: string[]) => {
      const row = await client.query<{ originals: number; watermarks: number }>(
        `SELECT (SELECT count(*) FROM id_document_objects WHERE path = ANY($1::text[]))::int AS originals,
                (SELECT count(*) FROM id_document_wm_objects WHERE path = ANY($2::text[]))::int AS watermarks`,
        [paths, wmPaths],
      );
      return row.rows[0];
    };
    const expired = await seed("both expired", -120);
    const kept = await seed("both kept", 40);
    const dropped = await seed("photo delete", 80);
    try {
      const before = await counts(expired.paths, expired.wmPaths);
      assert.equal(before?.originals, 3);
      assert.equal(before?.watermarks, 3);
      await runIdPurge(client);
      const gone = await counts(expired.paths, expired.wmPaths);
      assert.equal(gone?.originals, 0);
      assert.equal(gone?.watermarks, 0);
      const marked = await client.query<{ deleted_at: Date | null; photos: string }>(
        `SELECT deleted_at,
                (SELECT count(*) FROM identity_document_photos p WHERE p.document_id = d.id)::text AS photos
           FROM identity_documents d WHERE d.id = $1`,
        [expired.documentId],
      );
      assert.ok(marked.rows[0]?.deleted_at);
      assert.equal(marked.rows[0]?.photos, "0");
      const stay = await counts(kept.paths, kept.wmPaths);
      assert.equal(stay?.originals, 3);
      assert.equal(stay?.watermarks, 3);
      await client.query(`DELETE FROM identity_document_photos WHERE document_id = $1`, [kept.documentId]);
      const afterPhoto = await counts(kept.paths, kept.wmPaths);
      assert.equal(afterPhoto?.originals, 0);
      assert.equal(afterPhoto?.watermarks, 0);
      await client.query(`DELETE FROM identity_documents WHERE id = $1`, [dropped.documentId]);
      const afterDocument = await counts(dropped.paths, dropped.wmPaths);
      assert.equal(afterDocument?.originals, 0);
      assert.equal(afterDocument?.watermarks, 0);
    } finally {
      await client.query(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [[expired.contactId, kept.contactId, dropped.contactId]]);
      await client.query(`DELETE FROM leases WHERE id = ANY($1::uuid[])`, [[expired.leaseId, kept.leaseId, dropped.leaseId]]);
    }
  });
});

test("locked retention rejects non-cap writes through server tx and FlowError", async () => {
  for (const days of [30, 89, 91, 365, 0]) {
    await assert.rejects(tx(USERS.admin, async (client) => {
      await client.query(`UPDATE organizations SET id_doc_retention_days = $2 WHERE id = $1`, [ORG_ID, days]);
    }, { orgId: ORG_ID }), (error: unknown) =>
      error instanceof FlowError && error.key === "errors.idRetention");
  }
  await tx(USERS.admin, async (client) => {
    const result = await client.query(
      `UPDATE organizations SET id_doc_retention_days = 90 WHERE id = $1 RETURNING id_doc_retention_days`, [ORG_ID]);
    assert.equal(result.rows[0]?.id_doc_retention_days, 90);
  }, { orgId: ORG_ID });
});

test("fixed 90-day clock ignores legacy organization and platform retention settings", async () => {
  await withDb(async (client) => {
    await client.query("BEGIN");
    try {
      const lease = (await client.query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,target_room_id,status,esign_status,start_date,end_date,terminated_on,currency,rent_amount_minor,deposit_amount_minor,created_by)
        SELECT org_id,property_id,unit_id,target_unit_id,target_room_id,'terminated','fully_signed',current_date-500,current_date-150,current_date-200,currency,rent_amount_minor,0,created_by
        FROM leases WHERE org_id=$1 LIMIT 1 RETURNING id::text`,[ORG_ID])).rows[0].id;
      const contacts = (await client.query<{id:string}>(`INSERT INTO contacts(org_id,is_tenant,display_name) VALUES ($1,true,'fixed formed'),($1,true,'fixed upload') RETURNING id::text`,[ORG_ID])).rows;
      const docs = (await client.query<{id:string}>(`INSERT INTO identity_documents(org_id,contact_id,lease_id,doc_type,storage_path,encryption_key_ref,created_at) VALUES
        ($1,$2,$4,'passport','fixed-formed','fixture','2020-06-01 23:30:00+00'),
        ($1,$3,NULL,'passport','fixed-upload','fixture','2020-06-01 23:30:00+00') RETURNING id::text`,[ORG_ID,contacts[0].id,contacts[1].id,lease])).rows;
      for (const legacy of [30,120]) {
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query(`UPDATE organizations SET id_doc_retention_days=$2 WHERE id=$1`,[ORG_ID,legacy]);
        await client.query("SET LOCAL session_replication_role = origin");
        for (const cap of [60,100,90]) {
          await client.query(`UPDATE platform_settings SET value=to_jsonb($1::int) WHERE key='id_documents.max_retention_days_after_close'`,[cap]);
          const clocks = (await client.query(`SELECT public.id_document_keep_days() AS keep,
            public.id_document_delete_after(NULL,$1,'2020-06-01 23:30:00+00'::timestamptz)::text AS upload,
            public.id_document_delete_after($2,$1,now()) = current_date-200+90 AS formed`,[ORG_ID,lease])).rows[0];
          assert.deepEqual(clocks,{keep:90,upload:"2020-08-31",formed:true});
          const cached = (await client.query(`SELECT id::text,delete_after::text FROM identity_documents WHERE id=ANY($1::uuid[])`,[docs.map((d) => d.id)])).rows;
          const expected = (await client.query(`SELECT (current_date-200+90)::text AS due`)).rows[0].due;
          assert.equal(cached.find((d) => d.id === docs[0].id)?.delete_after,expected);
          assert.equal(cached.find((d) => d.id === docs[1].id)?.delete_after,"2020-08-31");
        }
      }
    } finally { await client.query("ROLLBACK"); }
  });
});
