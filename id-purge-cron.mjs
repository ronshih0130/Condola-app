// Daily ID-photo purge. The caller must already be allowed to SET ROLE service_role.
// Counts only leave this module. Document ids and storage paths stay in the query.

export const PURGE_CRON = "0 19 * * *";
export const PURGE_LIMIT = 500;
export const PURGE_MAX_BATCHES = 40;

export async function runIdPurge(client) {
  let batches = 0;
  let documents = 0;
  let files = 0;
  while (batches < PURGE_MAX_BATCHES) {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE service_role");
      await client.query(`DELETE FROM id_upload_slots WHERE created_at < now() - interval '24 hours'`);
      const purged = await client.query(
        `SELECT document_id::text AS document_id, storage_bucket, storage_path
           FROM purge_due_identity_documents($1)`,
        [PURGE_LIMIT],
      );
      const rows = purged.rows;
      const ids = [...new Set(rows.map((row) => row.document_id))];
      let removedFiles = 0;
      if (rows.length > 0) {
        const buckets = rows.map((row) => row.storage_bucket);
        const paths = rows.map((row) => row.storage_path);
        const watermarks = await client.query(
          `DELETE FROM id_document_wm_objects AS w
            WHERE (w.bucket, w.path) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
          [buckets, paths.map((path) => `${path}.wm`)],
        );
        const objects = await client.query(
          `DELETE FROM id_document_objects AS o
            WHERE (o.bucket, o.path) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
          [buckets, paths],
        );
        const photos = await client.query(
          `DELETE FROM identity_document_photos WHERE document_id = ANY($1::uuid[])`,
          [ids],
        );
        removedFiles = (watermarks.rowCount ?? 0) + (objects.rowCount ?? 0) + (photos.rowCount ?? 0);
      }
      await client.query("COMMIT");
      batches += 1;
      documents += ids.length;
      files += removedFiles;
      if (rows.length < PURGE_LIMIT) break;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The original error is the one to surface.
      }
      throw error;
    }
  }
  return { batches, documents, files };
}
