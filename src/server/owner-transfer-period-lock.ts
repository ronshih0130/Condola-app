import type { Client } from "pg";
import type { Session } from "./types";
import { isUuid } from "./repair-rules";

/** Cooperative current-application serialization; legacy writers are not covered. */
export async function lockOwnerTransferPeriod(client: Client, orgId: string) {
  if (!isUuid(orgId)) throw new Error("Invalid organization");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`condola:owner-transfer-month:${orgId.toLowerCase()}`]);
}

/** Current membership and session for close and transfer writes, independent of rollout flags. */
export async function currentOwnerTransferStaff(client:Client,s:Session) {
  if(s.kind!=="staff" || s.needsSandbox || !s.role || !["admin","accountant"].includes(s.role) || ![s.userId,s.orgId,s.liveOrgId,s.sessionId].every(isUuid) || !["live","sandbox"].includes(s.environment))return false;
  const r=await client.query(`SELECT 1 FROM public.organizations o JOIN public.org_members m ON m.org_id=$2 AND m.user_id=$3 AND m.status='active' AND m.role::text=$4 JOIN public.auth_sessions a ON a.id=$5 AND a.user_id=$3 WHERE o.id=$1 AND o.environment::text=$6 AND ((o.environment='live' AND o.id=$2 AND o.live_org_id IS NULL) OR (o.environment='sandbox' AND o.live_org_id=$2)) AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp()`,[s.orgId,s.liveOrgId,s.userId,s.role,s.sessionId,s.environment]);return r.rowCount===1;
}
