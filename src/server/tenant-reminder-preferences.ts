import { svc } from "./db";
import type { Session } from "./types";

async function preference(session:Session,leaseId:string,value:boolean | null) {
  if (session.kind !== "tenant" || session.needsSandbox) throw new Error("Preference unavailable");
  return svc(session.userId,async c=>(await c.query<{enabled:boolean}>(
    `SELECT app.b010_tenant_due_preference($1,$2,$3,$4,$5,$6) AS enabled`,
    [session.orgId,session.liveOrgId,session.environment,session.sessionId,leaseId,value])).rows[0].enabled);
}
export async function tenantDuePreference(session:Session,leaseId:string) {
  if (session.kind !== "tenant" || session.needsSandbox) return null;
  try {
    return await svc(session.userId,async c=>{
      const available=(await c.query<{enabled:boolean}>(`SELECT to_regprocedure('app.b010_tenant_due_preference(uuid,uuid,text,uuid,uuid,boolean)') IS NOT NULL
        AND EXISTS (SELECT 1 FROM organizations o JOIN platform_settings f ON f.key='rent_reminders_v2'
          WHERE o.id=$1 AND o.feature_flags->'rent_reminders_v2'='true'::jsonb AND f.value->'enabled'='true'::jsonb
            AND jsonb_typeof(f.value->'allowed_org_ids')='array' AND f.value->'allowed_org_ids' @> jsonb_build_array(o.id::text)) AS enabled`,[session.orgId])).rows[0].enabled;
      if (!available) return null;
      return (await c.query<{enabled:boolean}>(`SELECT app.b010_tenant_due_preference($1,$2,$3,$4,$5,NULL) AS enabled`,
        [session.orgId,session.liveOrgId,session.environment,session.sessionId,leaseId])).rows[0].enabled;
    });
  } catch { return null; }
}
export async function saveTenantDuePreference(session:Session,leaseId:string,enabled:boolean) {
  return preference(session,leaseId,enabled);
}
