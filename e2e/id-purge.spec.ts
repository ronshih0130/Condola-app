import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { expect, test } from "@playwright/test";

const DATABASE_URL = process.env.DATABASE_URL || "postgres://condola:condola@127.0.0.1:5432/condola";

function db() {
  return new Client({ connectionString: DATABASE_URL });
}

async function withClient<T>(fn: (client: Client) => Promise<T>) {
  const client = db();
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function seedPhoto(client: Client, orgId: string, documentId: string) {
  const path = `${orgId}/qa-pr9-e2e/${documentId}/front`;
  await client.query(
    `INSERT INTO identity_document_photos (
       org_id, document_id, slot, storage_bucket, storage_path, mime_type, size_bytes, sha256
     ) VALUES ($1, $2, 'front', 'id-documents-private', $3, 'image/jpeg', 1, $4)`,
    [orgId, documentId, path, "e".repeat(64)],
  );
  await client.query(
    `INSERT INTO id_document_objects (bucket, path, mime_type, byte_size, sha256, ciphertext)
     VALUES ('id-documents-private', $1, 'image/jpeg', 1, $2, $3)`,
    [path, "f".repeat(64), Buffer.from([2])],
  );
  return path;
}

async function insertDoc(
  client: Client,
  input: { orgId: string; label: string; leaseId: string | null; uploadedDaysAgo: number },
) {
  const contact = await client.query<{ id: string }>(
    `INSERT INTO contacts (org_id, is_tenant, display_name) VALUES ($1, true, $2) RETURNING id::text`,
    [input.orgId, `QA-PR9 ${input.label}`],
  );
  const document = await client.query<{ id: string; delete_after: string }>(
    `INSERT INTO identity_documents (
       org_id, contact_id, lease_id, doc_type, number_masked, storage_path, encryption_key_ref, created_at
     ) VALUES (
       $1, $2, $3, 'passport', 'A******789', $4, 'env:ID_DOC_ENCRYPTION_KEY',
       now() - make_interval(days => $5::int)
     )
     RETURNING id::text, delete_after::text`,
    [
      input.orgId,
      contact.rows[0].id,
      input.leaseId,
      `${input.orgId}/qa-pr9-e2e/${input.label}/${randomUUID()}/doc`,
      input.uploadedDaysAgo,
    ],
  );
  const documentId = document.rows[0].id;
  const path = await seedPhoto(client, input.orgId, documentId);
  return { contactId: contact.rows[0].id, documentId, path, leaseId: input.leaseId, deleteAfter: document.rows[0].delete_after };
}

async function insertEndedLease(client: Client, orgId: string, endOffset: number) {
  const lease = await client.query<{ id: string }>(
    `INSERT INTO leases (
       org_id, property_id, unit_id, target_unit_id, target_room_id, status, esign_status,
       start_date, end_date, currency, rent_amount_minor, deposit_amount_minor, created_by
     )
     SELECT org_id, property_id, unit_id, target_unit_id, target_room_id, 'ended', 'fully_signed',
            current_date - 400, current_date + $2::int, currency, rent_amount_minor, 0, created_by
       FROM leases
      WHERE org_id = $1
      LIMIT 1
     RETURNING id::text`,
    [orgId, endOffset],
  );
  return lease.rows[0].id;
}

async function readDoc(documentId: string, path: string) {
  return withClient(async (client) => {
    const row = await client.query<{ gone: boolean; storage_path: string; photos: string; objects: string; delete_after: string }>(
      `SELECT d.deleted_at IS NOT NULL AS gone, d.storage_path, d.delete_after::text,
              (SELECT count(*) FROM identity_document_photos p WHERE p.document_id = d.id)::text AS photos,
              (SELECT count(*) FROM id_document_objects o WHERE o.path = $2)::text AS objects
         FROM identity_documents d WHERE d.id = $1`,
      [documentId, path],
    );
    return row.rows[0];
  });
}

test("preview purge drops expired lease-end and upload-date QA-PR9 photos and keeps the current ones", async ({ request }) => {
  const seeded = await withClient(async (client) => {
    const org = await client.query<{ id: string }>(`SELECT id::text FROM organizations WHERE name = '松信住宅管理' LIMIT 1`);
    const orgId = org.rows[0].id;
    const expiredLease = await insertEndedLease(client, orgId, 200);
    const keptLease = await insertEndedLease(client, orgId, 40);
    const leaseExpired = await insertDoc(client, {
      orgId,
      label: "lease expired",
      leaseId: expiredLease,
      uploadedDaysAgo: 0,
    });
    const futureEnd = await client.query<{ due: string }>(
      `SELECT (current_date + 200 + id_document_keep_days())::text AS due`,
    );
    expect(leaseExpired.deleteAfter).toBe(futureEnd.rows[0].due);
    await client.query(`UPDATE leases SET end_date = current_date - 120 WHERE id = $1`, [expiredLease]);
    const moved = await client.query<{ delete_after: string; expected: string }>(
      `SELECT delete_after::text,
              (current_date - 120 + id_document_keep_days())::text AS expected
         FROM identity_documents WHERE id = $1`,
      [leaseExpired.documentId],
    );
    expect(moved.rows[0].delete_after).toBe(moved.rows[0].expected);

    const leaseKept = await insertDoc(client, {
      orgId,
      label: "lease kept",
      leaseId: keptLease,
      uploadedDaysAgo: 0,
    });
    const keptEnd = await client.query<{ due: string }>(
      `SELECT (current_date + 40 + id_document_keep_days())::text AS due`,
    );
    expect(leaseKept.deleteAfter).toBe(keptEnd.rows[0].due);

    const uploadExpired = await insertDoc(client, {
      orgId,
      label: "upload expired",
      leaseId: null,
      uploadedDaysAgo: 120,
    });
    const uploadKept = await insertDoc(client, {
      orgId,
      label: "upload kept",
      leaseId: null,
      uploadedDaysAgo: 0,
    });
    const uploadDue = await client.query<{ id: string; due: boolean; expected: string }>(
      `SELECT id::text,
              delete_after <= current_date AS due,
              ((created_at AT TIME ZONE 'Asia/Taipei')::date + id_document_keep_days())::text AS expected
         FROM identity_documents
        WHERE id = ANY($1::uuid[])`,
      [[uploadExpired.documentId, uploadKept.documentId]],
    );
    const uploadById = new Map(uploadDue.rows.map((row) => [row.id, row]));
    expect(uploadById.get(uploadExpired.documentId)?.expected).toBe(uploadExpired.deleteAfter);
    expect(uploadById.get(uploadExpired.documentId)?.due).toBe(true);
    expect(uploadById.get(uploadKept.documentId)?.expected).toBe(uploadKept.deleteAfter);
    expect(uploadById.get(uploadKept.documentId)?.due).toBe(false);
    return { leaseExpired, leaseKept, uploadExpired, uploadKept, leases: [expiredLease, keptLease] };
  });

  try {
    const response = await request.post("/api/cron/purge-id-documents", {
      headers: { "x-cron-secret": "demo-cron" },
    });
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { removed?: number };
    expect(body.removed ?? 0).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(body)).not.toContain(seeded.leaseExpired.documentId);

    for (const expired of [seeded.leaseExpired, seeded.uploadExpired]) {
      const gone = await readDoc(expired.documentId, expired.path);
      expect(gone.gone).toBe(true);
      expect(gone.storage_path.startsWith("purged/")).toBe(true);
      expect(gone.photos).toBe("0");
      expect(gone.objects).toBe("0");
    }
    for (const kept of [seeded.leaseKept, seeded.uploadKept]) {
      const stays = await readDoc(kept.documentId, kept.path);
      expect(stays.gone).toBe(false);
      expect(stays.photos).toBe("1");
      expect(stays.objects).toBe("1");
    }
  } finally {
    await withClient(async (client) => {
      const contacts = [
        seeded.leaseExpired.contactId,
        seeded.leaseKept.contactId,
        seeded.uploadExpired.contactId,
        seeded.uploadKept.contactId,
      ];
      await client.query(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [contacts]);
      await client.query(`DELETE FROM leases WHERE id = ANY($1::uuid[])`, [seeded.leases]);
    });
  }
});
