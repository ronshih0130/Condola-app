import { brandV3ReadForOrg } from "./brand-v3";
import { guardEffectiveSession, withEffectiveReadAuthority, customAuthorityAllowsOn } from "./b017-custom-role-governance";
import { tx } from "./db";
import { FlowError, logServerError } from "./errors";
import { requireOrgScope } from "./org-guard";
import { assertPerm } from "./perms";
import { isUuid } from "./repair-rules";
import { propertyRoomState, propertyTotals, type PropertyRoomFacts, type PropertyRoom } from "./b3-property-rules";
import type { Session } from "./types";

export type PropertyReady = { state:"ready"; id:string; name:string; archived:boolean; canInvite:boolean;
  rows:PropertyRoom[]; rooms:number; occupied:number; pending:number; unknown:number };
export type PropertyResult = PropertyReady | {state:"off" | "unavailable" | "not_found"};
type Deps = {v3?:(orgId:string)=>Promise<boolean>; transaction?:typeof tx};
export const PROPERTY_ADMISSION_SQL = `SELECT m.role::text AS role
 FROM organizations o
 JOIN org_members m ON m.org_id=CASE WHEN o.environment='sandbox' THEN o.live_org_id ELSE o.id END
 JOIN auth_sessions s ON s.id=$2::uuid AND s.user_id=auth.uid() AND s.user_id=$3::uuid
 WHERE o.id=$1::uuid AND o.environment::text=$4
 AND ((o.environment='live' AND o.id=$5::uuid AND o.live_org_id IS NULL)
   OR (o.environment='sandbox' AND o.live_org_id=$5::uuid))
 AND m.user_id=auth.uid() AND m.status='active' AND m.role IN ('admin','manager','accountant')
 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()`;
export const PROPERTY_SQL = `SELECT p.id::text,p.name,p.archived_at IS NOT NULL AS archived
 FROM properties p WHERE p.org_id=$1 AND p.id=$2::uuid`;

// One row per rentable target, no pagination cap and no lease-party fan-out.
// Same occupancy definition as today's dashboard: active OR pending_signature.
// Address belongs to property, floor to unit, owner to property, not to each room.
export const PROPERTY_ROOMS_SQL = `WITH targets AS (
 SELECT r.id,r.unit_id,u.label AS unit_label,r.label,r.room_type::text AS room_type,'room' AS kind,u.floor
 FROM rooms r JOIN units u ON u.id=r.unit_id AND u.org_id=r.org_id
 WHERE r.org_id=$1 AND u.property_id=$2::uuid AND u.rental_mode='by_room'
 AND r.archived_at IS NULL AND u.archived_at IS NULL
 UNION ALL
 SELECT u.id,u.id,u.label,u.label,NULL,'whole_unit',u.floor FROM units u
 WHERE u.org_id=$1 AND u.property_id=$2::uuid AND u.rental_mode='whole_unit' AND u.archived_at IS NULL
)
 SELECT t.id::text,t.unit_id::text AS "unitId",t.kind,t.label,t.unit_label AS "unitLabel",t.room_type AS "roomType",
 (nullif(btrim(p.address->>'city'),'') IS NOT NULL
   AND coalesce(nullif(btrim(p.address->>'street'),''),nullif(btrim(p.address->>'line'),''),nullif(btrim(p.address->>'house_number'),'')) IS NOT NULL
   AND nullif(btrim(t.floor),'') IS NOT NULL) AS "addressReady",
 EXISTS (SELECT 1 FROM property_owners po JOIN contacts c ON c.id=po.owner_contact_id AND c.org_id=po.org_id
   WHERE po.org_id=$1 AND po.property_id=p.id AND po.is_primary AND c.archived_at IS NULL
   AND po.effective_from<=current_date AND (po.effective_to IS NULL OR po.effective_to>=current_date)) AS "ownerReady",
 NULL::boolean AS "moneyReady",
 CASE WHEN EXISTS (SELECT 1 FROM leases l JOIN lease_parties lp ON lp.lease_id=l.id AND lp.org_id=l.org_id
   JOIN contacts c ON c.id=lp.contact_id AND c.org_id=lp.org_id
   WHERE l.org_id=$1 AND l.property_id=p.id AND l.unit_id=t.unit_id
   AND ((t.kind='room' AND l.target_room_id=t.id) OR (t.kind='whole_unit' AND l.target_unit_id=t.id))
   AND l.status IN ('draft','pending_signature','active') AND lp.role IN ('primary','co_tenant')
   AND c.is_tenant AND c.archived_at IS NULL) THEN true ELSE NULL END AS "tenantReady",
 (SELECT l.status::text FROM leases l WHERE l.org_id=$1 AND l.property_id=p.id AND l.unit_id=t.unit_id
   AND ((t.kind='room' AND l.target_room_id=t.id) OR (t.kind='whole_unit' AND l.target_unit_id=t.id))
   AND l.status IN ('draft','pending_signature','active')
   ORDER BY CASE l.status WHEN 'active' THEN 0 WHEN 'pending_signature' THEN 1 ELSE 2 END,l.id LIMIT 1) AS "leaseStatus"
 FROM targets t JOIN properties p ON p.id=$2::uuid AND p.org_id=$1
 ORDER BY t.unit_label,t.label,t.id`;

export async function brandProperty(session:Session,id:string,deps:Deps={}):Promise<PropertyResult> {
  try {
    if (!(await (deps.v3 ?? brandV3ReadForOrg)(session.orgId))) return {state:"off"};
    const admitted=await guardEffectiveSession(session,"props.view");
    assertPerm(admitted,"props.view");
    if(admitted.needsSandbox) throw new FlowError("errors.forbidden");
    if(!isUuid(id)) return {state:"not_found"};
    return await (deps.transaction ?? tx)(admitted.userId,async client=>{
      await client.query("SET LOCAL statement_timeout = '2s'");
      return withEffectiveReadAuthority(client,admitted,"props.view",async()=>{
        const context=(await client.query<{role:string}>(PROPERTY_ADMISSION_SQL,
          [admitted.orgId,admitted.sessionId,admitted.userId,admitted.environment,admitted.liveOrgId])).rows[0];
        if(!context) throw new FlowError("errors.forbidden");
        const property=(await client.query<{id:string;name:string;archived:boolean}>(PROPERTY_SQL,[admitted.orgId,id])).rows[0];
        if(!property) return {state:"not_found" as const};
        const canInvite=!property.archived && ["admin","manager"].includes(context.role)
          && await customAuthorityAllowsOn(client,admitted,"leases.edit");
        const rows=(await client.query<PropertyRoomFacts>(PROPERTY_ROOMS_SQL,[admitted.orgId,id])).rows.map(propertyRoomState);
        // MGT-83 has no runtime profile/override reader. Binding-only tenants are
        // service-only and unit-scoped, with no room attribution. Keep both unknown;
        // never infer completion from an owner, a bank account, or a sibling's join.
        return {state:"ready" as const,...property,canInvite,rows,...propertyTotals(rows)};
      });
    },requireOrgScope(admitted),{isolation:"repeatable read",readOnly:true});
  } catch(error) {
    if(error instanceof FlowError && error.key==="errors.forbidden") throw error;
    logServerError("b3_property",error);return {state:"unavailable"};
  }
}
