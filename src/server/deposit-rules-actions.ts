"use server";

import { guardEffectiveSession } from "@/server/b017-custom-role-governance";

import { tx } from "./db";
import { requireCurrentConsent } from "./consent-gate";
import { resolveDepositPolicy, type DepositPolicy } from "./deposit-rules";
import { requireOrgScope } from "./org-guard";
import { can } from "./perms";
import { getSession } from "./session";

/** Only resolve a property already visible to this staff session. */
export async function actionDepositPolicy(input: { spaceId?: string; leaseId?: string; startDate?: string }): Promise<DepositPolicy | null> {
  await requireCurrentConsent();
  const session = await guardEffectiveSession(await getSession(), "leases.edit");
  if (session.kind !== "staff" || !can(session, "leases.edit") || session.needsSandbox) return null;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const id = input.leaseId ?? input.spaceId ?? "";
  if (!uuid.test(id)) return null;
  if (!input.leaseId && !/^\d{4}-\d{2}-\d{2}$/.test(input.startDate ?? "")) return null;
  const scope = requireOrgScope(session) as { orgId: string; environment: "live" | "sandbox" };
  return tx(session.userId, async (client) => {
    const row = input.leaseId
      ? await client.query<{ property_id: string; on_date: string }>(`SELECT property_id::text, start_date::text AS on_date FROM leases WHERE id=$1 AND org_id=$2`, [id, scope.orgId])
      : await client.query<{ property_id: string; on_date: string }>(`SELECT property_id::text, $3::date::text AS on_date FROM (
           SELECT u.property_id FROM units u WHERE u.id=$1 AND u.org_id=$2
           UNION ALL SELECT u.property_id FROM rooms r JOIN units u ON u.id=r.unit_id AND u.org_id=r.org_id WHERE r.id=$1 AND r.org_id=$2
         ) candidates LIMIT 1`, [id, scope.orgId, input.startDate]);
    if (!row.rows[0]) return null;
    return resolveDepositPolicy(client, scope.orgId, row.rows[0].property_id, row.rows[0].on_date);
  }, { orgId: scope.orgId, environment: scope.environment });
}
