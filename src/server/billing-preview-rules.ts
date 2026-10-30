import type { Client } from "pg";

export function billingPreviewsOn(global: unknown, flags: unknown, orgId: string): boolean {
  if (!global || typeof global !== "object" || Array.isArray(global) || !flags || typeof flags !== "object" || Array.isArray(flags)) return false;
  const g = global as Record<string, unknown>, f = flags as Record<string, unknown>;
  return g.enabled === true && Array.isArray(g.allowed_org_ids) && g.allowed_org_ids.includes(orgId) && f.billing_previews === true;
}

export async function billingPreviewsEnabled(client: Client, orgId: string): Promise<boolean> {
  const result = await client.query<{ value: unknown; feature_flags: unknown }>(
    `SELECT (SELECT value FROM platform_settings WHERE key='billing_previews') AS value, feature_flags FROM organizations WHERE id=$1`, [orgId],
  );
  return billingPreviewsOn(result.rows[0]?.value,result.rows[0]?.feature_flags,orgId);
}
