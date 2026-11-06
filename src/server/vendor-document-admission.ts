import type { Client } from "pg";
import { maybe, one } from "./db";
import { FlowError } from "./errors";
import { requireOrgScope } from "./org-guard";

/** Strict TS mirror of app.b025_flag_on; malformed settings fail closed. */
export async function vendorDocumentsEnabled(client: Client, orgId: string) {
  const row = await maybe<{ value: { enabled?: unknown; allowed_org_ids?: unknown }; feature_flags: Record<string, unknown> }>(client,
    `SELECT f.value,o.feature_flags FROM platform_settings f JOIN organizations o ON o.id=$1
      WHERE f.key='vendor_documents'`, [orgId]);
  return row?.value?.enabled === true && Array.isArray(row.value.allowed_org_ids)
    && row.value.allowed_org_ids.includes(orgId) && row.feature_flags?.vendor_documents === true;
}

/** Lock admission before ticket/profile locks; pin capability-derived scope. */
export async function admitVendorDocumentsOrgOn(client: Client, orgId: string) {
  await client.query("SELECT key FROM platform_settings WHERE key='vendor_documents' FOR SHARE");
  const org = await one<{ environment: "live" | "sandbox" }>(client,
    "SELECT environment FROM organizations WHERE id=$1 FOR SHARE", [orgId]);
  if (!await vendorDocumentsEnabled(client, orgId)) throw new FlowError("errors.notFound");
  requireOrgScope({ orgId, environment: org.environment });
  await client.query("SELECT set_config('app.active_org_id',$1,true),set_config('app.env',$2,true)", [orgId, org.environment]);
}
