// Existing daily ID-photo purge. No scheduler is introduced here.
// This shared module must remain free of Node-only imports.

export const PURGE_CRON = "0 19 * * *";
export const PURGE_LIMIT = 500;
export const PURGE_MAX_BATCHES = 40;

function clamp(value, fallback, maximum) {
  return Number.isFinite(value)
    ? Math.max(1, Math.min(maximum, Math.trunc(value)))
    : fallback;
}

function defaultAssertTarget({ bucket, path }) {
  if (
    bucket !== "id-documents-private" ||
    typeof path !== "string" ||
    path.trim().length === 0 ||
    path.startsWith("/") ||
    path.includes("..") ||
    path.includes("\\")
  ) {
    throw new Error("Unsafe ID purge target");
  }
}

/**
 * @typedef {{query: (sql: string, params?: any[]) => Promise<any>}} PurgeClient
 * @typedef {(fn: (client: PurgeClient) => Promise<any>) => Promise<any>} PurgeTransaction
 */

/**
 * Pass an application transaction callback (svc), or a connected raw client
 * without an active transaction. Each callback invocation owns one transaction.
 * Preview examines one bounded batch because repeated previews do not advance.
 *
 * @param {PurgeClient | PurgeTransaction} source
 * @param {{
 *   dryRun?: boolean,
 *   limit?: number,
 *   maxBatches?: number,
 *   assertTarget?: (target: {bucket: string, path: string}) => void
 * }} options
 */
export async function runIdPurge(source, options = {}) {
  /** @type {PurgeTransaction} */
  const transaction = typeof source === "function"
    ? source
    : async (fn) => {
        await source.query("BEGIN");
        try {
          await source.query(
            `SELECT set_config('request.jwt.claim.role', 'service_role', true)`,
          );
          await source.query("SET LOCAL ROLE service_role");
          const result = await fn(source);
          await source.query("COMMIT");
          return result;
        } catch (error) {
          try {
            await source.query("ROLLBACK");
          } catch {
            // Preserve the original error.
          }
          throw error;
        }
      };

  const dryRun = options.dryRun === true;
  const limit = clamp(options.limit ?? PURGE_LIMIT, PURGE_LIMIT, 1000);
  const maxBatches = clamp(options.maxBatches ?? PURGE_MAX_BATCHES, PURGE_MAX_BATCHES, 100);
  const assertTarget = options.assertTarget ?? defaultAssertTarget;
  const startedAt = new Date().toISOString();
  let batches = 0;
  let documents = 0;
  let wouldDelete = 0;
  let uploadSlots = 0;
  const byBucket = {};

  const summary = (nextBatches, nextDocuments, nextWouldDelete, nextUploadSlots) => ({
    mode: dryRun ? "dry_run" : "purge",
    limit,
    batches: nextBatches,
    ...(dryRun
      ? {
          would_delete: nextWouldDelete,
          upload_slots_would_delete: nextUploadSlots,
        }
      : {
          deleted: nextDocuments,
          upload_slots_deleted: nextUploadSlots,
        }),
    storage_failed: 0,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  });

  const writeSummary = async (client, counts) => {
    await client.query(
      `INSERT INTO public.audit_log (
         org_id, actor_user_id, actor_role, table_name, row_id,
         action, event_type, new_row
       ) VALUES (
         NULL, NULL, 'system', 'id_purge_runs', 'id_purge_run',
         'insert'::public.audit_action, 'id_purge_run', $1::jsonb
       )`,
      [JSON.stringify(counts)],
    );
  };

  try {
    while (batches < (dryRun ? 1 : maxBatches)) {
      const batch = await transaction(async (client) => {
        const result = await client.query(
          dryRun
            ? `SELECT document_id::text, storage_bucket, storage_path
                 FROM public.preview_due_identity_documents($1)`
            : `SELECT document_id::text, storage_bucket, storage_path
                 FROM public.purge_due_identity_documents($1)`,
          [limit],
        );
        const rows = result.rows;

        // SQL validates before deleting; this independently validates its output.
        // A failure here rolls back SQL's original and derived-object deletes.
        for (const row of rows) {
          assertTarget({ bucket: row.storage_bucket, path: row.storage_path });
          assertTarget({ bucket: row.storage_bucket, path: `${row.storage_path}.wm` });
        }

        if (!dryRun) {
          for (const row of rows) {
            await client.query(
              `DELETE FROM id_document_wm_objects WHERE bucket = $1 AND path = $2`,
              [row.storage_bucket, `${row.storage_path}.wm`],
            );
            await client.query(
              `DELETE FROM id_document_objects WHERE bucket = $1 AND path = $2`,
              [row.storage_bucket, row.storage_path],
            );
          }
          const documentIds = [...new Set(rows.map((row) => row.document_id))];
          if (documentIds.length > 0) {
            await client.query(
              `DELETE FROM identity_document_photos WHERE document_id = ANY($1::uuid[])`,
              [documentIds],
            );
          }
        }

        const count = new Set(rows.map((row) => row.document_id)).size;
        let slots = 0;
        if (batches === 0) {
          if (dryRun) {
            const preview = await client.query(
              `SELECT count(*)::int AS count FROM id_upload_slots
                WHERE created_at < now() - interval '24 hours'`,
            );
            slots = Number(preview.rows[0]?.count ?? 0);
          } else {
            const deleted = await client.query(
              `DELETE FROM id_upload_slots WHERE created_at < now() - interval '24 hours'`,
            );
            slots = deleted.rowCount ?? 0;
          }
        }

        const done = dryRun || count < limit || batches + 1 === maxBatches;
        if (done) {
          // The one successful-run summary commits with the final batch.
          await writeSummary(
            client,
            summary(
              batches + 1,
              documents + (dryRun ? 0 : count),
              dryRun ? count : 0,
              uploadSlots + slots,
            ),
          );
        }
        return { rows, count, slots, done };
      });

      // Advance totals only after the transaction commits.
      batches += 1;
      uploadSlots += batch.slots;
      if (dryRun) {
        wouldDelete = batch.count;
        for (const bucket of new Set(batch.rows.map((row) => row.storage_bucket))) {
          byBucket[bucket] = new Set(
            batch.rows
              .filter((row) => row.storage_bucket === bucket)
              .map((row) => row.document_id),
          ).size;
        }
      } else {
        documents += batch.count;
      }
      if (batch.done) break;
    }
  } catch (error) {
    // Record only committed progress after the failing batch has rolled back.
    // Failure to record this must not replace the original purge error.
    try {
      await transaction((client) =>
        writeSummary(client, summary(batches, documents, wouldDelete, uploadSlots)),
      );
    } catch {
      // Preserve the original purge error.
    }
    throw error;
  }

  return {
    dryRun,
    wouldDelete,
    byBucket,
    batches,
    documents,
    files: 0,
    storageFailed: 0,
    uploadSlotsDeleted: dryRun ? 0 : uploadSlots,
    uploadSlotsWouldDelete: dryRun ? uploadSlots : 0,
  };
}
