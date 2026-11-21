import { brandV3ReadForOrg } from "./brand-v3";
import { guardEffectiveSession, withEffectiveReadAuthority, customAuthorityAllowsOn } from "./b017-custom-role-governance";
import { TENANTS_ADMISSION_SQL } from "./b3-tenants";
import { tx } from "./db";
import { FlowError, logServerError } from "./errors";
import { requireOrgScope } from "./org-guard";
import { assertPerm } from "./perms";
import { isUuid } from "./repair-rules";
import type { Session } from "./types";

export type TenantOneLease = { id: string; place: string; status: string; endDate: string | null };
export type TenantOneReady = {
  state: "ready"; id: string; name: string; lineLinked: boolean;
  canViewContact: boolean; mobileRequired: boolean;
  phone?: string | null; email?: string | null;
  // OQ-066 fallback, not per-number verification or provenance facts.
  legacyPhoneNotice?: true;
  /** B-076a: 「查看改號紀錄」 for a native admin/manager with contact access while tenant_directory_edit is on. */
  phoneHistory?: true;
  leases: TenantOneLease[];
};
export type TenantOneResult = { state: "off" | "unavailable" | "not_found" } | TenantOneReady;
type Deps = { v3?: (orgId: string) => Promise<boolean>; transaction?: typeof tx };

export const TENANT_ONE_CONTACT_SQL = `SELECT c.id::text,c.display_name AS name,
 CASE WHEN $3::boolean THEN nullif(btrim(c.phone_e164),'') END AS phone,
 CASE WHEN $3::boolean THEN c.email::text END AS email,
 EXISTS (SELECT 1 FROM line_account_links lk WHERE lk.org_id=$1 AND lk.contact_id=c.id
   AND lk.status='linked') AS "lineLinked"
 FROM contacts c WHERE c.org_id=$1 AND c.id=$2::uuid AND c.is_tenant AND c.archived_at IS NULL`;

// Match the existing detail's primary parties, adding co-tenants only when
// tenant_directory_edit admits this org. A contact without leases is still visible.
export const TENANT_ONE_LEASES_SQL = `SELECT DISTINCT l.id::text,l.status::text,l.created_at,
 p.name || ' ' || u.label || coalesce(' ' || r.label,'') AS place,l.end_date::text AS "endDate"
 FROM lease_parties lp JOIN leases l ON l.id=lp.lease_id AND l.org_id=lp.org_id
 JOIN properties p ON p.id=l.property_id AND p.org_id=l.org_id
 JOIN units u ON u.id=l.unit_id AND u.org_id=l.org_id
 LEFT JOIN rooms r ON r.id=l.target_room_id AND r.org_id=l.org_id
 WHERE lp.org_id=$1 AND lp.contact_id=$2::uuid
 AND (lp.role='primary' OR ($3::boolean AND lp.role='co_tenant'))
 ORDER BY l.created_at DESC,id DESC`;

export async function brandTenantOne(session: Session, id: string, deps: Deps = {}): Promise<TenantOneResult> {
  try {
    if (!(await (deps.v3 ?? brandV3ReadForOrg)(session.orgId))) return { state: "off" };
    const admitted = await guardEffectiveSession(session, "props.view");
    assertPerm(admitted, "props.view");
    if (admitted.needsSandbox) throw new FlowError("errors.forbidden");
    if (!isUuid(id)) return { state: "not_found" };
    return await (deps.transaction ?? tx)(admitted.userId, async client => {
      await client.query("SET LOCAL statement_timeout = '2s'");
      return withEffectiveReadAuthority(client, admitted, "props.view", async () => {
        const context = (await client.query<{ role: string; directory: boolean; mobileRequired: boolean }>(TENANTS_ADMISSION_SQL,
          [admitted.orgId,admitted.sessionId,admitted.userId,admitted.environment,admitted.liveOrgId])).rows[0];
        if (!context) throw new FlowError("errors.forbidden");
        const canViewContact = ["admin","manager"].includes(context.role)
          && await customAuthorityAllowsOn(client, admitted, "tenants.contact");
        const mobileRequired = context.mobileRequired === true;
        const contact = (await client.query<{ id: string; name: string; phone: string | null; email: string | null; lineLinked: boolean }>(
          TENANT_ONE_CONTACT_SQL,[admitted.orgId,id,canViewContact])).rows[0];
        if (!contact) return { state: "not_found" as const };
        const leases = (await client.query<TenantOneLease>(TENANT_ONE_LEASES_SQL,[admitted.orgId,id,context.directory])).rows
          .map(({id,place,status,endDate}) => ({id,place,status,endDate}));
        const { name,lineLinked } = contact;
        // Do not return private fields at all to accountant or contact-denied custom roles.
        // No verified-at/source/change-request schema or MGT-76 action exists here.
        // B-015 immediate contact editing is not a substitute for an OTP change.
        const phoneHistory = canViewContact && context.directory === true && ["admin","manager"].includes(context.role);
        return { state:"ready" as const,id,name,lineLinked,canViewContact,mobileRequired,leases,
          ...(phoneHistory ? { phoneHistory:true as const } : {}),
          ...(canViewContact ? { phone:contact.phone,email:contact.email,
            ...(mobileRequired && contact.phone ? { legacyPhoneNotice:true as const } : {}) } : {}) };
      });
    },requireOrgScope(admitted),{ isolation:"repeatable read",readOnly:true });
  } catch (error) {
    if (error instanceof FlowError && error.key==="errors.forbidden") throw error;
    logServerError("b3_tenant_one",error);
    return { state:"unavailable" };
  }
}
