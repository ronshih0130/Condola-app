import { svc, tx } from "./db";
import type { Session } from "./types";
import { isUuid } from "./repair-rules";

export async function paymentRequestEnabled(session: Session): Promise<boolean> {
  if (session.kind !== "staff" || !["admin", "manager", "accountant"].includes(session.role ?? "") || session.needsSandbox) return false;
  return svc(session.userId, async c => (await c.query<{enabled:boolean}>(`SELECT EXISTS (SELECT 1 FROM organizations o JOIN platform_settings f ON f.key='payment_results_v2'
    WHERE o.id=$1 AND o.feature_flags->'payment_results_v2'='true'::jsonb AND f.value->'enabled'='true'::jsonb
      AND jsonb_typeof(f.value->'allowed_org_ids')='array' AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) AS enabled`, [session.orgId])).rows[0].enabled);
}

export async function ownerCollectedPaymentIds(session: Session, paymentIds: string[]): Promise<Set<string>> {
  if (paymentIds.length === 0 || !(await paymentRequestEnabled(session))) return new Set<string>();
  return svc(session.userId, async c => {
    const available = await c.query<{exists:boolean}>(`SELECT to_regclass('app.b010_lease_collectors') IS NOT NULL AS exists`);
    if (!available.rows[0].exists) return new Set<string>();
    const result = await c.query<{id:string}>(`SELECT p.id::text FROM payments p
      JOIN app.b010_lease_collectors lc ON lc.org_id=p.org_id AND lc.lease_id=p.lease_id
      WHERE p.org_id=$1 AND p.id = ANY($2::uuid[]) AND lc.collector='owner'`, [session.orgId, paymentIds]);
    return new Set(result.rows.map(row => row.id));
  });
}

export async function paymentRequestStatus(session: Session, leaseId: string, requestId: string): Promise<"recorded" | "unknown"> {
  if (session.kind !== "staff" || !["admin", "manager", "accountant"].includes(session.role ?? "") || session.needsSandbox || !isUuid(leaseId) || !isUuid(requestId) || !isUuid(session.sessionId)) throw new Error("Payment status unavailable");
  return tx(session.userId, async c => {
    const result = await c.query<{status:"recorded" | "unknown"}>(`SELECT app.b010_payment_command_status($1,$2,$3,$4,$5,$6,$7) AS status`, [session.orgId,session.liveOrgId,session.environment,session.sessionId,leaseId,session.role,requestId]);
    if (result.rows[0]?.status !== "recorded" && result.rows[0]?.status !== "unknown") throw new Error("Payment status unavailable");
    return result.rows[0].status;
  }, {orgId:session.orgId,environment:session.environment});
}
