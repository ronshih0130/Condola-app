import { withClient } from "../db";
import { hashInviteToken } from "../portal-invite";
import { readLineConfig } from "./config";

/** Read-only display gate. Acceptance always revalidates the original invitation inside B-033. */
export async function tenantLineInviteOrg(token: string): Promise<string | null> {
 if (!readLineConfig().platformEnabled) return null;
 return withClient(async c => (await c.query<{ org_id: string }>(`SELECT org_id FROM invitations
  WHERE code_hash=$1 AND kind='tenant' AND status='pending' AND expires_at>now()
  AND app.b033_portal_enabled(org_id,'tenant')`, [hashInviteToken(token)])).rows[0]?.org_id ?? null);
}
export async function tenantLineEntryEnabled(orgId: string) {
 if (!readLineConfig().platformEnabled) return false;
 return withClient(async c => (await c.query<{ enabled: boolean }>(
  "SELECT app.b033_portal_enabled($1,'tenant') AS enabled", [orgId])).rows[0]?.enabled === true);
}
