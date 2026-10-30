import type { Client } from "pg";
import { demoModeEnabled } from "./demo";
import { deleteHandoverObject } from "./handover-storage";

/** In the authorized demo reset transaction, before handover and public wipes. */
export async function captureSettlementBeforeDemoReset(client:Client) {
  if (!demoModeEnabled()) throw new Error("Settlement reset requires local demo mode");
  await client.query("LOCK TABLE public.platform_settings IN SHARE ROW EXCLUSIVE MODE");
  await client.query(`LOCK TABLE app.settlement_records,app.settlement_versions,app.settlement_upload_intents,
    app.settlement_evidence,app.settlement_evidence_links,app.settlement_sources,app.settlement_rent_cycles,app.settlement_allocation_roots,app.settlement_line_roots,app.settlement_line_bindings,app.settlement_attributions,
    app.settlement_version_attributions,app.settlement_items,app.settlement_replies,app.settlement_outcomes,
    app.settlement_outcome_events,app.settlement_external_observations,app.settlement_outcome_reconciliations IN ACCESS EXCLUSIVE MODE`);
  await client.query(`INSERT INTO app.settlement_gc_tombstones(storage_path,reason)
    SELECT path,'demo_reset' FROM (SELECT storage_path AS path FROM app.settlement_upload_intents
      UNION SELECT storage_path || '/sealed' FROM app.settlement_upload_intents
      UNION SELECT storage_path FROM app.settlement_evidence WHERE intent_id IS NOT NULL) paths
    ON CONFLICT(storage_path) DO NOTHING`);
  for (const name of ["settlement_outcome_events","settlement_outcome_reconciliations","settlement_external_observations","settlement_outcomes","settlement_replies","settlement_items","settlement_version_attributions","settlement_attributions","settlement_allocation_roots","settlement_line_bindings","settlement_line_roots","settlement_rent_cycles","settlement_sources","settlement_evidence_links","settlement_evidence","settlement_upload_intents","settlement_versions","settlement_records"]) await client.query(`DELETE FROM app.${name}`);
}
/** Local/operator retries retain tombstones even after an accepted deletion. */
export async function reconcileSettlementDemoObjects(client:Client,limit:number) {
  if(!demoModeEnabled() || !Number.isInteger(limit) || limit<1 || limit>100) throw new Error("Settlement cleanup requires local demo mode");
  const rows=await client.query<{id:string;storage_path:string}>(`SELECT t.id,t.storage_path FROM app.settlement_gc_tombstones t LEFT JOIN LATERAL (SELECT max(attempted_at) AS last_attempt FROM app.settlement_gc_attempts WHERE tombstone_id=t.id) a ON true ORDER BY a.last_attempt NULLS FIRST,t.recorded_at,t.id LIMIT $1`,[limit]);
  for(const row of rows.rows) { let outcome="delete_accepted"; try { await deleteHandoverObject(row.storage_path); } catch { outcome="storage_unavailable"; } await client.query(`INSERT INTO app.settlement_gc_attempts(tombstone_id,outcome) VALUES($1,$2)`,[row.id,outcome]); }
  return rows.rowCount ?? 0;
}
