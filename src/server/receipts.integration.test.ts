import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { svc, tx } from "./db";
import { FlowError } from "./errors";
import { ORG_ID, USERS } from "./ids";
import { RECEIPT_BUCKET, RECEIPT_MAX_BYTES } from "./receipt-rules";

function receiptRow(ext: "jpg" | "png" | "pdf", fileName: string, mime: string, size: number) {
  const id = randomUUID();
  return { id, path: `org/${ORG_ID}/receipts/${id}.${ext}`, fileName, mime, size };
}

test("receipt rows stay inside the firm, and the old placeholder bucket still inserts", async () => {
  const stamp = Date.now().toString(36);
  const name = `rls-receipt-${stamp}.jpg`;
  const legacyName = `rls-legacy-${stamp}.txt`;
  const created: string[] = [];
  let paymentId = "";
  try {
    const lease = await tx(USERS.admin, (client) =>
      client.query<{ id: string; property_id: string }>(
        `SELECT l.id::text, l.property_id::text
           FROM leases l
           JOIN lease_parties lp ON lp.lease_id = l.id
           JOIN contacts c ON c.id = lp.contact_id
          WHERE c.user_id = $1 AND l.org_id = $2 AND l.status = 'active'
          ORDER BY l.created_at
          LIMIT 1`,
        [USERS.tenant2, ORG_ID],
      ),
    );
    const place = lease.rows[0];
    assert.ok(place, "seeded tenant lease");

    const good = receiptRow("jpg", name, "image/jpeg", 839680);
    const fileId = await svc(null, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO files (id, org_id, storage_bucket, storage_path, file_name, mime_type, size_bytes, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id::text`,
        [good.id, ORG_ID, RECEIPT_BUCKET, good.path, good.fileName, good.mime, good.size, USERS.admin],
      );
      return inserted.rows[0].id;
    });
    created.push(fileId);

    const own = await tx(USERS.admin, (client) =>
      client.query(`SELECT id FROM files WHERE id = $1 AND storage_bucket = $2`, [fileId, RECEIPT_BUCKET]),
    );
    assert.equal(own.rows.length, 1);
    const coast = await tx(USERS.coastAdmin, (client) =>
      client.query(`SELECT id FROM files WHERE id = $1 OR file_name = $2`, [fileId, name]),
    );
    assert.equal(coast.rows.length, 0);
    const stranger = await tx(USERS.tenant, (client) =>
      client.query(`SELECT id FROM files WHERE id = $1`, [fileId]),
    );
    assert.equal(stranger.rows.length, 0);

    paymentId = (
      await svc(null, (client) =>
        client.query<{ id: string }>(
          `INSERT INTO payments (
             org_id, property_id, lease_id, currency, amount_minor, paid_on, method,
             status, source, submitted_by, proof_file_id
           ) VALUES ($1,$2,$3,'TWD',100,'2026-10-21','bank_transfer','submitted','manager_entry',$4,$5)
           RETURNING id::text`,
          [ORG_ID, place.property_id, place.id, USERS.admin, fileId],
        ),
      )
    ).rows[0].id;
    const payer = await tx(USERS.tenant2, (client) =>
      client.query(`SELECT id FROM files WHERE id = $1`, [fileId]),
    );
    assert.equal(payer.rows.length, 1);

    const tooBig = receiptRow("pdf", `big-${stamp}.pdf`, "application/pdf", RECEIPT_MAX_BYTES + 1);
    await assert.rejects(
      () =>
        svc(null, (client) =>
          client.query(
            `INSERT INTO files (id, org_id, storage_bucket, storage_path, file_name, mime_type, size_bytes, uploaded_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [tooBig.id, ORG_ID, RECEIPT_BUCKET, tooBig.path, tooBig.fileName, tooBig.mime, tooBig.size, USERS.admin],
          ),
        ),
      (error: unknown) => error instanceof FlowError && error.key === "errors.receiptSize",
    );
    const gif = receiptRow("jpg", "anim.gif", "image/gif", 12);
    await assert.rejects(
      () =>
        svc(null, (client) =>
          client.query(
            `INSERT INTO files (id, org_id, storage_bucket, storage_path, file_name, mime_type, size_bytes, uploaded_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [gif.id, ORG_ID, RECEIPT_BUCKET, gif.path, gif.fileName, gif.mime, gif.size, USERS.admin],
          ),
        ),
      (error: unknown) => error instanceof FlowError && error.key === "errors.receiptSize",
    );
    await assert.rejects(
      () =>
        svc(null, (client) =>
          client.query(
            `INSERT INTO files (org_id, storage_bucket, storage_path, file_name, mime_type, size_bytes, uploaded_by)
             VALUES ($1,$2,$3,'bad-path.pdf','application/pdf',12,$4)`,
            [ORG_ID, RECEIPT_BUCKET, `demo/${stamp}.pdf`, USERS.admin],
          ),
        ),
      (error: unknown) => error instanceof FlowError && error.key === "errors.forbidden",
    );

    const legacy = await svc(null, (client) =>
      client.query<{ id: string }>(
        `INSERT INTO files (org_id, storage_bucket, storage_path, file_name, mime_type, size_bytes, uploaded_by)
         VALUES ($1, 'receipts', 'demo/' || gen_random_uuid()::text || '.txt', $2, 'text/plain', 4, $3)
         RETURNING id::text`,
        [ORG_ID, legacyName, USERS.admin],
      ),
    );
    created.push(legacy.rows[0].id);
    assert.ok(legacy.rows[0].id);
  } finally {
    await svc(null, async (client) => {
      if (paymentId) await client.query(`DELETE FROM payments WHERE id = $1`, [paymentId]);
      if (created.length) await client.query(`DELETE FROM files WHERE id = ANY($1::uuid[])`, [created]);
      await client.query(`DELETE FROM files WHERE org_id = $1 AND file_name LIKE $2`, [ORG_ID, `%${stamp}%`]);
    });
  }
});
