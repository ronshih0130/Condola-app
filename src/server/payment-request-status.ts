import { svc, tx } from "./db";
import type { Session } from "./types";
import { isUuid } from "./repair-rules";

export async function paymentRequestEnabled(session: Session): Promise<boolean> {
  if (session.kind !== "staff" || !["admin", "manager", "accountant"].includes(session.role ?? "") || session.needsSandbox) return false;
  return svc(session.userId, async c => (await c.query<{enabled:boolean}>(`SELECT EXISTS (SELECT 1 FROM organizations o JOIN platform_settings f ON f.key='payment_results_v2'
    WHERE o.id=$1 AND o.feature_flags->'payment_results_v2'='true'::jsonb AND f.value->'enabled'='true'::jsonb
      AND jsonb_typeof(f.value->'allowed_org_ids')='array' AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) AS enabled`, [session.orgId])).rows[0].enabled);
}

export async function paymentRequestStatus(session: Session, leaseId: string, requestId: string): Promise<"recorded" | "unknown"> {
  if (session.kind !== "staff" || !["admin", "manager", "accountant"].includes(session.role ?? "") || session.needsSandbox || !isUuid(leaseId) || !isUuid(requestId) || !isUuid(session.sessionId)) throw new Error("Payment status unavailable");
  return tx(session.userId, async c => {
    const result = await c.query<{status:"recorded" | "unknown"}>(`SELECT app.b010_payment_command_status($1,$2,$3,$4,$5,$6,$7) AS status`, [session.orgId,session.liveOrgId,session.environment,session.sessionId,leaseId,session.role,requestId]);
    if (result.rows[0]?.status !== "recorded" && result.rows[0]?.status !== "unknown") throw new Error("Payment status unavailable");
    return result.rows[0].status;
  }, {orgId:session.orgId,environment:session.environment});
}
