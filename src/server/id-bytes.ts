import type { Client } from "pg";

/**
 * pg sends each bytea parameter inside one Bind message and writes that
 * message with one socket write. Cloudflare Workers and Supavisor (the
 * Supabase transaction pooler on port 6543) both reject a single protocol
 * message above 64KiB. A ~55KB ciphertext passes; ~68KB fails.
 *
 * The driver also reads bytea as hex text, so a 32KiB slice comes back as
 * about 64KiB of `\x` plus the DataRow header and can fail on the way out.
 * 24KiB stays under the cap in both directions (hex read is about 48KiB).
 */
export const BYTEA_CHUNK = 24 * 1024;

export function byteaChunks(bytes: Buffer, size = BYTEA_CHUNK) {
  if (size < 1) throw new Error("bytea chunk size must be positive");
  if (bytes.length === 0) return [Buffer.alloc(0)];
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.subarray(offset, offset + size));
  }
  return chunks;
}

function asBuffer(value: unknown) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") {
    const hex = value.startsWith("\\x") ? value.slice(2) : value;
    return Buffer.from(hex, "hex");
  }
  throw new Error("ciphertext chunk was not bytea");
}

/** Replace one staged photo. The ciphertext is chunked so a Bind stays under 64KiB. */
export async function writeUploadSlot(
  client: Client,
  row: {
    userId: string;
    leaseId: string;
    documentId: string;
    slot: string;
    mime: string;
    plainSize: number;
    sha256: string;
    ciphertext: Buffer;
  },
) {
  await client.query(`DELETE FROM id_upload_slots WHERE user_id = $1::uuid AND lease_id = $2::uuid AND slot = $3`, [
    row.userId,
    row.leaseId,
    row.slot,
  ]);
  const chunks = byteaChunks(row.ciphertext);
  await client.query(
    `INSERT INTO id_upload_slots (
       user_id, lease_id, document_id, slot, mime_type, plain_size, sha256, ciphertext
     ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8)`,
    [row.userId, row.leaseId, row.documentId, row.slot, row.mime, row.plainSize, row.sha256, chunks[0]],
  );
  for (let index = 1; index < chunks.length; index += 1) {
    await client.query(
      `UPDATE id_upload_slots
          SET ciphertext = ciphertext || $4::bytea
        WHERE user_id = $1::uuid AND lease_id = $2::uuid AND slot = $3`,
      [row.userId, row.leaseId, row.slot, chunks[index]],
    );
  }
}

/** Insert ciphertext in slices small enough for one Bind message. */
export async function writeCiphertext(
  client: Client,
  row: { bucket: string; path: string; mime: string; sha256: string; ciphertext: Buffer },
) {
  const chunks = byteaChunks(row.ciphertext);
  await client.query(
    `INSERT INTO id_document_objects (bucket, path, mime_type, byte_size, sha256, ciphertext)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [row.bucket, row.path, row.mime, row.ciphertext.length, row.sha256, chunks[0]],
  );
  for (let index = 1; index < chunks.length; index += 1) {
    await client.query(
      `UPDATE id_document_objects
          SET ciphertext = ciphertext || $3::bytea
        WHERE bucket = $1 AND path = $2`,
      [row.bucket, row.path, chunks[index]],
    );
  }
}

/**
 * Copy one staged ciphertext onto the photo row.
 * The bytea stays in Postgres: each statement binds only text and integers,
 * and substring moves 24KiB at a time so a pooler never sees one giant value.
 */
export async function copySlotCiphertext(
  client: Client,
  row: { bucket: string; userId: string; leaseId: string; orgId: string; documentId: string; slot: string },
) {
  const head = await client.query<{ n: number | null; mime: string | null; sha256: string | null }>(
    `SELECT octet_length(ciphertext)::int AS n, mime_type AS mime, sha256
       FROM id_upload_slots
      WHERE user_id = $1::uuid AND lease_id = $2::uuid AND slot = $3`,
    [row.userId, row.leaseId, row.slot],
  );
  const total = head.rows[0]?.n;
  if (total == null || total < 1 || !head.rows[0]?.mime || !head.rows[0]?.sha256) {
    throw new Error("staged ciphertext missing");
  }
  const path = `${row.orgId}/${row.documentId}/${row.slot}`;
  const first = Math.min(BYTEA_CHUNK, total);
  await client.query(
    `INSERT INTO id_document_objects (bucket, path, mime_type, byte_size, sha256, ciphertext)
     SELECT $1, $2, mime_type, octet_length(ciphertext), sha256, substring(ciphertext from 1 for $3::int)
       FROM id_upload_slots
      WHERE user_id = $4::uuid AND lease_id = $5::uuid AND slot = $6`,
    [row.bucket, path, first, row.userId, row.leaseId, row.slot],
  );
  for (let offset = BYTEA_CHUNK; offset < total; offset += BYTEA_CHUNK) {
    await client.query(
      `UPDATE id_document_objects AS o
          SET ciphertext = o.ciphertext || s.chunk
         FROM (
           SELECT substring(ciphertext from $3::int for $4::int) AS chunk
             FROM id_upload_slots
            WHERE user_id = $5::uuid AND lease_id = $6::uuid AND slot = $7
         ) AS s
        WHERE o.bucket = $1 AND o.path = $2`,
      [row.bucket, path, offset + 1, BYTEA_CHUNK, row.userId, row.leaseId, row.slot],
    );
  }
  const wrote = await client.query<{ n: number }>(
    `SELECT octet_length(ciphertext)::int AS n
       FROM id_document_objects
      WHERE bucket = $1 AND path = $2`,
    [row.bucket, path],
  );
  if (wrote.rows[0]?.n !== total) throw new Error("ciphertext copy length mismatch");
}

/** Read ciphertext in slices small enough that the hex DataRow stays under 64KiB. */
export async function readCiphertext(client: Client, bucket: string, path: string) {
  const head = await client.query<{ n: number | null }>(
    `SELECT octet_length(ciphertext)::int AS n
       FROM id_document_objects
      WHERE bucket = $1 AND path = $2`,
    [bucket, path],
  );
  const total = head.rows[0]?.n;
  if (total == null) return null;
  const parts: Buffer[] = [];
  for (let offset = 0; offset < total; offset += BYTEA_CHUNK) {
    const row = await client.query<{ chunk: unknown }>(
      `SELECT substring(ciphertext from $3::int for $4::int) AS chunk
         FROM id_document_objects
        WHERE bucket = $1 AND path = $2`,
      [bucket, path, offset + 1, BYTEA_CHUNK],
    );
    const chunk = asBuffer(row.rows[0]?.chunk ?? Buffer.alloc(0));
    if (chunk.length === 0) break;
    parts.push(chunk);
  }
  const joined = Buffer.concat(parts);
  if (joined.length !== total) throw new Error("ciphertext read length mismatch");
  return joined;
}
