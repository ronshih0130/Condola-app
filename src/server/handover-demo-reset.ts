import type { Client } from "pg";
import { demoModeEnabled } from "./demo";
import { deleteHandoverObject } from "./handover-storage";

/** Called within the existing, already-authorized demo reset transaction,
 * before public demo data is wiped. Does not itself change the reset policy. */
export async function captureHandoverBeforeDemoReset(client: Client) {
  if (!demoModeEnabled()) throw new Error("Handover reset requires local demo mode");
  // The app takes SHARE on this table before any org/lease/private locks.
  // Reset must take the conflicting admission lock first to avoid inversion.
  await client.query("LOCK TABLE public.platform_settings IN SHARE ROW EXCLUSIVE MODE");
  // Fence app operations until private references have been snapshotted and removed.
  await client.query(`LOCK TABLE app.handover_records, app.handover_versions, app.handover_upload_intents, app.handover_attachments, app.handover_version_attachments, app.handover_replies IN ACCESS EXCLUSIVE MODE`);
  await client.query(`INSERT INTO app.handover_gc_tombstones(storage_path,reason)
    SELECT path,'demo_reset' FROM (
      SELECT storage_path AS path FROM app.handover_upload_intents
      UNION SELECT storage_path || '/sealed' FROM app.handover_upload_intents
      UNION SELECT storage_path FROM app.handover_attachments
    ) paths ON CONFLICT (storage_path) DO NOTHING`);
  for (const name of ["handover_version_attachments", "handover_replies", "handover_attachments", "handover_upload_intents", "handover_versions", "handover_records"]) {
    await client.query(`DELETE FROM app.${name}`);
  }
}

/** Trusted local/operator entry point: retryable, bounded and never marks a
 * tombstone complete. No scheduler is registered by this module. */
export async function reconcileHandoverDemoObjects(client: Client, limit: number) {
  if (!demoModeEnabled() || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Handover cleanup requires local demo mode");
  const rows = await client.query<{id:string;storage_path:string}>(`SELECT t.id,t.storage_path FROM app.handover_gc_tombstones t
    LEFT JOIN LATERAL (SELECT max(attempted_at) AS last_attempt FROM app.handover_gc_attempts WHERE tombstone_id=t.id) a ON true
    ORDER BY a.last_attempt NULLS FIRST,t.recorded_at,t.id LIMIT $1`, [limit]);
  for (const row of rows.rows) {
    let outcome = "delete_accepted";
    try { await deleteHandoverObject(row.storage_path); } catch { outcome = "storage_unavailable"; }
    await client.query(`INSERT INTO app.handover_gc_attempts(tombstone_id,outcome) VALUES($1,$2)`, [row.id,outcome]);
  }
  return rows.rowCount ?? 0;
}
