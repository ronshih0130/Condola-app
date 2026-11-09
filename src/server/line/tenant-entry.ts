import { withClient } from "../db";
import { hashInviteToken } from "../portal-invite";
import { readLineConfig } from "./config";

/** Read-only display gate. Acceptance always revalidates the original invitation inside B-033.
 * Tenant and owner portal invites share the same whitelisted-org gate; the persona comes from
 * the invitation kind so the accept page can bootstrap the correct portal entry. */
export async function lineInviteEntry(token: string): Promise<{ orgId: string; persona: "tenant" | "owner" } | null> {
 if (!readLineConfig().platformEnabled) return null;
 return withClient(async c => {
  const row = (await c.query<{ org_id: string; kind: "tenant" | "owner" }>(`SELECT org_id,kind FROM invitations
   WHERE code_hash=$1 AND kind IN ('tenant','owner') AND status='pending' AND expires_at>now()
   AND app.b033_portal_enabled(org_id,kind)`, [hashInviteToken(token)])).rows[0];
  return row ? { orgId: row.org_id, persona: row.kind } : null;
 });
}
/** Thin compatibility wrapper: the original tenant-only display gate. */
export async function tenantLineInviteOrg(token: string): Promise<string | null> {
 const entry = await lineInviteEntry(token);
 return entry && entry.persona === "tenant" ? entry.orgId : null;
}
export async function tenantLineEntryEnabled(orgId: string) {
 if (!readLineConfig().platformEnabled) return false;
 return withClient(async c => (await c.query<{ enabled: boolean }>(
  "SELECT app.b033_portal_enabled($1,'tenant') AS enabled", [orgId])).rows[0]?.enabled === true);
}
