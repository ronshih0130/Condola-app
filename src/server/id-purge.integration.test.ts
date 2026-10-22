import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { runIdPurge } from "../../id-purge-cron.mjs";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://condola:condola@127.0.0.1:5432/condola";

async function withDb<T>(fn: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
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
      await client.query(`UPDATE organizations SET id_doc_retention_days = 30 WHERE id = $1`, [orgId]);
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
